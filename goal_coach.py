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
import re
from datetime import date, datetime, timedelta
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


# ---------- Backup coach (no Gemini needed) ----------
# Used when Gemini is slow or unavailable, so the chat never hangs in a demo. It reads
# everything the user has said so far, asks for the first missing piece, and builds
# the same kind of plan once it has them all.

COACH_BUDGET_SECONDS = 15
MONTHS = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*"


def _find_amount(texts: list[str]) -> float | None:
    for t in texts:
        if re.search(MONTHS, t, re.I) and "$" not in t:
            continue  # "Jan 15, 2027" is a date, not money
        m = re.search(r"\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?\b", t, re.I)
        if m and ("$" in t or m.group(2) or len(t.strip()) <= 12):
            value = float(m.group(1).replace(",", "")) * (1000 if m.group(2) else 1)
            if value >= 1:
                return value
    return None


def _find_date(texts: list[str], today: date) -> date | None:
    for t in texts:
        for fmt in ("%b %d, %Y", "%B %d, %Y", "%Y-%m-%d", "%m/%d/%Y"):
            try:
                d = datetime.strptime(t.strip(), fmt).date()
                if d > today:
                    return d
            except ValueError:
                pass
        m = re.search(r"(\d+)\s*(week|month|year)", t, re.I)
        if m and re.search(r"\b(in|within|next|about)\b|^\s*\d", t, re.I):
            n, unit = int(m.group(1)), m.group(2).lower()
            return today + timedelta(days=n * {"week": 7, "month": 30, "year": 365}[unit])
    return None


def _find_frequency(texts: list[str]) -> str | None:
    for t in texts:
        low = t.lower()
        if "2 week" in low or "two week" in low or "biweekly" in low or "bi-weekly" in low:
            return "biweekly"
        if "week" in low:
            return "weekly"
        if "month" in low and not re.search(r"\d+\s*month", low):
            return "monthly"
    return None


def _find_penalty(texts: list[str]) -> tuple[str, float, str] | None:
    for t in texts:
        low = t.lower()
        if "no penalty" in low or low.strip() in ("none", "nothing", "no"):
            return "none", 0, ""
        if "dare" in low or "honor" in low:
            return "honor", 0, "Buy the group's next round of coffee"
        m = re.search(r"(\d+(?:\.\d+)?)\s*%", t)
        if m or "extra" in low or "money" in low:
            return "money", float(m.group(1)) if m else 10.0, ""
    return None


def backup_turn(messages: list[ChatMessage], members: int, picture: dict | None, today: date) -> dict:
    said = [m.text.strip() for m in messages if m.role == "user" and m.text.strip()]
    title = (said[0] if said else "Group goal")[:60]
    later = said[1:]
    amount, deadline = _find_amount(later), _find_date(later, today)
    frequency, penalty = _find_frequency(later), _find_penalty(later)
    plan = {"title": title.capitalize() if title.islower() else title, "target_amount": amount or 0,
            "deadline": deadline.isoformat() if deadline else "", "frequency": frequency or "none", "pace": "Steady",
            "penalty_type": penalty[0] if penalty else "none", "penalty_percent": penalty[1] if penalty else 0,
            "penalty_dare": penalty[2] if penalty else "", "realism_score": 7, "realism_note": "", "summary": ""}
    turn = {"ready": False, "plan": plan, "chips": []}
    if not said:
        turn["reply"], turn["chips"] = "What are you saving for?", ["A group trip", "Concert tickets", "A shared dinner fund"]
    elif amount is None:
        turn["reply"] = f"Nice: {plan['title']}. How much does the whole group need?"
        turn["chips"] = ["$500", "$1,000", "$2,500", "$5,000"]
    elif deadline is None:
        turn["reply"] = f"Got it, ${amount:,.0f}. When should the group hit it?"
        turn["chips"] = [(today + timedelta(days=d)).strftime("%b %d, %Y") for d in (30, 90, 180)]
    elif frequency is None:
        turn["reply"] = "How often should everyone chip in?"
        turn["chips"] = ["Weekly", "Every 2 weeks", "Monthly"]
    elif penalty is None:
        turn["reply"] = "What happens if someone misses a payment?"
        turn["chips"] = ["Pay 10% extra", "Honor-code dare", "No penalty"]
    else:
        turn["ready"] = True
        math = plan_math(plan, members, picture, today) or {}
        per = {"weekly": "week", "biweekly": "2 weeks", "monthly": "month"}[frequency]
        plan["realism_score"] = min(8, math.get("realism_cap", 8))
        plan["realism_note"] = (f"About ${math.get('monthly_per_person', 0):,.0f} a month each"
                                + (f", {math['share_of_spare_cash_pct']}% of your spare cash." if math.get("share_of_spare_cash_pct") is not None else "."))
        plan["summary"] = f"${amount:,.0f} by {deadline:%b %d, %Y}, paid every {per}."
        turn["reply"] = "Here's a plan based on your answers. Review it, then use it to fill in the goal."
        turn["chips"] = ["Use this plan", "Make it cheaper"]
    return turn


def _transcript(messages: list[ChatMessage]) -> str:
    if not messages:
        return "(The user just opened the coach. Greet them in one short sentence and ask your first question.)"
    return "\n".join(f"{'User' if m.role == 'user' else 'Coach'}: {m.text.strip()[:MAX_TEXT]}" for m in messages[-MAX_MESSAGES:])


@router.post("/groups/{group_id}/goal-coach")
def goal_coach(group_id: int, body: CoachIn, user: dict = Depends(current_user)):
    facts = _group_facts(group_id, user)
    today = date.today()
    picture = money_picture(user)
    context = {
        "today": today.isoformat(),
        "user_first_name": user["display_name"].split(" ")[0],
        **facts,
        "user_money_picture": picture or "No bank linked, so you can't judge affordability. Say so if it matters.",
    }
    prompt = f"Context (JSON):\n{context}\n\nConversation so far:\n{_transcript(body.messages)}\n\nYour next turn:"
    source = "gemini"
    try:
        if not gemini.available():
            raise RuntimeError("no GEMINI_API_KEY")
        turn = gemini.generate_json_within(COACH_BUDGET_SECONDS, SYSTEM, prompt, CoachTurn, tier="coach")
    except Exception as e:
        # Too slow or failed: answer with the backup coach so the chat keeps moving.
        print(f"Goal coach used its backup ({e.__class__.__name__}: {str(e)[:120]})")
        turn, source = backup_turn(body.messages, facts["members"], picture, today), "backup"

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
    return {"available": True, "reply": turn["reply"], "chips": turn["chips"][:4], "ready": turn["ready"], "plan": plan, "math": math,
            "source": source}
