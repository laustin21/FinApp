"""Learn: short money lessons with a quiz, tailored by Gemini to the user's own spending,
plus an Ask box for money questions. Part of the Budget tab (see budget.py).

  GET  /api/learn                       the lessons, which ones are recommended for you, your progress
  GET  /api/learn/lessons/{key}         one lesson (Gemini personalizes it once a week; quiz answers stay on the server)
  POST /api/learn/lessons/{key}/quiz    {answers: [0-3, ...]} -> results; 2 of 3 right earns +10 points
                                        (once per lesson per week, up to 3 lessons a week)
  POST /api/learn/ask                   {question, history} -> {answer, follow_ups}

Every lesson has a built-in version, so Learn works without Gemini too.
Educational only: no investment advice.
"""
from __future__ import annotations

import json
import random
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import budget
import db
import gemini
from auth import current_user

router = APIRouter(prefix="/api")

LESSON_BUDGET_SECONDS = 22
ASK_BUDGET_SECONDS = 20

# Each lesson: the facts Gemini must teach, plus a complete built-in version.
LESSONS = {
    "budget-basics": {
        "title": "Build a budget that sticks", "minutes": 3, "emoji": "🧭",
        "blurb": "Weekly limits, the 50/30/20 rule, and why simple beats perfect.",
        "facts": "A budget is a plan for your money before you spend it. The 50/30/20 rule: about 50% of income for needs, "
                 "30% for wants, 20% for savings and debt. Weekly limits are easier to stick to than monthly ones because "
                 "you get a fresh start every Monday. Track a few categories, not dozens. Review and adjust weekly.",
        "sections": [
            ("What a budget really is", "A budget is just a plan for your money before you spend it. It isn't about saying no to everything; it's about choosing what matters most to you."),
            ("The 50/30/20 rule", "A simple starting point: about 50% of what you earn goes to needs (rent, groceries, transport), 30% to wants (eating out, shopping, fun) and 20% to savings or paying down debt."),
            ("Why weekly works", "Weekly limits give you a fresh start every Monday. If you overspend on Tuesday, you see it right away and can adjust by Friday, instead of finding out at the end of the month."),
        ],
        "takeaway": "Start simple: a weekly limit for your 3-5 biggest categories, checked once a week.",
        "try_this": "Set a weekly budget for your two biggest categories and check it every Sunday night.",
        "quiz": [
            ("In the 50/30/20 rule, what is the 20% for?", ["Eating out", "Savings and paying down debt", "Rent", "Shopping"], 1,
             "The 20% goes to your future: savings and paying down debt."),
            ("Why can weekly budgets be easier to stick to than monthly ones?", ["They're always bigger", "You get a fresh start every week and spot overspending sooner", "Banks require them", "They include fewer categories"], 1,
             "A weekly check means you catch overspending within days, not weeks."),
            ("What's the best way to start a budget?", ["Track every single cent in 30 categories", "Pick a few big categories and set weekly limits", "Only budget once a year", "Wait until you earn more"], 1,
             "Simple budgets are the ones people actually keep."),
        ],
    },
    "needs-wants": {
        "title": "Needs vs. wants", "minutes": 2, "emoji": "⚖️",
        "blurb": "Sort your spending so cutting back hurts less.",
        "facts": "Needs are things you must pay for to live and work: housing, groceries, basic transport, required bills. "
                 "Wants make life nicer but are optional: eating out, new clothes beyond basics, entertainment. Many purchases "
                 "are a mix (a need upgraded into a want, e.g. groceries vs takeout). Cut wants first, and only the ones you value least.",
        "sections": [
            ("Needs", "Needs keep you housed, fed, healthy and able to get to class or work: rent, groceries, basic transport, required bills."),
            ("Wants", "Wants make life more fun but you could skip them: takeout, new clothes beyond the basics, concerts, games. Wants are good! They just come second."),
            ("The upgrade trap", "Lots of spending is a need upgraded into a want: groceries become takeout, a bus ride becomes a rideshare. Spotting upgrades is the easiest way to save without giving up much."),
        ],
        "takeaway": "Cut the wants you value least first, and watch for needs that quietly became wants.",
        "try_this": "Look at your last 10 purchases and mark each one need, want, or upgraded need.",
        "quiz": [
            ("Which of these is usually a need?", ["Concert tickets", "Groceries", "A new phone case", "Takeout"], 1, "Food from the grocery store is a need; takeout is usually a want."),
            ("Taking a rideshare instead of the bus for a short trip is an example of…", ["A need", "An upgraded need", "Saving money", "An investment"], 1, "Getting there is the need; the rideshare is the upgrade."),
            ("When cutting back, what should you cut first?", ["Rent", "Groceries", "The wants you value least", "Everything equally"], 2, "Keep the wants you love; cut the ones you barely notice."),
        ],
    },
    "small-purchases": {
        "title": "Small purchases add up", "minutes": 2, "emoji": "☕",
        "blurb": "Why a $6 coffee habit can cost hundreds a year.",
        "facts": "Small, frequent purchases (coffee, snacks, rideshares, delivery fees) feel harmless but add up: $6 five times "
                 "a week is about $1,560 a year. Fix: notice frequency, set a weekly cap for the habit, swap some (not all) "
                 "occurrences, and redirect the savings to a goal.",
        "sections": [
            ("The math of tiny", "$6 doesn't feel like much. But $6 five times a week is $30 a week, about $130 a month, and about $1,560 a year."),
            ("Frequency beats price", "It's usually how often, not how much. Ten $8 lunches cost more than one $60 dinner out, and they're much easier to miss."),
            ("Swap, don't ban", "You don't have to quit. Swapping two of five coffee runs for coffee from home saves about $600 a year and still leaves you three treats a week."),
        ],
        "takeaway": "Count how often, not just how much, and swap some of the habit instead of quitting it.",
        "try_this": "Pick your most frequent small purchase and replace two of them this week.",
        "quiz": [
            ("Roughly how much is $6 a day, five days a week, over a year?", ["$300", "$780", "$1,560", "$6,000"], 2, "$6 × 5 × 52 ≈ $1,560."),
            ("What usually makes small purchases expensive?", ["High prices", "How often they happen", "Sales tax", "Credit card fees"], 1, "Frequency is what adds up."),
            ("What's a realistic way to cut a daily coffee habit?", ["Never buy coffee again", "Swap a couple of runs a week for coffee from home", "Buy bigger coffees", "Only pay with cash"], 1, "Small swaps stick better than bans."),
        ],
    },
    "impulse-buys": {
        "title": "Beat impulse buys", "minutes": 2, "emoji": "🛍️",
        "blurb": "The 24-hour rule and other tricks that actually work.",
        "facts": "Impulse buys are unplanned purchases triggered by emotion, sales, or ads. Tactics: the 24-hour rule (wait a day "
                 "for non-essential purchases), remove saved cards from shopping apps, unsubscribe from sale emails, keep a wish list, "
                 "and ask 'would I buy this at full price?'. A 'sale' isn't savings if you didn't plan to buy it.",
        "sections": [
            ("Why we impulse buy", "Sales, ads, boredom and stress all make spending feel good in the moment. That's normal. The trick is adding a little friction between the urge and the purchase."),
            ("The 24-hour rule", "For anything that isn't a need, wait 24 hours. Put it on a wish list. If you still want it tomorrow, it's a real choice, not an impulse."),
            ("Add friction", "Remove saved cards from shopping apps, unsubscribe from sale emails, and ask: would I buy this at full price? A sale isn't savings if you weren't going to buy it."),
        ],
        "takeaway": "Put a day between wanting something and buying it.",
        "try_this": "Unsubscribe from three store emails and start a wish list in your notes app.",
        "quiz": [
            ("What is the 24-hour rule?", ["Return items within 24 hours", "Wait a day before buying non-essentials", "Shop only after 24:00", "Pay bills within a day"], 1, "Waiting a day lets the impulse pass."),
            ("A 50%-off sale on something you didn't plan to buy is…", ["Always savings", "Not savings if you didn't need it", "An investment", "A need"], 1, "Spending less on something you didn't need is still spending."),
            ("Which adds helpful friction?", ["Saving your card in every app", "Removing saved cards from shopping apps", "Turning on sale notifications", "Shopping when stressed"], 1, "Extra steps give you a moment to reconsider."),
        ],
    },
    "emergency-fund": {
        "title": "Start an emergency fund", "minutes": 3, "emoji": "🛟",
        "blurb": "A cushion so surprises don't become debt.",
        "facts": "An emergency fund is money set aside only for real surprises (car repair, medical bill, job loss). Common "
                 "guidance: start with a mini fund of $500-$1,000, then build toward 3-6 months of essential expenses. Keep it "
                 "in a separate savings account so it's easy to reach but not to spend. Automate small weekly transfers.",
        "sections": [
            ("What it's for", "Real surprises only: a car repair, a medical bill, a lost job. Not concert tickets. It keeps a bad week from turning into credit card debt."),
            ("How much", "Start small: a mini fund of $500 to $1,000 covers most surprises. Over time, aim for 3 to 6 months of your essential expenses."),
            ("Make it automatic", "Keep it in a separate savings account and move a small amount every week, even $10. Automatic saving works because you don't have to remember."),
        ],
        "takeaway": "A small cushion first ($500-$1,000), built with automatic weekly transfers.",
        "try_this": "Move $10 to savings today and set a reminder to do it every week.",
        "quiz": [
            ("What is an emergency fund for?", ["Vacations", "Real surprises like a car repair", "Shopping sales", "Investing in stocks"], 1, "It's for genuine, unexpected costs."),
            ("A common first target for a starter emergency fund is…", ["$50", "$500 to $1,000", "$50,000", "One year of income"], 1, "A mini fund covers most surprises."),
            ("Why keep it in a separate account?", ["It earns stock returns", "It's easy to reach but harder to spend by accident", "Banks require it", "So you forget it exists"], 1, "Separation protects it from everyday spending."),
        ],
    },
    "smart-goals": {
        "title": "Set goals you'll actually hit", "minutes": 2, "emoji": "🎯",
        "blurb": "SMART goals, and why saving with friends helps.",
        "facts": "SMART goals are Specific, Measurable, Achievable, Relevant, Time-bound ('Save $600 for spring break by March 1' "
                 "beats 'save more'). Break big goals into weekly amounts. Accountability helps: sharing a goal with friends or "
                 "saving as a group makes you more likely to follow through. Celebrate milestones.",
        "sections": [
            ("SMART goals", "Specific, Measurable, Achievable, Relevant, Time-bound. 'Save $600 for spring break by March 1' is SMART. 'Save more money' isn't."),
            ("Make it weekly", "Divide the goal by the weeks left. $600 in 12 weeks is $50 a week, which is something you can plan around."),
            ("Bring friends", "People who share goals and check in with others follow through more often. Group goals and a friendly leaderboard make saving social."),
        ],
        "takeaway": "Name it, price it, date it, then break it into a weekly amount.",
        "try_this": "Turn one 'someday' wish into a SMART goal with a weekly amount, and share it with a friend.",
        "quiz": [
            ("Which goal is SMART?", ["Save more", "Be better with money", "Save $600 for spring break by March 1", "Spend less someday"], 2, "It's specific, measurable and has a deadline."),
            ("$600 over 12 weeks is about how much per week?", ["$5", "$50", "$120", "$600"], 1, "600 ÷ 12 = 50."),
            ("Why can saving with friends help?", ["It's required by banks", "Accountability makes you more likely to follow through", "You save less", "It removes deadlines"], 1, "Shared goals and check-ins build follow-through."),
        ],
    },
    "credit-cards": {
        "title": "Credit cards without the trap", "minutes": 3, "emoji": "💳",
        "blurb": "Interest, minimum payments, and building credit safely.",
        "facts": "Credit cards charge interest (APR, often 20%+) on any balance not paid in full by the due date. Paying only the "
                 "minimum can take years and cost much more. Pay the full statement balance every month to pay no interest. "
                 "Keep utilization (balance / limit) under about 30%. On-time payments are the biggest factor in your credit score.",
        "sections": [
            ("How interest works", "If you don't pay the full statement balance by the due date, the card charges interest on what's left, often 20% a year or more."),
            ("The minimum-payment trap", "Paying only the minimum keeps you in good standing but can take years to clear a balance and cost far more than you borrowed."),
            ("Build credit safely", "Pay the full balance every month, always on time, and keep your balance under about 30% of your limit. On-time payments matter most for your score."),
        ],
        "takeaway": "Use it like a debit card: only spend what you can pay off in full every month.",
        "try_this": "Turn on autopay for the full statement balance (or at least a reminder before the due date).",
        "quiz": [
            ("How do you avoid paying credit card interest?", ["Pay the minimum", "Pay the full statement balance by the due date", "Pay once a year", "Use the card more"], 1, "Paying in full means no interest."),
            ("What happens if you only pay the minimum?", ["The debt disappears", "It can take years and cost much more", "Your limit doubles", "Nothing"], 1, "Interest keeps building on the rest."),
            ("A good rule for credit utilization is to stay under about…", ["5%", "30%", "75%", "100%"], 1, "Under about 30% of your limit is a common guideline."),
        ],
    },
}


