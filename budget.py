"""Weekly budgets, points and the friends leaderboard, plus Gemini help to build a budget.

The Budget tab (frontend/src/Budget.tsx) has three parts:
  My budget    a weekly limit per spending category, live progress, Gemini tips
  Leaderboard  you + your friends, ranked by this week's points (percentages only)
  Learn        short lessons with quizzes and an Ask box (learn.py)

Endpoints
  GET  /api/budget                    your budget, this week's spending vs it, points
  PUT  /api/budget                    save it {style, savings_goal, share_goals, categories:[{category, limit}]}
  POST /api/budget/coach              guided Gemini chat that proposes a budget (fills the form)
  GET  /api/budget/insights           high-spending categories + Gemini savings tips
  GET  /api/budget/leaderboard        this week's points for you and your friends
  PUT  /api/budget/sharing            {share_goals}: show your goal progress to friends or not
  POST /api/budget/cheer/{friend_id}  send a friend a cheer (shows in their bell)

Weeks run Monday to Sunday. Points for a week (POINTS below):
  +10 for each budgeted category you stay under, +5 more if you used 75% or less
   -5 for each category you go over
  +20 for staying under your whole budget, plus +5 per week of your streak (up to +25)
  +10 per lesson quiz passed (up to 3 a week, learn.py)
   +5 per contribution to a group goal (up to 4 a week)
A week never goes below 0. The current week updates live, so points can still drop
if you overspend before Sunday. Finished weeks are saved in budget_weeks.

Privacy: friends only ever see points, streaks and percentages (how much of the
budget is used, how far along each goal is). Never dollar amounts or purchases.
"""
from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import banking
import db
import gemini
import nessie
from auth import current_user
from friends import friend_ids

router = APIRouter(prefix="/api")

DEFAULT_CATEGORIES = ["Dining", "Groceries", "Shopping", "Transport", "Other"]
# Dollars per week, a sensible student starting point when there's no spending history yet.
STARTER_LIMITS = {"Dining": 60, "Groceries": 70, "Shopping": 40, "Transport": 30, "Other": 25}
HISTORY_WEEKS = 8          # weeks of history used for "you usually spend"
SCORED_WEEKS_MAX = 12      # how far back finished weeks are scored
POINTS = {"under": 10, "way_under": 5, "over": -5, "under_total": 20, "streak_each": 5, "streak_max": 5,
          "lesson": 10, "lessons_max": 3, "goal_save": 5, "goal_saves_max": 4}
STYLE_FACTOR = {"strict": 0.8, "balanced": 0.9, "relaxed": 1.0}
COACH_BUDGET_SECONDS = 15
INSIGHT_BUDGET_SECONDS = 14

_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="budget")


def init_tables():
    with db.connect() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS budget_settings (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            style TEXT NOT NULL DEFAULT 'balanced',
            savings_goal_cents INTEGER NOT NULL DEFAULT 0,
            share_goals INTEGER NOT NULL DEFAULT 1,
            summary TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        -- The current weekly limit per category.
        CREATE TABLE IF NOT EXISTS budgets (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            category TEXT NOT NULL, weekly_cents INTEGER NOT NULL,
            PRIMARY KEY (user_id, category)
        );
        -- Which limits were in force each week (the last save of a week wins), so old weeks keep their score.
        CREATE TABLE IF NOT EXISTS budget_versions (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            week_start TEXT NOT NULL, categories_json TEXT NOT NULL,
            PRIMARY KEY (user_id, week_start)
        );
        -- Final results of finished weeks.
        CREATE TABLE IF NOT EXISTS budget_weeks (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            week_start TEXT NOT NULL, points INTEGER NOT NULL, under_total INTEGER NOT NULL,
            detail_json TEXT NOT NULL, computed_at TEXT NOT NULL,
            PRIMARY KEY (user_id, week_start)
        );
        CREATE TABLE IF NOT EXISTS budget_cheers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            week_start TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE (from_id, to_id, week_start)
        );
        -- Lessons (learn.py): quiz results, and each user's generated lesson for the week.
        CREATE TABLE IF NOT EXISTS lesson_progress (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            lesson_key TEXT NOT NULL, week_start TEXT NOT NULL,
            score INTEGER NOT NULL, passed INTEGER NOT NULL, points INTEGER NOT NULL, completed_at TEXT NOT NULL,
            PRIMARY KEY (user_id, lesson_key, week_start)
        );
        CREATE TABLE IF NOT EXISTS lesson_cache (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            lesson_key TEXT NOT NULL, week_start TEXT NOT NULL,
            content_json TEXT NOT NULL, source TEXT NOT NULL,
            PRIMARY KEY (user_id, lesson_key, week_start)
        );
        """)


init_tables()


# ---------- Weeks and spending ----------

def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _cents(dollars: float) -> int:
    return int(round(float(dollars) * 100))


def bank_customer(conn, user_id: int) -> str | None:
    row = conn.execute("SELECT nessie_customer_id FROM bank_links WHERE user_id = ?", (user_id,)).fetchone()
    return row["nessie_customer_id"] if row else None


def ledger_for(user_id: int) -> dict | None:
    """The user's bank ledger (cached by banking.py for a few seconds), or None."""
    with db.connect() as conn:
        customer = bank_customer(conn, user_id)
    if not customer:
        return None
    try:
        return banking.customer_ledger(customer)
    except nessie.NessieError:
        return None


