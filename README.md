# Gatorstar

Planning a group trip is fun until the money part. One person fronts the Airbnb, three people "will Venmo you later," and by the time the trip comes around half the group hasn't saved anything. Gatorstar lets friend groups save toward shared goals together, with Gemini to help plan, a Solana vault anyone can verify, and weekly budgets and leaderboards that keep everyone accountable. Along the way it explains your own money in plain English.

We built it for SwampHacksXII and entered it in Capital One's Best Use of Nessie, Best Use of Google Gemini API, and Best Use of Solana challenges.

<img width="2560" height="1279" alt="image" src="https://github.com/user-attachments/assets/b7c1c046-10da-4771-81bf-bae7117aea5b" />

<img width="2560" height="1272" alt="image" src="https://github.com/user-attachments/assets/718929bf-8762-42ad-b7fd-e2a490315b4f" />

<img width="2560" height="1272" alt="image" src="https://github.com/user-attachments/assets/4bd675be-9f57-487e-9e19-a1d208f01514" />

## The idea

Gatorstar is built on three pieces:

- **Nessie** is the bank. The whole project runs on Capital One's Nessie API, which gives us simulated customers, accounts, transactions and statements.
- **Gemini** is the coach. It reads your financial data, explains it in plain English, and helps you plan goals and budgets by filling in the forms for you.
- **Solana** is the trust layer. When friends pool money for a goal, Solana gives us an escrow-style vault and a public record of who put in what, so nobody has to just take someone's word for it.

On top of that we added a social layer (friends, an activity feed, a weekly leaderboard) and short money lessons, because accountability and a little friendly pressure are what actually get people to save.

## What it does

**Home.** A "your week" summary at the top: points earned this week, how much budget you have left, your next goal payment, and the latest update from your friends. Below it is your spending dashboard: purchases grouped by category, daily or weekly trends, and a comparison to the last period.

**Insights.** Gemini's plain-English read of your spending (where most of your money went, what changed, a couple of tips), plus your full bank statement: every deposit, purchase, withdrawal, transfer and bill from Nessie, newest first, with running balances. Filter by account, look at a month or a longer stretch, download a CSV, or print it.

**Budget.** Set a weekly limit for each spending category, either by hand or with the Gemini budget coach. The coach asks what you want from a budget, how strict it should be, which categories to cover and how much you'd like to save, then proposes limits based on your real spending and fills in the form. You see live progress against each limit, how much the budget saves you compared with your usual spending, and Gemini tips on where you could save, with a one-click "lower this limit" button.

**Points.** Weeks run Monday to Sunday:

| What you do | Points |
| --- | --- |
| Stay under a category's limit | +10 |
| ...and use 75% or less of it | +5 more |
| Go over a category | −5 |
| Stay under your whole budget | +20 |
| Each week of your under-budget streak | +5 (up to +25) |
| Pass a lesson quiz | +10 (up to 3 a week) |
| Save toward a group goal | +5 (up to 4 a week) |

A week never goes below 0, and the current week updates live, so points can still drop if you overspend before Sunday.

**Social.**
- **Activity feed:** what you and your friends have been doing in the last 30 days: savings toward goals and milestones (25/50/75/100% of a share), goals reached, payouts, weeks finished under budget and streaks, lessons passed, new budgets and new friends. React with 👏 🔥 💪 🎉, and your friend gets a notification.
- **Leaderboard:** this week's points for you and your friends, with streaks, how much of their budget each person has used, and their goal progress. Cheer someone on with one tap.
- **Friends:** add friends by username, and accept or decline requests.
- **Privacy:** friends only see points, streaks and percentages, never dollar amounts or what you bought. In a group you share, savings show with amounts (the group can already see them). Everywhere else, friends see percentages unless you turn on "Share my savings amounts with friends" in Settings.

**Groups and shared goals.** Invite friends to a group and set a shared goal. Each person commits to a share. When you add money, it's a real withdrawal from your checking account in Nessie. The app tracks everyone's pace against the deadline and marks each person on track, behind or complete.

**Goal coach.** Setting up a goal is a short chat with Gemini. It asks what you're saving for, how much, by when and how often to pay, checks how realistic that is against your own spending, and fills in the goal form for you to review. You can also set what happens when someone misses a payment: a money penalty (a percent added to their share), or an honor-code dare the friend group enforces.

