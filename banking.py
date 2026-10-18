"""Shared bank logic on top of Nessie: transactions, balances, and moving money.

Used by the statement, goal savings (groups.py), demo simulations and demo setup.

What this Nessie server supports (checked with probe_nessie.py)
---------------------------------------------------------------
  - deposits, withdrawals, purchases and bills can be created
  - transfers can't (the server rejects them), so a transfer between two of
    your accounts is recorded as a matching withdrawal + deposit pair
  - deposits and bills can be deleted; withdrawals and purchases can't, so
    "undoing" those hides them in the app instead (table nessie_hidden)
  - an account's stored `balance` never changes and can't be edited

Balances
--------
Because Nessie never updates the stored balance (checked with probe_nessie.py),
So the app treats Nessie's stored balance as the account's OPENING balance and
works out the current balance itself:

    current balance = opening balance + money in - money out

That's what a real bank ledger does, and it means every transaction the app
creates (like saving toward a goal) shows up in the balance immediately.

Activity log
------------
Every transaction the app creates in Nessie is recorded in app.db
(`nessie_activity`), so reset_demo.py can delete exactly what a demo run added.
"""
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import db
import nessie

# From probe_nessie.py results (see the module docstring).
NESSIE_UPDATES_BALANCE = False   # True would mean: trust Nessie's balance field as current
DELETABLE = {"deposits", "bills"}  # DELETE /deposits/{id} and /bills/{id} work; the rest don't

TYPES = ("deposits", "withdrawals", "purchases", "transfers", "bills")

_merchant_cache: dict = {}

# ---------- Speed ----------
# Nessie is slow (~0.5-1.5 s per call) and one ledger needs ~16 calls, so:
#  1. the calls for a ledger run in parallel instead of one after another,
#  2. a finished ledger is reused for LEDGER_TTL seconds by every page
#     (dashboard, statement, insights, goals) and by concurrent requests,
#  3. any write the app makes (see create/hide/remove) throws the cache away,
#     so your own changes show up on the very next request.
LEDGER_TTL = 30          # seconds; changes made outside the app show up within this
CUSTOMER_TTL = 600       # names/addresses barely change
_pool = ThreadPoolExecutor(max_workers=12, thread_name_prefix="nessie")
_ledger_cache: dict = {}             # customer_id -> (loaded_at, ledger)
_customer_cache: dict = {}           # customer_id -> (loaded_at, customer)
_ledger_locks: dict = defaultdict(threading.Lock)
_cache_guard = threading.Lock()
_generation = 0                      # bumped on every write


def invalidate():
    """Forget cached ledgers (called after the app writes to Nessie)."""
    global _generation
    with _cache_guard:
        _generation += 1
        _ledger_cache.clear()


def customer(customer_id: str) -> dict:
    """Nessie customer (name, address), cached."""
    hit = _customer_cache.get(customer_id)
    if hit and time.monotonic() - hit[0] < CUSTOMER_TTL:
        return hit[1]
    c = nessie.get_customer(customer_id)
    _customer_cache[customer_id] = (time.monotonic(), c)
    return c


# ---------- Reading ----------

def get_list(path: str) -> list:
    """GET a list from Nessie; an unsupported or failing endpoint just means 'none'."""
    try:
        result = nessie._request("GET", path)
    except nessie.NessieError:
        return []
    return result if isinstance(result, list) else []


_get_list = get_list  # module-level name that account_transactions' local helper falls back to


# The spending categories the app uses (dashboard, budgets, insights).
CATEGORIES = ("Dining", "Groceries", "Shopping", "Transport", "Other")
# Words in a merchant's name or Nessie category that tell us its category.
_CATEGORY_HINTS = (
    ("Groceries", ("grocer", "grocery", "groceries", "market", "supermarket", "foods", "produce", "pantry")),
    ("Dining", ("dining", "restaurant", "coffee", "cafe", "café", "bar", "grill", "noodle", "pizza", "burger",
                "kitchen", "bistro", "diner", "taco", "sushi", "bakery", "food", "eat", "juniper")),
    ("Transport", ("transport", "ride", "taxi", "uber", "lyft", "fuel", "gas", "parking", "transit", "bus", "train", "auto")),
    ("Shopping", ("shopping", "shop", "store", "outfitter", "apparel", "clothing", "loom", "boutique", "mall", "retail", "electronics")),
)


