import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { GeminiThinking } from "./AiStatus";

// ---------- Goal terms: payment schedule + what happens when someone misses ----------

export type Frequency = "none" | "weekly" | "biweekly" | "monthly";
export type PenaltyType = "none" | "money" | "honor";
export type Terms = {
  frequency: Frequency;
  penalty_type: PenaltyType;
  penalty_percent: number;
  penalty_dare: string;
  pace: string;
  realism_score: number | null;
  realism_note: string;
  coach_summary: string;
};
export const NO_TERMS: Terms = {
  frequency: "none",
  penalty_type: "none",
  penalty_percent: 0,
  penalty_dare: "",
  pace: "",
  realism_score: null,
  realism_note: "",
  coach_summary: "",
};

const FREQ_LABEL: Record<Frequency, string> = { none: "No schedule", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };
export const DARE_IDEAS = ["Wear the rival team's jersey to class", "Buy the group's next round of coffee", "Post an embarrassing throwback photo"];

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const longDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const input = "w-full rounded-xl border border-[#DADDF1] bg-white px-3.5 py-2.5 text-xs outline-none transition focus:border-[#95A1D8]";
const fieldLabel = "mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6F789A]";
const primaryBtn = "rounded-lg bg-[#275992] px-3.5 py-2 text-[11px] font-bold text-white transition hover:bg-[#1F4777] disabled:opacity-50";

export function describePenalty(t: Pick<Terms, "penalty_type" | "penalty_percent" | "penalty_dare">): string {
  if (t.penalty_type === "money") return `Miss a payment: +${t.penalty_percent}% of that payment`;
  if (t.penalty_type === "honor") return `Miss a payment: ${t.penalty_dare} (honor code)`;
  return "No penalty for missed payments";
}

/** The terms inputs, used when creating a goal and when changing an existing goal's terms. */
export function TermsFields({ terms, onChange }: { terms: Terms; onChange: (t: Terms) => void }) {
  const set = (patch: Partial<Terms>) => onChange({ ...terms, ...patch });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="block">
        <span className={fieldLabel}>How often does everyone pay?</span>
        <select className={input} onChange={(e) => set({ frequency: e.target.value as Frequency })} value={terms.frequency}>
          {(Object.keys(FREQ_LABEL) as Frequency[]).map((f) => (
            <option key={f} value={f}>
              {FREQ_LABEL[f]}
            </option>
          ))}
        </select>
      </label>
      <div>
        <span className={fieldLabel}>If someone misses a payment</span>
        <div className="grid grid-cols-3 gap-1.5">
          {(["none", "money", "honor"] as PenaltyType[]).map((p) => (
            <button
              className={`rounded-lg border px-2 py-2 text-[11px] font-bold transition ${terms.penalty_type === p ? "border-[#95A1D8] bg-[#E2E5F4] text-[#275992]" : "border-[#DADDF1] bg-white text-[#6F789A] hover:bg-[#F4F5FB]"}`}
              disabled={terms.frequency === "none" && p !== "none"}
              key={p}
              onClick={() => set({ penalty_type: p, penalty_percent: p === "money" && !terms.penalty_percent ? 10 : terms.penalty_percent, penalty_dare: p === "honor" && !terms.penalty_dare ? DARE_IDEAS[0] : terms.penalty_dare })}
              type="button"
            >
              {p === "none" ? "Nothing" : p === "money" ? "Pay extra %" : "Honor dare"}
            </button>
          ))}
        </div>
      </div>
      {terms.frequency !== "none" && terms.penalty_type === "money" && (
        <label className="block">
          <span className={fieldLabel}>Extra per missed payment (%)</span>
          <input className={input} max="100" min="1" onChange={(e) => set({ penalty_percent: Number(e.target.value) })} required step="1" type="number" value={terms.penalty_percent || ""} />
          <span className="mt-1 block text-[10px] text-[#8790AE]">Added to that person's total, so they end up contributing more.</span>
        </label>
      )}
      {terms.frequency !== "none" && terms.penalty_type === "honor" && (
        <label className="block sm:col-span-2">
          <span className={fieldLabel}>The dare (your group enforces it, honor code)</span>
          <input className={input} maxLength={160} onChange={(e) => set({ penalty_dare: e.target.value })} required value={terms.penalty_dare} />
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {DARE_IDEAS.map((d) => (
              <button className="rounded-full border border-[#DADDF1] bg-white px-2.5 py-1 text-[10px] text-[#6F789A] hover:bg-[#F4F5FB]" key={d} onClick={() => set({ penalty_dare: d })} type="button">
                {d}
              </button>
            ))}
          </span>
        </label>
      )}
    </div>
  );
}