def _builtin(key: str) -> dict:
    l = LESSONS[key]
    return {
        "title": l["title"],
        "sections": [{"heading": h, "body": b} for h, b in l["sections"]],
        "takeaway": l["takeaway"], "try_this": l["try_this"],
        "quiz": [{"question": q, "options": o, "answer_index": a, "explanation": e} for q, o, a, e in l["quiz"]],
    }


def recommendations(user: dict) -> dict[str, str]:
    """Which lessons fit this user, and why (from their own spending and goals)."""
    ledger = budget.ledger_for(user["id"]) if user["bank_link"] else None
    stats = budget.spending_stats(budget.purchases(ledger), date.today())
    cats = stats["categories"]
    total = stats["usual_weekly_total"] or 0
    out: dict[str, str] = {}
    with db.connect() as conn:
        has_budget = bool(budget.current_limits(conn, user["id"]))
        has_goal = conn.execute("SELECT 1 FROM goal_commitments WHERE user_id = ? LIMIT 1", (user["id"],)).fetchone() is not None
    if not has_budget:
        out["budget-basics"] = "You haven't set a weekly budget yet."
    dining = cats.get("Dining", {}).get("avg_weekly", 0)
    if total and dining / total >= 0.25:
        out["small-purchases"] = f"Dining is {round(100 * dining / total)}% of your spending."
    shopping = cats.get("Shopping", {}).get("avg_weekly", 0)
    if total and shopping / total >= 0.2:
        out["impulse-buys"] = f"Shopping is {round(100 * shopping / total)}% of your spending."
    if ledger:
        cash = sum(a["balance"] for a in ledger["accounts"] if a["type"] in ("Checking", "Savings"))
        if total and cash < total * 52 / 12 * 3:
            out["emergency-fund"] = "Your balance covers less than 3 months of spending."
        if any(a["type"] == "Credit Card" for a in ledger["accounts"]):
            out.setdefault("credit-cards", "You have a credit card account.")
    if not has_goal:
        out["smart-goals"] = "You're not part of a savings goal yet."
    return out