def purchases(ledger: dict | None) -> list[dict]:
    if not ledger:
        return []
    return [{"date": l["date"], "cents": _cents(-l["amount"]), "category": l["category"] or "Other",
             "merchant": l.get("merchant") or "Unknown merchant"}
            for l in ledger["lines"] if l["type"] == "Purchase"]


def spent_by_category(items: list[dict], start: date, end: date) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for p in items:
        if start <= p["date"] <= end:
            out[p["category"]] += p["cents"]
    return dict(out)


def spending_stats(items: list[dict], today: date) -> dict:
    """What Gemini and the budget form see: usual weekly spending per category, this week,
    last week, and the merchants you visit most. Only the user's own numbers."""
    this_week = week_start(today)
    weeks = [this_week - timedelta(weeks=i) for i in range(1, HISTORY_WEEKS + 1)]
    first = min((p["date"] for p in items), default=None)
    counted = [w for w in weeks if first and w + timedelta(days=6) >= first]
    by = defaultdict(int)
    for p in items:
        by[(week_start(p["date"]), p["category"])] += p["cents"]
    cats = list(DEFAULT_CATEGORIES) + sorted({p["category"] for p in items} - set(DEFAULT_CATEGORIES))
    per = {}
    for c in cats:
        avg = sum(by[(w, c)] for w in counted) / len(counted) if counted else 0
        per[c] = {"avg_weekly": round(avg / 100, 2), "last_week": by[(weeks[0], c)] / 100, "this_week": by[(this_week, c)] / 100}
    since = this_week - timedelta(weeks=4)
    merchants: dict = defaultdict(lambda: {"cents": 0, "visits": 0, "category": "Other"})
    for p in items:
        if p["date"] >= since:
            m = merchants[p["merchant"]]
            m["cents"] += p["cents"]
            m["visits"] += 1
            m["category"] = p["category"]
    top = sorted(merchants.items(), key=lambda kv: -kv[1]["cents"])[:6]
    total_avg = sum(v["avg_weekly"] for v in per.values())
    return {
        "weeks_of_history": len(counted),
        "categories": per,
        "usual_weekly_total": round(total_avg, 2),
        "this_week_total": round(sum(v["this_week"] for v in per.values()), 2),
        "top_merchants_last_4_weeks": [{"merchant": k, "category": v["category"], "visits": v["visits"], "amount": v["cents"] / 100} for k, v in top],
    }


# ---------- Budgets ----------

def current_limits(conn, user_id: int) -> dict[str, int]:
    return {r["category"]: r["weekly_cents"] for r in conn.execute(
        "SELECT category, weekly_cents FROM budgets WHERE user_id = ? ORDER BY weekly_cents DESC", (user_id,))}


def limits_for_week(conn, user_id: int, ws: date) -> dict[str, int] | None:
    row = conn.execute("SELECT categories_json FROM budget_versions WHERE user_id = ? AND week_start <= ? "
                       "ORDER BY week_start DESC LIMIT 1", (user_id, ws.isoformat())).fetchone()
    return json.loads(row["categories_json"]) if row else None


