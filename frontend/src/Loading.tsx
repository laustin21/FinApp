import { useEffect, useRef, useState } from "react";
import { api, type Me } from "./api";
import { statementPath } from "./Transactions";
import { Logo } from "./Logo";

// Full-screen loading screens. They cover Nessie's slow first load with something
// that tells the story: signing in, connecting the bank, syncing transactions.
// Each one does real work (preloading data) while it shows, so the app is ready
// when it fades out.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The visual: logo, title, checklist of steps, progress bar. Pure display. */
export function LoadingScreen({
  title,
  subtitle,
  steps,
  active,
  detail,
  progress,
  leaving = false,
}: {
  title: string;
  subtitle: string;
  steps: string[];
  active: number; // index of the step in progress; steps before it show as done
  detail?: string; // small live text under the active step (e.g. "84 of 140")
  progress: number; // 0..1
  leaving?: boolean; // fade out
}) {
  return (
    <div
      aria-busy={!leaving}
      aria-live="polite"
      className={`fixed inset-0 z-50 grid place-items-center bg-[#FFFAED] px-4 transition-opacity duration-500 ${leaving ? "pointer-events-none opacity-0" : "opacity-100"}`}
      role="status"
    >
      <div className="w-full max-w-[420px] rounded-[24px] border border-[#DADDF1] bg-[#FFFDF7] p-7 shadow-[0_20px_60px_-30px_rgba(39,89,146,0.35)] sm:p-9">
        <div className="flex items-center gap-3">
          <div className="relative grid size-11 place-items-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-[#95A1D8] opacity-20" />
            <Logo className="relative" size={44} />
          </div>
          <span className="text-[19px] font-bold tracking-[-0.04em]">Gatorstar</span>
        </div>

        <h1 className="mt-7 text-[24px] font-bold tracking-[-0.04em]">{title}</h1>
        <p className="mt-1 text-sm text-[#6F789A]">{subtitle}</p>

        <ol className="mt-6 space-y-3.5">
          {steps.map((step, i) => {
            const done = i < active;
            const current = i === active;
            return (
              <li className="flex items-start gap-3" key={step}>
                <span
                  className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border transition-colors duration-300 ${
                    done ? "border-[#FF8A5B] bg-[#FF8A5B] text-white" : current ? "border-[#95A1D8]" : "border-[#DADDF1]"
                  }`}
                >
                  {done ? (
                    <svg aria-hidden="true" fill="none" height="11" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" viewBox="0 0 24 24" width="11">
                      <path d="m5 12 5 5 9-10" />
                    </svg>
                  ) : current ? (
                    <span className="size-2.5 animate-spin rounded-full border-2 border-[#95A1D8] border-t-transparent" />
                  ) : null}
                </span>
                <span>
                  <span className={`block text-sm transition-colors duration-300 ${done ? "text-[#275992]" : current ? "font-bold text-[#275992]" : "text-[#8D95B1]"}`}>
                    {step}
                  </span>
                  {current && detail && <span className="mt-0.5 block text-[11px] text-[#6F789A]">{detail}</span>}
                </span>
              </li>
            );
          })}
        </ol>

        <div className="mt-7 h-1.5 overflow-hidden rounded-full bg-[#C4CAE3]">
          <div className="h-full rounded-full bg-[#FF8A5B] transition-[width] duration-500 ease-out" style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }} />
        </div>
      </div>
    </div>
  );
}

/** Step pacing helper: moves through steps on a timer, but never past `gate` until it's lifted. */
function useSteps(count: number, msPerStep: number) {
  const [active, setActive] = useState(0);
  const [gate, setGate] = useState(count - 1); // highest step the timer may reach on its own
  useEffect(() => {
    if (active >= gate) return;
    const t = setTimeout(() => setActive((a) => Math.min(a + 1, gate)), msPerStep);
    return () => clearTimeout(t);
  }, [active, gate, msPerStep]);
  return { active, setActive, gate, setGate };
}

const MIN_MS = 2600; // always show at least this long, so it reads as a step, not a flicker
const MAX_MS = 9000; // never hold anyone longer than this; data keeps loading after

/**
 * After logging in or creating a profile. Preloads the Overview, the Insights
 * statement and Gemini's insights, then fades out.
 * `me` is null until /api/me answers.
 */
export function SignInLoading({ me, onDone }: { me: Me | null; onDone: () => void }) {
  const linked = me ? me.bank_link !== null : null;
  const steps =
    linked === false
      ? ["Signing you in", "Setting up your profile", "Getting Gatorstar ready"]
      : ["Signing you in", "Connecting to your bank", "Syncing transactions and balances", "Preparing your insights"];
  const { active, setActive, setGate } = useSteps(steps.length, 650);
  const [leaving, setLeaving] = useState(false);
  const started = useRef(Date.now());
  const ran = useRef(false);

  // Hold on the bank-sync step until the data is actually here.
  useEffect(() => setGate(linked === false ? steps.length - 1 : 2), [linked]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!me || ran.current) return;
    ran.current = true;
    (async () => {
      if (me.bank_link) {
        const dashboard = api("GET", "/api/me/dashboard?period=this_month").catch(() => {});
        api("GET", statementPath("last_30_days")).catch(() => {});
        const insights = api("GET", "/api/me/insights?period=this_month").catch(() => {});
        await Promise.race([dashboard, wait(MAX_MS - 1500)]);
        setGate(steps.length - 1);
        setActive((a) => Math.max(a, 3));
        // Give Gemini a moment too, but don't wait long for it.
        await Promise.race([insights, wait(Math.max(900, MAX_MS - (Date.now() - started.current) - 600))]);
      }
      const left = MIN_MS - (Date.now() - started.current);
      if (left > 0) await wait(left);
      setActive(steps.length); // everything ticked
      await wait(450);
      setLeaving(true);
      await wait(500);
      onDone();
    })();
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  const progress = Math.min(1, (active + (leaving ? 1 : 0.4)) / steps.length);
  return (
    <LoadingScreen
      active={active}
      leaving={leaving}
      progress={progress}
      steps={steps}
      subtitle={linked === false ? "Creating your space. This only takes a moment." : "Pulling in your latest activity from the bank."}
      title={me ? `Welcome${linked === false ? "" : " back"}, ${me.display_name.split(" ")[0] || "there"}` : "Signing you in"}
    />
  );
}

type HistoryStatus = { status: string; done: number; total: number };

/**
 * After "Link bank" or "Open a new account". Runs `connect` (the POST that links
 * or creates the bank), then, for a new account, follows the history import
 * live, preloads the Overview and fades out.
 */
export function ConnectBankLoading({
  connect,
  newAccount,
  onDone,
  onError,
}: {
  connect: () => Promise<unknown>;
  newAccount: boolean;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const steps = newAccount
    ? ["Opening your Gatorstar bank account", "Linking it to your profile", "Importing your transaction history", "Calculating balances"]
    : ["Verifying your customer ID", "Linking it to your profile", "Syncing transactions and balances"];
  const { active, setActive, setGate } = useSteps(steps.length, 700);
  const [detail, setDetail] = useState("");
  const [importShare, setImportShare] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    setGate(0);
    (async () => {
      const started = Date.now();
      try {
        await connect();
      } catch (e) {
        onError((e as Error).message);
        return;
      }
      setActive(1);
      await wait(700);
      setActive(2);

      if (newAccount) {
        // Follow the import as Nessie fills in about two months of activity.
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          const s = await api<HistoryStatus>("GET", "/api/bank/history-status").catch(() => null);
          if (s && s.total > 0) {
            setDetail(`${s.done} of ${s.total} transactions`);
            setImportShare(s.done / s.total);
          }
          if (!s || s.status !== "building") break;
          await wait(900);
        }
        setActive(3);
        setDetail("");
      }

      await Promise.race([api("GET", "/api/me/dashboard?period=this_month").catch(() => {}), wait(8000)]);
      api("GET", statementPath("last_30_days")).catch(() => {});
      const left = MIN_MS - (Date.now() - started);
      if (left > 0) await wait(left);
      setActive(steps.length);
      await wait(450);
      setLeaving(true);
      await wait(500);
      onDone();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const importStep = 2;
  const progress = Math.min(1, (active + (active === importStep && newAccount ? importShare * 0.9 : 0.4) + (leaving ? 1 : 0)) / steps.length);
  return (
    <LoadingScreen
      active={active}
      detail={detail}
      leaving={leaving}
      progress={progress}
      steps={steps}
      subtitle={newAccount ? "Setting up your account with about two months of activity." : "Connecting your bank to Gatorstar."}
      title="Connecting your bank"
    />
  );
}