@router.get("/learn")
def lessons(user: dict = Depends(current_user)):
    ws = budget.week_start(date.today()).isoformat()
    recs = recommendations(user)
    with db.connect() as conn:
        progress = {r["lesson_key"]: dict(r) for r in conn.execute(
            "SELECT lesson_key, MAX(passed) AS passed, MAX(CASE WHEN week_start = ? THEN passed ELSE 0 END) AS passed_this_week, "
            "MAX(score) AS best FROM lesson_progress WHERE user_id = ? GROUP BY lesson_key", (ws, user["id"]))}
        this_week = budget._lessons_passed(conn, user["id"], budget.week_start(date.today()))
    items = []
    for key, l in LESSONS.items():
        p = progress.get(key, {})
        items.append({"key": key, "title": l["title"], "minutes": l["minutes"], "emoji": l["emoji"], "blurb": l["blurb"],
                      "recommended": key in recs, "reason": recs.get(key), "passed_ever": bool(p.get("passed")),
                      "passed_this_week": bool(p.get("passed_this_week")), "best_score": p.get("best")})
    items.sort(key=lambda i: (not i["recommended"], i["passed_this_week"]))
    cap = budget.POINTS["lessons_max"]
    with db.connect() as conn:
        rows = conn.execute("SELECT lesson_key, week_start, points FROM lesson_progress WHERE user_id = ? AND passed = 1", (user["id"],)).fetchall()
    # Learning streak: weeks in a row (ending this week or last week) with at least one lesson passed.
    weeks_with = {r["week_start"] for r in rows}
    streak, w = 0, budget.week_start(date.today())
    if w.isoformat() not in weeks_with:
        w -= timedelta(weeks=1)
    while w.isoformat() in weeks_with:
        streak += 1
        w -= timedelta(weeks=1)
    progress = {"passed": len({r["lesson_key"] for r in rows}), "total": len(LESSONS),
                "points_all_time": sum(r["points"] for r in rows), "streak_weeks": streak}
    return {"lessons": items, "progress": progress, "passed_this_week": this_week, "weekly_cap": cap, "points_each": budget.POINTS["lesson"],
            "points_left_this_week": budget.POINTS["lesson"] * max(0, cap - this_week)}


