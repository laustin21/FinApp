import { useEffect, useRef, useState, type ReactNode } from "react";
import { API_URL, api } from "./api";
import { useLive } from "./live";

// ---------- A goal's on-chain vault on Solana (solana_vault.py, GET /api/goals/{id}/vault) ----------
// Showcase pieces in this file:
//   EscrowStrip   - the vault is escrow: Locked -> Goal reached -> Released
//   ChainAudit    - "Verify on Solana": your browser checks every record against the blockchain
//                   itself (not Gatorstar's server), plus a "Try to cheat" tamper demo
//   ShareProof    - public proof page link + QR code
//   ChainTracker  - live view of one contribution travelling bank -> Solana

type ChainStatus = "pending" | "sent" | "confirmed" | "failed" | "cancelled";
type TxKind = "deposit" | "refund" | "release";
export type Escrow = {
  state: "locked" | "releasable" | "released";
  released_at: string | null;
  released_amount: number;
  released_to: string | null;
  can_release: boolean;
  pot: number;
};
export type AuditRecord = { kind: TxKind; contribution_id: number | null; user: string; wallet: string | null; amount: number; signature: string; slot: number | null };
export type Audit = { rpc_url: string; network: string; mint: string | null; vault_owner: string; vault_token_account: string | null; expected_balance: number; records: AuditRecord[] };
export type VaultInfo = {
  enabled: boolean;
  network?: string;
  state?: "starting" | "ready" | "needs_funding" | "offline" | "off";
  error?: string | null;
  vault_address?: string;
  vault_url?: string;
  token?: { symbol: string; mint: string | null; url: string | null };
  onchain_balance?: number | null;
  onchain_error?: string | null;
  confirmed_total?: number;
  app_ledger_total?: number;
  expected_balance?: number;
  waiting?: number;
  verified?: boolean;
  escrow?: Escrow;
  audit?: Audit;
  members?: { user_id: number; name: string; wallet: string | null; wallet_url: string | null; confirmed: number; waiting: number }[];
  transactions?: { kind: TxKind; user: string; amount: number; status: ChainStatus; created_at: string; error: string | null; url: string | null }[];
  by_contribution?: Record<string, { kind: string; status: ChainStatus; url: string | null }>;
};

export const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
export const short = (addr: string) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;
const first = (name: string) => name.split(" ")[0];
const explorerTx = (sig: string, network: string) => `https://explorer.solana.com/tx/${sig}?cluster=${network}`;

const primaryBtn = "rounded-lg bg-[#275992] px-3.5 py-2 text-[11px] font-bold text-white transition hover:bg-[#1F4777] disabled:opacity-50";
const secondaryBtn = "rounded-lg border border-[#DADDF1] bg-white px-3.5 py-2 text-[11px] font-bold text-[#275992] transition hover:bg-[#E2E5F4] disabled:opacity-50";

/** Loads the vault and keeps it fresh: quickly while transactions are confirming, slowly otherwise. */
export function useVault(goalId: number, refreshKey: unknown) {
  const [vault, setVault] = useState<VaultInfo | null>(null);
  // Reload when anything in groups changes (e.g. another member's deposit just confirmed on Solana).
  const [tick, setTick] = useState(0);
  useLive(["groups"], () => setTick((t) => t + 1));
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api<VaultInfo>("GET", `/api/goals/${goalId}/vault`)
        .then((v) => {
          if (stop) return;
          setVault(v);
          if (v.enabled) timer = setTimeout(load, v.waiting ? 2000 : 20000);
        })
        .catch(() => {
          if (!stop) timer = setTimeout(load, 20000);
        });
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [goalId, refreshKey, tick]);
  return vault;
}

const CHAIN_ICON = (
  <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="15">
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </svg>
);

/** Small status for one contribution, e.g. in "Your recent entries". */
export function ChainBadge({ entry }: { entry?: { kind: string; status: ChainStatus; url: string | null } }) {
  if (!entry || entry.status === "cancelled") return null;
  if (entry.status === "confirmed" && entry.url)
    return (
      <a className="ml-1.5 inline-flex items-center gap-0.5 rounded-md bg-[#E3F7F0] px-1.5 py-0.5 text-[9px] font-bold text-[#209E86] hover:underline" href={entry.url} rel="noreferrer" target="_blank" title="See this on Solana Explorer">
        ✓ on-chain ↗
      </a>
    );
  if (entry.status === "failed") return <span className="ml-1.5 rounded-md bg-[#fff0e9] px-1.5 py-0.5 text-[9px] font-bold text-[#b4502f]">on-chain failed</span>;
  return <span className="ml-1.5 animate-pulse rounded-md bg-[#F4F5FB] px-1.5 py-0.5 text-[9px] font-bold text-[#6F789A]">recording on-chain…</span>;
}

