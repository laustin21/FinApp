"""Linking an app profile to a bank profile (a Nessie customer).

Bank profiles are set up in Nessie ahead of time (see seed.py). To link one,
you enter its bank customer ID; the app checks the ID exists in Nessie and
saves the link.

Don't have a bank profile? POST /api/bank/create opens one for you in Nessie
(customer + accounts), links it, and fills in about 3 months of realistic
history in the background, using the same spending styles as the demo users.

Rules:
  - One bank link per app profile (for now).
  - A bank profile can only be linked to one app profile, so nobody else can
    link a bank that's already yours.
Note: the ID is the only proof of ownership, so treat it like an account number.
"""
import json
import random
import threading
from datetime import date, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import db
import nessie
from auth import current_user

router = APIRouter(prefix="/api/bank")


class LinkIn(BaseModel):
    nessie_customer_id: str


class CreateIn(BaseModel):
    style: str = "student"   # student, commuter or professional (see STYLES)


def require_bank_link(user: dict = Depends(current_user)) -> dict:
    """Dependency for endpoints that need bank data: the user, who must have a link."""
    if not user["bank_link"]:
        raise HTTPException(409, "Link your bank account first")
    return user


@router.get("")
def bank_summary(user: dict = Depends(require_bank_link)):
    """The linked bank profile and its accounts (for the Accounts page)."""
    customer_id = user["bank_link"]["nessie_customer_id"]
    try:
        customer = nessie.get_customer(customer_id)
        accounts = nessie.get_customer_accounts(customer_id)
    except nessie.NessieError as e:
        raise HTTPException(502, str(e))
    return {
        "customer_id": customer_id,
        "linked_at": user["bank_link"]["linked_at"],
        "name": f"{customer['first_name']} {customer['last_name']}",
        "accounts": [
            {"id": a["_id"], "type": a["type"], "nickname": a["nickname"], "balance": a.get("balance", 0)}
            for a in accounts
        ],
    }


@router.post("/link", status_code=201)
def link_bank(body: LinkIn, user: dict = Depends(current_user)):
    if user["bank_link"]:
        raise HTTPException(409, "You already have a bank linked. Unlink it first to link a different one.")
    customer_id = body.nessie_customer_id.strip()
    if not customer_id:
        raise HTTPException(400, "Enter your bank customer ID")

    try:
        customer = nessie.get_customer(customer_id)
    except nessie.NessieError:
        raise HTTPException(400, "We couldn't find a bank profile with that ID. Check it and try again.")

    with db.connect() as conn:
        if conn.execute("SELECT 1 FROM bank_links WHERE nessie_customer_id = ?", (customer_id,)).fetchone():
            raise HTTPException(409, "This bank profile is already linked to another app profile")
        conn.execute(
            "INSERT INTO bank_links (user_id, nessie_customer_id, linked_at) VALUES (?, ?, ?)",
            (user["id"], customer_id, db.now()),
        )
    return {"nessie_customer_id": customer_id, "name": f"{customer['first_name']} {customer['last_name']}"}


@router.delete("/link")
def unlink(user: dict = Depends(current_user)):
    if not user["bank_link"]:
        raise HTTPException(404, "No bank is linked")
    with db.connect() as conn:
        conn.execute("DELETE FROM bank_links WHERE user_id = ?", (user["id"],))
    return {"status": "unlinked"}


# ---------- Opening a brand-new bank profile ----------

# Spending styles a new user can pick. Each borrows a demo persona's habits.
STYLES = {"student": "maya", "commuter": "carlos", "professional": "priya"}
NEW_HISTORY_DAYS = 60
MERCHANTS_FILE = db.DATA_DIR / "merchants.json"
_merchant_lock = threading.Lock()
_building: dict[int, str] = {}   # user_id -> "building" | "done" | "failed"
_progress: dict[int, dict] = {}  # user_id -> {"done": n, "total": n} transactions written so far
HISTORY_WORKERS = 8              # Nessie writes sent at once while filling in history

ADDRESSES = [
    ("101", "University Ave", "Gainesville", "FL", "32601"),
    ("45", "Archer Rd", "Gainesville", "FL", "32608"),
    ("2200", "SW 13th St", "Gainesville", "FL", "32608"),
    ("812", "NW 16th Ave", "Gainesville", "FL", "32601"),
    ("3300", "SW 34th St", "Gainesville", "FL", "32608"),
]


def _merchants() -> dict:
    """The demo's merchants in Nessie, created once and reused ({name: id})."""
    import demo_setup
    with _merchant_lock:
        demo_bank = demo_setup.DEMO_BANK
        if demo_bank.exists():
            saved = json.loads(demo_bank.read_text())
            return {n: m["id"] for n, m in saved["merchants"].items()}
        if MERCHANTS_FILE.exists():
            return json.loads(MERCHANTS_FILE.read_text())
        merchants = demo_setup.create_merchants()
        MERCHANTS_FILE.write_text(json.dumps(merchants, indent=2))
        return merchants


def _fill_history(user_id: int, persona: dict, account_ids: list):
    import demo_setup
    try:
        end = date.today() - timedelta(days=1)
        demo_setup.build_history(persona, account_ids, _merchants(), user_id,
                                 start=end - timedelta(days=NEW_HISTORY_DAYS), end=end,
                                 workers=HISTORY_WORKERS, progress=_progress.setdefault(user_id, {}))
        _building[user_id] = "done"
    except Exception as e:  # keep the account; just report that history didn't finish
        print(f"Building history for user {user_id} failed: {e}")
        _building[user_id] = "failed"


@router.post("/create", status_code=201)
def create_bank(body: CreateIn, user: dict = Depends(current_user)):
    """Open a new bank profile in Nessie for this user and link it."""
    import demo_setup
    if user["bank_link"]:
        raise HTTPException(409, "You already have a bank linked. Unlink it first to open a new one.")
    if body.style not in STYLES:
        raise HTTPException(400, f"style must be one of: {', '.join(STYLES)}")

    template = next(p for p in demo_setup.PERSONAS if p["username"] == STYLES[body.style])
    first, _, last = user["display_name"].partition(" ")
    rng = random.Random(user["id"])
    persona = {**template, "first": first or "New", "last": last or "Customer",
               "seed": 1000 + user["id"], "address": rng.choice(ADDRESSES)}

    try:
        customer_id = nessie.create_customer(persona["first"], persona["last"], *persona["address"])
        account_ids = [nessie.create_account(customer_id, t, nick, balance=opening)
                       for t, nick, opening in persona["accounts"]]
    except nessie.NessieError as e:
        raise HTTPException(502, f"Couldn't open the bank profile: {e}")

    with db.connect() as conn:
        conn.execute(
            "INSERT INTO bank_links (user_id, nessie_customer_id, linked_at) VALUES (?, ?, ?)",
            (user["id"], customer_id, db.now()),
        )

    # History takes a minute (one Nessie call per transaction), so build it in the
    # background. The dashboard refreshes itself and fills in as it goes.
    _building[user["id"]] = "building"
    threading.Thread(target=_fill_history, args=(user["id"], persona, account_ids), daemon=True).start()
    return {"nessie_customer_id": customer_id, "name": f"{persona['first']} {persona['last']}",
            "history": "building", "accounts": [nick for _, nick, _ in persona["accounts"]]}


@router.get("/history-status")
def history_status(user: dict = Depends(current_user)):
    """Whether a newly opened bank's history is still being filled in, and how far along."""
    p = _progress.get(user["id"], {})
    return {"status": _building.get(user["id"], "done"), "done": p.get("done", 0), "total": p.get("total", 0)}