**Solana vaults.**
- **On-chain records:** each goal has its own vault on Solana devnet, and every contribution is recorded on-chain.
- **Escrow:** the pot stays locked until the group hits its target. Then the goal's creator or the group owner releases it in one payout.
- **Live tracker:** after you add money, a step-by-step view follows it from the bank withdrawal to confirmed on Solana.
- **Verify on Solana:** your browser checks every record directly against the blockchain. A "Try to cheat" demo shows what happens when a record is tampered with.
- **Public proof page:** shareable by link or QR code, no login needed.

**Learn.** Seven short lessons (budgeting basics, needs vs. wants, small purchases, impulse buys, emergency funds, setting goals, credit cards). Gemini tailors them to your own spending, and each one ends with a quiz that earns leaderboard points. Lessons that fit your spending are marked "For you". There's also an "Ask Gemini" box for money questions, and a progress row with lessons passed, your learning streak and points earned.

**Live updates.** When someone creates a goal, adds money, changes a budget or reacts in the feed, everyone else's screen updates within a couple of seconds. There's a notification bell, and a confetti screen for every member when a group hits its goal.

**Settings.** The privacy switches, your account details and bank link. Bank accounts, Settings and Log out are in the menu under your name.

## How we use Nessie

Nessie is the foundation of the project. Every customer, account, transaction and statement in Gatorstar comes from the Nessie API.

- **Setup:** we create customers and accounts in Nessie.
- **Demo history:** we generate a few months of made-up but realistic transactions: paychecks, rent, bills, groceries, ATM withdrawals.
- **Reading:** we read all of it back for the dashboard, statements and budgets.
- **Writing:** adding money to a goal, a vault payout or a demo button creates a new transaction in Nessie on the spot.
- **Categories:** Nessie's merchant categories power the spending breakdown and budgets. If a category is missing or unfamiliar, we infer it from the merchant name.

We ran into a few limits on the Nessie server and built around them. `probe_nessie.py` is the script we used to test what it supports.

- **The stored balance never changes.** So we treat Nessie's balance as the opening balance and work out the current one ourselves: opening balance plus money in, minus money out.
- **Transfers get rejected.** A transfer between two accounts is saved as a withdrawal and a matching deposit.
- **Withdrawals and purchases can't be deleted.** When someone undoes a goal contribution, we hide that transaction in our own database and ignore it in balances and statements.
- **Transactions only have a date, not a time.** For transactions the app creates, we record the exact time ourselves, so same-day transactions show newest first.
- **It's slow.** Building one person's full ledger takes around 16 calls. We fetch them in parallel and cache the result for 30 seconds, and the cache clears whenever we write something.

All of that lives in `banking.py` and `nessie.py`.

## How we use Gemini

Bank data on its own is just a list of numbers. Gemini turns it into something you can read and act on. It has six jobs:

- **Insights:** a plain-English read of your spending on the Insights page. Answers are cached for 15 minutes.
- **Goal coach:** a guided chat that plans a group goal and fills in the form.
- **Budget coach:** a guided chat that proposes weekly limits from your real spending and fills in the budget form.
- **Spending tips:** your biggest categories and specific ways to save, each with an estimated weekly saving.
- **Lessons:** rewrites each lesson with your own numbers and writes the quiz.
- **Ask Gemini:** answers money questions in plain English, with suggested follow-ups.

We were careful about how it's used:

- **Python checks every number.** Gemini can propose plans and limits, but the backend validates and recalculates them: limits are kept in realistic ranges, savings estimates are capped, and goal payment math is redone in code.
- **It sees as little as possible.** Gemini gets aggregated summaries of your own money (category totals, your top merchants with visit counts, balance and income). It never sees account IDs, individual transactions, or other members' finances.
- **Its answers are checked.** Every response has to match a JSON schema before we use it.
- **Fast and smart models.** Live chats use a fast, lightweight model. Heavier analysis can use a stronger one.
- **It never blocks the app.** Every Gemini feature has a time limit and a built-in fallback (a quick planner, rule-based tips, built-in lessons), so the app keeps working if Gemini is slow, down or not set up.
- **Education, not advice.** All Gemini output is labeled as educational, and Ask Gemini won't recommend specific investments.

