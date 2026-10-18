import { useCallback, useEffect, useMemo, useState } from "react";
import { api, cached } from "./api";
import { useLive } from "./live";

/** The statement request for a period/account (App.tsx uses it to preload the default view). */
export const statementPath = (period: string, accountId = "") =>
  `/api/me/statement?period=${period}&account_id=${encodeURIComponent(accountId)}`;

type Line = {
  id: string;
  account_id: string;
  account: string;
  type: "Deposit" | "Withdrawal" | "Purchase" | "Transfer" | "Bill" | "Goal";
  date: string;
  description: string;
  category: string | null;
  amount: number;
  status: string;
  balance_after?: number;
};
type Account = { id: string; type: string; nickname: string; opening_balance: number; balance: number };
type Statement = {
  customer: { name: string; address: { street_number?: string; street_name?: string; city?: string; state?: string; zip?: string } };
  period: { key: string; start: string; end: string };
  accounts: Account[];
  account_id: string | null;
  balance: number;
  summary: { money_in: number; money_out: number; net: number; count: number; all_time_count: number };
  transactions: Line[];
};
type Simulation = { kind: string; label: string; type: "deposit" | "purchase"; amount: number; merchant: string | null };

const PERIODS = [
  { key: "last_30_days", label: "Last 30 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_3_months", label: "Last 3 months" },
  { key: "all", label: "All time" },
];
const REFRESH_MS = 8000; // live updates: re-check the bank every few seconds

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const signed = (n: number) => (n > 0 ? `+${money(n)}` : `−${money(Math.abs(n))}`);
const longDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const dayHeading = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

const TYPE_STYLE: Record<Line["type"], string> = {
  Deposit: "bg-[#E3F7F0] text-[#209E86]",
  Withdrawal: "bg-[#fff0e9] text-[#b4502f]",
  Purchase: "bg-[#E2E5F4] text-[#5F698D]",
  Transfer: "bg-[#784CCB33] text-[#275992]",
  Bill: "bg-[#fff7e6] text-[#8a5a12]",
  Goal: "bg-[#275992] text-white",
};

const select =
  "appearance-none rounded-xl border border-[#DADDF1] bg-white py-2.5 pl-4 pr-9 text-xs font-bold text-[#275992] shadow-sm outline-none focus:border-[#95A1D8]";
const secondaryBtn = "rounded-xl border border-[#DADDF1] bg-white px-4 py-2.5 text-xs font-bold text-[#275992] shadow-sm transition hover:bg-[#E2E5F4] disabled:opacity-50";

function toCsv(s: Statement) {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const single = Boolean(s.account_id);
  const rows = [["Date", "Type", "Description", "Category", "Account", "Amount", ...(single ? ["Balance"] : [])]];
  for (const t of s.transactions)
    rows.push([t.date, t.type, t.description, t.category ?? "", t.account, t.amount.toFixed(2), ...(single ? [(t.balance_after ?? 0).toFixed(2)] : [])]);
  return rows.map((r) => r.map(esc).join(",")).join("\r\n");
}