def settings_for(conn, user_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM budget_settings WHERE user_id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def save_budget(user_id: int, limits: dict[str, int], style: str, savings_goal_cents: int, share_goals: bool,
                summary: str = "", effective_from: date | None = None):
    ws = (effective_from or week_start(date.today())).isoformat()
    now = db.now()
    with db.connect() as conn:
        conn.execute("DELETE FROM budgets WHERE user_id = ?", (user_id,))
        for c, cents in limits.items():
            conn.execute("INSERT INTO budgets (user_id, category, weekly_cents) VALUES (?, ?, ?)", (user_id, c, cents))
        conn.execute("INSERT INTO budget_versions (user_id, week_start, categories_json) VALUES (?, ?, ?) "
                     "ON CONFLICT (user_id, week_start) DO UPDATE SET categories_json = excluded.categories_json",
                     (user_id, ws, json.dumps(limits)))
        conn.execute("INSERT INTO budget_settings (user_id, style, savings_goal_cents, share_goals, summary, created_at, updated_at) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET style = excluded.style, "
                     "savings_goal_cents = excluded.savings_goal_cents, share_goals = excluded.share_goals, "
                     "summary = excluded.summary, updated_at = excluded.updated_at",
                     (user_id, style, savings_goal_cents, int(share_goals), summary[:400], now, now))
        # This week's saved result (if any) is recomputed live; finished weeks keep theirs.
        conn.execute("DELETE FROM budget_weeks WHERE user_id = ? AND week_start >= ?", (user_id, ws))


def round5(dollars: float) -> int:
    """Round to a friendly number: nearest $5 (at least $5)."""
    return max(5, int(5 * round(dollars / 5)))


def suggested_limits(stats: dict, categories: list[str], style: str, savings_goal: float) -> dict[str, int]:
    """A budget from your own history: your usual weekly spending, trimmed by the style,
    then trimmed more if needed to free up the weekly savings goal. Groceries are cut
    the least; nothing goes below half of what you usually spend. Returns dollars."""
    factor = STYLE_FACTOR.get(style, 0.9)
    base = {c: (stats["categories"].get(c, {}).get("avg_weekly") or 0) or STARTER_LIMITS.get(c, 25) for c in categories}
    limits = {c: v * (min(1.0, factor + 0.1) if c == "Groceries" else factor) for c, v in base.items()}
    usual = sum(base.values())
    if savings_goal > 0 and usual > 0:
        room = usual - savings_goal
        total = sum(limits.values())
        if total > room:
            cuttable = {c: limits[c] - base[c] * (0.7 if c == "Groceries" else 0.5) for c in limits}
            need, pool = total - room, sum(max(0, v) for v in cuttable.values())
            if pool > 0:
                for c in limits:
                    limits[c] -= min(max(0, cuttable[c]), need * max(0, cuttable[c]) / pool)
    return {c: round5(v) for c, v in limits.items()}


def budget_math(limits_dollars: dict[str, float], stats: dict) -> dict:
    """How much this budget frees up compared with what you usually spend."""
    usual = sum(stats["categories"].get(c, {}).get("avg_weekly", 0) for c in limits_dollars)
    total = sum(limits_dollars.values())
    has_history = stats["weeks_of_history"] > 0
    weekly = round(usual - total, 2) if has_history else None
    return {
        "weekly_total": round(total, 2),
        "usual_weekly": round(usual, 2) if has_history else None,
        "weekly_savings": weekly,
        "monthly_savings": round(weekly * 52 / 12, 2) if weekly is not None else None,
        "yearly_savings": round(weekly * 52, 2) if weekly is not None else None,
    }


# ---------- Points ----------

def _lessons_passed(conn, user_id: int, ws: date) -> int:
    return conn.execute("SELECT COUNT(*) AS n FROM lesson_progress WHERE user_id = ? AND week_start = ? AND passed = 1",
                        (user_id, ws.isoformat())).fetchone()["n"]


def _goal_saves(conn, user_id: int, ws: date) -> int:
    return conn.execute("SELECT COUNT(*) AS n FROM contributions WHERE user_id = ? AND substr(created_at, 1, 10) BETWEEN ? AND ?",
                        (user_id, ws.isoformat(), (ws + timedelta(days=6)).isoformat())).fetchone()["n"]


def score_week(limits: dict[str, int] | None, spent: dict[str, int], lessons: int, goal_saves: int, streak_before: int) -> dict:
    """Points for one week. limits/spent are in cents. Returns points, breakdown and per-category status."""
    items, cats = [], []
    limits = {c: v for c, v in (limits or {}).items() if v > 0}
    for c, cents in limits.items():
        s = spent.get(c, 0)
        used = s / cents
        if s <= cents:
            pts = POINTS["under"] + (POINTS["way_under"] if used <= 0.75 else 0)
            items.append({"label": f"{'Way under' if used <= 0.75 else 'Under'} your {c} budget", "points": pts})
            status = "under" if used < 0.9 else "near"
        else:
            pts = POINTS["over"]
            items.append({"label": f"Over your {c} budget", "points": pts})
            status = "over"
        cats.append({"category": c, "status": status, "used_pct": round(100 * used), "points": pts})
    total_limit = sum(limits.values())
    total_spent = sum(spent.get(c, 0) for c in limits)
    under_total = bool(limits) and total_spent <= total_limit
    if under_total:
        items.append({"label": "Under your whole budget", "points": POINTS["under_total"]})
        if streak_before:
            weeks = min(streak_before, POINTS["streak_max"])
            items.append({"label": f"{streak_before}-week streak bonus", "points": POINTS["streak_each"] * weeks})
    if lessons:
        n = min(lessons, POINTS["lessons_max"])
        items.append({"label": f"{n} lesson{'s' if n > 1 else ''} passed", "points": POINTS["lesson"] * n})
    if goal_saves:
        n = min(goal_saves, POINTS["goal_saves_max"])
        items.append({"label": f"Saved toward a goal {n}×", "points": POINTS["goal_save"] * n})
    return {
        "points": max(0, sum(i["points"] for i in items)),
        "breakdown": items,
        "categories": cats,
        "under_total": under_total,
        "budget_used_pct": round(100 * total_spent / total_limit) if total_limit else None,
        "on_track": sum(1 for c in cats if c["status"] != "over"),
        "budgeted": len(cats),
        "lessons": lessons,
        "goal_saves": goal_saves,
    }


def user_points(user_id: int, ledger: dict | None, today: date | None = None) -> dict:
    """This week's live score, plus finished weeks (scored once, then saved)."""
    today = today or date.today()
    this_ws = week_start(today)
    items = purchases(ledger)
    with db.connect() as conn:
        first = conn.execute("SELECT MIN(week_start) AS w FROM budget_versions WHERE user_id = ?", (user_id,)).fetchone()["w"]
        saved = {r["week_start"]: dict(r) for r in conn.execute("SELECT * FROM budget_weeks WHERE user_id = ?", (user_id,))}
        weeks = []
        if first:
            ws = max(date.fromisoformat(first), this_ws - timedelta(weeks=SCORED_WEEKS_MAX))
            while ws < this_ws:
                weeks.append(ws)
                ws += timedelta(weeks=1)
        streak = 0
        history = []
        for ws in weeks:
            row = saved.get(ws.isoformat())
            if row is None:
                if ledger is None:   # bank unreachable: can't score this week yet
                    continue
                result = score_week(limits_for_week(conn, user_id, ws), spent_by_category(items, ws, ws + timedelta(days=6)),
                                    _lessons_passed(conn, user_id, ws), _goal_saves(conn, user_id, ws), streak)
                conn.execute("INSERT OR REPLACE INTO budget_weeks (user_id, week_start, points, under_total, detail_json, computed_at) "
                             "VALUES (?, ?, ?, ?, ?, ?)", (user_id, ws.isoformat(), result["points"], int(result["under_total"]),
                                                          json.dumps(result), db.now()))
                row = {"points": result["points"], "under_total": int(result["under_total"])}
            streak = streak + 1 if row["under_total"] else 0
            history.append({"week_start": ws.isoformat(), "points": row["points"], "under_total": bool(row["under_total"])})
        limits = current_limits(conn, user_id) if first else None
        now = score_week(limits, spent_by_category(items, this_ws, today), _lessons_passed(conn, user_id, this_ws),
                         _goal_saves(conn, user_id, this_ws), streak)
    last = history[-1]["points"] if history and history[-1]["week_start"] == (this_ws - timedelta(weeks=1)).isoformat() else 0
    return {
        "this_week": now,
        "last_week_points": last,
        "total_points": sum(h["points"] for h in history) + now["points"],
        "streak": streak,
        "history": history[-6:],
    }


# ---------- Demo personas get a budget automatically ----------

DEMO_FACTORS = {"maya": 1.1, "carlos": 0.85, "priya": 0.97}


def ensure_demo_budget(user_id: int, ledger: dict | None):
    """Maya, Carlos and Priya get a budget built from their own history (started 4 weeks
    ago), so the leaderboard has real streaks and history in a demo."""
    with db.connect() as conn:
        row = conn.execute("SELECT username, is_demo FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row or not row["is_demo"] or settings_for(conn, user_id):
            return
    if ledger is None:
        return
    stats = spending_stats(purchases(ledger), date.today())
    factor = DEMO_FACTORS.get(row["username"], 1.0)
    limits = {c: round5((v["avg_weekly"] or STARTER_LIMITS.get(c, 25)) * factor) * 100
              for c, v in stats["categories"].items() if c in DEFAULT_CATEGORIES}
    save_budget(user_id, limits, "balanced", 2000, True, "Demo budget, built from this persona's spending.",
                effective_from=week_start(date.today()) - timedelta(weeks=4))


# ---------- My budget ----------

class LineIn(BaseModel):
    category: str
    limit: float


class BudgetIn(BaseModel):
    style: Literal["strict", "balanced", "relaxed"] = "balanced"
    savings_goal: float = 0
    share_goals: bool = True
    summary: str = ""
    categories: list[LineIn]


def _clean_category(name: str, known: list[str]) -> str | None:
    n = (name or "").strip().lower()
    for k in known:
        if k.lower() == n or k.lower().rstrip("s") == n.rstrip("s"):
            return k
    return None


@router.get("/budget")
def my_budget(user: dict = Depends(current_user)):
    ledger = ledger_for(user["id"]) if user["bank_link"] else None
    ensure_demo_budget(user["id"], ledger)
    today = date.today()
    ws = week_start(today)
    stats = spending_stats(purchases(ledger), today)
    with db.connect() as conn:
        limits = current_limits(conn, user["id"])
        settings = settings_for(conn, user["id"])
    points = user_points(user["id"], ledger, today)
    status_by_cat = {c["category"]: c for c in points["this_week"]["categories"]}
    rows = []
    for c, v in stats["categories"].items():
        limit = limits.get(c)
        spent = v["this_week"]
        rows.append({
            "category": c, "limit": limit / 100 if limit is not None else None, "spent": spent,
            "used_pct": round(100 * spent * 100 / limit) if limit else None,
            "status": status_by_cat.get(c, {}).get("status") if limit else None,
            "avg_weekly": v["avg_weekly"], "last_week": v["last_week"],
        })
    rows.sort(key=lambda r: (r["limit"] is None, -(r["limit"] or 0), -r["avg_weekly"]))
    total_limit = sum(limits.values()) / 100
    total_spent = sum(r["spent"] for r in rows if r["limit"] is not None)
    limits_dollars = {c: v / 100 for c, v in limits.items()}
    return {
        "linked": bool(user["bank_link"]),
        "bank_ok": ledger is not None or not user["bank_link"],
        "has_budget": bool(limits),
        "week": {"start": ws.isoformat(), "end": (ws + timedelta(days=6)).isoformat(), "days_left": 6 - today.weekday()},
        "settings": {
            "style": settings["style"] if settings else "balanced",
            "savings_goal": (settings["savings_goal_cents"] / 100) if settings else 0,
            "share_goals": bool(settings["share_goals"]) if settings else True,
            "summary": settings["summary"] if settings else "",
        },
        "categories": rows,
        "totals": {"limit": total_limit, "spent": round(total_spent, 2), "left": round(total_limit - total_spent, 2),
                   "used_pct": round(100 * total_spent / total_limit) if total_limit else None},
        "math": budget_math(limits_dollars, stats) if limits else None,
        "suggested": suggested_limits(stats, [c for c in stats["categories"] if c in DEFAULT_CATEGORIES or stats["categories"][c]["avg_weekly"]],
                                      "balanced", 0),
        "usual_weekly_total": stats["usual_weekly_total"],
        "weeks_of_history": stats["weeks_of_history"],
        "points": points,
        "rules": POINTS,
    }


@router.put("/budget")
def set_budget(body: BudgetIn, user: dict = Depends(current_user)):
    known = list(DEFAULT_CATEGORIES)
    ledger = ledger_for(user["id"]) if user["bank_link"] else None
    known += [c for c in {p["category"] for p in purchases(ledger)} if c not in known]
    limits: dict[str, int] = {}
    for line in body.categories:
        c = _clean_category(line.category, known)
        if c is None:
            raise HTTPException(400, f"Unknown category: {line.category}")
        if line.limit < 0 or line.limit > 10000:
            raise HTTPException(400, f"Pick a weekly limit between $0 and $10,000 for {c}")
        if line.limit > 0:
            limits[c] = _cents(line.limit)
    if not limits:
        raise HTTPException(400, "Give at least one category a weekly limit")
    if body.savings_goal < 0 or body.savings_goal > 10000:
        raise HTTPException(400, "The weekly savings goal should be between $0 and $10,000")
    save_budget(user["id"], limits, body.style, _cents(body.savings_goal), body.share_goals, body.summary)
    return {"ok": True}


# ---------- Gemini: budget coach (guided chat that fills the form) ----------

COACH_SYSTEM = """You are the budget coach inside Gatorstar, a student banking app.
You help ONE user build a WEEKLY budget (a weekly spending limit per category) through a short guided chat.

How to talk:
- Ask exactly ONE question per turn. 1-3 short, friendly sentences. Plain English.
- Offer 2-4 tap-to-answer chips that are complete answers.
- Cover, in this order, skipping anything already answered:
  1. what they want from a budget (save for something, cut spending, just keep track),
  2. how strict (strict, balanced, relaxed),
  3. which categories to budget (use the categories in their spending; suggest their biggest ones),
  4. how much they'd like to save each week (suggest amounts that fit their spending).
- Use their real numbers: mention a high-spending category or a merchant they visit a lot when it helps
  ("You spent $84 at Bean There Coffee in 4 weeks"). Be encouraging, never judgmental.
- Educational guidance only, not financial advice.

Output rules:
- Always fill `plan` with your best current guess. Categories must be from the user's category list.
  weekly_limit is whole dollars per week. Base limits on their usual weekly spending: strict trims
  about 20%, balanced about 10%, relaxed keeps it about the same, and the total should leave room
  for their weekly savings goal. Never go below half of what they usually spend in a category.
- Each category needs a one-sentence `reason` that mentions their usual spending.
- Set ready=true once you know the style, the categories and the savings goal. Then make `reply`
  a short recap asking them to review it, with chips like "Use this budget" / "Make it stricter" / "Make it more relaxed".
"""


class PlanLine(BaseModel):
    category: str
    weekly_limit: float
    reason: str


class BudgetPlan(BaseModel):
    purpose: str
    style: Literal["strict", "balanced", "relaxed"]
    weekly_savings_goal: float
    categories: list[PlanLine]
    summary: str


class BudgetTurn(BaseModel):
    reply: str
    chips: list[str]
    ready: bool
    plan: BudgetPlan


class ChatMessage(BaseModel):
    role: Literal["user", "coach"]
    text: str


class CoachIn(BaseModel):
    messages: list[ChatMessage] = []


def _find_money(text: str) -> float | None:
    m = re.search(r"\$?\s*(\d[\d,]*(?:\.\d+)?)", text)
    return float(m.group(1).replace(",", "")) if m else None


def _find_style(text: str) -> str | None:
    t = text.lower()
    for word, style in (("strict", "strict"), ("tight", "strict"), ("aggressive", "strict"), ("relax", "relaxed"),
                        ("loose", "relaxed"), ("easy", "relaxed"), ("balanced", "balanced"), ("middle", "balanced"),
                        ("medium", "balanced"), ("moderate", "balanced")):
        if word in t:
            return style
    return None


def _find_categories(text: str, available: list[str]) -> list[str] | None:
    t = text.lower()
    named = [c for c in available if c.lower().rstrip("s") in t]
    if re.search(r"\b(all|every|everything)\b", t):
        if "but" in t or "except" in t:
            return [c for c in available if c not in named] or available
        return available
    return named or None


def backup_coach(messages: list[ChatMessage], stats: dict) -> dict:
    """Gatorstar's quick planner, used when Gemini is slow or off. Same questions, same plan shape."""
    said = [m.text.strip() for m in messages if m.role == "user" and m.text.strip()]
    spending = sorted(stats["categories"].items(), key=lambda kv: -kv[1]["avg_weekly"])
    available = [c for c, v in spending if v["avg_weekly"] > 0] or list(DEFAULT_CATEGORIES)
    # The latest style wins, so "Make it stricter" after the plan changes it.
    style = next((s for s in (_find_style(t) for t in reversed(said[1:])) if s), None)
    cats = next((c for c in (_find_categories(t, available) for t in said[2:]) if c), None)
    savings = None
    for t in said[3:]:
        if re.search(r"\b(nothing|none|no goal|skip|0)\b", t.lower()):
            savings = 0.0
            break
        if (v := _find_money(t)) is not None:
            savings = v
            break
    usual = stats["usual_weekly_total"]
    last = said[-1].lower() if said else ""
    if savings is not None and len(said) > 4:   # tweaking a finished plan
        if "strict" in last:
            savings += 10
        elif "relax" in last:
            savings = max(0, savings - 10)
    plan = {"purpose": (said[0] if said else "")[:80], "style": style or "balanced", "weekly_savings_goal": savings or 0,
            "categories": [], "summary": ""}
    turn = {"ready": False, "plan": plan, "chips": []}
    if not said:
        turn["reply"] = "What do you want your budget to do for you?"
        turn["chips"] = ["Save for something", "Cut my spending", "Just keep track"]
    elif style is None:
        biggest = spending[0] if spending and spending[0][1]["avg_weekly"] else None
        hint = f" Your biggest category is {biggest[0]} at about ${biggest[1]['avg_weekly']:,.0f} a week." if biggest else ""
        turn["reply"] = f"Got it.{hint} How strict should the budget be?"
        turn["chips"] = ["Strict", "Balanced", "Relaxed"]
    elif cats is None:
        top = available[:2]
        turn["reply"] = "Which categories should we budget?"
        turn["chips"] = ["All of them", " + ".join(top) if len(top) == 2 else available[0], "Everything but groceries"]
    elif savings is None:
        steps = [round5(usual * f) for f in (0.1, 0.2, 0.3)] if usual else [10, 25, 50]
        turn["reply"] = "How much would you like to save each week?"
        turn["chips"] = [f"${s} a week" for s in dict.fromkeys(steps)] + ["Nothing set"]
    else:
        limits = suggested_limits(stats, cats, plan["style"], savings)
        plan["categories"] = [{"category": c, "weekly_limit": v,
                               "reason": (f"You usually spend about ${stats['categories'][c]['avg_weekly']:,.0f} a week here."
                                          if stats["categories"].get(c, {}).get("avg_weekly") else "A starter amount; adjust it as you learn your spending.")}
                              for c, v in limits.items()]
        plan["summary"] = f"A {plan['style']} weekly budget of ${sum(limits.values()):,} across {len(limits)} categories."
        turn["ready"] = True
        turn["reply"] = "Here's a weekly budget from your answers and your spending. Review it, then use it to fill in the form."
        turn["chips"] = ["Use this budget", "Make it stricter", "Make it more relaxed"]
    return turn


def _transcript(messages: list[ChatMessage]) -> str:
    if not messages:
        return "(The user just opened the coach. Greet them in one short sentence and ask your first question.)"
    return "\n".join(f"{'User' if m.role == 'user' else 'Coach'}: {m.text.strip()[:500]}" for m in messages[-24:])


def _clean_plan(plan: dict, stats: dict) -> dict:
    known = list(stats["categories"])
    lines, seen = [], set()
    for line in plan.get("categories") or []:
        c = _clean_category(line.get("category", ""), known)
        if c is None or c in seen:
            continue
        seen.add(c)
        limit = max(0, min(10000, round(float(line.get("weekly_limit") or 0))))
        usual = stats["categories"].get(c, {}).get("avg_weekly") or 0
        if usual and limit < usual * 0.5:   # keep it humane: never below half of the usual spending
            limit = round5(usual * 0.5)
        lines.append({"category": c, "weekly_limit": limit, "reason": (line.get("reason") or "")[:200]})
    plan["categories"] = lines
    plan["weekly_savings_goal"] = max(0, min(10000, round(float(plan.get("weekly_savings_goal") or 0))))
    return plan


@router.post("/budget/coach")
def budget_coach(body: CoachIn, user: dict = Depends(current_user)):
    from goal_coach import money_picture
    ledger = ledger_for(user["id"]) if user["bank_link"] else None
    stats = spending_stats(purchases(ledger), date.today())
    with db.connect() as conn:
        limits = current_limits(conn, user["id"])
    context = {
        "today": date.today().isoformat(),
        "user_first_name": user["display_name"].split(" ")[0],
        "spending_per_week": stats,
        "user_category_list": list(stats["categories"]),
        "current_budget_per_week": {c: v / 100 for c, v in limits.items()} or "none yet",
        "money_picture": money_picture(user) or "No bank linked; use starter amounts and say so.",
    }
    prompt = f"Context (JSON):\n{json.dumps(context, default=str)}\n\nConversation so far:\n{_transcript(body.messages)}\n\nYour next turn:"
    source = "gemini"
    try:
        if not gemini.available():
            raise RuntimeError("no GEMINI_API_KEY")
        turn = gemini.generate_json_within(COACH_BUDGET_SECONDS, COACH_SYSTEM, prompt, BudgetTurn, tier="coach")
    except Exception as e:
        print(f"Budget coach used its backup ({e.__class__.__name__}: {str(e)[:120]})")
        turn, source = backup_coach(body.messages, stats), "backup"
    plan = _clean_plan(turn["plan"], stats)
    if turn["ready"] and not plan["categories"]:
        turn["ready"] = False
        turn["reply"] = "Which categories should the budget cover?"
        turn["chips"] = ["All of them", "Dining + Shopping", "Everything but groceries"]
    math = budget_math({l["category"]: l["weekly_limit"] for l in plan["categories"]}, stats) if turn["ready"] else None
    return {"available": True, "reply": turn["reply"], "chips": turn["chips"][:4], "ready": turn["ready"],
            "plan": plan, "math": math, "source": source}


# ---------- Gemini: high-spending categories and savings tips ----------

TIPS_SYSTEM = """You are Gatorstar's budgeting assistant for students. From ONE user's weekly spending numbers,
write a short, encouraging read of where their money goes and how to save.
- headline: one sentence about their spending pattern, with a real number.
- highlights: for 2-3 of the highest-spending categories, one sentence each that uses their numbers
  (usual weekly spend, this week so far, a merchant they visit often).
- tips: 3 concrete, realistic ways to save, each tied to one category, with a weekly_savings estimate in
  whole dollars that is modest and believable (at most 40% of that category's usual weekly spend), and
  suggested_limit = a new weekly limit in whole dollars for that category if they take the tip.
Never judge. No investment advice. Only use categories from the data."""


class Highlight(BaseModel):
    category: str
    message: str


class Tip(BaseModel):
    title: str
    detail: str
    category: str
    weekly_savings: float
    suggested_limit: float


class BudgetInsights(BaseModel):
    headline: str
    highlights: list[Highlight]
    tips: list[Tip]


FALLBACK_TIPS = {
    "Dining": ("Cook two more meals at home", "Swap two takeout meals or coffee runs a week for something you make.", 0.25),
    "Groceries": ("Shop with a list", "Plan the week's meals before you go and stick to the list.", 0.1),
    "Shopping": ("Try the 24-hour rule", "Wait a day before buying anything that isn't a need. Most urges pass.", 0.3),
    "Transport": ("Bundle your trips", "Combine errands, or take transit or a bike for short trips.", 0.15),
    "Other": ("Check the extras", "Look for subscriptions and small extras you've stopped using.", 0.15),
}
_insight_cache: dict = {}


def _high_categories(stats: dict, limits: dict[str, int]) -> list[dict]:
    total = stats["usual_weekly_total"] or 0
    rows = []
    for c, v in stats["categories"].items():
        if not v["avg_weekly"] and not v["this_week"]:
            continue
        limit = limits.get(c)
        rows.append({"category": c, "avg_weekly": v["avg_weekly"], "this_week": v["this_week"],
                     "share_pct": round(100 * v["avg_weekly"] / total) if total else 0,
                     "limit": limit / 100 if limit else None,
                     "used_pct": round(100 * v["this_week"] * 100 / limit) if limit else None})
    rows.sort(key=lambda r: -(r["avg_weekly"] or r["this_week"]))
    return rows[:3]


def fallback_insights(stats: dict, high: list[dict]) -> dict:
    tips, highlights = [], []
    merchants = stats["top_merchants_last_4_weeks"]
    for r in high:
        c = r["category"]
        m = next((m for m in merchants if m["category"] == c), None)
        extra = f" {m['merchant']}: {m['visits']} visits, ${m['amount']:,.0f} in the last 4 weeks." if m else ""
        highlights.append({"category": c, "message": f"About ${r['avg_weekly']:,.0f} a week ({r['share_pct']}% of your spending).{extra}"})
        title, detail, share = FALLBACK_TIPS.get(c, FALLBACK_TIPS["Other"])
        save = max(1, round(r["avg_weekly"] * share))
        tips.append({"title": title, "detail": detail, "category": c, "weekly_savings": save,
                     "suggested_limit": round5(max(5, r["avg_weekly"] - save))})
    top = high[0] if high else None
    headline = (f"{top['category']} is your biggest category at about ${top['avg_weekly']:,.0f} a week."
                if top else "Not much spending yet. Set a budget and your tips will appear here.")
    return {"headline": headline, "highlights": highlights, "tips": tips}


@router.get("/budget/insights")
def budget_insights(user: dict = Depends(current_user)):
    ledger = ledger_for(user["id"]) if user["bank_link"] else None
    stats = spending_stats(purchases(ledger), date.today())
    with db.connect() as conn:
        limits = current_limits(conn, user["id"])
    high = _high_categories(stats, limits)
    if not high:
        return {"source": "none", "high_categories": [], **fallback_insights(stats, high)}
    key = (user["id"], json.dumps(stats, sort_keys=True, default=str), json.dumps(limits, sort_keys=True))
    hit = _insight_cache.get(user["id"])
    if hit and hit[0] == key and time.time() - hit[1] < 600:
        return hit[2]
    source = "gemini"
    try:
        if not gemini.available():
            raise RuntimeError("no GEMINI_API_KEY")
        data = {"spending_per_week": stats, "current_weekly_budget": {c: v / 100 for c, v in limits.items()} or "none yet",
                "highest_categories": high}
        result = gemini.generate_json_within(INSIGHT_BUDGET_SECONDS, TIPS_SYSTEM, "Spending data (JSON):\n" + json.dumps(data, default=str),
                                             BudgetInsights, tier="fast")
        known = list(stats["categories"])
        tips = []
        for t in result["tips"][:3]:
            c = _clean_category(t["category"], known)
            if not c:
                continue
            usual = stats["categories"][c]["avg_weekly"] or 0
            save = max(1, min(round(t["weekly_savings"]), round(usual * 0.4) or 1))
            tips.append({**t, "category": c, "weekly_savings": save, "suggested_limit": round5(max(5, t["suggested_limit"] or (usual - save)))})
        result["tips"] = tips or fallback_insights(stats, high)["tips"]
        result["highlights"] = [h for h in result["highlights"] if _clean_category(h["category"], known)][:3]
    except Exception as e:
        print(f"Budget tips used the backup ({e.__class__.__name__}: {str(e)[:120]})")
        result, source = fallback_insights(stats, high), "backup"
    out = {"source": source, "high_categories": high, **result}
    _insight_cache[user["id"]] = (key, time.time(), out)
    return out


# ---------- Leaderboard ----------

def goal_progress_for(conn, user_id: int) -> list[dict]:
    """The group goals a user has committed to, as percentages only."""
    rows = conn.execute(
        "SELECT g.id, g.title, g.target_cents, gr.name AS group_name, c.share_cents, "
        "(SELECT COALESCE(SUM(amount_cents), 0) FROM contributions WHERE goal_id = g.id AND user_id = ?) AS mine, "
        "(SELECT COALESCE(SUM(amount_cents), 0) FROM contributions WHERE goal_id = g.id) AS everyone "
        "FROM goal_commitments c JOIN goals g ON g.id = c.goal_id JOIN groups gr ON gr.id = g.group_id "
        "WHERE c.user_id = ? ORDER BY g.created_at DESC LIMIT 4", (user_id, user_id)).fetchall()
    return [{"title": r["title"], "group": r["group_name"],
             "my_pct": min(100, round(100 * r["mine"] / r["share_cents"])) if r["share_cents"] else 0,
             "group_pct": min(100, round(100 * r["everyone"] / r["target_cents"])) if r["target_cents"] else 0} for r in rows]


def _badges(entry: dict) -> list[str]:
    out = []
    if entry["streak"] >= 2:
        out.append(f"🔥 {entry['streak']}-week streak")
    if entry["lessons"]:
        out.append(f"📚 {entry['lessons']} lesson{'s' if entry['lessons'] > 1 else ''}")
    if entry["goal_saves"]:
        out.append("🎯 Saved toward a goal")
    if entry["budgeted"] and entry["on_track"] == entry["budgeted"]:
        out.append("✅ All on track")
    return out


@router.get("/budget/leaderboard")
def leaderboard(user: dict = Depends(current_user)):
    today = date.today()
    ws = week_start(today)
    with db.connect() as conn:
        ids = [user["id"], *sorted(friend_ids(conn, user["id"]))]
        people = {r["id"]: dict(r) for r in conn.execute(
            f"SELECT id, username, display_name FROM users WHERE id IN ({','.join('?' * len(ids))})", ids)}
        cheers_from_me = {r["to_id"] for r in conn.execute("SELECT to_id FROM budget_cheers WHERE from_id = ? AND week_start = ?",
                                                          (user["id"], ws.isoformat()))}
        cheers_to = defaultdict(int)
        for r in conn.execute(f"SELECT to_id, COUNT(*) AS n FROM budget_cheers WHERE week_start = ? AND to_id IN ({','.join('?' * len(ids))}) "
                              "GROUP BY to_id", (ws.isoformat(), *ids)):
            cheers_to[r["to_id"]] = r["n"]

    def one(uid: int) -> dict:
        ledger = ledger_for(uid)
        ensure_demo_budget(uid, ledger)
        pts = user_points(uid, ledger, today)
        with db.connect() as conn:
            s = settings_for(conn, uid)
            share = s["share_goals"] if s else 1
            goals = goal_progress_for(conn, uid) if share or uid == user["id"] else []
        w = pts["this_week"]
        entry = {
            "user_id": uid, "username": people[uid]["username"], "name": people[uid]["display_name"], "is_me": uid == user["id"],
            "points": w["points"], "last_week_points": pts["last_week_points"], "total_points": pts["total_points"],
            "streak": pts["streak"], "has_budget": w["budgeted"] > 0, "budget_used_pct": w["budget_used_pct"],
            "on_track": w["on_track"], "budgeted": w["budgeted"], "lessons": w["lessons"], "goal_saves": w["goal_saves"],
            "goals": goals, "goals_hidden": not share and uid != user["id"],
            "cheers": cheers_to.get(uid, 0), "cheered_by_me": uid in cheers_from_me,
        }
        entry["badges"] = _badges(entry)
        return entry

    entries = list(_pool.map(one, [i for i in ids if i in people]))
    entries.sort(key=lambda e: (-e["points"], -e["total_points"], e["name"]))
    for i, e in enumerate(entries):
        e["rank"] = i + 1
    return {"week": {"start": ws.isoformat(), "end": (ws + timedelta(days=6)).isoformat(), "days_left": 6 - today.weekday()},
            "entries": entries, "rules": POINTS}


class SharingIn(BaseModel):
    share_goals: bool


@router.put("/budget/sharing")
def set_sharing(body: SharingIn, user: dict = Depends(current_user)):
    """Whether friends see your goal progress (as percentages) on the leaderboard."""
    now = db.now()
    with db.connect() as conn:
        conn.execute("INSERT INTO budget_settings (user_id, share_goals, created_at, updated_at) VALUES (?, ?, ?, ?) "
                     "ON CONFLICT (user_id) DO UPDATE SET share_goals = excluded.share_goals, updated_at = excluded.updated_at",
                     (user["id"], int(body.share_goals), now, now))
    return {"share_goals": body.share_goals}


@router.post("/budget/cheer/{friend_id}")
def cheer(friend_id: int, user: dict = Depends(current_user)):
    """Encourage a friend. One cheer per friend per week; it shows up in their bell."""
    with db.connect() as conn:
        if friend_id not in friend_ids(conn, user["id"]):
            raise HTTPException(404, "You can only cheer on your friends")
        conn.execute("INSERT OR IGNORE INTO budget_cheers (from_id, to_id, week_start, created_at) VALUES (?, ?, ?, ?)",
                     (user["id"], friend_id, week_start(date.today()).isoformat(), db.now()))
    return {"ok": True}