def categorize(name: str | None, category=None) -> str:
    """One of CATEGORIES for a merchant. Uses its Nessie category when that's one of ours,
    otherwise looks for hints in the category and name, otherwise "Other"."""
    if isinstance(category, list):
        category = category[0] if category else ""
    raw = (category or "").strip()
    for c in CATEGORIES:
        if raw.lower() == c.lower():
            return c
    text = f"{raw} {name or ''}".lower()
    for c, words in _CATEGORY_HINTS:
        if any(w in text for w in words):
            return c
    return "Other"


def merchant(merchant_id) -> dict:
    if not merchant_id:
        return {"name": "Unknown merchant", "category": "Other"}
    if merchant_id not in _merchant_cache:
        try:
            m = nessie._request("GET", f"/merchants/{merchant_id}")
            name = m.get("name", "Unknown merchant")
            _merchant_cache[merchant_id] = {"name": name, "category": categorize(name, m.get("category"))}
        except nessie.NessieError:
            # Don't remember a failed lookup: try again next time instead of filing everything under Other.
            return {"name": "Unknown merchant", "category": "Other"}
    return _merchant_cache[merchant_id]


def remember_merchant(merchant_id: str, name: str, category: str):
    """Skip a lookup for merchants we just created."""
    _merchant_cache[merchant_id] = {"name": name, "category": categorize(name, category)}


def _day(value) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def hidden_ids() -> set:
    with db.connect() as conn:
        return {r["nessie_id"] for r in conn.execute("SELECT nessie_id FROM nessie_hidden")}


def _kind(description: str, fallback: str) -> str:
    """Show transfers (stored as withdrawal/deposit pairs) and goal savings as their own types."""
    if description.startswith(("Transfer to ", "Transfer from ")):
        return "Transfer"
    if description.startswith("Saved for "):
        return "Goal"
    return fallback


def account_transactions(account: dict, names: dict, hidden: set | None = None, fetched: dict | None = None) -> list:
    """Every transaction on one account as statement lines (amount > 0 = money in).

    `fetched` ({"deposits": [...], ...}) passes in lists already downloaded;
    any type missing from it is fetched here."""
    hidden = hidden_ids() if hidden is None else hidden
    aid = account["_id"]
    base = {"account_id": aid, "account": account.get("nickname") or account.get("type", "Account")}
    lines = []
    fetched = fetched or {}

    def get_list(path: str) -> list:  # noqa: F811 - prefer what was already fetched
        kind = path.rsplit("/", 1)[-1]
        return fetched[kind] if kind in fetched else _get_list(path)

    for d in get_list(f"/accounts/{aid}/deposits"):
        lines.append({**base, "id": d.get("_id"), "type": _kind(d.get("description") or "", "Deposit"),
                      "date": _day(d.get("transaction_date")),
                      "description": d.get("description") or "Deposit", "category": None,
                      "amount": abs(float(d.get("amount", 0))), "status": d.get("status", "")})

    for w in get_list(f"/accounts/{aid}/withdrawals"):
        lines.append({**base, "id": w.get("_id"), "type": _kind(w.get("description") or "", "Withdrawal"),
                      "date": _day(w.get("transaction_date")),
                      "description": w.get("description") or "Withdrawal",
                      "category": "Savings goal" if (w.get("description") or "").startswith("Saved for") else None,
                      "amount": -abs(float(w.get("amount", 0))), "status": w.get("status", "")})

    for p in get_list(f"/accounts/{aid}/purchases"):
        m = merchant(p.get("merchant_id"))
        desc = m["name"] + (f" · {p['description']}" if p.get("description") else "")
        lines.append({**base, "id": p.get("_id"), "type": "Purchase", "date": _day(p.get("purchase_date")),
                      "description": desc, "category": m["category"], "merchant": m["name"],
                      "amount": -abs(float(p.get("amount", 0))), "status": p.get("status", "")})

    for t in get_list(f"/accounts/{aid}/transfers"):
        outgoing = t.get("payer_id") == aid
        other = t.get("payee_id") if outgoing else t.get("payer_id")
        other_name = names.get(other, "another account")
        lines.append({**base, "id": t.get("_id"), "type": "Transfer", "date": _day(t.get("transaction_date")),
                      "description": t.get("description") or (f"Transfer to {other_name}" if outgoing else f"Transfer from {other_name}"),
                      "category": None, "amount": (-1 if outgoing else 1) * abs(float(t.get("amount", 0))),
                      "status": t.get("status", "")})

    for b in get_list(f"/accounts/{aid}/bills"):
        paid_on = _day(b.get("payment_date"))
        if paid_on is None:
            continue  # not paid yet, so it isn't on the statement
        lines.append({**base, "id": b.get("_id"), "type": "Bill", "date": paid_on,
                      "description": b.get("nickname") or b.get("payee") or "Bill payment", "category": "Bills",
                      "amount": -abs(float(b.get("payment_amount", 0))), "status": b.get("status", "")})

    return [line for line in lines if line["date"] is not None and line["id"] not in hidden]


