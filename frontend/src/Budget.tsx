import { useCallback, useEffect, useRef, useState } from "react";
import { api, cached } from "./api";
import { GeminiThinking } from "./AiStatus";
import { initials } from "./Friends";
import { useLive } from "./live";

// ---------- The Budget tab (budget.py): your weekly budget, points and Gemini tips ----------
// The leaderboard lives in Social (exported below), lessons in Learn.

type Status = "under" | "near" | "over";
type CatRow = { category: string; limit: number | null; spent: number; used_pct: number | null; status: Status | null; avg_weekly: number; last_week: number };
type Score = {
  points: number;
  breakdown: { label: string; points: number }[];
  under_total: boolean;
  budget_used_pct: number | null;
  on_track: number;
  budgeted: number;
  lessons: number;
  goal_saves: number;
};
type Points = { this_week: Score; last_week_points: number; total_points: number; streak: number; history: { week_start: string; points: number; under_total: boolean }[] };
type Rules = Record<string, number>;
type BudgetMath = { weekly_total: number; usual_weekly: number | null; weekly_savings: number | null; monthly_savings: number | null; yearly_savings: number | null };
type Style = "strict" | "balanced" | "relaxed";
type BudgetData = {
  linked: boolean;
  bank_ok: boolean;
  has_budget: boolean;
  week: { start: string; end: string; days_left: number };
  settings: { style: Style; savings_goal: number; share_goals: boolean; summary: string };
  categories: CatRow[];
  totals: { limit: number; spent: number; left: number; used_pct: number | null };
  math: BudgetMath | null;
  suggested: Record<string, number>;
  usual_weekly_total: number;
  weeks_of_history: number;
  points: Points;
  rules: Rules;
};
type Draft = { style: Style; savings_goal: number; summary: string; limits: Record<string, number> };

export const money = (n: number, cents = false) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const COLORS: Record<string, string> = { Dining: "#9a6bff", Groceries: "#2ec7a6", Shopping: "#ff9b6a", Transport: "#ffcc57", Other: "#a9b6c8" };
const colorFor = (c: string) => COLORS[c] ?? "#95A1D8";
const input = "w-full rounded-xl border border-[#DADDF1] bg-white px-3.5 py-2.5 text-xs outline-none transition focus:border-[#95A1D8]";
const fieldLabel = "mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6F789A]";
const primaryBtn = "rounded-lg bg-[#275992] px-3.5 py-2 text-[11px] font-bold text-white transition hover:bg-[#1F4777] disabled:opacity-50";
const secondaryBtn = "rounded-lg border border-[#DADDF1] bg-white px-3.5 py-2 text-[11px] font-bold text-[#275992] transition hover:bg-[#E2E5F4] disabled:opacity-50";
const STATUS_LOOK: Record<Status, { label: string; pill: string; bar: string }> = {
  under: { label: "On track", pill: "bg-[#E3F7F0] text-[#209E86]", bar: "#2ec7a6" },
  near: { label: "Close to limit", pill: "bg-[#fff7e6] text-[#8a5a12]", bar: "#ffcc57" },
  over: { label: "Over", pill: "bg-[#fff0e9] text-[#b4502f]", bar: "#ff8a5b" },
};

const SPARKLE = (
  <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
    <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3ZM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" />
  </svg>
);

