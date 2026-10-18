import { useEffect, useState } from "react";
import { api } from "./api";

// ---------- A goal's on-chain vault on Solana (solana_vault.py, GET /api/goals/{id}/vault) ----------

type ChainStatus = "pending" | "sent" | "confirmed" | "failed" | "cancelled";
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
  waiting?: number;
  verified?: boolean;
  members?: { user_id: number; name: string; wallet: string | null; wallet_url: string | null; confirmed: number; waiting: number }[];
  transactions?: { kind: "deposit" | "refund"; user: string; amount: number; status: ChainStatus; created_at: string; error: string | null; url: string | null }[];
  by_contribution?: Record<string, { kind: string; status: ChainStatus; url: string | null }>;
};

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const short = (addr: string) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;

/** Loads the vault and keeps it fresh: quickly while transactions are confirming, slowly otherwise. */
export function useVault(goalId: number, refreshKey: unknown) {
  const [vault, setVault] = useState<VaultInfo | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api<VaultInfo>("GET", `/api/goals/${goalId}/vault`)
        .then((v) => {
          if (stop) return;
          setVault(v);
          if (v.enabled) timer = setTimeout(load, v.waiting ? 3000 : 20000);
        })
        .catch(() => {
          if (!stop) timer = setTimeout(load, 20000);
        });
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [goalId, refreshKey]);
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

/** The vault row on a goal card; expands into the full on-chain picture. */
export function VaultPanel({ vault }: { vault: VaultInfo | null }) {
  const [open, setOpen] = useState(false);
  if (!vault || !vault.enabled) return null;

  const waiting = vault.waiting ?? 0;
  const summary = vault.verified ? (
    <span className="font-bold text-[#209E86]">✓ Verified · {money(vault.onchain_balance ?? 0)} on-chain</span>
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
        <span className="text-[11px] font-bold text-[#FF8A5B]">{open ? "Hide" : "Details"}</span>
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
              <p className="text-[10px] text-[#8790AE]">Saved, per Gatorstar's records</p>
              <p className="text-sm font-bold">{money(vault.app_ledger_total ?? 0)}</p>
            </div>
          </div>
          {vault.verified ? (
            <p className="rounded-lg bg-[#E3F7F0] px-3 py-2 font-semibold text-[#209E86]">✓ They match: the public blockchain holds exactly what the app says is in the pot.</p>
          ) : waiting ? (
            <p className="rounded-lg bg-[#fff7e6] px-3 py-2 font-semibold text-[#8a5a12]">Still recording the latest savings on Solana. This usually takes a few seconds.</p>
          ) : vault.error || vault.onchain_error ? (
            <p className="rounded-lg bg-[#fff4f0] px-3 py-2 font-semibold text-[#9a3b22]">{vault.error || vault.onchain_error}</p>
          ) : null}

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

          {(vault.members?.length ?? 0) > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#6F789A]">Who put in what (on-chain)</p>
              {vault.members!.map((m) => (
                <div className="flex items-center justify-between py-1" key={m.user_id}>
                  <span>
                    <strong>{m.name.split(" ")[0]}</strong>{" "}
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
                <div className="flex items-center justify-between gap-2 border-t border-[#F0F1F8] py-1.5 first:border-t-0" key={i}>
                  <span className="min-w-0 truncate">
                    {t.kind === "deposit" ? "↓ " : "↑ "}
                    <strong>{money(t.amount)}</strong> {t.kind === "deposit" ? "in from" : "back to"} {t.user.split(" ")[0]}
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
          <p className="text-[10px] text-[#8790AE]">Runs on Solana {vault.network}, the public test network: test tokens only, no real money or crypto.</p>
        </div>
      )}
    </div>
  );
}