A status badge in the header shows whether Gemini is set up and responding.

## How we use Solana

Pooling money with friends usually means one person collects everyone's share and holds it. That puts a lot of trust, and some legal and ethical weight, on one person. Solana fixes that: each goal gets an escrow-style vault, and every contribution is written to a public blockchain, so anyone can check that people actually paid in.

Nessie still moves the dollars. Solana is the escrow record on top of it.

- **The token:** Gatorstar Savings Dollar (GSD). 1 GSD is $1.00, and it's only ever created to mirror dollars that really left someone's bank account.
- **Wallets:** every user gets a wallet, and every goal gets its own vault wallet. For this project the app manages the wallets (custodial), so no single member can move the pot on their own.
- **Contributions:** a $50 contribution is one Solana transaction. It mints 50 GSD, moves it into the goal's vault, and attaches a memo with the goal and the Nessie transaction ID. Undoing it moves the tokens back out and burns them.
- **Escrow:** the vault is locked until the goal is reached. Then the creator or group owner can release it. The payout lands in their bank account, and the vault's tokens are sent out and burned. Deleting a goal before release refunds everyone, both in the bank and on-chain.
- **Never blocks the bank:** on-chain steps go into a queue, and a background worker sends them, retrying if Solana is slow. If Solana is down, contributions still work and show as pending until they sync.
- **Verification:** the proof page and the "Verify on Solana" button check every record against the blockchain from your browser, not from our server. The "Try to cheat" button edits one record in the browser's copy and shows the blockchain catching it.

This runs on devnet, Solana's free test network, so no real money or crypto is involved.

**Beyond this project.** The same idea could apply well outside group trips. A public record that can't be edited makes it harder to fake a payment or quietly move money, and that could help against financial fraud, including scams that target vulnerable people.

## Tech

- **Backend:** Python, FastAPI, SQLite
- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS 4. The first design was made in Figma Make.
- **APIs:** Capital One Nessie, Google Gemini (`google-genai`), Solana devnet (`solders` plus JSON-RPC)
- **Hosting:** set up for Railway, but it runs locally just as well

The app's own data (users, friends, groups, goals, budgets, points, lessons) is in `app.db`. Nessie holds the bank data. Friends and groups point at our user IDs and never at Nessie IDs, so they keep working if someone unlinks or switches banks. Money in our database is stored as whole cents, so there are no rounding problems.

Main backend files:

| File | What it does |
| --- | --- |
| `server.py` | Starts the app, dashboard and insights |
| `banking.py`, `nessie.py` | Talking to Nessie, ledgers, balances, categories |
| `statement.py` | Bank statements |
| `groups.py` | Groups, goals, contributions, escrow release, proof page |
| `goal_coach.py` | Gemini goal coach |
| `budget.py` | Budgets, points, leaderboard, budget coach, tips |
| `learn.py` | Lessons, quizzes, Ask Gemini |
| `social.py` | Activity feed, reactions, privacy settings, "your week" |
| `solana_vault.py` | Solana vaults, token, transaction queue |
| `live.py` | Live updates |
| `notifications.py` | The notification bell |
| `gemini.py` | Gemini client, model tiers, status badge |

## Running it

Install **Python 3.12+** and **Node.js 22+** first.

**1. Get your keys.** Make a file called `.env` in the project folder:

```
NESSIE_API_KEY=your_key_here
GEMINI_API_KEY=your_key_here
```