/** 1-10 realism meter with a label. */
export function Realism({ score, note }: { score: number; note?: string }) {
  const tone = score >= 8 ? "#209E86" : score >= 5 ? "#C09022" : "#b4502f";
  const label = score >= 8 ? "Realistic" : score >= 5 ? "A stretch" : "Not realistic yet";
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-bold" style={{ color: tone }}>
          {label} · {score}/10
        </span>
      </div>
      <div className="mt-1 flex gap-0.5">
        {Array.from({ length: 10 }, (_, i) => (
          <span className="h-1.5 flex-1 rounded-full" key={i} style={{ background: i < score ? tone : "#DADDF1" }} />
        ))}
      </div>
      {note && <p className="mt-1.5 text-[11px] leading-4 text-[#6F789A]">{note}</p>}
    </div>
  );
}

// ---------- The Gemini goal coach (goal_coach.py) ----------

export type CoachPlan = Omit<Terms, "coach_summary" | "realism_score"> & {
  title: string;
  target_amount: number;
  deadline: string;
  realism_score: number;
  summary: string;
};
export type CoachMath = {
  members: number;
  share_per_person: number;
  payments_per_person: number;
  payment_per_person: number;
  monthly_per_person: number;
  frequency: Frequency;
  weeks_left: number;
  share_of_spare_cash_pct: number | null;
  realism_label: string | null;
};
type CoachReply = { available: boolean; reason?: string; reply: string; chips: string[]; ready: boolean; plan: CoachPlan; math: CoachMath | null; source?: "gemini" | "backup" };
type Line = { role: "user" | "coach"; text: string };

