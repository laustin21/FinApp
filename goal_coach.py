"""Gemini goal coach: a guided chat that helps a group set up a shared savings goal.

POST /api/groups/{group_id}/goal-coach  {messages: [{role: "user"|"coach", text}]}
  -> {available, reply, chips, ready, plan, math}

How it works
------------
- Gemini asks ONE question at a time (what for, how much, by when, how fast, how
  often to pay, what happens when someone misses a payment) and offers 2-4 short
  answer chips. Send an empty `messages` list to start.
- It sees the group's size, today's date, and the CURRENT user's own money picture
  (balance, typical monthly income and spending over the last 90 days). It never
  sees other members' finances.
- When it has enough, it returns ready=true and a plan. Python then does the math
  itself (number of payments, payment per person, monthly equivalent, share of the
  user's spare cash) and keeps the realism score honest. The frontend uses the plan
  to fill in the new-goal form, where the user reviews it and creates the goal.
"""
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import banking
import db
import gemini
import nessie
from auth import current_user
from groups import _require_group_member, due_dates

router = APIRouter(prefix="/api")

MAX_MESSAGES = 24
MAX_TEXT = 500

SYSTEM = """You are the goal coach inside Gatorstar, a student banking app where friend groups save together.
You help ONE user set up a shared savings goal for their group, through a short guided chat.

How to talk:
- Ask exactly ONE question per turn. Keep replies to 1-3 short sentences, friendly, plain English.
- Offer 2-4 tap-to-answer chips that are complete answers (e.g. "$1,500", "By spring break", "Weekly").
- Cover, in roughly this order, skipping anything the user already told you:
  1. what they're saving for, 2. target amount (offer to estimate if unsure),
  3. deadline, 4. how fast / how intense (relaxed, steady, aggressive),
  5. payment frequency (weekly, biweekly, monthly),
  6. what happens when someone misses a payment: a money penalty (a percent of one
     payment added to their total, suggest 5-20%) or an honor-code dare the friend group
     enforces, fantasy-football style (suggest 3 fun, harmless, legal dares), or none.
- Use the user's money picture to judge realism. If the per-person payment looks too big
  for their spare cash, say so kindly and suggest a later deadline or a smaller target.
- Educational guidance only, never investment advice. Never invent facts about other members.

Output rules:
- Always fill `plan` with your best current understanding (blank strings / 0 for unknowns).
- Dates are YYYY-MM-DD and must be after today. Amounts are plain numbers in dollars.
- Set ready=true only when you know the title, target, deadline, frequency and penalty
  choice. Then make `reply` a short recap that asks them to review the plan, chips like
  "Use this plan" / "Make it cheaper" / "Change the penalty", and give an honest
  realism_score (1 = not realistic, 10 = very comfortable) with a one-sentence realism_note.
"""


class CoachPlan(BaseModel):
    title: str
    target_amount: float
    deadline: str
    frequency: Literal["weekly", "biweekly", "monthly", "none"]
    pace: str
    penalty_type: Literal["money", "honor", "none"]
    penalty_percent: float
    penalty_dare: str
    realism_score: int
    realism_note: str
    summary: str


class CoachTurn(BaseModel):
    reply: str
    chips: list[str]
    ready: bool
    plan: CoachPlan


class ChatMessage(BaseModel):
    role: Literal["user", "coach"]
    text: str


class CoachIn(BaseModel):
    messages: list[ChatMessage] = []


# ---------- What the coach knows ----------

def money_picture(user: dict) -> dict | None:
    """The user's own finances, summarized (last 90 days). None without a linked bank."""
    if not user["bank_link"]:
        return None
    try:
        ledger = banking.customer_ledger(user["bank_link"]["nessie_customer_id"])
    except nessie.NessieError:
        return None
    since = date.today() - timedelta(days=90)
    recent = [l for l in ledger["lines"] if l["date"] >= since]
    income = sum(l["amount"] for l in recent if l["type"] == "Deposit")
    spending = -sum(l["amount"] for l in recent if l["type"] in ("Purchase", "Bill", "Withdrawal"))
    balance = sum(a["balance"] for a in ledger["accounts"] if a["type"] != "Credit Card")
    monthly_income, monthly_spending = round(income / 3, 2), round(spending / 3, 2)
    return {
        "available_balance": round(balance, 2),
        "typical_monthly_income": monthly_income,
        "typical_monthly_spending": monthly_spending,
        "typical_monthly_spare_cash": round(monthly_income - monthly_spending, 2),
    }