function StatusPill({ status }: { status: ChainStatus }) {
  const look: Record<ChainStatus, string> = {
    confirmed: "bg-[#E3F7F0] text-[#209E86]",
    sent: "bg-[#fff7e6] text-[#8a5a12] animate-pulse",
    pending: "bg-[#F4F5FB] text-[#6F789A] animate-pulse",
    failed: "bg-[#fff0e9] text-[#b4502f]",
    cancelled: "bg-[#F4F5FB] text-[#8790AE]",
  };
  const label: Record<ChainStatus, string> = { confirmed: "Confirmed", sent: "Confirming", pending: "Queued", failed: "Failed", cancelled: "Cancelled" };
  return <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${look[status]}`}>{label[status]}</span>;
}

// ---------- Escrow: Locked -> Goal reached -> Released ----------

export function EscrowStrip({ escrow, onRelease, busy }: { escrow: Escrow; onRelease?: () => void; busy?: boolean }) {
  const step = escrow.state === "locked" ? 0 : escrow.state === "releasable" ? 1 : 2;
  const steps = ["Locked in vault", "Goal reached", "Released"];
  return (
    <div className="rounded-xl border border-[#DADDF1] bg-white px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold text-[#275992]">
            {step === 0 ? "🔒 Escrow: locked until the goal is reached" : step === 1 ? "🔓 Escrow: ready to release" : `💸 Escrow released: ${money(escrow.released_amount)} to ${first(escrow.released_to ?? "the organizer")}`}
          </p>
          <p className="mt-0.5 text-[10px] leading-4 text-[#6F789A]">
            {step === 0
              ? "Nobody can take money out of the pot early. It only leaves the vault as a refund to whoever put it in, or as one payout once the target is hit."
              : step === 1
                ? "The target is hit. The goal's creator can now pay the whole pot out in one transaction that everyone can see on Solana."
                : "Paid into the organizer's bank account, and the vault's tokens were sent out and burned on Solana. The vault is now empty and closed."}
          </p>
        </div>
        {escrow.can_release && onRelease && (
          <button className="rounded-lg bg-[#209E86] px-3.5 py-2 text-[11px] font-bold text-white transition hover:bg-[#1a8571] disabled:opacity-50" disabled={busy} onClick={onRelease} type="button">
            Release {money(escrow.pot)}
          </button>
        )}
      </div>
      <ol className="mt-3 grid grid-cols-3 gap-1.5">
        {steps.map((label, i) => (
          <li className="min-w-0" key={label}>
            <div className={`h-1.5 rounded-full ${i <= step ? (step === 2 ? "bg-[#209E86]" : "bg-[#275992]") : "bg-[#E2E5F4]"}`} />
            <p className={`mt-1 truncate text-[9px] font-bold ${i <= step ? "text-[#275992]" : "text-[#8790AE]"}`}>{label}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------- Verify on Solana (runs in the browser, straight against the blockchain) ----------

type Check = { label: string; ok: boolean };
type RowResult = { record: AuditRecord; state: "waiting" | "checking" | "ok" | "bad"; checks: Check[]; slot?: number; tampered?: { from: number } };
type BalanceResult = { state: "waiting" | "checking" | "ok" | "bad"; onchain?: number; claimed: number };

async function solanaRpc(url: string, method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 900 * (attempt + 1))); // public devnet is rate-limited
      continue;
    }
    const data = await res.json();
    if (data.error) throw new Error(data.error.message ?? "Solana error");
    return data.result;
  }
}

/** Checks one record against the transaction Solana actually stored. */
async function verifyRecord(audit: Audit, rec: AuditRecord): Promise<{ checks: Check[]; slot?: number }> {
  const tx = await solanaRpc(audit.rpc_url, "getTransaction", [rec.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  if (!tx) return { checks: [{ label: "Found on Solana", ok: false }] };
  const ixs: any[] = tx.transaction?.message?.instructions ?? [];
  const info = ixs.find((i) => i.parsed?.type === "transferChecked")?.parsed?.info;
  const memo = ixs.find((i) => i.program === "spl-memo")?.parsed;
  const cents = Math.round(rec.amount * 100);
  const deposit = rec.kind === "deposit";
  const checks: Check[] = [
    { label: "Found on Solana", ok: true },
    { label: "Succeeded", ok: tx.meta?.err == null },
    deposit
      ? { label: `Signed by ${first(rec.user)}'s wallet`, ok: !!info && info.authority === rec.wallet }
      : { label: "Signed by the vault", ok: !!info && info.authority === audit.vault_owner },
    deposit
      ? { label: "Landed in this goal's vault", ok: !!info && info.destination === audit.vault_token_account }
      : { label: "Left this goal's vault", ok: !!info && info.source === audit.vault_token_account },
    { label: `Amount ${money(rec.amount)}`, ok: !!info && info.tokenAmount?.amount === String(cents) },
    { label: "GSD token", ok: !!info && info.mint === audit.mint },
    { label: "Gatorstar memo", ok: typeof memo === "string" && memo.startsWith("Gatorstar") },
  ];
  return { checks, slot: tx.slot };
}

