"""Build the demo baseline ONCE: realistic bank history in Nessie + app data.

Run it with the server STOPPED:  venv\\Scripts\\python.exe demo_setup.py

What it creates
---------------
In Nessie (new bank profiles, so the old test data doesn't get in the way):
  - Maya Johnson   (student, part-time job)   Checking + Savings
  - Carlos Rivera  (student, part-time job)   Checking + Credit Card
  - Priya Patel    (salaried analyst)          Checking + Savings + Credit Card
  - about 3 months of history each, ending yesterday: paychecks, rent and bills,
    everyday purchases at categorized merchants, ATM withdrawals, transfers to
    savings and credit card payments. Amounts are random but repeatable, and
    accounts never go below $50.

In the app (app.db):
  - demo profiles @maya, @carlos, @priya (password demo1234) linked to those
    bank profiles
  - all three are already friends (no pending requests)
  - group "Spring Break Crew" with the goal "Miami spring break" ($3,000).
    Everyone committed $1,000 and has saved some, and every saved dollar is a
    real withdrawal in Nessie, so it's on their statements.

Then it saves that state as the baseline (demo_baseline.db + demo_bank.json).
reset_demo.py puts everything back to exactly this baseline after a demo run.

Run it once. If it has already run, it stops (use --force to build a brand-new
set of bank profiles).
"""
import random
import shutil
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
import json

import banking
import db
import nessie
from auth import hash_password

HERE = Path(__file__).parent
DEMO_BANK = db.DATA_DIR / "demo_bank.json"
BASELINE = db.DATA_DIR / "demo_baseline.db"
DEMO_PASSWORD = "demo1234"

END = date.today() - timedelta(days=1)       # history ends yesterday
START = END - timedelta(days=88)             # about 3 months

# Invented businesses: name -> category (category drives the dashboard)
MERCHANTS = {
    "Juniper & Stone": "Dining", "Midtown Noodle Bar": "Dining", "Bean There Coffee": "Dining",
    "Greenleaf Grocer": "Groceries", "Sunshine Market": "Groceries",
    "North & Loom": "Shopping", "Pixel Outfitters": "Shopping",
    "CityRide": "Transport", "FuelUp Gas": "Transport",
    "Campus Books": "Other", "Starlight Cinema": "Other",
}
NOTES = {
    "Juniper & Stone": ["Dinner", "Dinner with friends", "Date night", "Birthday dinner"],
    "Midtown Noodle Bar": ["Lunch", "Takeout", "Ramen night"],
    "Bean There Coffee": ["Latte", "Iced coffee", "Coffee and a muffin"],
    "Greenleaf Grocer": ["Weekly groceries", "Groceries"],
    "Sunshine Market": ["Groceries", "Snacks and produce"],
    "North & Loom": ["Jacket", "Shoes", "Sweater", "Jeans"],
    "Pixel Outfitters": ["Headphones", "Phone case", "Charger", "Keyboard"],
    "CityRide": ["Ride to campus", "Ride home", "Ride downtown", "Ride to work"],
    "FuelUp Gas": ["Gas"],
    "Campus Books": ["Textbook", "Notebooks and pens"],
    "Starlight Cinema": ["Movie night"],
}

