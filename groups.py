"""Groups and shared savings goals.

Flow:
  1. Anyone creates a group (they become its owner and first member).
  2. Members invite their FRIENDS (accepted friend requests only).
     The invitee accepts or declines; the inviter can cancel.
  3. Any member creates a shared goal: title, target amount, deadline.
  4. Each member COMMITS to the goal by taking on a share (default: an even split).
     Uncommitted members are shown as "not committed", which is the point:
     everyone can see who's in.
  5. Committed members log what they've saved (contributions).
     Progress is compared with where each person should be by now
     (their share x how much of the time from when THEY committed to the
     deadline has passed), so each member is "on track", "behind" or "complete".
     The group as a whole is measured from when the goal was created.
  6. Every join, commitment and contribution goes into the group's activity feed.

Money: amounts come in and go out as dollars, but are stored as whole cents.
Adding money to a goal is a real withdrawal from your linked bank account in
Nessie (see banking.py), so it shows on your statement and lowers your balance.
Undoing it takes that withdrawal back (Nessie can't delete withdrawals, so the
app hides it), returning the money to your balance.

Goal terms (optional, set by hand or filled in by the Gemini goal coach, goal_coach.py):
  - frequency: weekly / biweekly / monthly. Each member's share is split into equal
    payments, due from when THEY committed until the deadline.
  - a payment is MISSED if, by its due date, that member's savings are below what
    they should have paid so far. Missed payments stay on the record.
  - penalty_type "money": each missed payment adds penalty_percent of one payment to
    that member's total (their share goes up). "honor": each missed payment means
    they owe the group the agreed dare (enforced by the friend group, shown here).
"""
import math
import secrets
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import banking
import db
import nessie
import solana_vault
from auth import current_user, public_user
from friends import friend_ids

router = APIRouter(prefix="/api")

MAX_AMOUNT_CENTS = 100_000_000  # $1,000,000 sanity cap


# ---------- Helpers ----------

def to_cents(dollars: float, field: str = "Amount") -> int:
    if dollars is None or not math.isfinite(dollars):
        raise HTTPException(400, f"{field} must be a number")
    cents = round(dollars * 100)
    if cents <= 0:
        raise HTTPException(400, f"{field} must be more than $0")
    if cents > MAX_AMOUNT_CENTS:
        raise HTTPException(400, f"{field} is too large")
    return cents


def dollars(cents: int) -> float:
    return round(cents / 100, 2)


def _log(conn, group_id, user_id, kind, message):
    conn.execute(
        "INSERT INTO group_activity (group_id, user_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)",
        (group_id, user_id, kind, message, db.now()),
    )


def _name(conn, user_id):
    row = conn.execute("SELECT display_name FROM users WHERE id = ?", (user_id,)).fetchone()
    return row["display_name"] if row else "Someone"


def _is_member(conn, group_id, user_id) -> bool:
    return conn.execute(
        "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", (group_id, user_id)
    ).fetchone() is not None


def _require_group_member(conn, group_id, user_id):
    group = conn.execute("SELECT * FROM groups WHERE id = ?", (group_id,)).fetchone()
    # Same 404 whether the group doesn't exist or you're not in it.
    if group is None or not _is_member(conn, group_id, user_id):
        raise HTTPException(404, "Group not found")
    return group


def _goal_for_member(conn, goal_id, user_id):
    goal = conn.execute("SELECT * FROM goals WHERE id = ?", (goal_id,)).fetchone()
    if goal is None or not _is_member(conn, goal["group_id"], user_id):
        raise HTTPException(404, "Goal not found")
    return goal


def _time_elapsed_fraction(created_at: str, deadline: str, today: date) -> float:
    start = date.fromisoformat(created_at[:10])
    end = date.fromisoformat(deadline)
    if end <= start:
        return 1.0
    return min(1.0, max(0.0, (today - start).days / (end - start).days))


def mark_complete_if_reached(conn, goal) -> bool:
    """The first time a goal's savings reach its target: record it and tell the whole
    group (the activity entry has no author, so every member is notified, including
    whoever made the last contribution). Returns True if it just completed."""
    if "completed_at" in goal.keys() and goal["completed_at"]:
        return False
    saved = conn.execute("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM contributions WHERE goal_id = ?",
                         (goal["id"],)).fetchone()["c"]
    if saved < goal["target_cents"]:
        return False
    conn.execute("UPDATE goals SET completed_at = ? WHERE id = ? AND completed_at IS NULL", (db.now(), goal["id"]))
    _log(conn, goal["group_id"], None, "goal_complete",
         f"🎉 Goal reached! “{goal['title']}” hit ${dollars(goal['target_cents']):,.2f}. Nice work, team!")
    return True


def _can_manage(conn, goal, user_id) -> bool:
    owner = conn.execute("SELECT owner_id FROM groups WHERE id = ?", (goal["group_id"],)).fetchone()["owner_id"]
    return user_id in (goal["created_by"], owner)