def _group_facts(group_id: int, user: dict) -> dict:
    with db.connect() as conn:
        _require_group_member(conn, group_id, user["id"])
        name = conn.execute("SELECT name FROM groups WHERE id = ?", (group_id,)).fetchone()["name"]
        members = conn.execute("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?", (group_id,)).fetchone()["n"]
        goals = [r["title"] for r in conn.execute("SELECT title FROM goals WHERE group_id = ?", (group_id,))]
    return {"group_name": name, "members": members, "existing_goals": goals}


# ---------- The math Python owns ----------

PER_MONTH = {"weekly": 52 / 12, "biweekly": 26 / 12, "monthly": 1.0}
REALISM = [(0.25, "Comfortable", 10), (0.5, "Doable", 8), (0.8, "A stretch", 6), (float("inf"), "Not realistic yet", 3)]


def plan_math(plan: dict, members: int, picture: dict | None, today: date) -> dict | None:
    """Exact payment numbers for a plan, plus a realism check against the user's spare cash."""
    try:
        deadline = date.fromisoformat(plan["deadline"])
    except (TypeError, ValueError):
        return None
    if deadline <= today or plan["target_amount"] <= 0:
        return None
    frequency = plan["frequency"] if plan["frequency"] in PER_MONTH else "monthly"
    payments = len(due_dates(today, deadline, frequency))
    share = plan["target_amount"] / max(1, members)
    per_payment = share / payments
    monthly = per_payment * PER_MONTH[frequency]
    out = {
        "members": members,
        "share_per_person": round(share, 2),
        "payments_per_person": payments,
        "payment_per_person": round(per_payment, 2),
        "monthly_per_person": round(monthly, 2),
        "frequency": frequency,
        "weeks_left": round((deadline - today).days / 7, 1),
        "share_of_spare_cash_pct": None,
        "realism_label": None,
        "realism_cap": 10,
    }
    spare = picture["typical_monthly_spare_cash"] if picture else None
    if spare is not None:
        ratio = monthly / spare if spare > 0 else float("inf")
        out["share_of_spare_cash_pct"] = round(100 * ratio) if spare > 0 else None
        for limit, label, cap in REALISM:
            if ratio <= limit:
                out["realism_label"], out["realism_cap"] = label, cap
                break
    return out


def _transcript(messages: list[ChatMessage]) -> str:
    if not messages:
        return "(The user just opened the coach. Greet them in one short sentence and ask your first question.)"
    return "\n".join(f"{'User' if m.role == 'user' else 'Coach'}: {m.text.strip()[:MAX_TEXT]}" for m in messages[-MAX_MESSAGES:])


@router.post("/groups/{group_id}/goal-coach")
def goal_coach(group_id: int, body: CoachIn, user: dict = Depends(current_user)):
    facts = _group_facts(group_id, user)
    if not gemini.available():
        return {"available": False, "reason": "Add GEMINI_API_KEY to turn on the goal coach. You can still fill in the goal yourself."}
    today = date.today()
    picture = money_picture(user)
    context = {
        "today": today.isoformat(),
        "user_first_name": user["display_name"].split(" ")[0],
        **facts,
        "user_money_picture": picture or "No bank linked, so you can't judge affordability. Say so if it matters.",
    }
    prompt = f"Context (JSON):\n{context}\n\nConversation so far:\n{_transcript(body.messages)}\n\nYour next turn:"
    try:
        turn = gemini.generate_json(SYSTEM, prompt, CoachTurn, tier="smart")
    except Exception as e:
        print(f"Goal coach failed: {e}")
        raise HTTPException(502, "The goal coach couldn't reach Gemini. Try again, or fill in the goal yourself.")

    plan = turn["plan"]
    math = plan_math(plan, facts["members"], picture, today) if turn["ready"] else None
    if turn["ready"] and math is None:
        # Gemini thought it was done but the plan isn't usable (e.g. a past deadline): keep asking.
        turn["ready"] = False
        turn["reply"] = "Almost there. What date should this goal be finished by? It needs to be in the future."
        turn["chips"] = [(today + timedelta(days=d)).strftime("%b %d, %Y") for d in (60, 120, 180)]
    if math:
        # Keep the score honest: it can't be rosier than the numbers allow.
        if plan["realism_score"] > math["realism_cap"]:
            plan["realism_score"] = math["realism_cap"]
        plan["realism_score"] = max(1, min(10, int(plan["realism_score"] or math["realism_cap"])))
    return {"available": True, "reply": turn["reply"], "chips": turn["chips"][:4], "ready": turn["ready"], "plan": plan, "math": math}