# How each person spends: (merchants, times per week, low, high, account type)
PERSONAS = [
    {
        "username": "maya", "first": "Maya", "last": "Johnson", "seed": 11,
        "address": ("101", "University Ave", "Gainesville", "FL", "32601"),
        "accounts": [("Checking", "Everyday Checking", 1250), ("Savings", "Emergency Fund", 2600)],
        "pay": {"desc": "Paycheck · Campus Bookstore", "amount": 780, "every": 14, "first_offset": 4},
        "bills": [(1, "Rent · Oakwood Apartments", 650), (8, "Phone · Gator Wireless", 45), (14, "Music · Melodia", 11.99)],
        "transfers": [(3, "Savings", 100, "Monthly savings")],
        "atm": (14, 40),
        "spend": [
            (["Juniper & Stone", "Midtown Noodle Bar"], 1.5, 12, 48, "Checking"),
            (["Bean There Coffee"], 1.5, 4, 8, "Checking"),
            (["Greenleaf Grocer", "Sunshine Market"], 1, 35, 85, "Checking"),
            (["CityRide"], 1, 12, 22, "Checking"),
            (["North & Loom", "Pixel Outfitters"], 0.5, 25, 90, "Checking"),
            (["Campus Books", "Starlight Cinema"], 0.3, 14, 70, "Checking"),
        ],
    },
    {
        "username": "carlos", "first": "Carlos", "last": "Rivera", "seed": 22,
        "address": ("45", "Archer Rd", "Gainesville", "FL", "32608"),
        "accounts": [("Checking", "Student Checking", 900), ("Credit Card", "Starter Card", 0)],
        "pay": {"desc": "Paycheck · Riverside Diner", "amount": 560, "every": 14, "first_offset": 2},
        "bills": [(1, "Rent · Archer Commons", 500), (12, "Phone · Gator Wireless", 35)],
        "transfers": [(20, "Credit Card", 350, "Credit card payment")],
        "atm": (30, 20),
        "spend": [
            (["CityRide"], 3, 9, 24, "Credit Card"),
            (["FuelUp Gas"], 0.5, 25, 40, "Credit Card"),
            (["Midtown Noodle Bar", "Bean There Coffee"], 2, 6, 20, "Credit Card"),
            (["Greenleaf Grocer", "Sunshine Market"], 1, 25, 50, "Credit Card"),
            (["Campus Books"], 0.1, 40, 70, "Credit Card"),
        ],
    },
    {
        "username": "priya", "first": "Priya", "last": "Patel", "seed": 33,
        "address": ("2200", "SW 13th St", "Gainesville", "FL", "32608"),
        "accounts": [("Checking", "Main Checking", 3800), ("Savings", "House Fund", 14500), ("Credit Card", "Travel Rewards", 0)],
        "pay": {"desc": "Salary · Brightline Analytics", "amount": 2450, "days_of_month": (1, 15)},
        "bills": [(1, "Rent · Parkview Lofts", 1400), (5, "Gym · PeakFit", 40), (10, "Internet · FiberNet", 65)],
        "transfers": [(2, "Savings", 800, "Monthly savings"), (25, "Credit Card", 1200, "Credit card payment")],
        "atm": (30, 60),
        "spend": [
            (["North & Loom", "Pixel Outfitters"], 1, 30, 220, "Credit Card"),
            (["Juniper & Stone", "Midtown Noodle Bar"], 2, 18, 95, "Credit Card"),
            (["Greenleaf Grocer", "Sunshine Market"], 1, 70, 140, "Credit Card"),
            (["CityRide"], 1, 15, 30, "Credit Card"),
            (["Starlight Cinema"], 0.5, 16, 32, "Credit Card"),
        ],
    },
]

GROUP = {"name": "Spring Break Crew", "goal": "Miami spring break", "target_cents": 300_000, "share_cents": 100_000}
# (username, days after the goal was created, cents, note)
GOAL_SAVINGS = [("maya", 5, 20_000, "First paycheck of the month"), ("carlos", 12, 15_000, "Part-time job"),
                ("priya", 16, 30_000, "Bonus from work"), ("maya", 25, 22_000, "Skipped takeout this week")]


def stamp(d: date, hour: int = 15) -> str:
    return datetime.combine(d, time(hour), tzinfo=timezone.utc).isoformat(timespec="seconds")


