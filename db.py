"""The app's own database (app.db, SQLite, created automatically).

Nessie holds the bank data. This database holds everything that belongs to
the app itself:

  users        app profiles (name, username, hashed password)
  sessions     login tokens (only a hash of each token is stored)
  bank_links   which Nessie customer each app user has linked
  friendships  friend requests and friends, between app users

Friends, groups and goals always point at app user IDs, never Nessie IDs,
so they keep working if someone unlinks or switches banks.
"""
import sqlite3
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

# Where app.db (and the demo baseline files) live. Defaults to this folder.
# On Railway, point FINAPP_DATA_DIR at a mounted Volume (e.g. /data) so accounts
# and demo data survive redeploys.
DATA_DIR = Path(os.getenv("FINAPP_DATA_DIR") or Path(__file__).parent)
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "app.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    is_demo       INTEGER NOT NULL DEFAULT 0,   -- 1 = seeded demo user (one-click login)
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- One bank customer can only be linked to one app user.
-- (One link per user is enforced in bank.py, so allowing several later
--  only means relaxing that check, not changing this table.)
CREATE TABLE IF NOT EXISTS bank_links (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nessie_customer_id TEXT NOT NULL UNIQUE,
    linked_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS friendships (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    created_at   TEXT NOT NULL,
    responded_at TEXT,
    -- the two user IDs in sorted order, so a pair can only have one row
    pair_low     INTEGER NOT NULL,
    pair_high    INTEGER NOT NULL,
    UNIQUE (pair_low, pair_high)
);

-- ---------- Groups and shared goals (see groups.py) ----------
-- Money is stored in whole cents (INTEGER) so totals never have rounding errors.

CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    owner_id   INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_invites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    UNIQUE (group_id, invitee_id)
);

CREATE TABLE IF NOT EXISTS goals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    target_cents INTEGER NOT NULL CHECK (target_cents > 0),
    deadline     TEXT NOT NULL,          -- YYYY-MM-DD
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL
);

-- A member "commits" to a goal by taking on a share of the target.
CREATE TABLE IF NOT EXISTS goal_commitments (
    goal_id      INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    share_cents  INTEGER NOT NULL CHECK (share_cents > 0),
    committed_at TEXT NOT NULL,
    PRIMARY KEY (goal_id, user_id)
);

CREATE TABLE IF NOT EXISTS contributions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id      INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    -- The Nessie transaction that moved the money (NULL for older, log-only entries)
    nessie_type  TEXT,
    nessie_id    TEXT,
    account_id   TEXT
);

-- Every transaction this app created in Nessie, so a demo can be reset
-- (source: 'seed' = part of the demo baseline, 'contribution', 'simulation').
CREATE TABLE IF NOT EXISTS nessie_activity (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source       TEXT NOT NULL,
    nessie_type  TEXT NOT NULL,   -- deposits, withdrawals, purchases, transfers, bills
    nessie_id    TEXT NOT NULL,
    account_id   TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL
);

-- Nessie transactions the app should ignore. Nessie can't delete withdrawals or
-- purchases, so undoing one (or resetting the demo) hides it here instead.
CREATE TABLE IF NOT EXISTS nessie_hidden (
    nessie_id   TEXT PRIMARY KEY,
    nessie_type TEXT NOT NULL,
    hidden_at   TEXT NOT NULL,
    reason      TEXT NOT NULL DEFAULT ''
);

-- What happened in a group, newest first (joins, commitments, savings...).
CREATE TABLE IF NOT EXISTS group_activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind       TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _migrate_email_to_username(conn):
    """Older app.db files logged in by email. Convert them to usernames, keeping
    every user ID (so friends, groups and bank links stay attached).
    New usernames come from the part before the @ (maya@demo.finapp -> maya),
    with a number added if two would clash."""
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "email" not in columns:
        return
    # Keep a copy of the old file first, just in case.
    backup = DB_PATH.with_name("app.db.bak")
    if not backup.exists():
        conn.execute("VACUUM INTO ?", (str(backup),))
        print(f"app.db: saved a backup of the old database to {backup.name}")

    rows = conn.execute("SELECT * FROM users ORDER BY id").fetchall()
    taken, converted = set(), []
    for r in rows:
        base = "".join(ch for ch in r["email"].split("@")[0].lower() if ch.isalnum() or ch in "._")[:20] or "user"
        name, n = base, 2
        while name in taken:
            name, n = f"{base[:18]}{n}", n + 1
        taken.add(name)
        converted.append((r["id"], name, r["password_hash"], r["display_name"],
                          int(r["email"].endswith("@demo.finapp")), r["created_at"]))

    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("DROP TABLE IF EXISTS users_new")
    conn.execute(SCHEMA.split(";")[0].replace("CREATE TABLE IF NOT EXISTS users", "CREATE TABLE users_new"))
    conn.executemany(
        "INSERT INTO users_new (id, username, password_hash, display_name, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        converted,
    )
    conn.execute("DROP TABLE users")
    conn.execute("ALTER TABLE users_new RENAME TO users")
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    print(f"app.db: switched {len(converted)} users from email to username logins: "
          + ", ".join(c[1] for c in converted))


def _add_missing_columns(conn):
    """Columns added after a table first shipped (CREATE TABLE IF NOT EXISTS won't add them)."""
    have = {r["name"] for r in conn.execute("PRAGMA table_info(contributions)")}
    for column in ("nessie_type", "nessie_id", "account_id"):
        if column not in have:
            conn.execute(f"ALTER TABLE contributions ADD COLUMN {column} TEXT")

    # Goal terms (groups.py): payment schedule, missed-payment penalty, and the
    # Gemini goal coach's read on how realistic the goal is.
    have = {r["name"] for r in conn.execute("PRAGMA table_info(goals)")}
    for column, kind in (
        ("frequency", "TEXT NOT NULL DEFAULT 'none'"),      # none | weekly | biweekly | monthly
        ("penalty_type", "TEXT NOT NULL DEFAULT 'none'"),   # none | money | honor
        ("penalty_percent", "REAL NOT NULL DEFAULT 0"),     # money: % added to a missed payment
        ("penalty_dare", "TEXT"),                           # honor: what someone who misses has to do
        ("pace", "TEXT"),                                   # e.g. "Steady", from the coach
        ("realism_score", "INTEGER"),                       # 1-10, from the coach
        ("realism_note", "TEXT"),
        ("coach_summary", "TEXT"),
    ):
        if column not in have:
            conn.execute(f"ALTER TABLE goals ADD COLUMN {column} {kind}")


def init():
    with connect() as conn:
        exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").fetchone()
        if exists:
            _migrate_email_to_username(conn)
        conn.executescript(SCHEMA)
        _add_missing_columns(conn)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


init()