def _copy(ledger: dict) -> dict:
    """Callers may edit lines (e.g. statement adds balance_after), so hand out copies."""
    return {"accounts": [dict(a) for a in ledger["accounts"]], "lines": [dict(l) for l in ledger["lines"]]}


def customer_ledger(customer_id: str) -> dict:
    """All accounts with their transactions and current balances.

    Returns {"accounts": [...], "lines": [...]} where each account has
    opening_balance, balance (current) and each line has amount and date.
    Cached for LEDGER_TTL seconds; simultaneous requests share one download."""
    hit = _ledger_cache.get(customer_id)
    if hit and time.monotonic() - hit[0] < LEDGER_TTL:
        return _copy(hit[1])
    with _cache_guard:
        lock = _ledger_locks[customer_id]
    with lock:  # if another request is already downloading this ledger, wait for it
        hit = _ledger_cache.get(customer_id)
        if hit and time.monotonic() - hit[0] < LEDGER_TTL:
            return _copy(hit[1])
        generation = _generation
        ledger = _load_ledger(customer_id)
        with _cache_guard:
            if generation == _generation:  # skip caching if a write happened mid-download
                _ledger_cache[customer_id] = (time.monotonic(), ledger)
        return _copy(ledger)


def _load_ledger(customer_id: str) -> dict:
    accounts = nessie.get_customer_accounts(customer_id) or []
    names = {a["_id"]: a.get("nickname") or a.get("type") for a in accounts}
    hidden = hidden_ids()

    # Every account x transaction type at once, instead of one after another.
    jobs = {(a["_id"], kind): _pool.submit(_get_list, f"/accounts/{a['_id']}/{kind}") for a in accounts for kind in TYPES}
    fetched = defaultdict(dict)
    for (aid, kind), job in jobs.items():
        fetched[aid][kind] = job.result()

    # Look up merchants we haven't seen yet, also in parallel.
    new_merchants = {p.get("merchant_id") for f in fetched.values() for p in f.get("purchases", [])} - set(_merchant_cache) - {None, ""}
    list(_pool.map(merchant, new_merchants))

    # Nessie only stores a date, not a time. For transactions the app created we know the
    # exact moment (nessie_activity), so same-day lines can be shown newest first.
    with db.connect() as conn:
        # "time#row" so two made in the same second still sort in the order they happened.
        recorded = {r["nessie_id"]: f"{r['created_at']}#{r['id']:09d}" for r in conn.execute("SELECT id, nessie_id, created_at FROM nessie_activity")}

    lines, out = [], []
    for a in accounts:
        mine = account_transactions(a, names, hidden, fetched[a["_id"]])
        for line in mine:
            line["recorded_at"] = recorded.get(line["id"], "")
        lines.extend(mine)
        stored = float(a.get("balance") or 0)
        current = stored if NESSIE_UPDATES_BALANCE else stored + sum(l["amount"] for l in mine)
        out.append({"id": a["_id"], "type": a.get("type"), "nickname": a.get("nickname") or a.get("type"),
                    "opening_balance": round(stored, 2), "balance": round(current, 2)})
    return {"accounts": out, "lines": lines}