You can get a Nessie key at [nessieisreal.com](https://nessieisreal.com) and a Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). The Gemini key is optional: without it, the AI features fall back to built-in versions. `.env` is in `.gitignore`, so don't commit it.

**2. Start it.**

On Windows, double-click `start.bat`. It sets up Python and the frontend the first time, starts both servers, and opens the app logged out.

On macOS or Linux, use two terminals:

```
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python server.py
```

```
cd frontend
npm install
npm run dev
```

The backend runs on http://localhost:8000 and the app on http://localhost:8443.

**3. Demo data.** On a fresh database in demo mode, the server sets up three demo users automatically: @maya, @carlos and @priya (password `demo1234`).
- They have about three months of transaction history in Nessie, and they're already friends.
- They share a group called "Spring Break Crew" with a $3,000 goal.
- They get weekly budgets built from their own spending, so the leaderboard has history and streaks right away.

To set up the demo by hand, run `demo_setup.py` with the server stopped.

**4. Solana (optional).** Vaults work out of the box on devnet. The first time it runs, the app creates its own wallet (`solana_authority.json`, which is in `.gitignore`) and asks the devnet faucet for free test SOL to pay transaction fees. If the faucet is busy, paste the wallet address shown in the app into [faucet.solana.com](https://faucet.solana.com).

## Environment variables

Only `NESSIE_API_KEY` is required. The rest have defaults.

| Variable | What it does |
| --- | --- |
| `NESSIE_API_KEY` | Your Nessie key. |
| `GEMINI_API_KEY` | Turns on the Gemini features. |
| `GEMINI_MODEL`, `GEMINI_MODEL_FAST`, `GEMINI_MODEL_SMART`, `GEMINI_MODEL_COACH` | Which Gemini models to use. |
| `GEMINI_TIMEOUT_MS` | How long to wait on a stuck Gemini call. |
| `SOLANA_ENABLED` | Set to `0` to turn off the vaults. |
| `SOLANA_RPC_URL` | The Solana server the backend uses. Defaults to devnet. |
| `SOLANA_PUBLIC_RPC_URL` | The Solana server browsers use to verify records. Defaults to devnet. |
| `SOLANA_AUTHORITY_SECRET` | The app's wallet. If it's not set, one gets created locally. Set it on a host that wipes files on redeploy. Treat it like a password. |
| `FINAPP_DEV` | Demo mode, on by default. Set to `0` to turn off the one-click demo logins and demo buttons. |
| `FINAPP_AUTO_DEMO` | Set to `0` to stop the automatic demo setup. |
| `FINAPP_DATA_DIR` | Where `app.db` is kept. Point it at a persistent volume when hosting. |
| `FRONTEND_ORIGINS` | Extra website addresses allowed to call the API, separated by commas. |

## During a demo

- **Simulate** buttons on the Insights page create a real paycheck or purchase in Nessie on the spot. Watch the statement, dashboard, budget and points update.
- **Adding to a goal** takes real money out of the checking account in Nessie, and the live tracker follows it onto Solana. The statement, balance and dashboard all change too.
- **Verify on Solana**, then **Try to cheat**, on any goal's vault shows the blockchain catching a tampered record. **Share proof · QR** opens the public proof page.
- **Finishing a goal** sets off confetti for every member, and the creator can **release** the vault.
- **Undo** puts a goal contribution back.
- **Log in as two users in two browser windows** (for example @maya and @carlos) to show live updates, the feed, reactions and cheers.
- A judge can make their own profile and add @maya as a friend.

To put everything back to the starting state, stop the server and run `reset_demo.py`. It takes back every transaction added during the demo. `reset_demo.py --empty` also clears all friends and groups.

## What's fake, and what we'd do differently

- Nessie is a mock bank, so the money isn't real, and Solana is on a test network.
- The Solana vault holds tokens that mirror the pooled dollars. The dollars themselves come out of the Nessie account. With a real bank, the vault would be backed by a real held balance.
- To link a bank, you type in a Nessie customer ID, and that ID is the only proof you own it. A real version would use a proper bank-linking flow.
- Wallet keys are stored in our database for this hackathon (custodial wallets). A real version would keep them in a secure key vault or let users bring their own wallets.
- Demo mode lets anyone log in as a demo user with one click. Turn it off for anything that isn't a demo.
- Live updates poll every couple of seconds instead of using WebSockets.
- Points and budgets use weekly totals from Nessie's date-only transactions, so they're as accurate as the bank data.

## Team

- Austin Le: Full-Stack Developer & QA Engineer
- Alwin Chen: Backend Developer & Subject Matter Expert
- Mandy Hong: Project Manager & Frontend Developer
- John Zhou Su: Frontend Developer & UI/UX Designer

## What's next

- Real bank connections and real payments, with escrow released straight to the booking or vendor.
- Splitting shared expenses after the trip ("who paid for gas?"), not just saving before it.
- Smarter coaching: mid-goal check-ins, catch-up plans when someone falls behind, and personalized lesson paths.
- Group-vs-group challenges and seasonal leaderboards.
- Push notifications for cheers, reactions and payment reminders, and a mobile app.
- Alerts for unusual or suspicious transactions.
