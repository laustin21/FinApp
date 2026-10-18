"""Notifications for the bell icon in the header.

Nothing new is stored per notification. The list is built on the fly from what
the app already records:

  friend_request   someone sent you a friend request (still pending)
  friend_accepted  someone accepted a request you sent
  group_invite     you were invited to a group (still pending)
  group_activity   something happened in one of your groups (goals, savings,
                   joins...), done by someone other than you
  cheer            a friend cheered you on from the leaderboard (budget.py)
  reaction         a friend reacted to one of your updates in the Social feed (social.py)

The only thing saved is when you last opened the bell (notification_reads), so
items newer than that show as unread.

  GET  /api/notifications       -> {unread_count, items: [...]}, newest first
  POST /api/notifications/seen  -> marks everything as read
"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

import db
from auth import current_user

router = APIRouter(prefix="/api")

MAX_ITEMS = 30
LOOKBACK_DAYS = 30

with db.connect() as _conn:
    _conn.execute(
        """CREATE TABLE IF NOT EXISTS notification_reads (
               user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
               last_seen_at TEXT NOT NULL
           )"""
    )


def _items(conn, user_id: int) -> list[dict]:
    since = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).isoformat(timespec="seconds")
    items = []

    for r in conn.execute(
        """SELECT f.id, f.created_at, u.display_name, u.username
           FROM friendships f JOIN users u ON u.id = f.requester_id
           WHERE f.addressee_id = ? AND f.status = 'pending'""",
        (user_id,),
    ):
        items.append({
            "id": f"friend_request-{r['id']}", "kind": "friend_request", "created_at": r["created_at"],
            "title": f"{r['display_name']} sent you a friend request",
            "body": f"@{r['username']} wants to connect.", "target": "Social",
        })

    for r in conn.execute(
        """SELECT f.id, f.responded_at, u.display_name
           FROM friendships f JOIN users u ON u.id = f.addressee_id
           WHERE f.requester_id = ? AND f.status = 'accepted' AND f.responded_at >= ?""",
        (user_id, since),
    ):
        items.append({
            "id": f"friend_accepted-{r['id']}", "kind": "friend_accepted", "created_at": r["responded_at"],
            "title": f"{r['display_name']} accepted your friend request",
            "body": "You can now invite them to groups.", "target": "Social",
        })

    for r in conn.execute(
        """SELECT i.id, i.created_at, g.name, u.display_name
           FROM group_invites i JOIN groups g ON g.id = i.group_id JOIN users u ON u.id = i.inviter_id
           WHERE i.invitee_id = ?""",
        (user_id,),
    ):
        items.append({
            "id": f"group_invite-{r['id']}", "kind": "group_invite", "created_at": r["created_at"],
            "title": f"{r['display_name']} invited you to {r['name']}",
            "body": "Open Groups to accept or decline.", "target": "Groups",
        })

    for r in conn.execute(
        """SELECT a.id, a.kind, a.message, a.created_at, g.name
           FROM group_activity a
           JOIN groups g ON g.id = a.group_id
           JOIN group_members m ON m.group_id = a.group_id AND m.user_id = ?
           WHERE (a.user_id IS NULL OR a.user_id != ?) AND a.created_at >= ?
             AND a.kind NOT IN ('invite', 'create')""",
        (user_id, user_id, since),
    ):
        items.append({
            "id": f"group_activity-{r['id']}", "kind": "group_activity", "created_at": r["created_at"],
            "title": r["message"], "body": r["name"], "target": "Groups",
        })

    for r in conn.execute(
        """SELECT c.id, c.created_at, u.display_name FROM budget_cheers c JOIN users u ON u.id = c.from_id
           WHERE c.to_id = ? AND c.created_at >= ?""",
        (user_id, since),
    ):
        items.append({
            "id": f"cheer-{r['id']}", "kind": "cheer", "created_at": r["created_at"],
            "title": f"{r['display_name']} cheered you on 👏",
            "body": "Keep up the good budgeting this week!", "target": "Social",
        })

    for r in conn.execute(
        """SELECT x.item_id, x.emoji, x.summary, x.created_at, u.display_name FROM feed_reactions x JOIN users u ON u.id = x.user_id
           WHERE x.actor_id = ? AND x.user_id != ? AND x.created_at >= ?""",
        (user_id, user_id, since),
    ):
        items.append({
            "id": f"reaction-{r['item_id']}-{r['display_name']}-{r['emoji']}", "kind": "reaction", "created_at": r["created_at"],
            "title": f"{r['display_name']} reacted {r['emoji']} to your update",
            "body": r["summary"], "target": "Social",
        })

    items.sort(key=lambda i: i["created_at"] or "", reverse=True)
    return items[:MAX_ITEMS]


@router.get("/notifications")
def list_notifications(user: dict = Depends(current_user)):
    with db.connect() as conn:
        row = conn.execute("SELECT last_seen_at FROM notification_reads WHERE user_id = ?", (user["id"],)).fetchone()
        last_seen = row["last_seen_at"] if row else ""
        items = _items(conn, user["id"])
    for item in items:
        item["unread"] = (item["created_at"] or "") > last_seen
    return {"unread_count": sum(i["unread"] for i in items), "items": items}


@router.post("/notifications/seen")
def mark_seen(user: dict = Depends(current_user)):
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO notification_reads (user_id, last_seen_at) VALUES (?, ?)
               ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at""",
            (user["id"], db.now()),
        )
    return {"ok": True}
