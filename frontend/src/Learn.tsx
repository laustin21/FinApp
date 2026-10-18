import { useCallback, useEffect, useRef, useState } from "react";
import { api, cached } from "./api";
import { GeminiThinking } from "./AiStatus";

// ---------- Learn (learn.py): lessons Gemini tailors to your spending, a quiz that earns points, and an Ask box ----------

type LessonCard = {
  key: string;
  title: string;
  minutes: number;
  emoji: string;
  blurb: string;
  recommended: boolean;
  reason: string | null;
  passed_ever: boolean;
  passed_this_week: boolean;
  best_score: number | null;
};
type LessonList = {
  lessons: LessonCard[];
  passed_this_week: number;
  weekly_cap: number;
  points_each: number;
  points_left_this_week: number;
  progress: { passed: number; total: number; points_all_time: number; streak_weeks: number };
};
type Lesson = {
  key: string;
  emoji: string;
  minutes: number;
  source: string;
  title: string;
  sections: { heading: string; body: string }[];
  takeaway: string;
  try_this: string;
  quiz: { question: string; options: string[] }[];
  passed_this_week: boolean;
};
type QuizResult = { score: number; total: number; passed: boolean; points_awarded: number; already_passed: boolean; results: { correct: boolean; answer_index: number; explanation: string }[] };

const primaryBtn = "rounded-lg bg-[#275992] px-3.5 py-2 text-[11px] font-bold text-white transition hover:bg-[#1F4777] disabled:opacity-50";
const secondaryBtn = "rounded-lg border border-[#DADDF1] bg-white px-3.5 py-2 text-[11px] font-bold text-[#275992] transition hover:bg-[#E2E5F4] disabled:opacity-50";
const input = "w-full rounded-xl border border-[#DADDF1] bg-white px-3.5 py-2.5 text-xs outline-none transition focus:border-[#95A1D8]";