# ---------- One lesson (Gemini personalizes it) ----------

LESSON_SYSTEM = """You write short, friendly money lessons for college students inside the Gatorstar app.
Teach the given topic using ONLY the given facts, and make it personal with the student's own spending numbers
where they fit naturally (e.g. "You spent $84 on dining last week"). Plain English, no jargon, no judgment.
- 3 sections, each a heading and 2-3 sentences.
- takeaway: one sentence. try_this: one concrete action they can do this week.
- quiz: exactly 3 multiple-choice questions about the lesson, each with exactly 4 options, answer_index 0-3,
  and a one-sentence explanation. Questions test the ideas, not the student's personal numbers.
Educational only: never recommend specific investments."""


class Section(BaseModel):
    heading: str
    body: str


class Question(BaseModel):
    question: str
    options: list[str]
    answer_index: int
    explanation: str


class LessonOut(BaseModel):
    title: str
    sections: list[Section]
    takeaway: str
    try_this: str
    quiz: list[Question]


def _valid(lesson: dict) -> bool:
    quiz = lesson.get("quiz") or []
    return (2 <= len(lesson.get("sections") or []) <= 5 and len(quiz) == 3
            and all(len(q["options"]) == 4 and 0 <= q["answer_index"] <= 3 for q in quiz))