def build_history(p, accounts, merchants, user_id, start=None, end=None, workers=1, progress=None):
    """Create a persona's transactions in Nessie, day by day, never going below $50.
    start/end default to the demo window (about 3 months ending yesterday).

    workers > 1 sends that many Nessie writes at once (much faster; order doesn't
    matter because balances are worked out from all transactions together).
    progress, if given, is a dict kept up to date as {"done": n, "total": n}."""
    import threading
    from concurrent.futures import ThreadPoolExecutor
    count_lock = threading.Lock()
    start, end = start or START, end or END
    pool = ThreadPoolExecutor(max_workers=workers) if workers > 1 else None
    jobs = []
    if progress is not None:
        progress.update(done=0, total=0)

    def _finished(_job):
        if progress is not None:
            with count_lock:
                progress["done"] = progress.get("done", 0) + 1

    def do(fn, *args, **kwargs):
        """Run one Nessie write now, or queue it on the pool."""
        if progress is not None:
            progress["total"] = progress.get("total", 0) + 1
        if pool is None:
            fn(*args, **kwargs)
            _finished(None)
            return
        job = pool.submit(fn, *args, **kwargs)
        job.add_done_callback(_finished)
        jobs.append(job)

    rng = random.Random(p["seed"])
    by_type = {t: aid for (t, _, _), aid in zip(p["accounts"], accounts)}
    account_names = {aid: nick for (_, nick, _), aid in zip(p["accounts"], accounts)}
    balance = {aid: float(opening) for (_, _, opening), aid in zip(p["accounts"], accounts)}
    checking = by_type["Checking"]
    count = 0

    def can_spend(aid, amount):
        return by_type.get("Credit Card") == aid or balance[aid] - amount >= 50

    def money_out(aid, cents):
        balance[aid] -= cents / 100

    day = start
    while day <= end:
        when = day.isoformat()
        pay = p["pay"]
        if ("every" in pay and (day - start).days % pay["every"] == pay["first_offset"]) or \
           (day.day in pay.get("days_of_month", ())):
            do(banking.deposit, checking, pay["amount"] * 100, pay["desc"], user_id=user_id, source="seed", when=when)
            balance[checking] += pay["amount"]; count += 1

        for dom, name, amount in p["bills"]:
            if day.day == dom and can_spend(checking, amount):
                do(banking.create, "bills", checking, {"status": "completed", "payee": name.split(" · ")[-1],
                               "nickname": name, "payment_date": when, "recurring_date": dom,
                               "payment_amount": amount}, user_id=user_id, source="seed",
                               cents=round(amount * 100), description=name)
                money_out(checking, round(amount * 100)); count += 1

        for dom, to_type, amount, desc in p["transfers"]:
            if day.day == dom and to_type in by_type and can_spend(checking, amount):
                to = by_type[to_type]
                do(banking.transfer, checking, to, amount * 100, desc, account_names, user_id=user_id, source="seed", when=when)
                money_out(checking, amount * 100); balance[to] += amount; count += 1

        every, atm = p["atm"]
        if (day - start).days % every == every // 2 and can_spend(checking, atm):
            do(banking.withdraw, checking, atm * 100, "ATM withdrawal", user_id=user_id, source="seed", when=when)
            money_out(checking, atm * 100); count += 1

        for names, per_week, low, high, acct_type in p["spend"]:
            if rng.random() < per_week / 7:
                name = rng.choice(names)
                cents = rng.randint(low * 100, high * 100)
                aid = by_type.get(acct_type, checking)
                if can_spend(aid, cents / 100):
                    do(banking.purchase, aid, merchants[name], cents, rng.choice(NOTES[name]),
                                     user_id=user_id, source="seed", when=when)
                    money_out(aid, cents); count += 1
        day += timedelta(days=1)
    if pool is not None:
        pool.shutdown(wait=True)
        for job in jobs:
            job.result()  # re-raise the first failure, if any
    return count, balance


def create_merchants() -> dict:
    """Create the invented merchants in Nessie. Returns {name: merchant_id}."""
    merchants = {}
    for name, category in MERCHANTS.items():
        mid = nessie._created_id(nessie._request("POST", "/merchants", {
            "name": name, "category": category,
            "address": {"street_number": "100", "street_name": "Main St", "city": "Gainesville", "state": "FL", "zip": "32601"},
            "geocode": {"lat": 29.6516, "lng": -82.3248}}))
        merchants[name] = mid
        banking.remember_merchant(mid, name, category)
    return merchants