export function ChainAudit({ audit, autoRun = false }: { audit: Audit; autoRun?: boolean }) {
  const [rows, setRows] = useState<RowResult[] | null>(null);
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [mode, setMode] = useState<"honest" | "tamper">("honest");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [took, setTook] = useState<number | null>(null);
  const started = useRef(false);

  async function run(tamper: boolean) {
    setRunning(true);
    setError("");
    setTook(null);
    setMode(tamper ? "tamper" : "honest");
    const t0 = performance.now();
    // Newest 20 records is plenty for a demo and stays under devnet's rate limit.
    const real = audit.records.slice(-20);
    let claimed = audit.expected_balance;
    let edited: AuditRecord | null = null;
    if (tamper && real.length) {
      // Pretend someone edited Gatorstar's database: the biggest deposit now says $500 more.
      const deposits = real.filter((r) => r.kind === "deposit");
      edited = (deposits.length ? deposits : real).reduce((a, b) => (b.amount > a.amount ? b : a));
      claimed += edited.kind === "deposit" ? 500 : -500;
    }
    const list: RowResult[] = real.map((r) =>
      r === edited ? { record: { ...r, amount: r.amount + 500 }, state: "waiting", checks: [], tampered: { from: r.amount } } : { record: r, state: "waiting", checks: [] },
    );
    setRows([...list]);
    setBalance({ state: "waiting", claimed });
    try {
      for (let i = 0; i < list.length; i++) {
        list[i] = { ...list[i], state: "checking" };
        setRows([...list]);
        const { checks, slot } = await verifyRecord(audit, list[i].record);
        list[i] = { ...list[i], checks, slot, state: checks.every((c) => c.ok) ? "ok" : "bad" };
        setRows([...list]);
      }
      setBalance({ state: "checking", claimed });
      let onchain = 0;
      if (audit.vault_token_account) {
        try {
          const b = await solanaRpc(audit.rpc_url, "getTokenAccountBalance", [audit.vault_token_account, { commitment: "confirmed" }]);
          onchain = Number(b.value.amount) / 100;
        } catch {
          onchain = 0; // the vault account doesn't exist yet: nothing has been deposited
        }
      }
      setBalance({ state: Math.round(onchain * 100) === Math.round(claimed * 100) ? "ok" : "bad", onchain, claimed });
      setTook((performance.now() - t0) / 1000);
    } catch (e) {
      setError(`Couldn't reach Solana from this browser (${e instanceof Error ? e.message : "network error"}). Try again in a few seconds.`);
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    if (autoRun && !started.current && audit.records.length) {
      started.current = true;
      run(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, audit.records.length]);

  const done = rows && !running && !error && balance && balance.state !== "waiting" && balance.state !== "checking";
  const bad = (rows?.filter((r) => r.state === "bad").length ?? 0) + (balance?.state === "bad" ? 1 : 0);

  return (
    <div className="rounded-xl border border-[#DADDF1] bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold text-[#275992]">Verify it yourself</p>
          <p className="text-[10px] text-[#6F789A]">Your browser asks Solana directly, so you don't have to trust Gatorstar's server.</p>
        </div>
        <div className="flex gap-2">
          <button className={primaryBtn} disabled={running} onClick={() => run(false)} type="button">
            {running && mode === "honest" ? "Checking…" : "Verify on Solana"}
          </button>
          <button className={secondaryBtn} disabled={running || !audit.records.length} onClick={() => run(true)} title="Simulates someone editing the app's database" type="button">
            {running && mode === "tamper" ? "Checking…" : "Try to cheat"}
          </button>
        </div>
      </div>

      {!audit.records.length && <p className="mt-2 text-[10px] text-[#8790AE]">No confirmed transactions to check yet.</p>}
      {mode === "tamper" && rows && (
        <p className="mt-2 rounded-lg bg-[#fff7e6] px-2.5 py-1.5 text-[10px] font-semibold text-[#8a5a12]">
          Demo: we edited one record in the app's copy (+$500), like a dishonest admin or a hacked database would. Watch Solana catch it.
        </p>
      )}

      {rows && (
        <ul className="mt-2.5 space-y-1.5">
          {rows.map((r, i) => (
            <li className={`rounded-lg px-2.5 py-2 text-[10px] ${r.state === "bad" ? "bg-[#fff0e9]" : r.state === "ok" ? "bg-[#F1FAF6]" : "bg-[#F4F5FB]"}`} key={i}>
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  <span className="mr-1">{r.state === "ok" ? "✅" : r.state === "bad" ? "❌" : r.state === "checking" ? "⏳" : "·"}</span>
                  <strong>
                    {r.record.kind === "deposit" ? "Deposit" : r.record.kind === "refund" ? "Refund" : "Payout"} · {money(r.record.amount)}
                  </strong>{" "}
                  {r.record.kind === "deposit" ? "from" : "to"} {first(r.record.user)}
                  {r.tampered && <span className="ml-1 rounded bg-[#b4502f] px-1 py-px text-[8px] font-bold text-white">EDITED (was {money(r.tampered.from)})</span>}
                </span>
                <a className="shrink-0 font-mono text-[9px] text-[#8790AE] hover:underline" href={explorerTx(r.record.signature, audit.network)} rel="noreferrer" target="_blank">
                  {short(r.record.signature)}
                  {r.slot ? ` · slot ${r.slot.toLocaleString()}` : ""} ↗
                </a>
              </div>
              {r.checks.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {r.checks.map((c) => (
                    <span className={`rounded px-1.5 py-px text-[9px] font-semibold ${c.ok ? "bg-white text-[#209E86]" : "bg-[#b4502f] text-white"}`} key={c.label}>
                      {c.ok ? "✓" : "✗"} {c.label}
                    </span>
                  ))}
                </div>
              )}
              {r.state === "bad" && r.tampered && (
                <p className="mt-1 font-semibold text-[#9a3b22]">
                  Caught: the transaction Solana stored says {money(r.tampered.from)}. It was signed by {r.record.kind === "deposit" ? `${first(r.record.user)}'s wallet` : "the vault"} and
                  can't be edited afterwards, by anyone.
                </p>
              )}
            </li>
          ))}
          {balance && (
            <li className={`rounded-lg px-2.5 py-2 text-[10px] ${balance.state === "bad" ? "bg-[#fff0e9]" : balance.state === "ok" ? "bg-[#F1FAF6]" : "bg-[#F4F5FB]"}`}>
              <span className="mr-1">{balance.state === "ok" ? "✅" : balance.state === "bad" ? "❌" : balance.state === "checking" ? "⏳" : "·"}</span>
              <strong>Vault balance</strong>: records say {money(balance.claimed)}
              {balance.onchain !== undefined && <> · Solana says {money(balance.onchain)}</>}
            </li>
          )}
        </ul>
      )}

      {error && <p className="mt-2 rounded-lg bg-[#fff4f0] px-2.5 py-1.5 text-[10px] font-semibold text-[#9a3b22]">{error}</p>}
      {done && (
        <p className={`mt-2 rounded-lg px-2.5 py-2 text-[11px] font-bold text-white ${bad ? "bg-[#b4502f]" : "bg-[#209E86]"}`}>
          {bad
            ? `Tampering detected: ${bad} check${bad === 1 ? "" : "s"} don't match the blockchain. The real numbers are the ones on Solana.`
            : `All ${rows!.length} transaction${rows!.length === 1 ? "" : "s"} and the vault balance match Solana, checked independently in ${took?.toFixed(1)} s.`}
        </p>
      )}
    </div>
  );
}

// ---------- Public proof page link + QR ----------

export function proofUrl(token: string) {
  return `${window.location.origin}${window.location.pathname}?proof=${token}`;
}

export function ShareProof({ goalId }: { goalId: number }) {
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const local = ["localhost", "127.0.0.1"].includes(window.location.hostname);

  async function make() {
    setError("");
    try {
      const { token } = await api<{ token: string }>("POST", `/api/goals/${goalId}/share`);
      setUrl(proofUrl(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't make a link");
    }
  }

  if (!url)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#DADDF1] bg-white p-3">
        <div>
          <p className="text-[11px] font-bold text-[#275992]">Public proof page</p>
          <p className="text-[10px] text-[#6F789A]">A link anyone can open (no login) to see and verify this vault. First names only.</p>
        </div>
        <button className={secondaryBtn} onClick={make} type="button">
          Share proof · QR
        </button>
        {error && <p className="w-full text-[10px] font-semibold text-[#b4502f]">{error}</p>}
      </div>
    );

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[#DADDF1] bg-white p-3">
      <img alt="QR code for the proof page" className="size-28 rounded-lg border border-[#DADDF1] bg-white p-1" src={`${API_URL}/api/public/qr.svg?data=${encodeURIComponent(url)}`} />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-bold text-[#275992]">Scan to verify this vault</p>
        <p className="mt-1 break-all font-mono text-[10px] text-[#6F789A]">{url}</p>
        <div className="mt-2 flex gap-2">
          <button
            className={secondaryBtn}
            onClick={() =>
              navigator.clipboard?.writeText(url).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => {},
              )
            }
            type="button"
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
          <a className={secondaryBtn} href={url} rel="noreferrer" target="_blank">
            Open ↗
          </a>
        </div>
        {local && <p className="mt-1.5 text-[9px] text-[#8a5a12]">This is a localhost link, so it only opens on this computer. Once the app is deployed, phones can scan it.</p>}
      </div>
    </div>
  );
}

// ---------- The vault panel on a goal card ----------

/** The vault row on a goal card; expands into the full on-chain picture. */
export function VaultPanel({ vault, goalId }: { vault: VaultInfo | null; goalId: number }) {
  const [open, setOpen] = useState(false);
  if (!vault || !vault.enabled) return null;

  const waiting = vault.waiting ?? 0;
  const released = vault.escrow?.state === "released";
  const summary = vault.verified ? (
    <span className="font-bold text-[#209E86]">✓ Verified · {released ? "paid out, vault empty" : `${money(vault.onchain_balance ?? 0)} on-chain`}</span>
  ) : waiting ? (
    <span className="font-bold text-[#8a5a12]">
      Recording {waiting} transaction{waiting === 1 ? "" : "s"} on Solana…
    </span>
  ) : vault.state === "needs_funding" ? (
    <span className="font-bold text-[#8a5a12]">Waiting for test SOL to pay fees</span>
  ) : vault.state === "offline" || vault.onchain_error ? (
    <span className="font-bold text-[#b4502f]">Solana unreachable · savings are safe and will sync</span>
  ) : (
    <span className="font-bold text-[#275992]">{money(vault.onchain_balance ?? 0)} on-chain</span>
  );

  return (
    <div className="mt-4 rounded-xl border border-[#DADDF1] bg-[#FFFDF7]">
      <button aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left" onClick={() => setOpen((o) => !o)} type="button">
        <span className="flex items-center gap-2 text-[11px]">
          <span className="grid size-6 place-items-center rounded-lg bg-[#275992] text-white">{CHAIN_ICON}</span>
          <span>
            <span className="block font-bold text-[#275992]">On-chain vault · Solana {vault.network}</span>
            <span className="block">{summary}</span>
          </span>
        </span>
        <span className="text-[11px] font-bold text-[#FF8A5B]">{open ? "Hide" : "Details · verify"}</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-[#DADDF1] px-3.5 py-3.5 text-[11px]">
          <p className="leading-4 text-[#6F789A]">
            Every dollar added to this goal leaves your bank account and is recorded as {vault.token?.symbol ?? "GSD"} tokens (1 = $1) in this goal's own vault on Solana. Anyone can check it,
            and nobody can quietly change it.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-[#F4F5FB] p-2.5">
              <p className="text-[10px] text-[#8790AE]">In the vault, on Solana</p>
              <p className="text-sm font-bold">{vault.onchain_balance !== null && vault.onchain_balance !== undefined ? money(vault.onchain_balance) : "—"}</p>
            </div>
            <div className="rounded-lg bg-[#F4F5FB] p-2.5">
              <p className="text-[10px] text-[#8790AE]">{released ? "Should be in the vault (after payout)" : "Saved, per Gatorstar's records"}</p>
              <p className="text-sm font-bold">{money(vault.expected_balance ?? vault.app_ledger_total ?? 0)}</p>
            </div>
          </div>
          {vault.verified ? (
            <p className="rounded-lg bg-[#E3F7F0] px-3 py-2 font-semibold text-[#209E86]">✓ They match: the public blockchain holds exactly what the app says is in the pot.</p>
          ) : waiting ? (
            <p className="rounded-lg bg-[#fff7e6] px-3 py-2 font-semibold text-[#8a5a12]">Still recording the latest savings on Solana. This usually takes a few seconds.</p>
          ) : vault.error || vault.onchain_error ? (
            <p className="rounded-lg bg-[#fff4f0] px-3 py-2 font-semibold text-[#9a3b22]">{vault.error || vault.onchain_error}</p>
          ) : null}

          {vault.audit && <ChainAudit audit={vault.audit} />}
          <ShareProof goalId={goalId} />

          {vault.vault_address && (
            <p className="text-[#6F789A]">
              Vault address:{" "}
              <a className="font-mono font-semibold text-[#275992] hover:underline" href={vault.vault_url} rel="noreferrer" target="_blank">
                {short(vault.vault_address)} ↗
              </a>
              {vault.token?.url && (
                <>
                  {" "}· Token:{" "}
                  <a className="font-semibold text-[#275992] hover:underline" href={vault.token.url} rel="noreferrer" target="_blank">
                    {vault.token.symbol} ↗
                  </a>
                </>
              )}
            </p>
          )}

          <VaultLists vault={vault} />
          <p className="text-[10px] text-[#8790AE]">Runs on Solana {vault.network}, the public test network: test tokens only, no real money or crypto.</p>
        </div>
      )}
    </div>
  );
}

/** Who put in what + recent transactions (shared with the public proof page). */
export function VaultLists({ vault }: { vault: VaultInfo }) {
  return (
    <>
      {(vault.members?.length ?? 0) > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#6F789A]">Who put in what (on-chain)</p>
          {vault.members!.map((m) => (
            <div className="flex items-center justify-between py-1 text-[11px]" key={m.user_id}>
              <span>
                <strong>{first(m.name)}</strong>{" "}
                {m.wallet && (
                  <a className="font-mono text-[10px] text-[#8790AE] hover:underline" href={m.wallet_url ?? undefined} rel="noreferrer" target="_blank">
                    {short(m.wallet)}
                  </a>
                )}
              </span>
              <span className="font-bold">
                {money(m.confirmed)}
                {m.waiting > 0 && <span className="ml-1 font-normal text-[#8a5a12]">+{m.waiting} syncing</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {(vault.transactions?.length ?? 0) > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#6F789A]">Recent vault transactions</p>
          {vault.transactions!.map((t, i) => (
            <div className="flex items-center justify-between gap-2 border-t border-[#F0F1F8] py-1.5 text-[11px] first:border-t-0" key={i}>
              <span className="min-w-0 truncate">
                {t.kind === "deposit" ? "↓ " : t.kind === "release" ? "💸 " : "↑ "}
                <strong>{money(t.amount)}</strong> {t.kind === "deposit" ? "in from" : t.kind === "release" ? "paid out to" : "back to"} {first(t.user)}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <StatusPill status={t.status} />
                {t.url && (
                  <a className="font-bold text-[#FF8A5B] hover:underline" href={t.url} rel="noreferrer" target="_blank">
                    View ↗
                  </a>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---------- Live tracker: one contribution, bank -> Solana ----------

type ChainTrack = {
  enabled: boolean;
  amount: number;
  bank: { nessie_id: string | null; at: string };
  chain: {
    status: ChainStatus;
    attempts: number;
    error: string | null;
    signature: string | null;
    url: string | null;
    network: string;
    slot: number | null;
    fee_sol: number | null;
    queued_at: number | null;
    sent_at: number | null;
    confirmed_at: number | null;
  } | null;
};

export function ChainTracker({ contributionId, onClose }: { contributionId: number; onClose: () => void }) {
  const [t, setT] = useState<ChainTrack | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();
    const load = () =>
      api<ChainTrack>("GET", `/api/contributions/${contributionId}/chain`)
        .then((r) => {
          if (stop) return;
          setT(r);
          const s = r.chain?.status;
          const finished = !r.enabled || s === "confirmed" || s === "failed" || s === "cancelled";
          if (!finished && Date.now() - startedAt < 120000) timer = setTimeout(load, 600);
        })
        .catch(() => {
          if (!stop) timer = setTimeout(load, 2000);
        });
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [contributionId]);

  const c = t?.chain;
  const s = c?.status;
  // 0 bank, 1 queued, 2 signing/sending, 3 confirming, 5 all done
  const stage = !t ? 0 : !c ? 1 : s === "pending" ? 2 : s === "sent" ? 3 : s === "confirmed" ? 5 : 2;
  const secs = (a?: number | null, b?: number | null) => (a && b ? `${Math.max(0, b - a).toFixed(1)} s` : "");
  const steps: { title: string; detail: ReactNode }[] = [
    { title: "Bank withdrawal", detail: t ? `${money(t.amount)} left your account (Nessie ${t.bank.nessie_id ? short(t.bank.nessie_id) : "record"})` : "Moving the money…" },
    { title: "Queued for Solana", detail: "Lined up for the next block, so the bank side never waits on the blockchain" },
    {
      title: "Signed & sent",
      detail: c?.signature ? (
        <>
          Your wallet signed the transfer ·{" "}
          <a className="font-mono font-semibold text-[#275992] hover:underline" href={c.url ?? undefined} rel="noreferrer" target="_blank">
            {short(c.signature)} ↗
          </a>
        </>
      ) : (
        "Signing with your wallet and the app's fee payer"
      ),
    },
    {
      title: "Confirmed by the network",
      detail:
        s === "confirmed"
          ? `Slot ${c?.slot?.toLocaleString() ?? "—"}${c?.fee_sol != null ? ` · fee ${c.fee_sol.toFixed(6)} test SOL` : ""}${c?.sent_at ? ` · ${secs(c.sent_at, c.confirmed_at)} after sending` : ""}`
          : "Solana validators agree on the block",
    },
    { title: "Vault updated", detail: `${money(t?.amount ?? 0)} of GSD is now in this goal's vault, for anyone to check` },
  ];

  return (
    <div className="mt-3 rounded-xl border border-[#DADDF1] bg-white p-3" role="status">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold text-[#275992]">Live: your money on its way to the vault</p>
        <button className="text-[10px] font-bold text-[#8790AE] hover:text-[#275992]" onClick={onClose} type="button">
          Close
        </button>
      </div>
      {t && !t.enabled ? (
        <p className="mt-2 text-[10px] text-[#6F789A]">Solana is turned off on this server, so only the bank step happened.</p>
      ) : (
        <ol className="mt-2.5 space-y-2">
          {steps.map((step, i) => {
            const done = i < stage || stage === 5;
            const active = i === stage && stage < 5;
            return (
              <li className="flex gap-2.5" key={step.title}>
                <span
                  className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-bold ${
                    done ? "bg-[#209E86] text-white" : active ? "animate-pulse bg-[#FFCC57] text-[#275992]" : "bg-[#E2E5F4] text-[#8790AE]"
                  }`}
                >
                  {done ? "✓" : i + 1}
                </span>
                <span className="min-w-0">
                  <span className={`block text-[11px] font-bold ${done || active ? "text-[#275992]" : "text-[#8790AE]"}`}>{step.title}</span>
                  {(done || active) && <span className="block text-[10px] text-[#6F789A]">{step.detail}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {s === "failed" && <p className="mt-2 text-[10px] font-semibold text-[#b4502f]">Solana didn't accept it: {c?.error}. Your savings are safe in the app.</p>}
      {c?.error && s !== "failed" && s !== "confirmed" && <p className="mt-2 text-[10px] text-[#8a5a12]">{c.error} (retrying automatically)</p>}
      {s === "confirmed" && c?.queued_at && c.confirmed_at && (
        <p className="mt-2 rounded-lg bg-[#E3F7F0] px-2.5 py-1.5 text-[10px] font-bold text-[#209E86]">
          Bank to blockchain in {secs(c.queued_at, c.confirmed_at)}. Permanent, public, and verifiable by anyone.
        </p>
      )}
    </div>
  );
}
