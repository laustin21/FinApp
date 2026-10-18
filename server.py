"""Backend API for the dashboard in frontend/.

The React app calls these endpoints; this server calls Nessie (with the API
key from .env) and returns JSON shaped for the screens.

Run it with:  venv\\Scripts\\python.exe server.py
(or click Run on this file in VS Code). It listens on http://localhost:8000
(or on $PORT when hosted, e.g. on Railway).
Needs:  pip install fastapi uvicorn

Everything except sign up / log in needs "Authorization: Bearer <token>".

App profiles (auth.py):
  POST /api/auth/signup {display_name, username, password} -> {token}
  POST /api/auth/login  {username, password}               -> {token}
  GET  /api/auth/username-available?username=...
  POST /api/auth/logout
  GET  /api/me                                          -> you + your bank link
Bank linking (bank.py):
  GET    /api/bank                                       -> linked profile + accounts
  POST   /api/bank/link   {nessie_customer_id}
  DELETE /api/bank/link
Dashboard (this file):
  GET /api/me/dashboard?period=this_month   (this_month, last_month, last_3_months)
Demo simulations (simulate.py, demo mode only):
  GET  /api/dev/simulations
  POST /api/dev/simulate {kind}
  GET  /api/me/funding-account          -> where goal savings come from + its balance (groups.py)
Bank statement (statement.py):
  GET /api/me/statement?period=last_30_days&account_id=   (last_30_days, this_month, last_month, last_3_months, all)
Friends (friends.py):
  GET    /api/friends                        -> friends and requests
  POST   /api/friend-requests {username}     -> send a request by username
  POST   /api/friend-requests/{id}/accept
  POST   /api/friend-requests/{id}/decline   (decline, or cancel one you sent)
  DELETE /api/friends/{user_id}              -> remove a friend
Groups and shared goals (groups.py):
  GET    /api/groups                          -> your groups + invites waiting for you
  POST   /api/groups {name, invite_user_ids}  -> create a group (invite friends only)
  GET    /api/groups/{id}                     -> members, invites, goals with progress, activity
  POST   /api/groups/{id}/invites {user_id}   -> invite a friend
  POST   /api/group-invites/{id}/accept | /decline
  POST   /api/groups/{id}/leave
  POST   /api/groups/{id}/goals {title, target_amount, deadline}
  DELETE /api/goals/{id}
  POST   /api/goals/{id}/commit {share_amount}
  POST   /api/goals/{id}/contributions {amount, note}
  DELETE /api/contributions/{id}
Notifications (notifications.py):
  GET  /api/notifications                  -> {unread_count, items}
  POST /api/notifications/seen
Gemini goal coach (goal_coach.py):
  POST /api/groups/{id}/goal-coach {messages}  -> {reply, chips, ready, plan, math}
  PUT  /api/goals/{id}/terms {frequency, penalty_type, penalty_percent, penalty_dare, ...}
Solana vaults (solana_vault.py):
  GET  /api/solana/status          -> network, app wallet, token, queue
  GET  /api/goals/{id}/vault        -> on-chain balance vs app ledger, members, transactions
Gemini status (gemini.py):
  GET  /api/ai/status        -> {state, latency_ms, model, error}
  POST /api/ai/status/check  -> same, after a live test prompt
AI insights (gemini.py, needs GEMINI_API_KEY in .env):
  GET /api/me/insights?period=this_month   -> {available, insights: {headline, persona, insights, tips}}
"""
import os
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import date, timedelta

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import auth
import bank
import banking
import db
import demo_setup
import friends
import gemini
import goal_coach
import groups
import nessie
import notifications
import simulate
import solana_vault
import statement

@asynccontextmanager
async def _lifespan(_app):
    # Fresh database (e.g. a new Railway deploy)? Set up the demo users automatically.
    demo_setup.ensure_demo()
    # Load Gemini and test the key in the background, so the first AI request is faster.
    gemini.warm_up()
    # Record group-goal savings on Solana (devnet) in the background.
    solana_vault.start_worker()
    yield


app = FastAPI(title="finapp backend", lifespan=_lifespan)

# Which websites may call this API: the deployed frontend on Railway plus local
# development (the Vite dev server runs on port 8443). To allow another site,
# set FRONTEND_ORIGINS in .env or Railway's variables (comma-separated).
ALLOWED_ORIGINS = [
    "https://finapp-poo.up.railway.app",
    "http://localhost:8443",
    "http://127.0.0.1:8443",
] + [o.strip() for o in os.getenv("FRONTEND_ORIGINS", "").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(bank.router)
app.include_router(friends.router)
app.include_router(groups.router)
app.include_router(goal_coach.router)
app.include_router(statement.router)
app.include_router(simulate.router)
app.include_router(notifications.router)

@app.get("/api/ai/status")
def ai_status():
    """Is Gemini set up and answering? {state: online|offline|checking|not_configured, latency_ms, model, error}"""
    return gemini.status()


@app.post("/api/ai/status/check")
def ai_status_check(user: dict = Depends(auth.current_user)):
    """Send Gemini a tiny test prompt right now (the header's "Test now")."""
    return gemini.check()


@app.get("/api/solana/status")
def solana_status():
    """The app's Solana setup: network, app wallet + fee balance, GSD token, queue size."""
    return solana_vault.status()


@app.get("/api/dev/demo-status")
def demo_status():
    """Whether the one-click demo logins are ready, still being built, or off."""
    return {"enabled": auth.DEV_MODE, "status": demo_setup.demo_status["status"]}


def _period_range(period, today=None):
    """Return (start, end, previous_start, previous_end) as dates, end inclusive."""
    today = today or date.today()
    first_this_month = today.replace(day=1)
    if period == "this_month":
        start, end = first_this_month, today
    elif period == "last_month":
        end = first_this_month - timedelta(days=1)
        start = end.replace(day=1)
    elif period == "last_3_months":
        start, end = today - timedelta(days=89), today
    else:
        raise HTTPException(400, "period must be this_month, last_month or last_3_months")
    length = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=length - 1)
    return start, end, prev_start, prev_end


