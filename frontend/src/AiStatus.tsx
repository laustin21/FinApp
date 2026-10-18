import { useEffect, useRef, useState } from "react";
import { api } from "./api";

// ---------- Header badge: is Gemini set up and answering? (GET /api/ai/status) ----------

type AiStatus = {
  state: "online" | "offline" | "checking" | "not_configured";
  latency_ms: number | null;
  model: string;
  models?: { fast: string; smart: string };
  last_model?: string | null;
  error: string | null;
  age_seconds?: number | null;
};

const LOOK: Record<AiStatus["state"], { dot: string; label: string; text: string }> = {
  online: { dot: "#209E86", label: "Gemini online", text: "text-[#209E86]" },
  checking: { dot: "#C09022", label: "Checking Gemini…", text: "text-[#8a5a12]" },
  offline: { dot: "#b4502f", label: "Gemini offline", text: "text-[#b4502f]" },
  not_configured: { dot: "#8790AE", label: "Gemini not set up", text: "text-[#6F789A]" },
};

const seconds = (ms: number | null) => (ms === null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function AiStatusBadge() {
  const [s, setS] = useState<AiStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () =>
      api<AiStatus>("GET", "/api/ai/status")
        .then((r) => {
          if (stop) return;
          setS(r);
          // Re-check soon while the first test is running, then once a minute.
          timer = setTimeout(poll, r.state === "checking" ? 2500 : 60000);
        })
        .catch(() => {
          if (!stop) timer = setTimeout(poll, 15000);
        });
    poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  async function testNow() {
    setTesting(true);
    try {
      setS(await api<AiStatus>("POST", "/api/ai/status/check"));
    } catch {
      /* the badge keeps its last status */
    } finally {
      setTesting(false);
    }
  }

  const look = LOOK[testing ? "checking" : s?.state ?? "checking"];
  return (
    <div className="relative" ref={box}>
      <button
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full border border-[#DADDF1] bg-white px-3 py-1.5 text-[11px] font-bold transition hover:bg-[#F4F5FB]"
        onClick={() => setOpen((o) => !o)}
        title="Gemini AI status"
      >
        <span className="relative flex size-2">
          {(s?.state === "online" || s?.state === "checking" || testing) && (
            <span className="absolute inline-flex size-full animate-ping rounded-full opacity-50" style={{ background: look.dot }} />
          )}
          <span className="relative inline-flex size-2 rounded-full" style={{ background: look.dot }} />
        </span>
        <span className={`hidden md:inline ${look.text}`}>{look.label}</span>
        {s?.state === "online" && !testing && <span className="hidden font-semibold text-[#8790AE] lg:inline">{seconds(s.latency_ms)}</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-40 w-72 rounded-2xl border border-[#DADDF1] bg-[#FFFDF7] p-4 text-xs shadow-xl">
          <p className={`font-bold ${look.text}`}>{look.label}</p>
          <dl className="mt-2 space-y-1 text-[11px] text-[#6F789A]">
            <div className="flex justify-between gap-3">
              <dt>Quick answers</dt>
              <dd className="font-semibold text-[#275992]">{s?.models?.fast ?? s?.model ?? "…"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Goal coach &amp; plans</dt>
              <dd className="font-semibold text-[#275992]">{s?.models?.smart ?? s?.model ?? "…"}</dd>
            </div>
            {s?.latency_ms !== null && s?.latency_ms !== undefined && (
              <div className="flex justify-between gap-3">
                <dt>Last answer took</dt>
                <dd className="font-semibold text-[#275992]">{seconds(s.latency_ms)}</dd>
              </div>
            )}
            {s?.age_seconds !== null && s?.age_seconds !== undefined && (
              <div className="flex justify-between gap-3">
                <dt>Last checked</dt>
                <dd className="font-semibold text-[#275992]">{s.age_seconds < 60 ? "just now" : `${Math.round(s.age_seconds / 60)} min ago`}</dd>
              </div>
            )}
          </dl>
          {s?.error && s.state !== "online" && <p className="mt-2 rounded-lg bg-[#fff4f0] px-2.5 py-2 text-[11px] font-semibold text-[#9a3b22]">{s.error}</p>}
          {s?.state !== "not_configured" && (
            <button
              className="mt-3 w-full rounded-lg bg-[#275992] py-2 text-[11px] font-bold text-white transition hover:bg-[#1F4777] disabled:opacity-60"
              disabled={testing}
              onClick={testNow}
            >
              {testing ? "Testing…" : "Test now"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- "Gemini is thinking" screen, for any wait on Gemini ----------

/** Walks through the given steps while Gemini works, with a timer, so a long wait reads as progress. */
export function GeminiThinking({ steps, compact = false }: { steps: string[]; compact?: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - started), 250);
    return () => clearInterval(t);
  }, []);
  // About 1.6 s per step; stay on the last one until the answer arrives.
  const step = Math.min(steps.length - 1, Math.floor(elapsed / 1600));
  const slow = elapsed > 12000;

  if (compact)
    return (
      <span className="flex items-center gap-2 text-[11px] text-[#6F789A]">
        <span className="flex gap-1">
          {[0, 1, 2].map((d) => (
            <span className="size-1.5 animate-bounce rounded-full bg-[#95A1D8]" key={d} style={{ animationDelay: `${d * 120}ms` }} />
          ))}
        </span>
        <span>{slow ? "Still working, almost there…" : steps[step]}</span>
        <span className="tabular-nums text-[#8790AE]">{(elapsed / 1000).toFixed(0)}s</span>
      </span>
    );

  return (
    <div aria-live="polite" role="status">
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li className="flex items-center gap-2.5 text-xs" key={s}>
            <span
              className={`grid size-4 shrink-0 place-items-center rounded-full border ${
                i < step ? "border-[#275992] bg-[#275992] text-white" : i === step ? "border-[#95A1D8]" : "border-[#C4CAE3]"
              }`}
            >
              {i < step ? (
                <svg aria-hidden="true" fill="none" height="9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" viewBox="0 0 24 24" width="9">
                  <path d="m5 12 5 5 9-10" />
                </svg>
              ) : i === step ? (
                <span className="size-2 animate-spin rounded-full border-2 border-[#95A1D8] border-t-transparent" />
              ) : null}
            </span>
            <span className={i <= step ? "font-semibold text-[#275992]" : "text-[#8790AE]"}>{s}</span>
          </li>
        ))}
      </ol>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/70">
        <div className="h-full rounded-full bg-[#275992] transition-[width] duration-300 ease-out" style={{ width: `${Math.min(95, 8 + (elapsed / 9000) * 87)}%` }} />
      </div>
      <p className="mt-1.5 text-[10px] text-[#6F789A]">
        {slow ? "Gemini is taking a little longer than usual. Hang tight…" : "Gemini is working on it"} · <span className="tabular-nums">{(elapsed / 1000).toFixed(0)}s</span>
      </p>
    </div>
  );
}