def setup(force: bool = False, workers: int = 8):
    if DEMO_BANK.exists() and not force:
        print("The demo is already set up (demo_bank.json exists), so nothing was changed.")
        print("To put the demo back to its baseline, run reset_demo.py.")
        print("To build brand-new bank profiles anyway, run: demo_setup.py --force")
        return

    print(f"Building demo history from {START:%b %d} to {END:%b %d, %Y}. This takes a minute or two...\n")
    with db.connect() as conn:
        for table in ("contributions", "goal_commitments", "goals", "group_activity", "group_invites",
                      "group_members", "groups", "friendships", "sessions", "nessie_activity", "nessie_hidden"):
            conn.execute(f"DELETE FROM {table}")

    # Merchants (shared by everyone)
    merchants = create_merchants()
    print(f"Created {len(merchants)} merchants")

    saved = {"created_at": db.now(), "history": [START.isoformat(), END.isoformat()],
             "merchants": {n: {"id": i, "category": MERCHANTS[n]} for n, i in merchants.items()}, "people": {}}
    user_ids = {}

    for p in PERSONAS:
        # App profile (created if missing) and a fresh bank profile linked to it.
        with db.connect() as conn:
            row = conn.execute("SELECT id FROM users WHERE username = ?", (p["username"],)).fetchone()
            if row:
                uid = row["id"]
                conn.execute("UPDATE users SET is_demo = 1, password_hash = ?, display_name = ? WHERE id = ?",
                             (hash_password(DEMO_PASSWORD), f"{p['first']} {p['last']}", uid))
            else:
                uid = conn.execute(
                    "INSERT INTO users (username, password_hash, display_name, is_demo, created_at) VALUES (?, ?, ?, 1, ?)",
                    (p["username"], hash_password(DEMO_PASSWORD), f"{p['first']} {p['last']}", db.now())).lastrowid
        user_ids[p["username"]] = uid

        customer_id = nessie.create_customer(p["first"], p["last"], *p["address"])
        accounts = [nessie.create_account(customer_id, t, nick, balance=opening) for t, nick, opening in p["accounts"]]
        with db.connect() as conn:
            conn.execute("DELETE FROM bank_links WHERE user_id = ?", (uid,))
            conn.execute("INSERT INTO bank_links (user_id, nessie_customer_id, linked_at) VALUES (?, ?, ?)",
                         (uid, customer_id, stamp(START, 12)))

        count, balance = build_history(p, accounts, merchants, uid, workers=workers)
        saved["people"][p["username"]] = {"customer_id": customer_id,
                                          "accounts": {nick: aid for (_, nick, _), aid in zip(p["accounts"], accounts)}}
        print(f"@{p['username']}: bank profile {customer_id}, {count} transactions, "
              + ", ".join(f"{nick} ${balance[aid]:,.2f}" for (_, nick, _), aid in zip(p["accounts"], accounts)))

    # Friends, group, goal and its savings (each saving is a real withdrawal in Nessie).
    maya, carlos, priya = (user_ids[u] for u in ("maya", "carlos", "priya"))
    goal_created = END - timedelta(days=32)
    deadline = END + timedelta(days=140)
    with db.connect() as conn:
        for a, b in ((maya, carlos), (maya, priya), (carlos, priya)):
            low, high = sorted((a, b))
            conn.execute("INSERT INTO friendships (requester_id, addressee_id, status, created_at, responded_at, pair_low, pair_high) "
                         "VALUES (?, ?, 'accepted', ?, ?, ?, ?)", (a, b, stamp(START), stamp(START, 18), low, high))
        gid = conn.execute("INSERT INTO groups (name, owner_id, created_at) VALUES (?, ?, ?)",
                           (GROUP["name"], maya, stamp(goal_created, 14))).lastrowid
        goal_id = conn.execute(
            "INSERT INTO goals (group_id, title, target_cents, deadline, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (gid, GROUP["goal"], GROUP["target_cents"], deadline.isoformat(), maya, stamp(goal_created, 14))).lastrowid
        # Goal rules (groups.py): weekly payments, and an honor-code dare for missing one.
        conn.execute("UPDATE goals SET frequency = 'weekly', penalty_type = 'honor', penalty_dare = ?, pace = 'Steady', "
                     "realism_score = 8, realism_note = ? WHERE id = ?",
                     ("Buy the group's next round of coffee",
                      "About $42 a week each fits comfortably alongside part-time paychecks.", goal_id))
        log = [(maya, "create", "Maya Johnson created the group", stamp(goal_created, 14)),
               (maya, "goal", f"Maya Johnson created the goal “{GROUP['goal']}”: $3,000.00 by {deadline:%b %d, %Y}", stamp(goal_created, 14))]
        for i, (uid, name) in enumerate(((maya, "Maya Johnson"), (carlos, "Carlos Rivera"), (priya, "Priya Patel"))):
            joined = stamp(goal_created + timedelta(days=i), 16)
            conn.execute("INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)", (gid, uid, joined))
            conn.execute("INSERT INTO goal_commitments (goal_id, user_id, share_cents, committed_at) VALUES (?, ?, ?, ?)",
                         (goal_id, uid, GROUP["share_cents"], joined))
            if uid != maya:
                log.append((uid, "join", f"{name} joined the group", joined))
            log.append((uid, "commit", f"{name} committed $1,000.00 to “{GROUP['goal']}”", joined))

    for username, after, cents, note in GOAL_SAVINGS:
        uid = user_ids[username]
        when = goal_created + timedelta(days=after)
        checking = next(iter(saved["people"][username]["accounts"].values()))
        desc = f"Saved for “{GROUP['goal']}” · {GROUP['name']}"
        nid = banking.withdraw(checking, cents, desc, user_id=uid, source="seed", when=when.isoformat())
        name = {"maya": "Maya Johnson", "carlos": "Carlos Rivera", "priya": "Priya Patel"}[username]
        with db.connect() as conn:
            conn.execute("INSERT INTO contributions (goal_id, user_id, amount_cents, note, created_at, nessie_type, nessie_id, account_id) "
                         "VALUES (?, ?, ?, ?, ?, 'withdrawals', ?, ?)", (goal_id, uid, cents, note, stamp(when, 17), nid, checking))
        log.append((uid, "contribution", f"{name} moved ${cents / 100:,.2f} into “{GROUP['goal']}”", stamp(when, 17)))

    with db.connect() as conn:
        for uid, kind, message, when in sorted(log, key=lambda r: r[3]):
            conn.execute("INSERT INTO group_activity (group_id, user_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)",
                         (gid, uid, kind, message, when))
    print(f"\nMaya, Carlos and Priya are friends; '{GROUP['name']}' has the goal '{GROUP['goal']}' with $870 saved.")

    DEMO_BANK.write_text(json.dumps(saved, indent=2))
    with db.connect() as conn:
        if BASELINE.exists():
            BASELINE.unlink()
        conn.execute("VACUUM INTO ?", (str(BASELINE),))
    print(f"Saved the baseline ({BASELINE.name}, {DEMO_BANK.name}). reset_demo.py returns to it any time.")
    print(f"\nDone! Log in as maya, carlos or priya (password {DEMO_PASSWORD}).")


# ---------- Automatic setup when the server starts ----------
# Railway starts every deploy with an empty app.db, so the demo users (and the
# one-click demo logins) would be missing until someone ran this script by hand.
# server.py calls ensure_demo() at startup instead:
#   - demo users already there              -> nothing to do
#   - empty app.db + a saved baseline        -> restore the baseline (instant)
#   - empty app.db and no baseline           -> build the demo in the background (~1 min)
#   - real profiles but no demo users        -> leave everything alone
# Only in demo mode (FINAPP_DEV not 0). FINAPP_AUTO_DEMO=0 turns it off.
demo_status = {"status": "unknown"}   # ready | building | failed | off | missing


def _has_users(conn, demo_only=False) -> bool:
    sql = "SELECT 1 FROM users" + (" WHERE is_demo = 1" if demo_only else "") + " LIMIT 1"
    return conn.execute(sql).fetchone() is not None


def ensure_demo():
    import os
    import threading
    import auth
    if not auth.DEV_MODE or os.getenv("FINAPP_AUTO_DEMO", "1") == "0":
        demo_status["status"] = "off"
        return
    with db.connect() as conn:
        has_demo, has_any = _has_users(conn, demo_only=True), _has_users(conn)
    if has_demo:
        demo_status["status"] = "ready"
        return
    if has_any:
        demo_status["status"] = "missing"
        print("Demo users are missing but other profiles exist, so the demo wasn't set up automatically. Run demo_setup.py.")
        return
    if BASELINE.exists():
        shutil.copyfile(BASELINE, db.DB_PATH)
        db.init()
        demo_status["status"] = "ready"
        print("Restored the demo baseline (maya, carlos, priya).")
        return

    def build():
        try:
            setup(force=True)
            demo_status["status"] = "ready"
        except Exception as e:
            demo_status["status"] = "failed"
            print(f"Automatic demo setup failed: {e}")

    demo_status["status"] = "building"
    print("No demo users yet: building them in the background (about a minute)...")
    threading.Thread(target=build, daemon=True, name="demo-setup").start()


if __name__ == "__main__":
    setup(force="--force" in sys.argv)