def _customer_purchases(ledger):
    """Purchases across all accounts (hidden/undone ones are already left out)."""
    return [
        {"id": l["id"], "date": l["date"], "amount": -l["amount"], "merchant": l.get("merchant", "Unknown merchant"),
         "category": l["category"] or "Other", "description": l["description"].split(" · ", 1)[-1] if " · " in l["description"] else ""}
        for l in ledger["lines"] if l["type"] == "Purchase"
    ]


def _daily_buckets(purchases, start, end):
    """Spending per day; per week when the period is longer than a month."""
    step = 1 if (end - start).days < 31 else 7
    buckets = []
    day = start
    while day <= end:
        bucket_end = min(day + timedelta(days=step - 1), end)
        total = sum(p["amount"] for p in purchases if day <= p["date"] <= bucket_end)
        buckets.append({"date": day.isoformat(), "amount": round(total, 2)})
        day = bucket_end + timedelta(days=1)
    return {"unit": "day" if step == 1 else "week", "points": buckets}


def _goal_savings_total(user_id: int) -> float:
    with db.connect() as conn:
        row = conn.execute("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM contributions WHERE user_id = ?", (user_id,)).fetchone()
    return round(row["c"] / 100, 2)


@app.get("/api/me/dashboard")
def dashboard(period: str = "this_month", user: dict = Depends(bank.require_bank_link)):
    """Spending dashboard for the logged-in user's linked bank profile."""
    customer_id = user["bank_link"]["nessie_customer_id"]
    try:
        customer = banking.customer(customer_id)
        start, end, prev_start, prev_end = _period_range(period)
        ledger = banking.customer_ledger(customer_id)
        all_purchases = _customer_purchases(ledger)
    except nessie.NessieError as e:
        raise HTTPException(502, str(e))

    current = [p for p in all_purchases if start <= p["date"] <= end]
    previous = [p for p in all_purchases if prev_start <= p["date"] <= prev_end]
    total = round(sum(p["amount"] for p in current), 2)
    previous_total = round(sum(p["amount"] for p in previous), 2)

    by_category = defaultdict(lambda: {"amount": 0.0, "count": 0})
    for p in current:
        by_category[p["category"]]["amount"] += p["amount"]
        by_category[p["category"]]["count"] += 1
    categories = sorted(
        (
            {
                "name": name,
                "amount": round(v["amount"], 2),
                "count": v["count"],
                "percent": round(100 * v["amount"] / total) if total else 0,
            }
            for name, v in by_category.items()
        ),
        key=lambda c: c["amount"],
        reverse=True,
    )

    recent = sorted(current, key=lambda p: p["date"], reverse=True)[:8]

    result = {
        "customer": {"id": customer_id, "first_name": customer["first_name"], "last_name": customer["last_name"]},
        "period": {"key": period, "start": start.isoformat(), "end": end.isoformat()},
        "total": total,
        "previous_total": previous_total,
        "change_percent": round(100 * (total - previous_total) / previous_total, 1) if previous_total else None,
        "purchase_count": len(current),
        "available_balance": round(sum(a["balance"] for a in ledger["accounts"] if a["type"] != "Credit Card"), 2),
        "goal_savings": _goal_savings_total(user["id"]),
        "top_category": categories[0] if categories else None,
        "categories": categories,
        "daily": _daily_buckets(current, start, end),
        "transactions": [
            {**p, "date": p["date"].isoformat()} for p in recent
        ],
    }
    # Start Gemini on these numbers now, in the background, so Insights is ready sooner.
    if current:
        gemini.prewarm(_insight_summary(result))
    return result


def _insight_summary(d: dict) -> dict:
    """The small, exact summary Gemini sees. No IDs, names of accounts or raw transaction lists."""
    points = d["daily"]["points"]
    peak = max(points, key=lambda p: p["amount"], default=None)
    return {
        "first_name": d["customer"]["first_name"],
        "period": d["period"],
        "total_spending": d["total"],
        "previous_period_spending": d["previous_total"],
        "change_vs_previous_pct": d["change_percent"],
        "purchase_count": d["purchase_count"],
        "available_balance": d["available_balance"],
        "saved_into_group_goals": d["goal_savings"],
        "spending_by_category": [
            {"category": c["name"], "amount": c["amount"], "purchases": c["count"], "pct_of_spending": c["percent"]}
            for c in d["categories"]
        ],
        "biggest_spending_" + d["daily"]["unit"]: {"start": peak["date"], "amount": peak["amount"]} if peak and peak["amount"] else None,
    }


@app.get("/api/me/insights")
def insights(period: str = "this_month", user: dict = Depends(bank.require_bank_link)):
    """Gemini's plain-English read of the dashboard numbers for this period."""
    if not gemini.available():
        return {"available": False, "reason": "Add GEMINI_API_KEY to .env to turn on AI insights."}
    d = dashboard(period, user)
    if not d["purchase_count"]:
        return {"available": False, "reason": "No purchases in this period yet."}
    result = gemini.explain(_insight_summary(d))
    if result is None:
        return {"available": False, "reason": "Couldn't reach Gemini right now. Try again in a minute."}
    return {"available": True, "insights": result}


if __name__ == "__main__":
    import uvicorn

    if auth.DEV_MODE:
        print("Demo login shortcut is ON (set FINAPP_DEV=0 to turn it off).")
    # Railway sets PORT and needs 0.0.0.0; locally this is still http://localhost:8000.
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
