"""Social: an activity feed of what you and your friends have been doing, quick reactions,
privacy settings, and the small "your week" summary used by Home and the header.

  GET  /api/social/feed       newest first: savings, goals reached, streaks, lessons, new budgets, cheers
  POST /api/social/react      {item_id, emoji}: toggle a reaction (👏 🔥 💪 🎉); the person gets a notification
  GET  /api/social/settings   {share_goals, share_amounts}
  PUT  /api/social/settings   change them
  GET  /api/me/week           points, streak, budget left, next goal payment, latest friend update

What friends can see (privacy):
  - In a group you're both in, savings show with dollar amounts (the group could already see them).
  - Otherwise a friend's savings show as progress ("now 67% of her share") and milestones,
    unless that friend turned on share_amounts ("Share my savings amounts with friends").
  - Budgets only ever show as points, streaks and "stayed under budget", never dollars.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import budget
import db
import learn
from auth import current_user
from friends import friend_ids
from groups import dollars, member_schedule

router = APIRouter(prefix="/api")

LOOKBACK_DAYS = 30
MAX_ITEMS = 40
REACTIONS = ("👏", "🔥", "💪", "🎉")
MILESTONES = (25, 50, 75, 100)
GROUP_KINDS = {"contribution": "💰", "goal": "🎯", "goal_complete": "🎉", "goal_released": "💸", "join": "👋"}


def init_tables():
    with db.connect() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS feed_reactions (
            item_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            emoji TEXT NOT NULL, actor_id INTEGER, summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
            PRIMARY KEY (item_id, user_id, emoji))""")
        have = {r["name"] for r in conn.execute("PRAGMA table_info(budget_settings)")}
        if "share_amounts" not in have:
            conn.execute("ALTER TABLE budget_settings ADD COLUMN share_amounts INTEGER NOT NULL DEFAULT 0")


init_tables()


def _first(name: str | None) -> str:
    return (name or "Someone").split(" ")[0]


def _short(d: date) -> str:
    return f"{d:%b} {d.day}"


def _iso(d: date) -> str:
    return datetime(d.year, d.month, d.day, 12, tzinfo=timezone.utc).isoformat(timespec="seconds")


def _settings(conn, uid: int) -> dict:
    row = conn.execute("SELECT share_goals, share_amounts FROM budget_settings WHERE user_id = ?", (uid,)).fetchone()
    return {"share_goals": bool(row["share_goals"]) if row else True, "share_amounts": bool(row["share_amounts"]) if row else False}


