"""Live updates: tell every open app when something changed, so pages refresh on
their own (User A creates a goal -> User B sees it within a couple of seconds).

How it works (simple on purpose):
  - The server keeps a small counter per topic: friends, groups, money.
  - Any successful change (POST/PUT/PATCH/DELETE) bumps the topic(s) it touches.
    This happens in one middleware, so new endpoints are covered automatically.
  - Every open app asks GET /api/live every ~2 s (a tiny, instant request) and
    reloads only the pages whose topic moved.

Counters live in memory: a restart resets them, and apps simply reload once.
"""
import itertools
import threading
import time

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api")

_boot = int(time.time())          # changes on restart, so apps know to reload everything
_lock = threading.Lock()
_counter = itertools.count(1)
_versions = {"friends": 0, "groups": 0, "money": 0}

# Which topics a change to each part of the API affects.
_ROUTES = [
    ("/api/friend-requests", ("friends", "groups")),   # new friends can be invited to groups
    ("/api/friends", ("friends", "groups")),
    ("/api/group-invites", ("groups",)),
    ("/api/groups", ("groups",)),
    ("/api/goals", ("groups", "money")),            # contributions move money out of the bank
    ("/api/contributions", ("groups", "money")),
    ("/api/bank", ("money",)),
    ("/api/dev/simulate", ("money",)),
]


def bump(*topics: str):
    with _lock:
        n = next(_counter)
        for t in topics:
            _versions[t] = n


async def middleware(request: Request, call_next):
    response = await call_next(request)
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and 200 <= response.status_code < 300:
        path = request.url.path
        if path.endswith("/goal-coach"):
            return response  # chatting with the coach doesn't change anything
        for prefix, topics in _ROUTES:
            if path.startswith(prefix):
                bump(*topics)
                break
    return response


@router.get("/live")
def live():
    """Current change counters. Cheap enough to ask every couple of seconds."""
    return {"boot": _boot, **_versions}