export default function Budget({ onGoTo }: { onGoTo: (nav: string) => void }) {
  const [data, setData] = useState<BudgetData | null>(() => cached<BudgetData>("/api/budget") ?? null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<BudgetData>("GET", "/api/budget")
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  // Spending, points and friends' budgets change live.
  useLive(["money", "budget", "groups"], load);

  return (
    <div>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#6F789A]">Budget</p>
          <h1 className="text-[28px] font-bold tracking-[-0.045em] sm:text-[34px]">Spend with a plan</h1>
          <p className="mt-1 text-sm text-[#6F789A]">Set weekly limits and earn points every week you stick to them.</p>
        </div>
        {data && (
          <div className="flex items-center gap-2 rounded-2xl border border-[#DADDF1] bg-[#FFFDF7] px-4 py-2.5">
            <span className="text-xl">⭐</span>
            <span>
              <span className="block text-lg font-bold leading-5">{data.points.this_week.points} pts</span>
              <span className="block text-[10px] text-[#8790AE]">this week · {data.week.days_left === 0 ? "ends today" : `${data.week.days_left} day${data.week.days_left === 1 ? "" : "s"} left`}</span>
            </span>
          </div>
        )}
      </div>

      {error && !data && <p className="rounded-xl bg-[#fff4f0] px-4 py-3 text-xs font-semibold text-[#9a3b22]">{error}</p>}
      {data ? <MyBudget data={data} onChanged={load} onGoTo={onGoTo} /> : !error && <div className="h-64 animate-pulse rounded-[18px] bg-white/60" />}
    </div>
  );
}

// ---------- My budget ----------

function MyBudget({ data, onChanged, onGoTo }: { data: BudgetData; onChanged: () => void; onGoTo: (nav: string) => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "coach">("view");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState("");

  function openForm(from?: Draft) {
    const limits: Record<string, number> = {};
    if (from) Object.assign(limits, from.limits);
    else if (data.has_budget) data.categories.forEach((c) => c.limit && (limits[c.category] = c.limit));
    else Object.assign(limits, data.suggested);
    setDraft(from ?? { style: data.settings.style, savings_goal: data.settings.savings_goal, summary: data.settings.summary, limits });
    setMode("edit");
  }

  if (!data.linked)
    return (
      <section className="panel text-center">
        <p className="text-sm font-bold">Link your bank to build a budget</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-[#6F789A]">Your budget compares your real spending with your weekly limits. You can still use the Leaderboard and Learn tabs.</p>
        <button className={`${primaryBtn} mt-4`} onClick={() => onGoTo("Accounts")} type="button">
          Link a bank
        </button>
      </section>
    );

  if (mode === "coach")
    return (
      <BudgetCoach
        onSkip={() => openForm()}
        onUsePlan={(plan) => {
          const limits: Record<string, number> = {};
          plan.categories.forEach((l) => (limits[l.category] = l.weekly_limit));
          openForm({ style: plan.style, savings_goal: plan.weekly_savings_goal, summary: plan.summary, limits });
          setNotice("Gemini filled in the form below. Review it, change anything, then save.");
        }}
      />
    );

  if (mode === "edit" && draft)
    return (
      <>
        {notice && <p className="mb-3 rounded-xl bg-[#E3F7F0] px-4 py-2.5 text-xs font-semibold text-[#209E86]">{notice}</p>}
        <BudgetForm
          data={data}
          draft={draft}
          onCancel={() => {
            setMode("view");
            setNotice("");
          }}
          onCoach={() => setMode("coach")}
          onSaved={() => {
            setMode("view");
            setNotice("");
            onChanged();
          }}
        />
      </>
    );

  if (!data.has_budget)
    return (
      <div className="space-y-5">
        <section className="relative overflow-hidden rounded-[20px] bg-[#E2E5F4] p-6 sm:p-8">
          <div className="absolute -bottom-20 -right-8 size-56 rounded-full border-[32px] border-[#9a6bff]/10" />
          <div className="relative max-w-xl">
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#275992]">Weekly budget</p>
            <h2 className="mt-1 text-2xl font-bold tracking-[-0.03em] text-[#275992]">Let's build your budget</h2>
            <p className="mt-2 text-sm leading-6 text-[#6F789A]">
              {data.weeks_of_history
                ? `You usually spend about ${money(data.usual_weekly_total)} a week. Pick a limit for each category and earn points every week you stay under.`
                : "Pick a weekly limit for each category and earn points every week you stay under."}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button className={`${primaryBtn} flex items-center gap-1.5 px-4 py-2.5`} onClick={() => setMode("coach")} type="button">
                {SPARKLE} Plan it with Gemini
              </button>
              <button className={`${secondaryBtn} px-4 py-2.5`} onClick={() => openForm()} type="button">
                Set it up myself
              </button>
            </div>
          </div>
        </section>
        <SpendingTips data={data} onApplied={onChanged} />
        <PointsRules rules={data.rules} />
      </div>
    );

  const t = data.totals;
  const w = data.points.this_week;
  const savings = data.math?.weekly_savings ?? null;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="panel">
          <p className="eyebrow">This week · {shortDate(data.week.start)} – {shortDate(data.week.end)}</p>
          <p className="mt-2 text-[26px] font-bold tracking-[-0.04em]">
            {money(t.spent, true)} <span className="text-sm font-semibold text-[#8790AE]">of {money(t.limit)}</span>
          </p>
          <Bar color={t.spent > t.limit ? STATUS_LOOK.over.bar : (t.used_pct ?? 0) >= 90 ? STATUS_LOOK.near.bar : STATUS_LOOK.under.bar} pct={t.used_pct ?? 0} />
          <p className="mt-2 text-[11px] text-[#6F789A]">
            {t.left >= 0 ? (
              <>
                <strong className="text-[#209E86]">{money(t.left, true)} left</strong> for {data.week.days_left + 1} day{data.week.days_left === 0 ? "" : "s"}, about{" "}
                {money(t.left / (data.week.days_left + 1), true)} a day
              </>
            ) : (
              <strong className="text-[#b4502f]">{money(-t.left, true)} over this week</strong>
            )}
          </p>
        </section>

        <section className="panel">
          <div className="flex items-start justify-between">
            <p className="eyebrow">Points this week</p>
            {data.points.streak > 0 && <span className="rounded-full bg-[#fff0e2] px-2 py-0.5 text-[10px] font-bold text-[#d85f36]">🔥 {data.points.streak}-week streak</span>}
          </div>
          <p className="mt-2 text-[26px] font-bold tracking-[-0.04em]">
            {w.points} <span className="text-sm font-semibold text-[#8790AE]">pts · {data.points.total_points} all-time</span>
          </p>
          <ul className="mt-2 space-y-1">
            {w.breakdown.map((b) => (
              <li className="flex justify-between text-[11px]" key={b.label}>
                <span className="text-[#6F789A]">{b.label}</span>
                <span className={`font-bold ${b.points < 0 ? "text-[#b4502f]" : "text-[#209E86]"}`}>
                  {b.points > 0 ? "+" : ""}
                  {b.points}
                </span>
              </li>
            ))}
            {w.breakdown.length === 0 && <li className="text-[11px] text-[#8790AE]">Stay under your limits, pass a lesson or save toward a goal to earn points.</li>}
          </ul>
          <p className="mt-2 text-[10px] text-[#8790AE]">Live: points can still change until Sunday night.</p>
        </section>

        <section className="panel">
          <p className="eyebrow">What this budget saves</p>
          {savings !== null && savings > 0 ? (
            <>
              <p className="mt-2 text-[26px] font-bold tracking-[-0.04em] text-[#209E86]">
                {money(savings)} <span className="text-sm font-semibold text-[#8790AE]">a week</span>
              </p>
              <p className="mt-1 text-[11px] leading-4 text-[#6F789A]">
                Compared with your usual {money(data.math!.usual_weekly ?? 0)} a week. That's about <strong className="text-[#275992]">{money(data.math!.monthly_savings ?? 0)} a month</strong> and{" "}
                {money(data.math!.yearly_savings ?? 0)} a year.
              </p>
            </>
          ) : savings !== null ? (
            <p className="mt-2 text-[11px] leading-4 text-[#6F789A]">
              This budget is {money(-savings)} a week above your usual spending in these categories. Try lowering a limit or two to start saving.
            </p>
          ) : (
            <p className="mt-2 text-[11px] leading-4 text-[#6F789A]">Once you have a few weeks of spending, we'll show how much this budget saves you.</p>
          )}
          {data.settings.savings_goal > 0 && (
            <p className="mt-2 rounded-lg bg-[#F4F5FB] px-2.5 py-1.5 text-[10px] text-[#275992]">Your goal: save {money(data.settings.savings_goal)} a week</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={`${secondaryBtn} whitespace-nowrap`} onClick={() => openForm()} type="button">
              Edit budget
            </button>
            <button className={`${secondaryBtn} flex items-center gap-1 whitespace-nowrap`} onClick={() => setMode("coach")} type="button">
              <span className="scale-75">{SPARKLE}</span> Re-plan with Gemini
            </button>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-heading mb-3">
          <div>
            <p className="panel-title">Categories</p>
            <p className="text-[11px] text-[#8790AE]">Spending this week against each weekly limit</p>
          </div>
          {!data.bank_ok && <span className="text-[10px] font-semibold text-[#b4502f]">Bank is slow right now; numbers may be a few minutes old</span>}
        </div>
        <div className="divide-y divide-[#F0F1F8]">
          {data.categories
            .filter((c) => c.limit)
            .map((c) => (
              <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 py-3 sm:grid-cols-[150px_1fr_auto]" key={c.category}>
                <span className="flex items-center gap-2 text-xs font-bold">
                  <span className="size-2.5 rounded-full" style={{ background: colorFor(c.category) }} />
                  {c.category}
                </span>
                <div className="order-3 col-span-2 sm:order-none sm:col-span-1">
                  <Bar color={STATUS_LOOK[c.status ?? "under"].bar} pct={c.used_pct ?? 0} />
                  <p className="mt-1 text-[10px] text-[#8790AE]">
                    {money(c.spent, true)} of {money(c.limit!)} · you usually spend {money(c.avg_weekly)} a week
                  </p>
                </div>
                {c.status && <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_LOOK[c.status].pill}`}>{STATUS_LOOK[c.status].label}</span>}
              </div>
            ))}
        </div>
        {data.categories.some((c) => !c.limit && c.spent > 0) && (
          <p className="mt-2 text-[10px] text-[#8790AE]">
            Not budgeted this week:{" "}
            {data.categories
              .filter((c) => !c.limit && c.spent > 0)
              .map((c) => `${c.category} ${money(c.spent, true)}`)
              .join(" · ")}
          </p>
        )}
      </section>

      <SpendingTips data={data} onApplied={onChanged} />

      <div className="grid gap-4 lg:grid-cols-2">
        <PointsHistory points={data.points} />
        <PointsRules rules={data.rules} />
      </div>
    </div>
  );
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#E2E5F4]">
      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(pct > 0 ? 3 : 0, pct))}%`, background: color }} />
    </div>
  );
}

// ---------- The budget form (filled in by hand or by Gemini) ----------

function BudgetForm({ data, draft, onSaved, onCancel, onCoach }: { data: BudgetData; draft: Draft; onSaved: () => void; onCancel: () => void; onCoach: () => void }) {
  const [style, setStyle] = useState<Style>(draft.style);
  const [savingsGoal, setSavingsGoal] = useState(String(draft.savings_goal || ""));
  const [limits, setLimits] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    data.categories.forEach((c) => (out[c.category] = draft.limits[c.category] ? String(draft.limits[c.category]) : ""));
    return out;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const chosen = data.categories.filter((c) => Number(limits[c.category]) > 0);
  const total = chosen.reduce((s, c) => s + Number(limits[c.category]), 0);
  const usual = chosen.reduce((s, c) => s + c.avg_weekly, 0);
  const saves = data.weeks_of_history ? usual - total : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("PUT", "/api/budget", {
        style,
        savings_goal: Number(savingsGoal) || 0,
        share_goals: data.settings.share_goals,
        summary: draft.summary,
        categories: chosen.map((c) => ({ category: c.category, limit: Number(limits[c.category]) })),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={save}>
      <div className="panel-heading mb-4">
        <div>
          <p className="panel-title">{data.has_budget ? "Edit your weekly budget" : "Your weekly budget"}</p>
          <p className="text-[11px] text-[#8790AE]">Leave a category blank to skip it. Limits reset every Monday.</p>
        </div>
        <button className={`${secondaryBtn} flex items-center gap-1`} onClick={onCoach} type="button">
          <span className="scale-75">{SPARKLE}</span> Ask Gemini to fill it
        </button>
      </div>

      {draft.summary && <p className="mb-4 rounded-lg bg-[#F4F5FB] px-3 py-2 text-[11px] text-[#275992]">{draft.summary}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <span className={fieldLabel}>How strict?</span>
          <div className="grid grid-cols-3 gap-1.5">
            {(["strict", "balanced", "relaxed"] as Style[]).map((s) => (
              <button
                className={`rounded-lg border px-2 py-2 text-[11px] font-bold capitalize transition ${style === s ? "border-[#95A1D8] bg-[#E2E5F4] text-[#275992]" : "border-[#DADDF1] bg-white text-[#6F789A] hover:bg-[#F4F5FB]"}`}
                key={s}
                onClick={() => setStyle(s)}
                type="button"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className={fieldLabel}>I want to save each week ($)</span>
          <input className={input} inputMode="decimal" min="0" onChange={(e) => setSavingsGoal(e.target.value)} placeholder="25" step="1" type="number" value={savingsGoal} />
        </label>
      </div>

      <div className="mt-5 divide-y divide-[#F0F1F8] rounded-xl border border-[#DADDF1] bg-white">
        {data.categories.map((c) => (
          <label className="flex items-center gap-3 px-3.5 py-2.5" key={c.category}>
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: colorFor(c.category) }} />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-bold">{c.category}</span>
              <span className="block text-[10px] text-[#8790AE]">{c.avg_weekly ? `You usually spend ${money(c.avg_weekly)} a week` : "No spending here yet"}</span>
            </span>
            <span className="flex items-center gap-1 text-xs text-[#8790AE]">
              $
              <input
                aria-label={`${c.category} weekly limit`}
                className="w-20 rounded-lg border border-[#DADDF1] px-2 py-1.5 text-right text-xs outline-none focus:border-[#95A1D8]"
                inputMode="decimal"
                min="0"
                onChange={(e) => setLimits((l) => ({ ...l, [c.category]: e.target.value }))}
                placeholder="—"
                step="1"
                type="number"
                value={limits[c.category]}
              />
              / wk
            </span>
          </label>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#F4F5FB] px-4 py-3">
        <p className="text-xs">
          Total <strong>{money(total)}</strong> a week
          {saves !== null && chosen.length > 0 && (
            <span className={saves >= 0 ? "text-[#209E86]" : "text-[#b4502f]"}>
              {" "}
              · {saves >= 0 ? `saves about ${money(saves)} a week (${money((saves * 52) / 12)} a month)` : `${money(-saves)} a week more than you usually spend`}
            </span>
          )}
          {Number(savingsGoal) > 0 && saves !== null && saves < Number(savingsGoal) && (
            <span className="block text-[10px] text-[#8a5a12]">To hit your {money(Number(savingsGoal))} savings goal, trim about {money(Number(savingsGoal) - saves)} more.</span>
          )}
        </p>
        <div className="flex gap-2">
          <button className={secondaryBtn} onClick={onCancel} type="button">
            Cancel
          </button>
          <button className={primaryBtn} disabled={busy || chosen.length === 0} type="submit">
            {busy ? "Saving…" : "Save budget"}
          </button>
        </div>
      </div>
      {error && <p className="mt-3 rounded-lg bg-[#fff4f0] px-3 py-2 text-[11px] font-semibold text-[#9a3b22]">{error}</p>}
    </form>
  );
}

// ---------- Gemini budget coach ----------

type PlanLine = { category: string; weekly_limit: number; reason: string };
type CoachPlan = { purpose: string; style: Style; weekly_savings_goal: number; categories: PlanLine[]; summary: string };
type CoachReply = { available: boolean; reason?: string; reply: string; chips: string[]; ready: boolean; plan: CoachPlan; math: BudgetMath | null; source?: string };
type Line = { role: "user" | "coach"; text: string };

function BudgetCoach({ onUsePlan, onSkip }: { onUsePlan: (plan: CoachPlan) => void; onSkip: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");
  const [quick, setQuick] = useState(false);
  const [result, setResult] = useState<{ plan: CoachPlan; math: BudgetMath } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  async function ask(history: Line[]) {
    setThinking(true);
    setError("");
    setChips([]);
    try {
      const r = await api<CoachReply>("POST", "/api/budget/coach", { messages: history });
      setLines([...history, { role: "coach", text: r.reply }]);
      setChips(r.chips);
      setResult(r.ready && r.math ? { plan: r.plan, math: r.math } : null);
      setQuick(r.source === "backup");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setThinking(false);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The first question is always the same, so ask it instantly instead of waiting on Gemini.
    setLines([{ role: "coach", text: "Hi! Let's build a weekly budget that fits how you actually spend. What do you want your budget to do for you?" }]);
    setChips(["Save for something", "Cut my spending", "Just keep track"]);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [lines, thinking, result]);

  function send(text: string) {
    const t = text.trim();
    if (!t || thinking) return;
    if (result && /use (this|the) (budget|plan)/i.test(t)) return onUsePlan(result.plan);
    setDraft("");
    ask([...lines, { role: "user", text: t }]);
  }

  return (
    <section className="relative overflow-hidden rounded-[20px] bg-[#E2E5F4] p-5 sm:p-6">
      <div className="absolute -bottom-20 -right-8 size-56 rounded-full border-[32px] border-[#9a6bff]/10" />
      <div className="relative">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#275992] text-white shadow-lg shadow-[#275992]/20">{SPARKLE}</div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#275992]">Budget coach · Gemini</p>
              <h2 className="text-lg font-bold tracking-[-0.025em] text-[#275992]">Let's plan your week</h2>
            </div>
          </div>
          <button className="rounded-lg bg-white/70 px-3 py-1.5 text-[11px] font-bold text-[#275992] transition hover:bg-white" onClick={onSkip} type="button">
            Fill it in myself
          </button>
        </div>

        <div className="max-h-[360px] space-y-2.5 overflow-y-auto pr-1">
          {lines.map((l, i) => (
            <div className={`flex ${l.role === "user" ? "justify-end" : "justify-start"}`} key={i}>
              <p className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-5 ${l.role === "user" ? "rounded-br-md bg-[#275992] text-white" : "rounded-bl-md bg-white text-[#275992] shadow-sm"}`}>
                {l.text}
              </p>
            </div>
          ))}
          {thinking && (
            <div className="flex justify-start">
              <span className="rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 shadow-sm">
                <GeminiThinking
                  compact
                  steps={lines.length < 6 ? ["Reading your answer", "Looking at your spending by category", "Thinking of the next question"] : ["Reading your answers", "Working out weekly limits", "Checking what it saves you", "Putting the budget together"]}
                />
              </span>
            </div>
          )}
          {result && <CoachPlanCard math={result.math} onUse={() => onUsePlan(result.plan)} plan={result.plan} />}
          <div ref={bottom} />
        </div>

        {quick && !thinking && <p className="mt-2 text-[10px] text-[#6F789A]">Gemini was slow to answer, so Gatorstar's quick planner replied. Keep going, nothing is lost.</p>}
        {error && <p className="mt-3 rounded-lg bg-[#fff4f0] px-3 py-2 text-[11px] font-semibold text-[#9a3b22]">{error}</p>}

        {chips.length > 0 && !thinking && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition ${
                  result && /use (this|the) (budget|plan)/i.test(c) ? "border-[#275992] bg-[#275992] text-white hover:bg-[#1F4777]" : "border-[#C4CAE3] bg-white text-[#275992] hover:bg-[#F4F5FB]"
                }`}
                key={c}
                onClick={() => send(c)}
                type="button"
              >
                {c}
              </button>
            ))}
          </div>
        )}

        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <input className={`${input} bg-white`} disabled={thinking} maxLength={500} onChange={(e) => setDraft(e.target.value)} placeholder={thinking ? "Gemini is thinking…" : "Type your answer…"} value={draft} />
          <button className={primaryBtn} disabled={thinking || !draft.trim()} type="submit">
            Send
          </button>
        </form>
      </div>
    </section>
  );
}

function CoachPlanCard({ plan, math, onUse }: { plan: CoachPlan; math: BudgetMath; onUse: () => void }) {
  return (
    <div className="rounded-2xl border border-[#C4CAE3] bg-[#FFFDF7] p-4 shadow-sm">
      <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#FF8A5B]">Proposed budget · {plan.style}</p>
      <p className="mt-1 text-base font-bold tracking-[-0.02em]">{money(math.weekly_total)} a week</p>
      {math.weekly_savings !== null && (
        <p className={`text-[11px] ${math.weekly_savings >= 0 ? "text-[#209E86]" : "text-[#b4502f]"}`}>
          {math.weekly_savings >= 0
            ? `Saves about ${money(math.weekly_savings)} a week vs. your usual (${money(math.monthly_savings ?? 0)} a month)`
            : `${money(-math.weekly_savings)} a week above your usual spending`}
        </p>
      )}
      <ul className="mt-3 space-y-1.5">
        {plan.categories.map((l) => (
          <li className="rounded-xl bg-[#F4F5FB] px-3 py-2" key={l.category}>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 font-bold">
                <span className="size-2 rounded-full" style={{ background: colorFor(l.category) }} />
                {l.category}
              </span>
              <span className="font-bold">{money(l.weekly_limit)} / wk</span>
            </div>
            {l.reason && <p className="mt-0.5 text-[10px] text-[#6F789A]">{l.reason}</p>}
          </li>
        ))}
      </ul>
      {plan.weekly_savings_goal > 0 && <p className="mt-2 text-[11px] text-[#275992]">Savings goal: {money(plan.weekly_savings_goal)} a week</p>}
      <div className="mt-3 flex items-center gap-2">
        <button className={primaryBtn} onClick={onUse} type="button">
          Use this budget
        </button>
        <span className="text-[10px] text-[#8790AE]">Fills in the form so you can review it first.</span>
      </div>
    </div>
  );
}

// ---------- Gemini: high-spending categories and tips ----------

type Tip = { title: string; detail: string; category: string; weekly_savings: number; suggested_limit: number };
type TipsData = {
  source: string;
  headline: string;
  high_categories: { category: string; avg_weekly: number; this_week: number; share_pct: number; limit: number | null; used_pct: number | null }[];
  highlights: { category: string; message: string }[];
  tips: Tip[];
};

function SpendingTips({ data, onApplied }: { data: BudgetData; onApplied: () => void }) {
  const [tips, setTips] = useState<TipsData | null>(() => cached<TipsData>("/api/budget/insights") ?? null);
  const [loading, setLoading] = useState(!tips);
  const [applying, setApplying] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api<TipsData>("GET", "/api/budget/insights")
      .then(setTips)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load, data.has_budget]);

  async function apply(t: Tip) {
    setApplying(t.category);
    try {
      const categories = data.categories.filter((c) => c.limit || c.category === t.category).map((c) => ({ category: c.category, limit: c.category === t.category ? t.suggested_limit : c.limit! }));
      await api("PUT", "/api/budget", { style: data.settings.style, savings_goal: data.settings.savings_goal, share_goals: data.settings.share_goals, summary: data.settings.summary, categories });
      setDone(`${t.category} is now ${money(t.suggested_limit)} a week.`);
      onApplied();
    } catch (e) {
      setDone((e as Error).message);
    } finally {
      setApplying("");
    }
  }

  if (!tips && !loading) return null;
  const maxShare = Math.max(1, ...(tips?.high_categories.map((h) => h.share_pct) ?? [1]));
  return (
    <section className="panel">
      <div className="panel-heading mb-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-[#275992] text-white">{SPARKLE}</span>
          <div>
            <p className="panel-title">Where you could save</p>
            <p className="text-[11px] text-[#8790AE]">{tips?.source === "gemini" ? "Tips from Gemini, based on your spending" : "Based on your spending"}</p>
          </div>
        </div>
        <button className="text-[11px] font-bold text-[#FF8A5B] hover:underline disabled:opacity-50" disabled={loading} onClick={load} type="button">
          Refresh
        </button>
      </div>
      {loading && !tips ? (
        <GeminiThinking steps={["Adding up your spending by category", "Finding your biggest categories", "Looking for easy savings"]} />
      ) : tips ? (
        <>
          <p className="text-sm font-bold text-[#275992]">{tips.headline}</p>
          {tips.high_categories.length > 0 && (
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {tips.high_categories.map((h) => {
                const note = tips.highlights.find((x) => x.category === h.category)?.message;
                return (
                  <div className="rounded-xl bg-[#F4F5FB] p-3" key={h.category}>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-bold">
                        <span className="size-2 rounded-full" style={{ background: colorFor(h.category) }} />
                        {h.category}
                      </span>
                      <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-[#d85f36]">{h.share_pct}% of spending</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white">
                      <div className="h-full rounded-full" style={{ width: `${(100 * h.share_pct) / maxShare}%`, background: colorFor(h.category) }} />
                    </div>
                    <p className="mt-2 text-[10px] leading-4 text-[#6F789A]">{note ?? `About ${money(h.avg_weekly)} a week`}</p>
                  </div>
                );
              })}
            </div>
          )}
          {tips.tips.length > 0 && (
            <ul className="mt-4 space-y-2">
              {tips.tips.map((t) => {
                const current = data.categories.find((c) => c.category === t.category)?.limit ?? null;
                const canApply = current === null || t.suggested_limit < current;
                return (
                  <li className="flex flex-col gap-2 rounded-xl border border-[#DADDF1] bg-white px-3.5 py-3 sm:flex-row sm:items-center sm:gap-3" key={t.title}>
                    <span className="min-w-0 sm:flex-1">
                      <span className="block text-xs font-bold">💡 {t.title}</span>
                      <span className="block text-[11px] leading-4 text-[#6F789A]">{t.detail}</span>
                    </span>
                    <span className="sm:text-right">
                      <span className="block text-xs font-bold text-[#209E86]">~{money(t.weekly_savings)}/wk</span>
                      <span className="block text-[10px] text-[#8790AE]">{money((t.weekly_savings * 52) / 12)} a month</span>
                    </span>
                    {data.has_budget && canApply && (
                      <button className={`${secondaryBtn} self-start whitespace-nowrap sm:self-auto`} disabled={!!applying} onClick={() => apply(t)} type="button">
                        {applying === t.category ? "Saving…" : current === null ? `Budget ${t.category} at ${money(t.suggested_limit)}` : `Lower ${t.category} to ${money(t.suggested_limit)}`}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {done && <p className="mt-3 text-[11px] font-semibold text-[#209E86]">{done}</p>}
          <p className="mt-3 text-[10px] text-[#8790AE]">For education, not financial advice.</p>
        </>
      ) : null}
    </section>
  );
}

// ---------- Points history and rules ----------

function PointsHistory({ points }: { points: Points }) {
  const weeks = [...points.history, { week_start: "this", points: points.this_week.points, under_total: points.this_week.under_total }];
  const max = Math.max(10, ...weeks.map((w) => w.points));
  return (
    <section className="panel">
      <p className="panel-title">Your weeks</p>
      <p className="text-[11px] text-[#8790AE]">Points per week · green = under your whole budget</p>
      <div className="mt-4 flex h-32 items-end gap-2">
        {weeks.map((w) => (
          <div className="flex max-w-[64px] flex-1 flex-col items-center gap-1" key={w.week_start}>
            <span className="text-[10px] font-bold">{w.points}</span>
            <div className="w-full rounded-t-md" style={{ height: `${Math.max(4, (90 * w.points) / max)}px`, background: w.under_total ? "#2ec7a6" : "#C4CAE3" }} />
            <span className="text-[9px] text-[#8790AE]">{w.week_start === "this" ? "Now" : shortDate(w.week_start)}</span>
          </div>
        ))}
      </div>
      {weeks.length === 1 && <p className="mt-2 text-[10px] text-[#8790AE]">Your first finished week shows up here next Monday.</p>}
    </section>
  );
}

function PointsRules({ rules }: { rules: Rules }) {
  const rows: [string, string][] = [
    ["Stay under a category's limit", `+${rules.under}`],
    ["…and use 75% or less of it", `+${rules.way_under} more`],
    ["Go over a category", `${rules.over}`],
    ["Stay under your whole budget", `+${rules.under_total}`],
    ["Each week of your streak", `+${rules.streak_each} (up to +${rules.streak_each * rules.streak_max})`],
    ["Pass a lesson quiz (Learn tab)", `+${rules.lesson} (up to ${rules.lessons_max} a week)`],
    ["Save toward a group goal", `+${rules.goal_save} (up to ${rules.goal_saves_max} a week)`],
  ];
  return (
    <section className="panel">
      <p className="panel-title">How points work</p>
      <p className="text-[11px] text-[#8790AE]">Weeks run Monday to Sunday. A week never goes below 0.</p>
      <ul className="mt-3 divide-y divide-[#F0F1F8]">
        {rows.map(([label, pts]) => (
          <li className="flex justify-between py-1.5 text-[11px]" key={label}>
            <span className="text-[#6F789A]">{label}</span>
            <span className={`font-bold ${pts.startsWith("-") ? "text-[#b4502f]" : "text-[#209E86]"}`}>{pts}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- Leaderboard ----------

type Entry = {
  user_id: number;
  username: string;
  name: string;
  is_me: boolean;
  rank: number;
  points: number;
  last_week_points: number;
  total_points: number;
  streak: number;
  has_budget: boolean;
  budget_used_pct: number | null;
  on_track: number;
  budgeted: number;
  lessons: number;
  goal_saves: number;
  goals: { title: string; group: string; my_pct: number; group_pct: number }[];
  goals_hidden: boolean;
  cheers: number;
  cheered_by_me: boolean;
  badges: string[];
};
type Board = { week: { start: string; end: string; days_left: number }; entries: Entry[] };
const MEDAL = ["🥇", "🥈", "🥉"];

type Sharing = { share_goals: boolean; share_amounts: boolean };

export function Leaderboard({ onGoTo }: { onGoTo: (nav: string) => void }) {
  const [board, setBoard] = useState<Board | null>(() => cached<Board>("/api/budget/leaderboard") ?? null);
  const [error, setError] = useState("");
  const [sharing, setSharing] = useState<Sharing | null>(null);
  useEffect(() => {
    api<Sharing>("GET", "/api/social/settings").then(setSharing).catch(() => {});
  }, []);
  const share = sharing?.share_goals ?? true;
  const load = useCallback(() => {
    api<Board>("GET", "/api/budget/leaderboard")
      .then((b) => {
        setBoard(b);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useLive(["budget", "money", "groups", "friends"], load);

  async function cheer(e: Entry) {
    setBoard((b) => b && { ...b, entries: b.entries.map((x) => (x.user_id === e.user_id ? { ...x, cheered_by_me: true, cheers: x.cheers + 1 } : x)) });
    api("POST", `/api/budget/cheer/${e.user_id}`).catch(load);
  }

  async function toggleShare() {
    if (!sharing) return;
    const next = { ...sharing, share_goals: !sharing.share_goals };
    setSharing(next);
    await api("PUT", "/api/social/settings", next).catch(() => setSharing(sharing));
    load();
  }

  if (!board) return error ? <p className="rounded-xl bg-[#fff4f0] px-4 py-3 text-xs font-semibold text-[#9a3b22]">{error}</p> : <div className="h-64 animate-pulse rounded-[18px] bg-white/60" />;
  const friends = board.entries.length - 1;
  return (
    <div className="space-y-4">
      <section className="panel">
        <div className="panel-heading mb-4">
          <div>
            <p className="panel-title">This week's leaderboard</p>
            <p className="text-[11px] text-[#8790AE]">
              {shortDate(board.week.start)} – {shortDate(board.week.end)} · resets Monday · {board.week.days_left === 0 ? "last day!" : `${board.week.days_left} days left`}
            </p>
          </div>
          <span className="rounded-full bg-[#E2E5F4] px-2.5 py-1 text-[10px] font-bold text-[#275992]">
            {friends} friend{friends === 1 ? "" : "s"}
          </span>
        </div>

        <ol className="space-y-2.5">
          {board.entries.map((e) => (
            <li className={`rounded-2xl border p-3.5 ${e.is_me ? "border-[#95A1D8] bg-[#F4F5FB]" : "border-[#DADDF1] bg-white"}`} key={e.user_id}>
              <div className="flex items-center gap-3">
                <span className="w-7 text-center text-lg font-bold text-[#8790AE]">{MEDAL[e.rank - 1] ?? e.rank}</span>
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#fff0e2] text-[11px] font-bold text-[#FF8A5B]">{initials(e.name)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">
                    {e.name}
                    {e.is_me && <span className="font-normal text-[#8790AE]"> (you)</span>}
                  </span>
                  <span className="flex flex-wrap gap-1 pt-0.5">
                    {e.badges.map((b) => (
                      <span className="rounded-full bg-white px-1.5 py-px text-[9px] font-bold text-[#6F789A] ring-1 ring-[#E2E5F4]" key={b}>
                        {b}
                      </span>
                    ))}
                    {e.cheers > 0 && <span className="rounded-full bg-[#fff0e2] px-1.5 py-px text-[9px] font-bold text-[#d85f36]">👏 {e.cheers}</span>}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block text-xl font-bold leading-6">{e.points}</span>
                  <span className="block text-[9px] text-[#8790AE]">pts · {e.total_points} total</span>
                </span>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2 sm:pl-10">
                <div>
                  {e.has_budget ? (
                    <>
                      <div className="flex justify-between text-[10px]">
                        <span className="font-bold text-[#6F789A]">Budget used</span>
                        <span className={`font-bold ${(e.budget_used_pct ?? 0) > 100 ? "text-[#b4502f]" : "text-[#275992]"}`}>{e.budget_used_pct ?? 0}%</span>
                      </div>
                      <Bar color={(e.budget_used_pct ?? 0) > 100 ? STATUS_LOOK.over.bar : (e.budget_used_pct ?? 0) >= 90 ? STATUS_LOOK.near.bar : STATUS_LOOK.under.bar} pct={e.budget_used_pct ?? 0} />
                      <p className="mt-1 text-[10px] text-[#8790AE]">
                        {e.on_track} of {e.budgeted} categories on track · last week {e.last_week_points} pts
                      </p>
                    </>
                  ) : (
                    <p className="text-[10px] text-[#8790AE]">{e.is_me ? "Set a budget to start earning budget points." : "Hasn't set a budget yet."}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  {e.goals_hidden ? (
                    <p className="text-[10px] text-[#8790AE]">Goals are private</p>
                  ) : e.goals.length ? (
                    e.goals.slice(0, 2).map((g) => (
                      <div key={g.title + g.group}>
                        <div className="flex justify-between text-[10px]">
                          <span className="truncate font-bold text-[#6F789A]">🎯 {g.title}</span>
                          <span className="font-bold text-[#275992]">{g.my_pct}% of their share</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#E2E5F4]">
                          <div className="h-full rounded-full bg-[#9a6bff]" style={{ width: `${g.my_pct}%` }} />
                        </div>
                        <p className="mt-0.5 text-[9px] text-[#8790AE]">
                          {g.group}: group at {g.group_pct}%
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="text-[10px] text-[#8790AE]">No goals yet</p>
                  )}
                </div>
              </div>

              {!e.is_me && (
                <div className="mt-2 text-right">
                  <button
                    className={`rounded-full px-3 py-1 text-[10px] font-bold transition ${e.cheered_by_me ? "bg-[#E3F7F0] text-[#209E86]" : "bg-[#275992] text-white hover:bg-[#1F4777]"}`}
                    disabled={e.cheered_by_me}
                    onClick={() => cheer(e)}
                    type="button"
                  >
                    {e.cheered_by_me ? "Cheered 👏" : `Cheer ${e.name.split(" ")[0]} on 👏`}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>

        {friends === 0 && (
          <div className="mt-4 rounded-xl bg-[#F4F5FB] p-4 text-center">
            <p className="text-xs font-bold">It's more fun with friends</p>
            <p className="mt-1 text-[11px] text-[#6F789A]">Add friends to see who sticks to their budget best this week.</p>
            <button className={`${primaryBtn} mt-3`} onClick={() => onGoTo("Friends")} type="button">
              Find friends
            </button>
          </div>
        )}
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#DADDF1] bg-[#FFFDF7] px-4 py-3">
        <p className="text-[11px] leading-4 text-[#6F789A]">
          🔒 Friends see your points and percentages only, never dollar amounts or what you bought.
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-[11px] font-bold text-[#275992]">
          <input checked={share} className="size-4 accent-[#275992]" onChange={toggleShare} type="checkbox" />
          Show my goal progress to friends
        </label>
      </section>
    </div>
  );
}