def build_feed(viewer: dict, refresh_weeks: bool = True) -> list[dict]:
    """Everything recent from you and your friends, newest first."""
    me = viewer["id"]
    since = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).isoformat(timespec="seconds")
    since_day = since[:10]
    with db.connect() as conn:
        friends = friend_ids(conn, me)
    people = {me, *friends}
    if refresh_weeks:
        # Make sure everyone's finished weeks are scored (saved in budget_weeks) so streaks show up.
        list(budget._pool.map(lambda uid: budget.user_points(uid, budget.ledger_for(uid)), people))

    items: list[dict] = []
    with db.connect() as conn:
        q = ",".join("?" * len(people))
        names = {r["id"]: r["display_name"] for r in conn.execute(f"SELECT id, display_name FROM users WHERE id IN ({q})", list(people))}
        name = lambda uid: "You" if uid == me else _first(names.get(uid))  # noqa: E731
        my_groups = {r["group_id"] for r in conn.execute("SELECT group_id FROM group_members WHERE user_id = ?", (me,))}
        settings = {uid: _settings(conn, uid) for uid in people}

        def add(item_id, kind, actor, emoji, text, created_at, detail=""):
            items.append({"id": item_id, "kind": kind, "actor": {"id": actor, "name": names.get(actor, "Gatorstar") if actor else "Gatorstar",
                                                                    "is_me": actor == me},
                          "emoji": emoji, "text": text, "detail": detail, "created_at": created_at})

        # 1. Group activity in groups you're in (amounts are fine: the group already sees them).
        if my_groups:
            gq = ",".join("?" * len(my_groups))
            for r in conn.execute(
                f"SELECT a.id, a.user_id, a.kind, a.message, a.created_at, g.name FROM group_activity a JOIN groups g ON g.id = a.group_id "
                f"WHERE a.group_id IN ({gq}) AND a.created_at >= ? AND a.kind IN ({','.join('?' * len(GROUP_KINDS))})",
                (*my_groups, since, *GROUP_KINDS)):
                add(f"ga-{r['id']}", r["kind"], r["user_id"], GROUP_KINDS[r["kind"]], r["message"], r["created_at"], r["name"])

        # 2. Friends saving toward goals in groups you're NOT in: progress and milestones.
        fq = ",".join("?" * len(friends)) if friends else "NULL"
        for r in conn.execute(
            f"SELECT c.id, c.user_id, c.goal_id, c.amount_cents, c.created_at, g.title, g.group_id, gc.share_cents FROM contributions c "
            f"JOIN goals g ON g.id = c.goal_id LEFT JOIN goal_commitments gc ON gc.goal_id = c.goal_id AND gc.user_id = c.user_id "
            f"WHERE c.user_id IN ({fq}) AND c.created_at >= ?", (*friends, since)):
            if r["group_id"] in my_groups:
                continue
            before = conn.execute("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM contributions WHERE goal_id = ? AND user_id = ? AND id < ?",
                                  (r["goal_id"], r["user_id"], r["id"])).fetchone()["s"]
            share = r["share_cents"] or 0
            pct_before = 100 * before / share if share else 0
            pct = min(100, round(100 * (before + r["amount_cents"]) / share)) if share else None
            crossed = [m for m in MILESTONES if pct_before < m <= (pct or 0)]
            who = name(r["user_id"])
            amount = f" ${dollars(r['amount_cents']):,.2f}" if settings[r["user_id"]]["share_amounts"] else ""
            if crossed and crossed[-1] == 100:
                text, emoji = f"{who} finished their share of “{r['title']}”!", "🏁"
            elif crossed:
                text, emoji = f"{who} saved{amount} toward “{r['title']}” and hit {crossed[-1]}% of their share", "🎯"
            else:
                text, emoji = f"{who} saved{amount} toward “{r['title']}”" + (f" · now {pct}% of their share" if pct is not None else ""), "💰"
            add(f"save-{r['id']}", "saved", r["user_id"], emoji, text, r["created_at"])

        # 3. Lessons passed.
        pq = ",".join("?" * len(people))
        for r in conn.execute(f"SELECT user_id, lesson_key, week_start, points, completed_at FROM lesson_progress "
                              f"WHERE user_id IN ({pq}) AND passed = 1 AND completed_at >= ?", (*people, since)):
            title = learn.LESSONS.get(r["lesson_key"], {}).get("title", "a lesson")
            pts = f" (+{r['points']} pts)" if r["points"] else ""
            add(f"lesson-{r['user_id']}-{r['lesson_key']}-{r['week_start']}", "lesson", r["user_id"], "📚",
                f"{name(r['user_id'])} passed the lesson “{title}”{pts}", r["completed_at"])

        # 4. Weeks finished under budget, with streaks.
        weeks = defaultdict(dict)
        for r in conn.execute(f"SELECT user_id, week_start, points, under_total FROM budget_weeks WHERE user_id IN ({pq})", list(people)):
            weeks[r["user_id"]][r["week_start"]] = r
        for uid, rows in weeks.items():
            streak = 0
            for ws in sorted(rows):
                r = rows[ws]
                streak = streak + 1 if r["under_total"] else 0
                ended = date.fromisoformat(ws) + timedelta(days=7)
                if not r["under_total"] or ended.isoformat() < since_day:
                    continue
                run = f" · {streak} weeks in a row" if streak >= 2 else ""
                add(f"week-{uid}-{ws}", "streak", uid, "🔥" if streak >= 2 else "✅",
                    f"{name(uid)} stayed under budget for the week of {_short(date.fromisoformat(ws))}{run}", _iso(ended), f"{r['points']} pts")

        # 5. Someone started a budget.
        for r in conn.execute(f"SELECT s.user_id, s.created_at FROM budget_settings s WHERE s.user_id IN ({pq}) AND s.created_at >= ? "
                              f"AND EXISTS (SELECT 1 FROM budgets b WHERE b.user_id = s.user_id)", (*people, since)):
            add(f"budget-{r['user_id']}", "budget", r["user_id"], "📊", f"{name(r['user_id'])} started a weekly budget", r["created_at"])

        # 6. New friendships among you and your friends.
        for r in conn.execute(f"SELECT id, requester_id, addressee_id, responded_at FROM friendships WHERE status = 'accepted' AND responded_at >= ? "
                              f"AND requester_id IN ({pq}) AND addressee_id IN ({pq})", (since, *people, *people)):
            a, b = r["requester_id"], r["addressee_id"]
            if me in (a, b):
                other = b if a == me else a
                text = f"You and {_first(names.get(other))} are now friends"
            else:
                text = f"{_first(names.get(a))} and {_first(names.get(b))} are now friends"
            add(f"friend-{r['id']}", "friends", a, "🤝", text, r["responded_at"])

        # 7. Cheers from the leaderboard.
        for r in conn.execute(f"SELECT id, from_id, to_id, created_at FROM budget_cheers WHERE from_id IN ({pq}) AND to_id IN ({pq}) AND created_at >= ?",
                              (*people, *people, since)):
            target = "you" if r["to_id"] == me else _first(names.get(r["to_id"]))
            add(f"cheer-{r['id']}", "cheer", r["from_id"], "👏", f"{name(r['from_id'])} cheered {target} on", r["created_at"])

        # Reactions on all of it.
        ids = [i["id"] for i in items]
        counts: dict = defaultdict(lambda: defaultdict(int))
        mine: dict = defaultdict(set)
        if ids:
            for r in conn.execute(f"SELECT item_id, user_id, emoji FROM feed_reactions WHERE item_id IN ({','.join('?' * len(ids))})", ids):
                counts[r["item_id"]][r["emoji"]] += 1
                if r["user_id"] == me:
                    mine[r["item_id"]].add(r["emoji"])
    for i in items:
        i["reactions"] = [{"emoji": e, "count": counts[i["id"]].get(e, 0), "mine": e in mine[i["id"]]} for e in REACTIONS]
    items.sort(key=lambda i: i["created_at"] or "", reverse=True)
    return items[:MAX_ITEMS]