// `embedded`: shown as a section inside another page (Insights) rather than as its own page.
export default function Transactions({ embedded = false }: { embedded?: boolean }) {
  const [period, setPeriod] = useState("last_30_days");
  const [accountId, setAccountId] = useState("");
  // Start from the last statement we saw (instant when coming back to this tab).
  const [data, setData] = useState<Statement | null>(() => cached<Statement>(statementPath("last_30_days")) ?? null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(() => !cached(statementPath("last_30_days")));
  const [sims, setSims] = useState<Simulation[]>([]);
  const [simBusy, setSimBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());

  const load = useCallback(
    (quiet = false) => {
      const path = statementPath(period, accountId);
      if (!quiet) {
        const seen = cached<Statement>(path);
        if (seen) setData(seen); // show it now, refresh quietly
        else setLoading(true);
      }
      return api<Statement>("GET", path)
        .then((next) => {
          setData((prev) => {
            // Briefly highlight lines that just appeared (live updates).
            if (prev && prev.period.key === next.period.key && prev.account_id === next.account_id) {
              const old = new Set(prev.transactions.map((t) => t.id));
              const fresh = next.transactions.filter((t) => !old.has(t.id)).map((t) => t.id);
              if (fresh.length) {
                setHighlight(new Set(fresh));
                setTimeout(() => setHighlight(new Set()), 4000);
              }
            }
            return next;
          });
          setError("");
        })
        .catch((e) => setError(`Couldn't load your statement (${e.message})`))
        .finally(() => !quiet && setLoading(false));
    },
    [period, accountId],
  );

  // New transactions (goal savings, simulations) show up within ~2 s.
  useLive(["money"], () => load(true));

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load(true);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    api<Simulation[]>("GET", "/api/dev/simulations").then(setSims).catch(() => setSims([]));
  }, []);

  async function simulate(s: Simulation) {
    setSimBusy(s.kind);
    setToast(null);
    try {
      const r = await api<{ label: string; account: string; amount: number; new_balance: number }>("POST", "/api/dev/simulate", { kind: s.kind });
      setToast({ kind: "ok", text: `${r.label}: ${signed(r.amount)} on ${r.account}. New balance ${money(r.new_balance)}.` });
      await load(true);
    } catch (e) {
      setToast({ kind: "error", text: (e as Error).message });
    } finally {
      setSimBusy(null);
    }
  }

  // Group lines by day for the statement list.
  const days = useMemo(() => {
    const groups: { date: string; lines: Line[] }[] = [];
    for (const t of data?.transactions ?? []) {
      const last = groups[groups.length - 1];
      if (last && last.date === t.date) last.lines.push(t);
      else groups.push({ date: t.date, lines: [t] });
    }
    return groups;
  }, [data]);

  function downloadCsv() {
    if (!data) return;
    const blob = new Blob([toCsv(data)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const who = data.customer.name.toLowerCase().replace(/\s+/g, "-");
    a.href = url;
    a.download = `statement-${who}-${data.period.start}-to-${data.period.end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const addr = data?.customer.address;
  const single = Boolean(data?.account_id);
  const selected = data?.accounts.find((a) => a.id === data.account_id);
  const cols = single ? 5 : 4;

  return (
    <div>
      <div className="mb-7 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#6F789A]">Transactions</p>
          {embedded ? (
            <h2 className="text-[22px] font-bold tracking-[-0.04em] sm:text-[26px]">Bank statement</h2>
          ) : (
            <h1 className="text-[28px] font-bold tracking-[-0.045em] sm:text-[34px]">Bank statement</h1>
          )}
          <p className="mt-1 flex items-center gap-2 text-sm text-[#6F789A]">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#FF8A5B] opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-[#FF8A5B]" />
            </span>
            Live from your bank. Updates on its own.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <label className="relative">
            <span className="sr-only">Account</span>
            <select className={select} onChange={(e) => setAccountId(e.target.value)} value={accountId}>
              <option value="">All accounts</option>
              {data?.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nickname} ({a.type})
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[#6F789A]">▼</span>
          </label>
          <label className="relative">
            <span className="sr-only">Statement period</span>
            <select className={select} onChange={(e) => setPeriod(e.target.value)} value={period}>
              {PERIODS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[#6F789A]">▼</span>
          </label>
          <button className={secondaryBtn} disabled={!data || data.transactions.length === 0} onClick={downloadCsv}>
            Download CSV
          </button>
          <button className={secondaryBtn} disabled={!data} onClick={() => window.print()}>
            Print / PDF
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-5 rounded-xl border border-[#f3c9bd] bg-[#fff4f0] px-4 py-3 text-xs font-semibold text-[#9a3b22]" role="alert">
          {error}
        </div>
      )}

      {sims.length > 0 && (
        <section className="mb-5 rounded-[20px] border border-dashed border-[#C4CAE3] bg-white/60 p-4 print:hidden">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6F789A]">Demo · simulate</span>
            {sims.map((s) => (
              <button className={`${secondaryBtn} !py-2`} disabled={simBusy !== null} key={s.kind} onClick={() => simulate(s)}>
                {simBusy === s.kind ? "…" : `${s.label} ${s.type === "deposit" ? "+" : "−"}${money(s.amount)}`}
              </button>
            ))}
          </div>
          {toast && (
            <p className={`mt-3 text-xs font-semibold ${toast.kind === "ok" ? "text-[#209E86]" : "text-[#9a3b22]"}`} role="status">
              {toast.text}
            </p>
          )}
        </section>
      )}

      {data && (
        <div className={`transition-opacity ${loading ? "opacity-50" : ""}`} aria-busy={loading}>
          {/* Statement header, like the top of a paper statement */}
          <section className="panel mb-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="eyebrow">Statement for</p>
                <p className="mt-1 text-lg font-bold">{data.customer.name}</p>
                {addr && (addr.street_name || addr.city) && (
                  <p className="text-xs text-[#6F789A]">
                    {[addr.street_number, addr.street_name].filter(Boolean).join(" ")}
                    {addr.city ? `, ${addr.city}` : ""}
                    {addr.state ? `, ${addr.state}` : ""} {addr.zip}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="eyebrow">Period</p>
                <p className="mt-1 text-sm font-bold">
                  {longDate(data.period.start)} – {longDate(data.period.end)}
                </p>
                <p className="text-xs text-[#6F789A]">{selected ? `${selected.nickname} (${selected.type})` : "All accounts"}</p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 border-t border-[#DADDF1] pt-5 md:grid-cols-5">
              <div>
                <p className="eyebrow">{selected?.type === "Credit Card" ? "Card balance" : "Balance now"}</p>
                <p className="mt-1 text-xl font-bold tracking-[-0.03em]">{money(selected ? selected.balance : data.balance)}</p>
                {!selected && <p className="text-[10px] text-[#8790AE]">Checking + savings</p>}
              </div>
              <div>
                <p className="eyebrow">Money in</p>
                <p className="mt-1 text-xl font-bold tracking-[-0.03em] text-[#209E86]">{money(data.summary.money_in)}</p>
              </div>
              <div>
                <p className="eyebrow">Money out</p>
                <p className="mt-1 text-xl font-bold tracking-[-0.03em]">{money(data.summary.money_out)}</p>
              </div>
              <div>
                <p className="eyebrow">Net</p>
                <p className={`mt-1 text-xl font-bold tracking-[-0.03em] ${data.summary.net >= 0 ? "text-[#209E86]" : "text-[#b4502f]"}`}>{signed(data.summary.net)}</p>
              </div>
              <div>
                <p className="eyebrow">Transactions</p>
                <p className="mt-1 text-xl font-bold tracking-[-0.03em]">{data.summary.count}</p>
              </div>
            </div>

            {!selected && data.accounts.length > 1 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {data.accounts.map((a) => (
                  <button className="rounded-full border border-[#DADDF1] px-3 py-1.5 text-[11px] text-[#6F789A] transition hover:bg-[#E2E5F4]" key={a.id} onClick={() => setAccountId(a.id)}>
                    {a.nickname}: <strong className="text-[#275992]">{money(a.balance)}</strong>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="panel !p-0">
            {data.transactions.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <p className="text-sm font-bold">{data.summary.all_time_count === 0 ? "No transactions yet" : "Nothing in this period"}</p>
                <p className="mt-1 text-xs text-[#8790AE]">
                  {data.summary.all_time_count === 0
                    ? "This bank profile doesn't have any deposits, purchases or other activity yet."
                    : "Try a longer period, like “All time”."}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-left">
                  <thead>
                    <tr className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#6F789A]">
                      <th className="px-6 py-3.5 font-bold">Description</th>
                      <th className="px-3 py-3.5 font-bold">Category</th>
                      <th className="px-3 py-3.5 font-bold">Account</th>
                      <th className="px-3 py-3.5 text-right font-bold">Amount</th>
                      {single && <th className="px-6 py-3.5 text-right font-bold">Balance</th>}
                    </tr>
                  </thead>
                  {days.map((day) => (
                    <tbody key={day.date}>
                      <tr>
                        <td className="bg-[#F4F5FB] px-6 py-2 text-[11px] font-bold text-[#6F789A]" colSpan={cols}>
                          {dayHeading(day.date)}
                        </td>
                      </tr>
                      {day.lines.map((t) => (
                        <tr className={`border-t border-[#DADDF1] transition-colors duration-700 ${highlight.has(t.id) ? "bg-[#E3F7F0]" : ""}`} key={`${t.type}-${t.id}`}>
                          <td className="px-6 py-3">
                            <div className="flex items-center gap-2.5">
                              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${TYPE_STYLE[t.type] ?? TYPE_STYLE.Purchase}`}>{t.type}</span>
                              <span className="text-xs font-semibold">{t.description}</span>
                              {highlight.has(t.id) && <span className="rounded-full bg-[#FF8A5B] px-1.5 py-0.5 text-[9px] font-bold text-white">NEW</span>}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-xs text-[#6F789A]">{t.category ?? "—"}</td>
                          <td className="px-3 py-3 text-xs text-[#6F789A]">{t.account}</td>
                          <td className={`px-3 py-3 text-right text-xs font-bold ${t.amount > 0 ? "text-[#209E86]" : "text-[#F6C28E]"}`}>{signed(t.amount)}</td>
                          {single && <td className="px-6 py-3 text-right text-xs text-[#6F789A]">{money(t.balance_after ?? 0)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              </div>
            )}
          </section>
          <p className="mt-4 text-center text-[10px] text-[#8790AE]">Data from your bank via the Nessie API. Balances are the opening balance plus every transaction.</p>
        </div>
      )}
    </div>
  );
}
