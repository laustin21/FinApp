import { useEffect, useState } from "react";
import { api } from "./api";
import { Logo } from "./Logo";
import { ChainAudit, EscrowStrip, VaultLists, money, short, type Escrow, type VaultInfo } from "./Vault";

// Public proof page (no login): opened from a shared link or QR code, /?proof=<token>.
// Shows one goal's vault and lets the visitor verify it against Solana themselves.

type Proof = {
  goal: { title: string; group: string; target: number; deadline: string; created_at: string; completed_at: string | null; members: number };
  escrow: Escrow;
  vault: VaultInfo;
};

const longDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

export function ProofPage({ token }: { token: string }) {
  const [proof, setProof] = useState<Proof | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api<Proof>("GET", `/api/public/vault/${encodeURIComponent(token)}`)
        .then((p) => {
          if (stop) return;
          setProof(p);
          setError("");
          timer = setTimeout(load, p.vault.waiting ? 3000 : 15000);
        })
        .catch((e) => {
          if (stop) return;
          setError(e.status === 404 ? "This proof link doesn't exist (or the goal was deleted)." : e.message);
          if (e.status !== 404) timer = setTimeout(load, 15000);
        });
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [token]);

  const v = proof?.vault;
  const saved = v?.app_ledger_total ?? 0;
  const pct = proof ? Math.min(100, Math.round((100 * saved) / proof.goal.target)) : 0;

  return (
    <div className="min-h-screen bg-[#FFFAED] px-4 py-8 text-[#275992]">
      <div className="mx-auto max-w-[640px] space-y-4">
        <header className="flex items-center justify-between">
          <a className="flex items-center gap-2 text-lg font-bold tracking-[-0.04em]" href={window.location.pathname}>
            <Logo size={34} />
            Gatorstar
          </a>
          <span className="rounded-full bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[#6F789A]">Public proof · Solana {v?.network ?? "devnet"}</span>
        </header>

        {error && <p className="rounded-2xl bg-[#fff4f0] p-5 text-sm font-semibold text-[#9a3b22]">{error}</p>}
        {!proof && !error && <div className="h-64 animate-pulse rounded-[24px] bg-white/70" />}

        {proof && v && (
          <>
            <section className="rounded-[24px] border border-[#DADDF1] bg-white p-6">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#FF8A5B]">{proof.goal.group} · group goal</p>
              <h1 className="mt-1 text-[28px] font-bold tracking-[-0.04em]">{proof.goal.title}</h1>
              <p className="text-xs text-[#6F789A]">
                {proof.goal.members} member{proof.goal.members === 1 ? "" : "s"} · due {longDate(proof.goal.deadline)}
                {proof.goal.completed_at && ` · reached ${longDate(proof.goal.completed_at)}`}
              </p>
              <div className="mt-5 flex items-end justify-between">
                <p className="text-[32px] font-bold tracking-[-0.04em]">{money(saved)}</p>
                <p className="text-xs text-[#6F789A]">
                  of {money(proof.goal.target)} · {pct}%
                </p>
              </div>
              <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-[#E2E5F4]">
                <div className="h-full rounded-full bg-[#209E86] transition-all" style={{ width: `${pct}%` }} />
              </div>
            </section>

            <EscrowStrip escrow={proof.escrow} />

            {!v.enabled ? (
              <p className="rounded-2xl bg-white p-5 text-xs text-[#6F789A]">The on-chain vault is turned off on this server.</p>
            ) : (
              <section className="space-y-4 rounded-[24px] border border-[#DADDF1] bg-[#FFFDF7] p-5 text-[11px]">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-[#F4F5FB] p-3">
                    <p className="text-[10px] text-[#8790AE]">In the vault, on Solana</p>
                    <p className="text-lg font-bold">{v.onchain_balance != null ? money(v.onchain_balance) : "—"}</p>
                  </div>
                  <div className="rounded-lg bg-[#F4F5FB] p-3">
                    <p className="text-[10px] text-[#8790AE]">Should be there, per the app</p>
                    <p className="text-lg font-bold">{money(v.expected_balance ?? 0)}</p>
                  </div>
                </div>
                {v.verified ? (
                  <p className="rounded-lg bg-[#E3F7F0] px-3 py-2 font-semibold text-[#209E86]">✓ The server says they match. Don't take its word for it: the check below runs in your browser.</p>
                ) : v.waiting ? (
                  <p className="rounded-lg bg-[#fff7e6] px-3 py-2 font-semibold text-[#8a5a12]">A transaction is being recorded on Solana right now…</p>
                ) : null}

                {v.audit && <ChainAudit audit={v.audit} autoRun />}

                {v.vault_address && (
                  <p className="text-[#6F789A]">
                    Vault:{" "}
                    <a className="font-mono font-semibold text-[#275992] hover:underline" href={v.vault_url} rel="noreferrer" target="_blank">
                      {short(v.vault_address)} ↗
                    </a>{" "}
                    · open it on Solana Explorer to see every transaction yourself.
                  </p>
                )}
                <VaultLists vault={v} />
              </section>
            )}

            <section className="rounded-[24px] border border-[#DADDF1] bg-white p-5 text-[11px] leading-5 text-[#6F789A]">
              <p className="mb-1 font-bold text-[#275992]">How this proof works</p>
              Each time a member saves, the dollars leave their bank account and the same amount of GSD tokens (1 GSD = $1) moves from that member's own wallet into this goal's vault on
              Solana. Every transfer is signed, timestamped and stored by thousands of independent computers, so nobody, Gatorstar included, can edit or delete it later. The vault only pays out
              when the goal is reached, or refunds the person who put the money in.
              <p className="mt-2 text-[10px] text-[#8790AE]">Solana devnet is a public test network: test tokens only, no real money or crypto.</p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
