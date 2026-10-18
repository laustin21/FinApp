"""Bank statement for the logged-in user's linked bank profile.

Shows every transaction type Nessie has for the customer's accounts
(deposits, withdrawals, purchases, transfers, paid bills) plus each account's
current balance. When one account is selected, each line also shows the
balance after that transaction, like a paper statement.

See banking.py for how balances are worked out.

GET /api/me/statement?period=last_30_days&account_id=<optional>
  period: last_30_days, this_month, last_month, last_3_months, all
"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException

import banking
import nessie
from bank import require_bank_link

router = APIRouter(prefix="/api")

PERIODS = ("last_30_days", "this_month", "last_month", "last_3_months", "all")


def _period_range(period: str, today: date):
    if period == "last_30_days":
        return today - timedelta(days=29), today
    if period == "this_month":
        return today.replace(day=1), today
    if period == "last_month":
        end = today.replace(day=1) - timedelta(days=1)
        return end.replace(day=1), end
    if period == "last_3_months":
        return today - timedelta(days=89), today
    if period == "all":
        return None, None
    raise HTTPException(400, f"period must be one of: {', '.join(PERIODS)}")


# Within one day: money in before money out, so running balances read naturally.
_ORDER = {"Deposit": 0, "Transfer": 1, "Purchase": 2, "Bill": 3, "Goal": 4, "Withdrawal": 5}


@router.get("/me/statement")
def statement(period: str = "last_30_days", account_id: str = "", user: dict = Depends(require_bank_link)):
    customer_id = user["bank_link"]["nessie_customer_id"]
    today = date.today()
    start, end = _period_range(period, today)

    try:
        customer = banking.customer(customer_id)
        ledger = banking.customer_ledger(customer_id)
    except nessie.NessieError as e:
        raise HTTPException(502, str(e))

    accounts = ledger["accounts"]
    by_id = {a["id"]: a for a in accounts}
    if account_id and account_id not in by_id:
        raise HTTPException(404, "That account isn't on your linked bank profile")

    lines = [l for l in ledger["lines"] if not account_id or l["account_id"] == account_id]
    # Oldest to newest: by date, then the exact time the app recorded it (if known), then type.
    lines.sort(key=lambda l: (l["date"], l.get("recorded_at") or "", _ORDER.get(l["type"], 9)))

    # Running balance (one account only): start from the opening balance.
    if account_id:
        running = by_id[account_id]["opening_balance"]
        for l in lines:
            running += l["amount"]
            l["balance_after"] = round(running, 2)

    in_range = [l for l in lines if start is None or start <= l["date"] <= end]
    in_range.reverse()  # newest first

    money_in = round(sum(l["amount"] for l in in_range if l["amount"] > 0), 2)
    money_out = round(-sum(l["amount"] for l in in_range if l["amount"] < 0), 2)
    first = min((l["date"] for l in lines), default=None)
    chosen = [by_id[account_id]] if account_id else accounts

    return {
        "customer": {"name": f"{customer['first_name']} {customer['last_name']}",
                     "address": customer.get("address") or {}},
        "period": {"key": period,
                   "start": (start or first or today).isoformat(),
                   "end": (end or today).isoformat()},
        "accounts": accounts,
        "account_id": account_id or None,
        "balance": round(sum(a["balance"] for a in chosen if a["type"] != "Credit Card"), 2),
        "summary": {"money_in": money_in, "money_out": money_out, "net": round(money_in - money_out, 2),
                    "count": len(in_range), "all_time_count": len(lines)},
        "transactions": [{**l, "date": l["date"].isoformat(), "amount": round(l["amount"], 2)} for l in in_range],
    }