export function GoalCoach({ groupId, onUsePlan, onSkip }: { groupId: number; onUsePlan: (plan: CoachPlan) => void; onSkip: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState("");
  const [quick, setQuick] = useState(false); // the backup planner answered because Gemini was slow
  const [result, setResult] = useState<{ plan: CoachPlan; math: CoachMath } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  async function ask(history: Line[]) {
    setThinking(true);
    setError("");
    setChips([]);
    try {
      const r = await api<CoachReply>("POST", `/api/groups/${groupId}/goal-coach`, { messages: history });
      if (!r.available) {
        setUnavailable(r.reason ?? "The goal coach isn't available right now.");
        return;
      }
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
    setLines([{ role: "coach", text: "Hey! Let's set up a goal your whole group can hit. What are you saving for?" }]);
    setChips(["A group trip", "Concert or festival tickets", "A shared dinner fund", "Something else"]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [lines, thinking, result]);

  function send(text: string) {
    const t = text.trim();
    if (!t || thinking) return;
    if (result && /use (this|the) plan/i.test(t)) return onUsePlan(result.plan);
    setDraft("");
    ask([...lines, { role: "user", text: t }]);
  }

  return (
    <section className="relative overflow-hidden rounded-[20px] bg-[#E2E5F4] p-5 sm:p-6">
      <div className="absolute -bottom-20 -right-8 size-56 rounded-full border-[32px] border-[#9a6bff]/10" />
      <div className="relative">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#275992] text-white shadow-lg shadow-[#275992]/20">
              <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
                <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3ZM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" />
              </svg>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#275992]">Goal coach · Gemini</p>
              <h2 className="text-lg font-bold tracking-[-0.025em] text-[#275992]">Let's plan this goal together</h2>
            </div>
          </div>
          <button className="rounded-lg bg-white/70 px-3 py-1.5 text-[11px] font-bold text-[#275992] transition hover:bg-white" onClick={onSkip} type="button">
            Fill it in myself
          </button>
        </div>

        {unavailable ? (
          <div className="rounded-xl bg-white/70 p-4 text-xs text-[#6F789A]">
            <p>{unavailable}</p>
            <button className={`${primaryBtn} mt-3`} onClick={onSkip} type="button">
              Open the goal form
            </button>
          </div>
        ) : (
          <>
            <div className="max-h-[340px] space-y-2.5 overflow-y-auto pr-1">
              {lines.map((l, i) => (
                <div className={`flex ${l.role === "user" ? "justify-end" : "justify-start"}`} key={i}>
                  <p
                    className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-5 ${
                      l.role === "user" ? "rounded-br-md bg-[#275992] text-white" : "rounded-bl-md bg-white text-[#275992] shadow-sm"
                    }`}
                  >
                    {l.text}
                  </p>
                </div>
              ))}
              {thinking && (
                <div className="flex justify-start">
                  <span className="rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 shadow-sm">
                    <GeminiThinking
                      compact
                      steps={lines.length < 4 ? ["Reading your answer", "Checking your balance and spending", "Thinking of the next question"] : ["Reading your answers", "Running the numbers for your group", "Checking how realistic it is", "Putting the plan together"]}
                    />
                  </span>
                </div>
              )}

              {result && <PlanCard math={result.math} onUse={() => onUsePlan(result.plan)} plan={result.plan} />}
              <div ref={bottom} />
            </div>

            {quick && !thinking && (
              <p className="mt-2 text-[10px] text-[#6F789A]">Gemini was slow to answer, so Gatorstar's quick planner replied. Keep going, nothing is lost.</p>
            )}
            {error && <p className="mt-3 rounded-lg bg-[#fff4f0] px-3 py-2 text-[11px] font-semibold text-[#9a3b22]">{error}</p>}

            {chips.length > 0 && !thinking && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {chips.map((c) => (
                  <button
                    className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition ${
                      result && /use (this|the) plan/i.test(c) ? "border-[#275992] bg-[#275992] text-white hover:bg-[#1F4777]" : "border-[#C4CAE3] bg-white text-[#275992] hover:bg-[#F4F5FB]"
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
          </>
        )}
      </div>
    </section>
  );
}

function PlanCard({ plan, math, onUse }: { plan: CoachPlan; math: CoachMath; onUse: () => void }) {
  const per = math.frequency === "weekly" ? "week" : math.frequency === "biweekly" ? "2 weeks" : "month";
  return (
    <div className="rounded-2xl border border-[#C4CAE3] bg-[#FFFDF7] p-4 shadow-sm">
      <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#FF8A5B]">Proposed plan</p>
      <p className="mt-1 text-base font-bold tracking-[-0.02em]">{plan.title}</p>
      <p className="text-[11px] text-[#6F789A]">
        {money(plan.target_amount)} by {longDate(plan.deadline)} · {math.weeks_left} weeks · {plan.pace || "Steady"} pace
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-[#F4F5FB] p-2.5">
          <p className="text-sm font-bold">{money(math.payment_per_person)}</p>
          <p className="text-[10px] text-[#8790AE]">each, every {per}</p>
        </div>
        <div className="rounded-xl bg-[#F4F5FB] p-2.5">
          <p className="text-sm font-bold">{math.payments_per_person}</p>
          <p className="text-[10px] text-[#8790AE]">payments each</p>
        </div>
        <div className="rounded-xl bg-[#F4F5FB] p-2.5">
          <p className="text-sm font-bold">{math.share_of_spare_cash_pct !== null ? `${math.share_of_spare_cash_pct}%` : money(math.monthly_per_person)}</p>
          <p className="text-[10px] text-[#8790AE]">{math.share_of_spare_cash_pct !== null ? "of your spare cash" : "per person / month"}</p>
        </div>
      </div>
      <div className="mt-3">
        <Realism note={plan.realism_note} score={plan.realism_score} />
      </div>
      <p className="mt-3 rounded-lg bg-[#F4F5FB] px-3 py-2 text-[11px] text-[#275992]">{describePenalty(plan)}</p>
      {plan.summary && <p className="mt-2 text-[11px] leading-4 text-[#6F789A]">{plan.summary}</p>}
      <div className="mt-3 flex gap-2">
        <button className={primaryBtn} onClick={onUse} type="button">
          Use this plan
        </button>
        <span className="self-center text-[10px] text-[#8790AE]">Fills in the goal form so you can review it first.</span>
      </div>
      <p className="mt-2 text-[10px] text-[#8790AE]">Split evenly across {math.members} member{math.members === 1 ? "" : "s"}: {money(math.share_per_person)} each.</p>
    </div>
  );
}