def escrow_state(conn, goal, viewer_id: int | None, total_saved: int | None = None) -> dict:
    """The vault works like escrow: money is LOCKED until the goal is reached, then the
    goal's creator (or group owner) can RELEASE the whole pot in one payout.
      locked     -> still saving; nobody can take the pot
      releasable -> target reached; waiting for the creator to release
      released   -> paid out (on Solana: vault -> creator, then burned)"""
    if total_saved is None:
        total_saved = conn.execute("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM contributions WHERE goal_id = ?",
                                   (goal["id"],)).fetchone()["c"]
    keys = goal.keys()
    released_at = goal["released_at"] if "released_at" in keys else None
    if released_at:
        state = "released"
    elif total_saved >= goal["target_cents"]:
        state = "releasable"
    else:
        state = "locked"
    to = goal["released_to"] if "released_to" in keys else None
    return {
        "state": state,
        "released_at": released_at,
        "released_cents": (goal["released_cents"] or 0) if "released_cents" in keys else 0,
        "released_amount": dollars((goal["released_cents"] or 0) if "released_cents" in keys else 0),
        "released_to": _name(conn, to) if to else None,
        "can_release": state == "releasable" and viewer_id is not None and _can_manage(conn, goal, viewer_id),
        "pot": dollars(total_saved),
    }


def _not_released(goal):
    if "released_at" in goal.keys() and goal["released_at"]:
        raise HTTPException(409, "This goal's vault has already been released, so its savings can't change")


FREQUENCIES = ("none", "weekly", "biweekly", "monthly")
PENALTY_TYPES = ("none", "money", "honor")