def _lesson(user: dict, key: str) -> tuple[dict, str]:
    """This week's version of a lesson for this user: cached, else Gemini, else built-in."""
    ws = budget.week_start(date.today()).isoformat()
    with db.connect() as conn:
        row = conn.execute("SELECT content_json, source FROM lesson_cache WHERE user_id = ? AND lesson_key = ? AND week_start = ?",
                           (user["id"], key, ws)).fetchone()
    if row:
        return json.loads(row["content_json"]), row["source"]
    l = LESSONS[key]
    ledger = budget.ledger_for(user["id"]) if user["bank_link"] else None
    stats = budget.spending_stats(budget.purchases(ledger), date.today())
    content, source = None, "builtin"
    try:
        if not gemini.available():
            raise RuntimeError("no GEMINI_API_KEY")
        prompt = (f"Topic: {l['title']}\nFacts to teach: {l['facts']}\n"
                  f"Student first name: {user['display_name'].split(' ')[0]}\n"
                  f"Student's weekly spending (JSON): {json.dumps(stats, default=str)}")
        content = gemini.generate_json_within(LESSON_BUDGET_SECONDS, LESSON_SYSTEM, prompt, LessonOut, tier="fast")
        if _valid(content):
            source = "gemini"
        else:
            content = None
    except Exception as e:
        print(f"Lesson {key} used the built-in version ({e.__class__.__name__}: {str(e)[:120]})")
    if content is None:
        content = _builtin(key)
        # Shuffle the answer options (differently per person and week) so the right answer isn't always B.
        rng = random.Random(f"{user['id']}-{key}-{ws}")
        for q in content["quiz"]:
            right = q["options"][q["answer_index"]]
            rng.shuffle(q["options"])
            q["answer_index"] = q["options"].index(right)
    with db.connect() as conn:
        conn.execute("INSERT OR REPLACE INTO lesson_cache (user_id, lesson_key, week_start, content_json, source) VALUES (?, ?, ?, ?, ?)",
                     (user["id"], key, ws, json.dumps(content), source))
    return content, source