function Stat({ label, value, note, children }: { label: string; value: string; note?: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[#DADDF1] bg-[#FFFDF7] p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#6F789A]">{label}</p>
      <p className="mt-1 text-lg font-bold tracking-[-0.02em]">{value}</p>
      {note && <p className="text-[10px] text-[#8790AE]">{note}</p>}
      {children}
    </div>
  );
}

export default function Learn() {
  const [list, setList] = useState<LessonList | null>(() => cached<LessonList>("/api/learn") ?? null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    api<LessonList>("GET", "/api/learn").then(setList).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const p = list?.progress;
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#6F789A]">Learn</p>
        <h1 className="text-[28px] font-bold tracking-[-0.045em] sm:text-[34px]">Get smarter with money</h1>
        <p className="mt-1 text-sm text-[#6F789A]">Short lessons tailored to your spending, quizzes that earn leaderboard points, and answers to your money questions.</p>
      </div>

      {p && !open && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Lessons passed" value={`${p.passed} of ${p.total}`}>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#E2E5F4]">
              <div className="h-full rounded-full bg-[#9a6bff]" style={{ width: `${(100 * p.passed) / p.total}%` }} />
            </div>
          </Stat>
          <Stat label="Learning streak" value={p.streak_weeks ? `🔥 ${p.streak_weeks} week${p.streak_weeks === 1 ? "" : "s"}` : "—"} note="Pass one lesson a week to keep it" />
          <Stat label="Points from lessons" value={`⭐ ${p.points_all_time}`} note="Count on the leaderboard" />
          <Stat label="This week" value={`${list!.passed_this_week} of ${list!.weekly_cap}`} note={list!.points_left_this_week ? `+${list!.points_left_this_week} pts left to earn` : "All lesson points earned ✓"} />
        </div>
      )}

      {open ? (
        <LessonView
          lessonKey={open}
          onClose={() => {
            setOpen(null);
            load();
          }}
          onPassed={load}
        />
      ) : (
        <section className="panel">
          <div className="panel-heading mb-4">
            <div>
              <p className="panel-title">Money lessons</p>
              <p className="text-[11px] text-[#8790AE]">2-3 minutes each, tailored to your spending by Gemini. Pass the quiz for points.</p>
            </div>
            {list && (
              <span className="rounded-full bg-[#E3F7F0] px-2.5 py-1 text-[10px] font-bold text-[#209E86]">
                {list.points_left_this_week > 0 ? `+${list.points_left_this_week} pts left to earn this week` : "Weekly lesson points earned ✓"}
              </span>
            )}
          </div>
          {!list ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div className="h-32 animate-pulse rounded-2xl bg-[#F4F5FB]" key={i} />
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.lessons.map((l) => (
                <button
                  className={`flex flex-col rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md ${l.recommended ? "border-[#95A1D8] bg-[#F4F5FB]" : "border-[#DADDF1] bg-white"}`}
                  key={l.key}
                  onClick={() => setOpen(l.key)}
                  type="button"
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-2xl">{l.emoji}</span>
                    {l.passed_this_week ? (
                      <span className="rounded-full bg-[#E3F7F0] px-2 py-0.5 text-[9px] font-bold text-[#209E86]">Passed ✓</span>
                    ) : (
                      <span className="rounded-full bg-[#fff0e2] px-2 py-0.5 text-[9px] font-bold text-[#d85f36]">+{list.points_each} pts</span>
                    )}
                  </span>
                  <span className="mt-2 text-sm font-bold">{l.title}</span>
                  <span className="mt-0.5 text-[11px] leading-4 text-[#6F789A]">{l.blurb}</span>
                  <span className="mt-auto pt-3 text-[10px] text-[#8790AE]">
                    {l.minutes} min{l.recommended && l.reason && <span className="font-bold text-[#275992]"> · For you: {l.reason}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      <AskGemini />
      <p className="text-center text-[10px] text-[#8790AE]">Lessons and answers are for education, not financial advice.</p>
    </div>
  );
}

function LessonView({ lessonKey, onClose, onPassed }: { lessonKey: string; onClose: () => void; onPassed: () => void }) {
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Lesson>("GET", `/api/learn/lessons/${lessonKey}`)
      .then((l) => {
        setLesson(l);
        setAnswers(l.quiz.map(() => null));
      })
      .catch((e) => setError(e.message));
  }, [lessonKey]);

  async function submit() {
    setBusy(true);
    try {
      const r = await api<QuizResult>("POST", `/api/learn/lessons/${lessonKey}/quiz`, { answers });
      setResult(r);
      if (r.points_awarded) onPassed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <button className="mb-4 text-[11px] font-bold text-[#FF8A5B] hover:underline" onClick={onClose} type="button">
        ← All lessons
      </button>
      {error && <p className="rounded-lg bg-[#fff4f0] px-3 py-2 text-[11px] font-semibold text-[#9a3b22]">{error}</p>}
      {!lesson && !error && (
        <div className="max-w-md">
          <GeminiThinking steps={["Opening the lesson", "Looking at your spending", "Tailoring the examples to you", "Writing your quiz"]} />
        </div>
      )}
      {lesson && (
        <div className="mx-auto max-w-2xl">
          <div className="flex items-center gap-3">
            <span className="text-4xl">{lesson.emoji}</span>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#FF8A5B]">
                {lesson.minutes}-minute lesson{lesson.source === "gemini" ? " · personalized by Gemini" : ""}
              </p>
              <h2 className="text-2xl font-bold tracking-[-0.03em]">{lesson.title}</h2>
            </div>
          </div>
          <div className="mt-5 space-y-4">
            {lesson.sections.map((s) => (
              <div key={s.heading}>
                <p className="text-sm font-bold text-[#275992]">{s.heading}</p>
                <p className="mt-1 text-[13px] leading-6 text-[#4C5677]">{s.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-[#E2E5F4] p-3.5">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#275992]">Key takeaway</p>
              <p className="mt-1 text-xs leading-5 text-[#275992]">{lesson.takeaway}</p>
            </div>
            <div className="rounded-xl bg-[#E3F7F0] p-3.5">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#209E86]">Try this week</p>
              <p className="mt-1 text-xs leading-5 text-[#16866e]">{lesson.try_this}</p>
            </div>
          </div>

          <div className="mt-6 border-t border-[#DADDF1] pt-5">
            <p className="text-sm font-bold">Quick quiz</p>
            <p className="text-[11px] text-[#8790AE]">Get 2 of 3 right for +10 points{lesson.passed_this_week ? " (you already earned them this week)" : ""}.</p>
            <ol className="mt-3 space-y-4">
              {lesson.quiz.map((q, qi) => {
                const r = result?.results[qi];
                return (
                  <li key={qi}>
                    <p className="text-xs font-bold">
                      {qi + 1}. {q.question}
                    </p>
                    <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                      {q.options.map((o, oi) => {
                        const picked = answers[qi] === oi;
                        const look = r
                          ? oi === r.answer_index
                            ? "border-[#2ec7a6] bg-[#E3F7F0] text-[#16866e]"
                            : picked
                              ? "border-[#ff8a5b] bg-[#fff0e9] text-[#b4502f]"
                              : "border-[#DADDF1] bg-white text-[#8790AE]"
                          : picked
                            ? "border-[#95A1D8] bg-[#E2E5F4] text-[#275992]"
                            : "border-[#DADDF1] bg-white text-[#275992] hover:bg-[#F4F5FB]";
                        return (
                          <button
                            className={`rounded-xl border px-3 py-2 text-left text-[11px] font-semibold transition ${look}`}
                            disabled={!!result}
                            key={oi}
                            onClick={() => setAnswers((a) => a.map((v, i) => (i === qi ? oi : v)))}
                            type="button"
                          >
                            {o}
                          </button>
                        );
                      })}
                    </div>
                    {r && <p className={`mt-1.5 text-[11px] ${r.correct ? "text-[#209E86]" : "text-[#b4502f]"}`}>{r.correct ? "✓ Right. " : "✗ Not quite. "}{r.explanation}</p>}
                  </li>
                );
              })}
            </ol>
            {!result ? (
              <button className={`${primaryBtn} mt-4`} disabled={busy || answers.some((a) => a === null)} onClick={submit} type="button">
                {busy ? "Checking…" : "Check my answers"}
              </button>
            ) : (
              <div className={`mt-4 rounded-xl px-4 py-3 ${result.passed ? "bg-[#E3F7F0]" : "bg-[#fff7e6]"}`}>
                <p className={`text-sm font-bold ${result.passed ? "text-[#209E86]" : "text-[#8a5a12]"}`}>
                  {result.score} of {result.total} right.{" "}
                  {result.points_awarded ? `+${result.points_awarded} points! 🎉` : result.passed ? (result.already_passed ? "Passed (points already earned this week)." : "Passed (weekly lesson points are maxed out).") : "Almost: give it another go."}
                </p>
                <div className="mt-2 flex gap-2">
                  {!result.passed && (
                    <button
                      className={secondaryBtn}
                      onClick={() => {
                        setResult(null);
                        setAnswers(lesson.quiz.map(() => null));
                      }}
                      type="button"
                    >
                      Try again
                    </button>
                  )}
                  <button className={primaryBtn} onClick={onClose} type="button">
                    Back to lessons
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- Ask Gemini ----------

type Turn = { role: "user" | "coach"; text: string };
const STARTERS = ["How big should my emergency fund be?", "How do I stop impulse buying?", "Is it better to save or pay off a credit card?", "What is the 50/30/20 rule?"];

function AskGemini() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [follow, setFollow] = useState<string[]>(STARTERS);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");
  const [quick, setQuick] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (turns.length) bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [turns, thinking]);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || thinking) return;
    const history = turns;
    setTurns([...history, { role: "user", text: question }]);
    setDraft("");
    setFollow([]);
    setThinking(true);
    setError("");
    try {
      const r = await api<{ answer: string; follow_ups: string[]; source: string }>("POST", "/api/learn/ask", { question, history });
      setTurns((t) => [...t, { role: "coach", text: r.answer }]);
      setFollow(r.follow_ups);
      setQuick(r.source === "backup");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setThinking(false);
    }
  }

  return (
    <section className="relative overflow-hidden rounded-[20px] bg-[#E2E5F4] p-5 sm:p-6">
      <div className="absolute -bottom-20 -right-8 size-56 rounded-full border-[32px] border-[#9a6bff]/10" />
      <div className="relative">
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#275992]">Ask Gemini</p>
        <h2 className="text-lg font-bold tracking-[-0.025em] text-[#275992]">Got a money question?</h2>
        <p className="text-[11px] text-[#6F789A]">Budgeting, saving, credit, goals. Gemini answers using your own spending when it helps.</p>

        {turns.length > 0 && (
          <div className="mt-4 max-h-[360px] space-y-2.5 overflow-y-auto pr-1">
            {turns.map((t, i) => (
              <div className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`} key={i}>
                <p className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3.5 py-2.5 text-xs leading-5 ${t.role === "user" ? "rounded-br-md bg-[#275992] text-white" : "rounded-bl-md bg-white text-[#275992] shadow-sm"}`}>
                  {t.text}
                </p>
              </div>
            ))}
            {thinking && (
              <div className="flex justify-start">
                <span className="rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 shadow-sm">
                  <GeminiThinking compact steps={["Reading your question", "Checking your spending", "Writing an answer"]} />
                </span>
              </div>
            )}
            <div ref={bottom} />
          </div>
        )}
        {quick && !thinking && <p className="mt-2 text-[10px] text-[#6F789A]">Gemini was busy, so this is a quick answer from Gatorstar. Ask again for more detail.</p>}
        {error && <p className="mt-3 rounded-lg bg-[#fff4f0] px-3 py-2 text-[11px] font-semibold text-[#9a3b22]">{error}</p>}

        {follow.length > 0 && !thinking && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {follow.map((f) => (
              <button className="rounded-full border border-[#C4CAE3] bg-white px-3 py-1.5 text-[11px] font-bold text-[#275992] transition hover:bg-[#F4F5FB]" key={f} onClick={() => ask(f)} type="button">
                {f}
              </button>
            ))}
          </div>
        )}
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            ask(draft);
          }}
        >
          <input className={input} disabled={thinking} maxLength={500} onChange={(e) => setDraft(e.target.value)} placeholder="Ask anything about money…" value={draft} />
          <button className={primaryBtn} disabled={thinking || !draft.trim()} type="submit">
            Ask
          </button>
        </form>
      </div>
    </section>
  );
}