def spending_account(accounts: list) -> dict | None:
    """Where money for goals/simulations comes from: the first checking account."""
    for wanted in ("Checking", "Savings", "Credit Card"):
        for a in accounts:
            if a["type"] == wanted:
                return a
    return accounts[0] if accounts else None


# ---------- Writing ----------

def _log(user_id, source, nessie_type, nessie_id, account_id, cents, description):
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO nessie_activity (user_id, source, nessie_type, nessie_id, account_id, amount_cents, description, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, source, nessie_type, nessie_id, account_id, cents, description, db.now()),
        )


def create(nessie_type: str, account_id: str, body: dict, *, user_id=None, source="simulation", cents=0, description="") -> str:
    """POST a transaction to Nessie, log it, and return its ID."""
    nessie_id = nessie._created_id(nessie._request("POST", f"/accounts/{account_id}/{nessie_type}", body))
    invalidate()
    _log(user_id, source, nessie_type, nessie_id, account_id, cents, description)
    return nessie_id


def withdraw(account_id: str, cents: int, description: str, *, user_id=None, source="contribution", when: str | None = None) -> str:
    return create("withdrawals", account_id, {
        "medium": "balance", "transaction_date": when or date.today().isoformat(), "status": "completed",
        "amount": round(cents / 100, 2), "description": description,
    }, user_id=user_id, source=source, cents=cents, description=description)


def deposit(account_id: str, cents: int, description: str, *, user_id=None, source="simulation", when: str | None = None) -> str:
    return create("deposits", account_id, {
        "medium": "balance", "transaction_date": when or date.today().isoformat(), "status": "completed",
        "amount": round(cents / 100, 2), "description": description,
    }, user_id=user_id, source=source, cents=cents, description=description)


def purchase(account_id: str, merchant_id: str, cents: int, description: str, *, user_id=None, source="simulation", when: str | None = None) -> str:
    return create("purchases", account_id, {
        "merchant_id": merchant_id, "medium": "balance", "purchase_date": when or date.today().isoformat(),
        "amount": round(cents / 100, 2), "status": "completed", "description": description,
    }, user_id=user_id, source=source, cents=cents, description=description)


def transfer(from_id: str, to_id: str, cents: int, note: str, names: dict, *, user_id=None, source="seed", when: str | None = None):
    """Move money between two of the customer's accounts.
    This Nessie server rejects transfers, so it's a withdrawal + deposit pair."""
    to_name, from_name = names.get(to_id, "another account"), names.get(from_id, "another account")
    suffix = f" · {note}" if note else ""
    withdraw(from_id, cents, f"Transfer to {to_name}{suffix}", user_id=user_id, source=source, when=when)
    deposit(to_id, cents, f"Transfer from {from_name}{suffix}", user_id=user_id, source=source, when=when)


def hide(nessie_type: str, nessie_id: str, reason: str):
    with db.connect() as conn:
        conn.execute("INSERT OR IGNORE INTO nessie_hidden (nessie_id, nessie_type, hidden_at, reason) VALUES (?, ?, ?, ?)",
                     (nessie_id, nessie_type, db.now(), reason))
    invalidate()


def remove(nessie_type: str, nessie_id: str, reason: str = "undone") -> str:
    """Take back a transaction the app created: delete it in Nessie when the
    server allows it, otherwise hide it so statements and balances ignore it."""
    how = "hidden"
    if nessie_type in DELETABLE:
        try:
            nessie._request("DELETE", f"/{nessie_type}/{nessie_id}")
            how = "deleted"
            invalidate()
        except nessie.NessieError:
            pass
    if how == "hidden":
        hide(nessie_type, nessie_id, reason)
    with db.connect() as conn:
        conn.execute("DELETE FROM nessie_activity WHERE nessie_type = ? AND nessie_id = ?", (nessie_type, nessie_id))
    return how