@router.get("/learn/lessons/{key}")
def lesson(key: str, user: dict = Depends(current_user)):
    if key not in LESSONS:
        raise HTTPException(404, "Lesson not found")
    content, source = _lesson(user, key)
    ws = budget.week_start(date.today()).isoformat()
    with db.connect() as conn:
        done = conn.execute("SELECT passed FROM lesson_progress WHERE user_id = ? AND lesson_key = ? AND week_start = ?",
                            (user["id"], key, ws)).fetchone()
    return {
        "key": key, "emoji": LESSONS[key]["emoji"], "minutes": LESSONS[key]["minutes"], "source": source,
        "title": content["title"], "sections": content["sections"], "takeaway": content["takeaway"], "try_this": content["try_this"],
        # The answers stay on the server until the quiz is submitted.
        "quiz": [{"question": q["question"], "options": q["options"]} for q in content["quiz"]],
        "passed_this_week": bool(done and done["passed"]),
    }


class QuizIn(BaseModel):
    answers: list[int]


@router.post("/learn/lessons/{key}/quiz")
def submit_quiz(key: str, body: QuizIn, user: dict = Depends(current_user)):
    if key not in LESSONS:
        raise HTTPException(404, "Lesson not found")
    content, _ = _lesson(user, key)
    quiz = content["quiz"]
    if len(body.answers) != len(quiz):
        raise HTTPException(400, f"Answer all {len(quiz)} questions")
    results = [{"correct": a == q["answer_index"], "answer_index": q["answer_index"], "explanation": q["explanation"]}
               for a, q in zip(body.answers, quiz)]
    score = sum(r["correct"] for r in results)
    passed = score >= 2
    ws = budget.week_start(date.today())
    awarded = 0
    with db.connect() as conn:
        before = conn.execute("SELECT passed, score, points FROM lesson_progress WHERE user_id = ? AND lesson_key = ? AND week_start = ?",
                              (user["id"], key, ws.isoformat())).fetchone()
        if passed and not (before and before["passed"]) and budget._lessons_passed(conn, user["id"], ws) < budget.POINTS["lessons_max"]:
            awarded = budget.POINTS["lesson"]
        conn.execute(
            "INSERT INTO lesson_progress (user_id, lesson_key, week_start, score, passed, points, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (user_id, lesson_key, week_start) DO UPDATE SET score = MAX(score, excluded.score), "
            "passed = MAX(passed, excluded.passed), points = MAX(points, excluded.points), completed_at = excluded.completed_at",
            (user["id"], key, ws.isoformat(), score, int(passed), awarded, db.now()))
    already = bool(before and before["passed"])
    return {"score": score, "total": len(quiz), "passed": passed, "points_awarded": awarded, "already_passed": already, "results": results}


