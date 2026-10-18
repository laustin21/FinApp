"""Demo-only buttons that create real transactions in Nessie on the spot.

Each one adds a deposit or purchase to the logged-in user's checking account
(today's date), so judges can watch the statement, balance and dashboard
update live. Everything created here is logged in app.db and removed by
reset_demo.py.

Only available while the demo shortcut is on (FINAPP_DEV is not 0).

GET  /api/dev/simulations          -> the list of buttons
POST /api/dev/simulate {kind}      -> create that transaction
"""
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import banking
import nessie
from auth import DEV_MODE
from bank import require_bank_link

router = APIRouter(prefix="/api/dev")

DEMO_BANK = Path(__file__).with_name("demo_bank.json")

# kind -> (label, type, merchant or None, cents, description)
SIMULATIONS = {
    "paycheck": ("Paycheck arrives", "deposit", None, 85000, "Paycheck · direct deposit"),
    "coffee": ("Buy a coffee", "purchase", "Bean There Coffee", 625, "Latte"),
    "groceries": ("Grocery run", "purchase", "Greenleaf Grocer", 5840, "Weekly groceries"),
    "dinner": ("Dinner out", "purchase", "Juniper & Stone", 4280, "Dinner with friends"),
    "ride": ("Take a ride", "purchase", "CityRide", 1735, "Ride across town"),
    "shopping": ("New shoes", "purchase", "North & Loom", 6400, "Sneakers"),
}


class SimulateIn(BaseModel):
    kind: str


def _merchants() -> dict:
    """{name: {"id", "category"}} for the demo merchants."""
    from demo_setup import DEMO_BANK as SAVED, MERCHANTS
    for path in (SAVED, DEMO_BANK):   # the data folder first (Railway), then next to this file
        if path.exists():
            return {name: {"id": m["id"], "category": m.get("category") or MERCHANTS.get(name, "")}
                    for name, m in json.loads(path.read_text())["merchants"].items()}
    legacy = Path(__file__).with_name("merchants.json")
    if legacy.exists():
        return {name: {"id": mid, "category": MERCHANTS.get(name, "")} for name, mid in json.loads(legacy.read_text()).items()}
    return {}


@router.get("/simulations")
def list_simulations():
    if not DEV_MODE:
        return []
    return [{"kind": k, "label": v[0], "type": v[1], "amount": v[3] / 100, "merchant": v[2]} for k, v in SIMULATIONS.items()]


@router.post("/simulate", status_code=201)
def simulate(body: SimulateIn, user: dict = Depends(require_bank_link)):
    if not DEV_MODE:
        raise HTTPException(404, "Not found")
    if body.kind not in SIMULATIONS:
        raise HTTPException(400, "Unknown simulation")
    label, kind, merchant_name, cents, description = SIMULATIONS[body.kind]

    try:
        ledger = banking.customer_ledger(user["bank_link"]["nessie_customer_id"])
    except nessie.NessieError as e:
        raise HTTPException(502, f"Couldn't reach the bank: {e}")
    account = banking.spending_account(ledger["accounts"])
    if account is None:
        raise HTTPException(409, "This bank profile has no accounts")

    try:
        if kind == "deposit":
            banking.deposit(account["id"], cents, description, user_id=user["id"], source="simulation")
        else:
            m = _merchants().get(merchant_name)
            if not m:
                raise HTTPException(409, f"The merchant {merchant_name} isn't set up. Run demo_setup.py first.")
            merchant_id = m["id"]
            # Remember its real category (e.g. Greenleaf Grocer -> Groceries) so budgets and insights file it correctly.
            banking.remember_merchant(merchant_id, merchant_name, m["category"])
            banking.purchase(account["id"], merchant_id, cents, description, user_id=user["id"], source="simulation")
    except nessie.NessieError as e:
        raise HTTPException(502, f"The bank couldn't record it: {e}")

    sign = 1 if kind == "deposit" else -1
    return {"label": label, "account": account["nickname"], "amount": sign * cents / 100,
            "new_balance": round(account["balance"] + sign * cents / 100, 2)}