@router.get("/social/feed")
def feed(user: dict = Depends(current_user)):
    return {"items": build_feed(user), "reactions": list(REACTIONS)}


class ReactIn(BaseModel):
    item_id: str
    emoji: Literal["👏", "🔥", "💪", "🎉"]


@router.post("/social/react")
def react(body: ReactIn, user: dict = Depends(current_user)):
    item = next((i for i in build_feed(user, refresh_weeks=False) if i["id"] == body.item_id), None)
    if item is None:
        raise HTTPException(404, "That update isn't in your feed")
    with db.connect() as conn:
        exists = conn.execute("SELECT 1 FROM feed_reactions WHERE item_id = ? AND user_id = ? AND emoji = ?",
                              (body.item_id, user["id"], body.emoji)).fetchone()
        if exists:
            conn.execute("DELETE FROM feed_reactions WHERE item_id = ? AND user_id = ? AND emoji = ?", (body.item_id, user["id"], body.emoji))
        else:
            conn.execute("INSERT INTO feed_reactions (item_id, user_id, emoji, actor_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                         (body.item_id, user["id"], body.emoji, item["actor"]["id"], item["text"][:140], db.now()))
    return {"reacted": not exists}


class SettingsIn(BaseModel):
    share_goals: bool
    share_amounts: bool


@router.get("/social/settings")
def get_settings(user: dict = Depends(current_user)):
    with db.connect() as conn:
        return _settings(conn, user["id"])


@router.put("/social/settings")
def put_settings(body: SettingsIn, user: dict = Depends(current_user)):
    now = db.now()
    with db.connect() as conn:
        conn.execute("INSERT INTO budget_settings (user_id, share_goals, share_amounts, created_at, updated_at) VALUES (?, ?, ?, ?, ?) "
                     "ON CONFLICT (user_id) DO UPDATE SET share_goals = excluded.share_goals, share_amounts = excluded.share_amounts, "
                     "updated_at = excluded.updated_at", (user["id"], int(body.share_goals), int(body.share_amounts), now, now))
    return {"share_goals": body.share_goals, "share_amounts": body.share_amounts}


# ---------- Your week (Home summary + header points) ----------

def next_payment(conn, user_id: int, today: date) -> dict | None:
    """The soonest scheduled goal payment you owe, else the goal you're furthest behind on."""
    best = None
    for g in conn.execute("SELECT g.*, gc.share_cents, gc.committed_at FROM goal_commitments gc JOIN goals g ON g.id = gc.goal_id "
                          "WHERE gc.user_id = ? AND g.completed_at IS NULL", (user_id,)):
        entries = [(r["created_at"], r["amount_cents"]) for r in conn.execute(
            "SELECT created_at, amount_cents FROM contributions WHERE goal_id = ? AND user_id = ?", (g["id"], user_id))]
        saved = sum(c for _, c in entries)
        pct = min(100, round(100 * saved / g["share_cents"])) if g["share_cents"] else 0
        s = member_schedule(g, g["share_cents"], g["committed_at"], entries, today)
        option = {"goal_id": g["id"], "group_id": g["group_id"], "title": g["title"], "my_pct": pct,
                  "due": s["next_due"] if s else None, "amount": s["next_amount"] if s else None}
        if pct >= 100:
            continue
        if best is None or (option["due"] or "9999") < (best["due"] or "9999") or (option["due"] == best["due"] and pct < best["my_pct"]):
            best = option
    return best


@router.get("/me/week")
def my_week(user: dict = Depends(current_user)):
    ledger = budget.ledger_for(user["id"]) if user["bank_link"] else None
    budget.ensure_demo_budget(user["id"], ledger)
    today = date.today()
    pts = budget.user_points(user["id"], ledger, today)
    ws = budget.week_start(today)
    with db.connect() as conn:
        limits = budget.current_limits(conn, user["id"])
        upcoming = next_payment(conn, user["id"], today)
    spent = budget.spent_by_category(budget.purchases(ledger), ws, today)
    limit = sum(limits.values())
    used = sum(spent.get(c, 0) for c in limits)
    latest = next((i for i in build_feed(user, refresh_weeks=False) if not i["actor"]["is_me"]), None)
    return {
        "points": pts["this_week"]["points"], "streak": pts["streak"], "total_points": pts["total_points"],
        "days_left": 6 - today.weekday(),
        "budget": {"limit": limit / 100, "spent": used / 100, "left": (limit - used) / 100, "used_pct": round(100 * used / limit) if limit else None} if limits else None,
        "next_payment": upcoming,
        "latest_update": latest,
    }