# ---------- Ask ----------

ASK_SYSTEM = """You are the money coach inside Gatorstar, a banking app for college students.
Answer the student's money question clearly and kindly, in plain English, in at most 120 words.
Use short paragraphs or lines starting with "- ". No headings, no bold, no tables.
When it helps, use their own spending summary (given as JSON) to make it concrete.
You teach financial basics (budgeting, saving, credit, debt, goals). You don't give personalized investment,
tax or legal advice: for questions like which stock or crypto to buy, explain the general principles
(diversification, risk, fees, time horizon) and suggest a licensed professional for specifics.
Also return 2-3 short follow_ups: questions the student might ask next."""


class AskIn(BaseModel):
    question: str
    history: list[budget.ChatMessage] = []


class Answer(BaseModel):
    answer: str
    follow_ups: list[str]


FAQ = [
    (("emergency",), "Aim for a starter emergency fund of $500 to $1,000, kept in a separate savings account, then build toward 3 to 6 months of essential expenses. Moving even $10 a week automatically adds up.",
     ["How do I save $500 fast?", "Where should I keep my emergency fund?"]),
    (("credit", "card", "interest", "apr"), "Pay the full statement balance every month and you won't pay interest. Pay on time, and keep your balance under about 30% of your limit. Paying only the minimum can take years and cost much more.",
     ["What is APR?", "How do I build credit as a student?"]),
    (("invest", "stock", "crypto"), "Gatorstar can't recommend specific investments. The basics: build an emergency fund first, invest only money you won't need for years, spread it out (diversify), and keep fees low. A licensed advisor can help with specifics.",
     ["What is diversification?", "Should I save or invest first?"]),
    (("budget", "spend", "save", "saving"), "Start with a weekly limit for your 3 to 5 biggest categories, check it every Sunday, and move whatever you don't spend into savings. The 50/30/20 rule (needs, wants, savings) is a good starting split.",
     ["What is the 50/30/20 rule?", "How do I stop impulse buying?"]),
]


def _faq(question: str) -> dict:
    q = question.lower()
    for words, answer, follow in FAQ:
        if any(w in q for w in words):
            return {"answer": answer, "follow_ups": follow}
    return {"answer": "Gemini is busy right now, so here's a quick tip: pick one category to watch this week, and open a lesson below to earn points while you learn. Try your question again in a moment.",
            "follow_ups": ["How do I make a budget?", "How big should my emergency fund be?"]}


@router.post("/learn/ask")
def ask(body: AskIn, user: dict = Depends(current_user)):
    question = body.question.strip()[:500]
    if not question:
        raise HTTPException(400, "Ask a question first")
    ledger = budget.ledger_for(user["id"]) if user["bank_link"] else None
    stats = budget.spending_stats(budget.purchases(ledger), date.today())
    history = "\n".join(f"{'Student' if m.role == 'user' else 'Coach'}: {m.text[:400]}" for m in body.history[-6:])
    prompt = (f"Student's weekly spending (JSON): {json.dumps(stats, default=str)}\n"
              f"Earlier in this chat:\n{history or '(nothing yet)'}\n\nQuestion: {question}")
    try:
        if not gemini.available():
            raise RuntimeError("no GEMINI_API_KEY")
        result = gemini.generate_json_within(ASK_BUDGET_SECONDS, ASK_SYSTEM, prompt, Answer, tier="coach")
        return {**result, "follow_ups": result["follow_ups"][:3], "source": "gemini"}
    except Exception as e:
        print(f"Ask used the quick answer ({e.__class__.__name__}: {str(e)[:120]})")
        return {**_faq(question), "source": "backup"}