def _add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    year, month = d.year + y, m + 1
    days_in_month = [31, 29 if year % 4 == 0 and (year % 100 or year % 400 == 0) else 28,
                     31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    return date(year, month, min(d.day, days_in_month))


def due_dates(start: date, deadline: date, frequency: str) -> list[date]:
    """When each payment is due: one per period after `start`, the last on the deadline."""
    if frequency not in ("weekly", "biweekly", "monthly") or deadline <= start:
        return [deadline]
    dates, k = [], 1
    while True:
        d = _add_months(start, k) if frequency == "monthly" else start + timedelta(days=7 * k * (2 if frequency == "biweekly" else 1))
        if d >= deadline:
            break
        dates.append(d)
        k += 1
    return dates + [deadline]


def member_schedule(goal, share: int, committed_at: str, entries: list, today: date) -> dict | None:
    """One member's payment plan, missed payments and penalty (all in cents), or None
    if the goal has no payment schedule. `entries` = [(created_at, amount_cents), ...]."""
    frequency = goal["frequency"] if "frequency" in goal.keys() else "none"
    if frequency not in ("weekly", "biweekly", "monthly"):
        return None
    dues = due_dates(date.fromisoformat(committed_at[:10]), date.fromisoformat(goal["deadline"]), frequency)
    payment = share / len(dues)
    passed = [d for d in dues if d < today]
    missed = 0
    for k, d in enumerate(passed, start=1):
        paid_by_then = sum(c for when, c in entries if date.fromisoformat(when[:10]) <= d)
        if paid_by_then + 1 < round(payment * k):  # 1 cent of rounding slack
            missed += 1
    have = sum(c for _, c in entries)
    penalty = round(missed * payment * goal["penalty_percent"] / 100) if goal["penalty_type"] == "money" else 0
    total_owed = share + penalty
    upcoming = next((d for d in dues if d >= today), None)
    next_amount = max(0, min(total_owed - have, round(payment * (len(passed) + 1)) + penalty - have))
    return {
        "payment": dollars(round(payment)),
        "payments_total": len(dues),
        "payments_due_so_far": len(passed),
        "next_due": upcoming.isoformat() if upcoming else None,
        "next_amount": dollars(next_amount),
        "missed": missed,
        "penalty_owed": dollars(penalty),
        "total_owed": dollars(total_owed),
        "dares_owed": missed if goal["penalty_type"] == "honor" else 0,
    }


def goal_terms(goal) -> dict:
    keys = goal.keys()
    get = lambda k, default=None: goal[k] if k in keys and goal[k] is not None else default
    return {
        "frequency": get("frequency", "none"),
        "penalty_type": get("penalty_type", "none"),
        "penalty_percent": get("penalty_percent", 0),
        "penalty_dare": get("penalty_dare", ""),
        "pace": get("pace", ""),
        "realism_score": get("realism_score"),
        "realism_note": get("realism_note", ""),
        "coach_summary": get("coach_summary", ""),
    }


def goal_progress(conn, goal, viewer_id: int, today: date | None = None) -> dict:
    """Everything the UI shows about one goal: totals, pace, and each member's status."""
    today = today or date.today()
    members = conn.execute(
        "SELECT u.id, u.username, u.display_name FROM group_members m JOIN users u ON u.id = m.user_id "
        "WHERE m.group_id = ? ORDER BY m.joined_at",
        (goal["group_id"],),
    ).fetchall()
    commitments = {r["user_id"]: r for r in conn.execute(
        "SELECT user_id, share_cents, committed_at FROM goal_commitments WHERE goal_id = ?", (goal["id"],))}
    shares = {uid: r["share_cents"] for uid, r in commitments.items()}
    saved = {r["user_id"]: r["total"] for r in conn.execute(
        "SELECT user_id, SUM(amount_cents) AS total FROM contributions WHERE goal_id = ? GROUP BY user_id",
        (goal["id"],))}
    entries: dict = {}
    for r in conn.execute("SELECT user_id, amount_cents, created_at FROM contributions WHERE goal_id = ?", (goal["id"],)):
        entries.setdefault(r["user_id"], []).append((r["created_at"], r["amount_cents"]))

    elapsed = _time_elapsed_fraction(goal["created_at"], goal["deadline"], today)
    target = goal["target_cents"]
    total_saved = sum(saved.values())
    member_ids = {m["id"] for m in members}

    rows = []
    for m in members:
        share, have = shares.get(m["id"]), saved.get(m["id"], 0)
        schedule = None
        if share is None:
            status, expected = "not_committed", 0
        else:
            # Each person's pace starts when THEY committed, so late joiners aren't instantly "behind".
            mine = _time_elapsed_fraction(commitments[m["id"]]["committed_at"], goal["deadline"], today)
            expected = round(share * mine)
            schedule = member_schedule(goal, share, commitments[m["id"]]["committed_at"], entries.get(m["id"], []), today)
            owed = round(schedule["total_owed"] * 100) if schedule else share
            if have >= owed:
                status = "complete"
            elif schedule and schedule["missed"]:
                status = "behind"
            else:
                status = "on_track" if have >= expected else "behind"
        rows.append({
            "schedule": schedule,
            "person": public_user(m),
            "share": dollars(share) if share else None,
            "saved": dollars(have),
            "expected_by_now": dollars(expected),
            "percent": min(100, round(100 * have / share)) if share else 0,
            "status": status,
        })

    # People who saved but have since left the group still count toward the total.
    former_saved = sum(v for uid, v in saved.items() if uid not in member_ids)

    days_left = (date.fromisoformat(goal["deadline"]) - today).days
    if total_saved >= target:
        status = "complete"
    elif days_left < 0:
        status = "missed"
    else:
        status = "on_track" if total_saved >= round(target * elapsed) else "behind"

    committed_total = sum(shares.get(uid, 0) for uid in member_ids)
    return {
        "id": goal["id"],
        "title": goal["title"],
        "target": dollars(target),
        "deadline": goal["deadline"],
        "created_at": goal["created_at"],
        "completed_at": goal["completed_at"] if "completed_at" in goal.keys() else None,
        "escrow": escrow_state(conn, goal, viewer_id, total_saved),
        "created_by": goal["created_by"],
        "days_left": days_left,
        "total_saved": dollars(total_saved),
        "former_members_saved": dollars(former_saved),
        "percent": min(100, round(100 * total_saved / target)),
        "expected_by_now": dollars(round(target * elapsed)),
        "committed_total": dollars(committed_total),
        "uncommitted_count": sum(1 for r in rows if r["status"] == "not_committed"),
        "status": status,
        "my_share": dollars(shares[viewer_id]) if viewer_id in shares else None,
        "suggested_share": dollars(math.ceil(target / max(1, len(members)))),
        "members": rows,
        "terms": goal_terms(goal),
    }


# ---------- Request bodies ----------

class GroupIn(BaseModel):
    name: str
    invite_user_ids: list[int] = []


class InviteIn(BaseModel):
    user_id: int


class TermsIn(BaseModel):
    frequency: str = "none"          # none | weekly | biweekly | monthly
    penalty_type: str = "none"       # none | money | honor
    penalty_percent: float = 0       # money: % of one payment added per missed payment
    penalty_dare: str = ""           # honor: the dare someone who misses owes the group
    pace: str = ""
    realism_score: int | None = None
    realism_note: str = ""
    coach_summary: str = ""


class GoalIn(TermsIn):
    title: str
    target_amount: float
    deadline: str  # YYYY-MM-DD


class CommitIn(BaseModel):
    share_amount: float


class ContributionIn(BaseModel):
    amount: float
    note: str = ""


# ---------- Groups ----------

def _invite(conn, group_id, inviter_id, invitee_id):
    if invitee_id == inviter_id:
        raise HTTPException(400, "You're already in this group")
    if invitee_id not in friend_ids(conn, inviter_id):
        raise HTTPException(403, "You can only invite people you're friends with")
    if _is_member(conn, group_id, invitee_id):
        raise HTTPException(409, "They're already in this group")
    if conn.execute(
        "SELECT 1 FROM group_invites WHERE group_id = ? AND invitee_id = ?", (group_id, invitee_id)
    ).fetchone():
        raise HTTPException(409, "They've already been invited")
    cur = conn.execute(
        "INSERT INTO group_invites (group_id, inviter_id, invitee_id, created_at) VALUES (?, ?, ?, ?)",
        (group_id, inviter_id, invitee_id, db.now()),
    )
    _log(conn, group_id, inviter_id, "invite", f"{_name(conn, inviter_id)} invited {_name(conn, invitee_id)}")
    return cur.lastrowid


@router.get("/groups")
def my_groups(user: dict = Depends(current_user)):
    """Your groups (with a quick progress summary) and invites waiting for you."""
    me = user["id"]
    with db.connect() as conn:
        groups = conn.execute(
            "SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? "
            "ORDER BY g.created_at DESC",
            (me,),
        ).fetchall()
        result = []
        for g in groups:
            members = conn.execute(
                "SELECT u.id, u.username, u.display_name FROM group_members m JOIN users u ON u.id = m.user_id "
                "WHERE m.group_id = ? ORDER BY m.joined_at", (g["id"],)
            ).fetchall()
            goals = [goal_progress(conn, row, me) for row in conn.execute(
                "SELECT * FROM goals WHERE group_id = ? ORDER BY deadline", (g["id"],))]
            result.append({
                "id": g["id"],
                "name": g["name"],
                "members": [public_user(m) for m in members],
                "goals": [{k: goal[k] for k in ("id", "title", "target", "total_saved", "percent", "status",
                                                 "days_left", "my_share")} for goal in goals],
            })

        invites = conn.execute(
            "SELECT i.id, i.created_at, g.id AS group_id, g.name, u.id AS inviter_id, u.username AS inviter_username, u.display_name AS inviter_name, "
            "(SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count "
            "FROM group_invites i JOIN groups g ON g.id = i.group_id JOIN users u ON u.id = i.inviter_id "
            "WHERE i.invitee_id = ? ORDER BY i.created_at DESC",
            (me,),
        ).fetchall()

    return {
        "groups": result,
        "invites": [
            {"id": i["id"], "created_at": i["created_at"],
             "group": {"id": i["group_id"], "name": i["name"], "member_count": i["member_count"]},
             "invited_by": {"id": i["inviter_id"], "username": i["inviter_username"], "display_name": i["inviter_name"]}}
            for i in invites
        ],
    }


@router.post("/groups", status_code=201)
def create_group(body: GroupIn, user: dict = Depends(current_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Give your group a name")
    me = user["id"]
    with db.connect() as conn:
        # Check every invite first so we don't create half a group.
        friends_of_me = friend_ids(conn, me)
        bad = [uid for uid in body.invite_user_ids if uid not in friends_of_me]
        if bad:
            raise HTTPException(403, "You can only invite people you're friends with")

        group_id = conn.execute(
            "INSERT INTO groups (name, owner_id, created_at) VALUES (?, ?, ?)", (name[:60], me, db.now())
        ).lastrowid
        conn.execute(
            "INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)", (group_id, me, db.now())
        )
        _log(conn, group_id, me, "create", f"{user['display_name']} created the group")
        for uid in dict.fromkeys(body.invite_user_ids):  # de-duplicate, keep order
            _invite(conn, group_id, me, uid)
    return {"id": group_id}


@router.get("/groups/{group_id}")
def group_detail(group_id: int, user: dict = Depends(current_user)):
    me = user["id"]
    with db.connect() as conn:
        group = _require_group_member(conn, group_id, me)
        members = conn.execute(
            "SELECT u.id, u.username, u.display_name, m.joined_at FROM group_members m JOIN users u ON u.id = m.user_id "
            "WHERE m.group_id = ? ORDER BY m.joined_at", (group_id,)
        ).fetchall()
        member_ids = {m["id"] for m in members}
        invites = conn.execute(
            "SELECT i.id, i.inviter_id, u.id AS uid, u.username, u.display_name FROM group_invites i "
            "JOIN users u ON u.id = i.invitee_id WHERE i.group_id = ? ORDER BY i.created_at", (group_id,)
        ).fetchall()
        invited_ids = {i["uid"] for i in invites}

        my_friends = friend_ids(conn, me)
        invitable = [
            public_user(r) for r in conn.execute("SELECT * FROM users ORDER BY display_name")
            if r["id"] in my_friends and r["id"] not in member_ids and r["id"] not in invited_ids
        ]
        goals = [goal_progress(conn, row, me) for row in conn.execute(
            "SELECT * FROM goals WHERE group_id = ? ORDER BY deadline", (group_id,))]
        activity = conn.execute(
            "SELECT kind, message, created_at FROM group_activity WHERE group_id = ? ORDER BY id DESC LIMIT 30",
            (group_id,),
        ).fetchall()
        my_contributions = conn.execute(
            "SELECT c.id, c.goal_id, c.amount_cents, c.note, c.created_at FROM contributions c "
            "JOIN goals g ON g.id = c.goal_id WHERE g.group_id = ? AND c.user_id = ? ORDER BY c.id DESC LIMIT 20",
            (group_id, me),
        ).fetchall()

    return {
        "id": group["id"],
        "name": group["name"],
        "owner_id": group["owner_id"],
        "created_at": group["created_at"],
        "members": [{**public_user(m), "joined_at": m["joined_at"],
                     "is_owner": m["id"] == group["owner_id"]} for m in members],
        "pending_invites": [{"id": i["id"], "person": {"id": i["uid"], "username": i["username"], "display_name": i["display_name"]},
                             "can_cancel": i["inviter_id"] == me} for i in invites],
        "invitable_friends": invitable,
        "goals": goals,
        "my_contributions": [{"id": c["id"], "goal_id": c["goal_id"], "amount": dollars(c["amount_cents"]),
                              "note": c["note"], "created_at": c["created_at"]} for c in my_contributions],
        "activity": [dict(a) for a in activity],
    }


@router.post("/groups/{group_id}/invites", status_code=201)
def invite_friend(group_id: int, body: InviteIn, user: dict = Depends(current_user)):
    with db.connect() as conn:
        _require_group_member(conn, group_id, user["id"])
        invite_id = _invite(conn, group_id, user["id"], body.user_id)
    return {"invite_id": invite_id}


def _get_invite(conn, invite_id):
    row = conn.execute("SELECT * FROM group_invites WHERE id = ?", (invite_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Invite not found")
    return row


@router.post("/group-invites/{invite_id}/accept")
def accept_invite(invite_id: int, user: dict = Depends(current_user)):
    me = user["id"]
    with db.connect() as conn:
        inv = _get_invite(conn, invite_id)
        if inv["invitee_id"] != me:
            raise HTTPException(404, "Invite not found")
        conn.execute(
            "INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
            (inv["group_id"], me, db.now()),
        )
        conn.execute("DELETE FROM group_invites WHERE id = ?", (invite_id,))
        _log(conn, inv["group_id"], me, "join", f"{user['display_name']} joined the group")
    return {"group_id": inv["group_id"]}


@router.post("/group-invites/{invite_id}/decline")
def decline_invite(invite_id: int, user: dict = Depends(current_user)):
    """The invitee declines, or the person who sent it cancels."""
    me = user["id"]
    with db.connect() as conn:
        inv = _get_invite(conn, invite_id)
        if me not in (inv["invitee_id"], inv["inviter_id"]):
            raise HTTPException(404, "Invite not found")
        conn.execute("DELETE FROM group_invites WHERE id = ?", (invite_id,))
        if me == inv["invitee_id"]:
            _log(conn, inv["group_id"], me, "decline", f"{user['display_name']} declined the invite")
    return {"status": "removed"}


@router.post("/groups/{group_id}/leave")
def leave_group(group_id: int, user: dict = Depends(current_user)):
    """Leave a group. Your past contributions stay in the totals; your commitments are dropped.
    If the owner leaves, the longest-standing member becomes owner. The last one out deletes the group."""
    me = user["id"]
    with db.connect() as conn:
        group = _require_group_member(conn, group_id, me)
        conn.execute("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", (group_id, me))
        conn.execute(
            "DELETE FROM goal_commitments WHERE user_id = ? AND goal_id IN (SELECT id FROM goals WHERE group_id = ?)",
            (me, group_id),
        )
        remaining = conn.execute(
            "SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at", (group_id,)
        ).fetchall()
        if not remaining:
            conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))
            return {"status": "group deleted"}
        if group["owner_id"] == me:
            conn.execute("UPDATE groups SET owner_id = ? WHERE id = ?", (remaining[0]["user_id"], group_id))
        _log(conn, group_id, me, "leave", f"{user['display_name']} left the group")
    return {"status": "left"}


# ---------- Goals ----------

@router.post("/groups/{group_id}/goals", status_code=201)
def create_goal(group_id: int, body: GoalIn, user: dict = Depends(current_user)):
    title = body.title.strip()
    if not title:
        raise HTTPException(400, "Give the goal a name")
    target = to_cents(body.target_amount, "Target")
    try:
        deadline = date.fromisoformat(body.deadline)
    except ValueError:
        raise HTTPException(400, "Deadline must be a date like 2027-03-01")
    if deadline <= date.today():
        raise HTTPException(400, "Pick a deadline in the future")

    terms = _clean_terms(body)
    with db.connect() as conn:
        _require_group_member(conn, group_id, user["id"])
        goal_id = conn.execute(
            "INSERT INTO goals (group_id, title, target_cents, deadline, created_by, created_at, frequency, penalty_type, "
            "penalty_percent, penalty_dare, pace, realism_score, realism_note, coach_summary) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (group_id, title[:80], target, deadline.isoformat(), user["id"], db.now(), *terms.values()),
        ).lastrowid
        _log(conn, group_id, user["id"], "goal",
             f"{user['display_name']} created the goal “{title[:80]}”: ${dollars(target):,.2f} by {deadline:%b %d, %Y}")
        if terms["frequency"] != "none" or terms["penalty_type"] != "none":
            _log(conn, group_id, user["id"], "terms", f"Terms for “{title[:80]}”: {describe_terms(terms)}")
    return {"id": goal_id}


def _clean_terms(body: TermsIn) -> dict:
    if body.frequency not in FREQUENCIES:
        raise HTTPException(400, f"frequency must be one of: {', '.join(FREQUENCIES)}")
    if body.penalty_type not in PENALTY_TYPES:
        raise HTTPException(400, f"penalty_type must be one of: {', '.join(PENALTY_TYPES)}")
    percent = float(body.penalty_percent or 0)
    if body.penalty_type == "money" and not 0 < percent <= 100:
        raise HTTPException(400, "Pick a penalty between 1% and 100% of a payment")
    dare = body.penalty_dare.strip()[:160]
    if body.penalty_type == "honor" and not dare:
        raise HTTPException(400, "Describe the dare for missing a payment")
    score = body.realism_score
    return {
        "frequency": body.frequency,
        "penalty_type": body.penalty_type,
        "penalty_percent": percent if body.penalty_type == "money" else 0,
        "penalty_dare": dare if body.penalty_type == "honor" else "",
        "pace": body.pace.strip()[:40],
        "realism_score": max(1, min(10, int(score))) if score is not None else None,
        "realism_note": body.realism_note.strip()[:300],
        "coach_summary": body.coach_summary.strip()[:600],
    }


def describe_terms(t: dict) -> str:
    parts = [f"{t['frequency']} payments" if t["frequency"] != "none" else "no payment schedule"]
    if t["penalty_type"] == "money":
        parts.append(f"a missed payment adds {t['penalty_percent']:g}% of a payment")
    elif t["penalty_type"] == "honor":
        parts.append(f"a missed payment means: {t['penalty_dare']}")
    return "; ".join(parts)


@router.put("/goals/{goal_id}/terms")
def set_terms(goal_id: int, body: TermsIn, user: dict = Depends(current_user)):
    """Set or change a goal's payment schedule and missed-payment penalty."""
    terms = _clean_terms(body)
    with db.connect() as conn:
        goal = _goal_for_member(conn, goal_id, user["id"])
        owner = conn.execute("SELECT owner_id FROM groups WHERE id = ?", (goal["group_id"],)).fetchone()["owner_id"]
        if user["id"] not in (goal["created_by"], owner):
            raise HTTPException(403, "Only the person who created this goal, or the group owner, can change its terms")
        conn.execute(
            "UPDATE goals SET frequency = ?, penalty_type = ?, penalty_percent = ?, penalty_dare = ?, pace = ?, "
            "realism_score = ?, realism_note = ?, coach_summary = ? WHERE id = ?",
            (*terms.values(), goal_id),
        )
        _log(conn, goal["group_id"], user["id"], "terms",
             f"{user['display_name']} set the terms for “{goal['title']}”: {describe_terms(terms)}")
    return {"terms": terms}


@router.delete("/goals/{goal_id}")
def delete_goal(goal_id: int, user: dict = Depends(current_user)):
    """Only the goal's creator or the group owner can delete it."""
    with db.connect() as conn:
        goal = _goal_for_member(conn, goal_id, user["id"])
        owner = conn.execute("SELECT owner_id FROM groups WHERE id = ?", (goal["group_id"],)).fetchone()["owner_id"]
        if user["id"] not in (goal["created_by"], owner):
            raise HTTPException(403, "Only the person who created this goal, or the group owner, can delete it")
        released = bool(goal["released_at"])
        money = [] if released else conn.execute(
            "SELECT nessie_type, nessie_id FROM contributions WHERE goal_id = ? AND nessie_id IS NOT NULL", (goal_id,)).fetchall()
    # Escrow: a goal deleted before payout gives everyone their money back, in the bank and on-chain.
    refunded = 0
    for c in money:
        try:
            banking.remove(c["nessie_type"], c["nessie_id"], reason="goal deleted")
            refunded += 1
        except nessie.NessieError:
            pass
    with db.connect() as conn:
        conn.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
        note = f" Everyone's savings went back to their bank accounts." if refunded else ""
        _log(conn, goal["group_id"], user["id"], "goal_deleted",
             f"{user['display_name']} deleted the goal “{goal['title']}”.{note}")
    if not released:
        solana_vault.enqueue_goal_refunds(goal_id, goal["title"])
    return {"status": "deleted", "refunded": refunded}


@router.post("/goals/{goal_id}/commit")
def commit_to_goal(goal_id: int, body: CommitIn, user: dict = Depends(current_user)):
    """Take on (or change) your share of a goal."""
    share = to_cents(body.share_amount, "Your share")
    with db.connect() as conn:
        goal = _goal_for_member(conn, goal_id, user["id"])
        if share > goal["target_cents"]:
            raise HTTPException(400, "Your share can't be more than the whole goal")
        existed = conn.execute(
            "SELECT 1 FROM goal_commitments WHERE goal_id = ? AND user_id = ?", (goal_id, user["id"])
        ).fetchone()
        conn.execute(
            "INSERT INTO goal_commitments (goal_id, user_id, share_cents, committed_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (goal_id, user_id) DO UPDATE SET share_cents = excluded.share_cents",
            (goal_id, user["id"], share, db.now()),
        )
        if existed:
            message = f"{user['display_name']} changed their share of “{goal['title']}” to ${dollars(share):,.2f}"
        else:
            message = f"{user['display_name']} committed ${dollars(share):,.2f} to “{goal['title']}”"
        _log(conn, goal["group_id"], user["id"], "commit", message)
    return {"share": dollars(share)}


def _from_account(user: dict) -> dict:
    """The linked bank's spending account, with its current balance (see banking.py)."""
    if not user["bank_link"]:
        raise HTTPException(409, "Link your bank first so you can move money into this goal")
    try:
        ledger = banking.customer_ledger(user["bank_link"]["nessie_customer_id"])
    except nessie.NessieError as e:
        raise HTTPException(502, f"Couldn't reach the bank: {e}")
    account = banking.spending_account(ledger["accounts"])
    if account is None:
        raise HTTPException(409, "Your bank profile has no accounts to move money from")
    return account


@router.get("/me/funding-account")
def funding_account(user: dict = Depends(current_user)):
    """Which account goal savings come out of, and how much is in it."""
    if not user["bank_link"]:
        return {"linked": False}
    a = _from_account(user)
    return {"linked": True, "id": a["id"], "nickname": a["nickname"], "type": a["type"], "balance": a["balance"]}


@router.post("/goals/{goal_id}/contributions", status_code=201)
def add_contribution(goal_id: int, body: ContributionIn, user: dict = Depends(current_user)):
    """Move money toward a goal: a real withdrawal from your bank account in Nessie,
    so it shows on your statement and your balance goes down."""
    amount = to_cents(body.amount)
    with db.connect() as conn:
        goal = _goal_for_member(conn, goal_id, user["id"])
        _not_released(goal)
        if not conn.execute(
            "SELECT 1 FROM goal_commitments WHERE goal_id = ? AND user_id = ?", (goal_id, user["id"])
        ).fetchone():
            raise HTTPException(409, "Commit to this goal before adding money")
        group_name = conn.execute("SELECT name FROM groups WHERE id = ?", (goal["group_id"],)).fetchone()["name"]

    account = _from_account(user)
    if account["type"] != "Credit Card" and round(account["balance"] * 100) < amount:
        raise HTTPException(409, f"Not enough money in {account['nickname']}: the balance is ${account['balance']:,.2f}")

    description = f"Saved for “{goal['title']}” · {group_name}"
    try:
        nessie_id = banking.withdraw(account["id"], amount, description, user_id=user["id"], source="contribution")
    except nessie.NessieError as e:
        raise HTTPException(502, f"The bank couldn't move the money: {e}")

    with db.connect() as conn:
        cid = conn.execute(
            "INSERT INTO contributions (goal_id, user_id, amount_cents, note, created_at, nessie_type, nessie_id, account_id) "
            "VALUES (?, ?, ?, ?, ?, 'withdrawals', ?, ?)",
            (goal_id, user["id"], amount, body.note.strip()[:120], db.now(), nessie_id, account["id"]),
        ).lastrowid
        _log(conn, goal["group_id"], user["id"], "contribution",
             f"{user['display_name']} moved ${dollars(amount):,.2f} into “{goal['title']}”")
        reached = mark_complete_if_reached(conn, goal)
    # Record it in the goal's on-chain vault (Solana). Queued, so the bank side never waits.
    solana_vault.enqueue_deposit(cid, goal_id, user["id"], amount,
                                 solana_vault.deposit_memo(goal_id, goal["title"], cid, amount, nessie_id))
    return {"id": cid, "goal_reached": reached, "from_account": account["nickname"],
            "new_balance": round(account["balance"] - amount / 100, 2), "nessie_id": nessie_id}


# ---------- Goal reached: celebrations ----------

@router.get("/me/celebrations")
def my_celebrations(user: dict = Depends(current_user)):
    """Goals in your groups that reached their target and you haven't celebrated yet."""
    out = []
    with db.connect() as conn:
        goals = conn.execute(
            "SELECT g.*, gr.name AS group_name FROM goals g JOIN groups gr ON gr.id = g.group_id "
            "JOIN group_members m ON m.group_id = g.group_id AND m.user_id = ?", (user["id"],)).fetchall()
        for goal in goals:
            mark_complete_if_reached(conn, goal)   # also catches goals finished before this feature existed
        rows = conn.execute(
            "SELECT g.*, gr.name AS group_name FROM goals g JOIN groups gr ON gr.id = g.group_id "
            "JOIN group_members m ON m.group_id = g.group_id AND m.user_id = ? "
            "WHERE g.completed_at IS NOT NULL AND g.completed_at >= datetime('now', '-30 days') AND NOT EXISTS "
            "(SELECT 1 FROM goal_celebrations c WHERE c.goal_id = g.id AND c.user_id = ?) ORDER BY g.completed_at",
            (user["id"], user["id"])).fetchall()
        for g in rows:
            people = conn.execute(
                "SELECT u.display_name, COALESCE(SUM(c.amount_cents), 0) AS saved FROM contributions c "
                "JOIN users u ON u.id = c.user_id WHERE c.goal_id = ? GROUP BY u.id ORDER BY saved DESC", (g["id"],)).fetchall()
            out.append({
                "goal_id": g["id"], "title": g["title"], "group_id": g["group_id"], "group_name": g["group_name"],
                "target": dollars(g["target_cents"]), "saved": dollars(sum(p["saved"] for p in people)),
                "completed_at": g["completed_at"],
                "contributors": [{"name": p["display_name"], "saved": dollars(p["saved"])} for p in people],
            })
    return out


@router.post("/goals/{goal_id}/celebrated")
def mark_celebrated(goal_id: int, user: dict = Depends(current_user)):
    """You've seen the celebration for this goal (it won't show again)."""
    with db.connect() as conn:
        _goal_for_member(conn, goal_id, user["id"])
        conn.execute("INSERT OR IGNORE INTO goal_celebrations (goal_id, user_id, seen_at) VALUES (?, ?, ?)",
                     (goal_id, user["id"], db.now()))
    return {"ok": True}


@router.get("/goals/{goal_id}/vault")
def goal_vault(goal_id: int, user: dict = Depends(current_user)):
    """The goal's on-chain vault: balance on Solana vs the app's records, who put in what, transactions."""
    with db.connect() as conn:
        goal = _goal_for_member(conn, goal_id, user["id"])
        names = {r["id"]: r["display_name"] for r in conn.execute(
            "SELECT u.id, u.display_name FROM users u JOIN contributions c ON c.user_id = u.id WHERE c.goal_id = ? "
            "UNION SELECT u.id, u.display_name FROM users u JOIN group_members m ON m.user_id = u.id WHERE m.group_id = ?",
            (goal_id, goal["group_id"]))}
        escrow = escrow_state(conn, goal, user["id"])
    return solana_vault.vault_info(goal_id, names, escrow)


# ---------- Escrow release, live tracker, public proof ----------

@router.post("/goals/{goal_id}/release")
def release_vault(goal_id: int, user: dict = Depends(current_user)):
    """Escrow release: once the goal is reached, its creator (or the group owner) pays the
    whole pot out to themselves (e.g. to book the trip). Bank: one deposit into their
    account. Solana: the vault sends every GSD to their wallet, and it's burned."""
    with db.connect() as conn:
        goal = _goal_for_member(conn, goal_id, user["id"])
        if not _can_manage(conn, goal, user["id"]):
            raise HTTPException(403, "Only the person who created this goal, or the group owner, can release the vault")
        _not_released(goal)
        escrow = escrow_state(conn, goal, user["id"])
        if escrow["state"] != "releasable":
            raise HTTPException(409, "The vault stays locked until the goal is reached")
        pot = round(escrow["pot"] * 100)
        group_name = conn.execute("SELECT name FROM groups WHERE id = ?", (goal["group_id"],)).fetchone()["name"]

    account = _from_account(user)
    try:
        nessie_id = banking.deposit(account["id"], pot, f"Payout from “{goal['title']}” vault · {group_name}",
                                    user_id=user["id"], source="goal_payout")
    except nessie.NessieError as e:
        raise HTTPException(502, f"The bank couldn't pay out the vault: {e}")

    with db.connect() as conn:
        done = conn.execute("UPDATE goals SET released_at = ?, released_cents = ?, released_to = ? "
                            "WHERE id = ? AND released_at IS NULL", (db.now(), pot, user["id"], goal_id)).rowcount
        if not done:   # someone else released it a split second earlier
            raise HTTPException(409, "This vault was just released")
        _log(conn, goal["group_id"], user["id"], "goal_released",
             f"💸 {user['display_name']} released the “{goal['title']}” vault: ${dollars(pot):,.2f} paid out")
    solana_vault.enqueue_release(goal_id, user["id"], pot,
                                 f"Gatorstar | goal {goal_id} “{goal['title'][:40]}” | escrow released | "
                                 f"${dollars(pot):,.2f} to {user['display_name'][:30]} | nessie {nessie_id}")
    return {"released": dollars(pot), "to_account": account["nickname"], "nessie_id": nessie_id}


@router.get("/contributions/{contribution_id}/chain")
def contribution_chain(contribution_id: int, user: dict = Depends(current_user)):
    """Live tracker for one contribution: bank withdrawal -> queued -> sent -> confirmed on Solana."""
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM contributions WHERE id = ?", (contribution_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Contribution not found")
        _goal_for_member(conn, row["goal_id"], user["id"])
    step = solana_vault.chain_step(contribution_id) if solana_vault.ENABLED else None
    return {"enabled": solana_vault.ENABLED, "contribution_id": contribution_id, "amount": dollars(row["amount_cents"]),
            "bank": {"nessie_id": row["nessie_id"], "at": row["created_at"]}, "chain": step}


@router.post("/goals/{goal_id}/share")
def share_goal_proof(goal_id: int, user: dict = Depends(current_user)):
    """Make (or reuse) a public link to this goal's proof page. Any member can share it."""
    with db.connect() as conn:
        goal = _goal_for_member(conn, goal_id, user["id"])
        token = goal["public_token"]
        if not token:
            token = secrets.token_urlsafe(9)
            conn.execute("UPDATE goals SET public_token = ? WHERE id = ?", (token, goal_id))
    return {"token": token}


def _first(name: str) -> str:
    return (name or "Member").split(" ")[0]


@router.get("/public/vault/{token}")
def public_vault(token: str):
    """The public proof page (no login): the goal, its escrow state and the vault on Solana.
    Shows first names only; anyone can re-check everything against the blockchain."""
    if not token or len(token) > 40:
        raise HTTPException(404, "Proof page not found")
    with db.connect() as conn:
        goal = conn.execute("SELECT * FROM goals WHERE public_token = ?", (token,)).fetchone()
        if goal is None:
            raise HTTPException(404, "Proof page not found")
        group_name = conn.execute("SELECT name FROM groups WHERE id = ?", (goal["group_id"],)).fetchone()["name"]
        names = {r["id"]: _first(r["display_name"]) for r in conn.execute(
            "SELECT u.id, u.display_name FROM users u JOIN contributions c ON c.user_id = u.id WHERE c.goal_id = ? "
            "UNION SELECT u.id, u.display_name FROM users u JOIN group_members m ON m.user_id = u.id WHERE m.group_id = ?",
            (goal["id"], goal["group_id"]))}
        escrow = escrow_state(conn, goal, None)
        escrow["released_to"] = _first(escrow["released_to"]) if escrow["released_to"] else None
        members = len(names)
    vault = solana_vault.vault_info(goal["id"], names, escrow)
    return {
        "goal": {"title": goal["title"], "group": group_name, "target": dollars(goal["target_cents"]),
                 "deadline": goal["deadline"], "created_at": goal["created_at"], "completed_at": goal["completed_at"],
                 "members": members},
        "escrow": escrow,
        "vault": vault,
    }


@router.get("/public/qr.svg")
def qr_svg(data: str):
    """A QR code (SVG) for a share link, so a phone can open the proof page."""
    from fastapi.responses import Response
    if not data or len(data) > 300 or not data.startswith(("http://", "https://")):
        raise HTTPException(400, "Give a link to encode")
    try:
        import qrcode
        import qrcode.image.svg
    except ImportError:
        raise HTTPException(503, "QR codes need the 'qrcode' package: pip install -r requirements.txt")
    img = qrcode.make(data, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    return Response(img.to_string(encoding="unicode"), media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=86400"})


@router.delete("/contributions/{contribution_id}")
def undo_contribution(contribution_id: int, user: dict = Depends(current_user)):
    """Undo one of your own contributions. The money goes back to your bank account."""
    with db.connect() as conn:
        row = conn.execute(
            "SELECT c.*, g.group_id, g.title, g.released_at FROM contributions c JOIN goals g ON g.id = c.goal_id WHERE c.id = ?",
            (contribution_id,),
        ).fetchone()
        if row is None or row["user_id"] != user["id"]:
            raise HTTPException(404, "Contribution not found")
        if row["released_at"]:
            raise HTTPException(409, "This goal's vault has already been paid out, so this can't be undone")

    how = "removed"
    if row["nessie_id"]:
        try:
            how = banking.remove(row["nessie_type"], row["nessie_id"], reason="contribution undone")
        except nessie.NessieError as e:
            raise HTTPException(502, f"The bank couldn't return the money: {e}")

    with db.connect() as conn:
        conn.execute("DELETE FROM contributions WHERE id = ?", (contribution_id,))
        _log(conn, row["group_id"], user["id"], "contribution_removed",
             f"{user['display_name']} took back ${dollars(row['amount_cents']):,.2f} from “{row['title']}”")
    # Take its GSD back out of the goal's on-chain vault (after the database write above is done).
    solana_vault.enqueue_refund(contribution_id, f"Gatorstar | goal {row['goal_id']} | contribution {contribution_id} undone | "
                                                 f"${dollars(row['amount_cents']):,.2f} back to the member")
    return {"status": how}
