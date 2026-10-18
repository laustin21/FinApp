import { useEffect, useState } from "react";
import { api, type Me } from "./api";

// ---------- Settings: privacy (what friends see), account, bank ----------

type Sharing = { share_goals: boolean; share_amounts: boolean };

function Toggle({ checked, onChange, label, detail }: { checked: boolean; onChange: () => void; label: string; detail: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-3.5">
      <span>
        <span className="block text-xs font-bold">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-4 text-[#6F789A]">{detail}</span>
      </span>
      <button
        aria-checked={checked}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${checked ? "bg-[#275992]" : "bg-[#C4CAE3]"}`}
        onClick={(e) => {
          e.preventDefault();
          onChange();
        }}
        role="switch"
        type="button"
      >
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? "left-[22px]" : "left-0.5"}`} />
      </button>
    </label>
  );
}

export default function Settings({ me, onGoTo, onLogout }: { me: Me; onGoTo: (nav: string) => void; onLogout: () => void }) {
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [saved, setSaved] = useState("");
  useEffect(() => {
    api<Sharing>("GET", "/api/social/settings").then(setSharing).catch(() => {});
  }, []);

  async function change(patch: Partial<Sharing>) {
    if (!sharing) return;
    const next = { ...sharing, ...patch };
    setSharing(next);
    try {
      await api("PUT", "/api/social/settings", next);
      setSaved("Saved");
      setTimeout(() => setSaved(""), 1500);
    } catch {
      setSharing(sharing);
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#6F789A]">Settings</p>
        <h1 className="text-[28px] font-bold tracking-[-0.045em] sm:text-[34px]">Your settings</h1>
      </div>

      <section className="panel">
        <div className="flex items-center justify-between">
          <p className="panel-title">Privacy</p>
          {saved && <span className="text-[11px] font-bold text-[#209E86]">{saved} ✓</span>}
        </div>
        <p className="text-[11px] text-[#8790AE]">What your friends can see in Social. Your budget is always shown as points and percentages only.</p>
        {sharing ? (
          <div className="mt-2 divide-y divide-[#F0F1F8]">
            <Toggle
              checked={sharing.share_goals}
              detail="Your group goals and how far along you are (as a percentage) on the leaderboard and in your friends' activity."
              label="Show my goal progress to friends"
              onChange={() => change({ share_goals: !sharing.share_goals })}
            />
            <Toggle
              checked={sharing.share_amounts}
              detail="Friends outside your groups see how much you saved (e.g. “saved $40”) instead of just percentages. People in your groups can always see group savings."
              label="Share my savings amounts with friends"
              onChange={() => change({ share_amounts: !sharing.share_amounts })}
            />
          </div>
        ) : (
          <div className="mt-3 h-24 animate-pulse rounded-xl bg-[#F4F5FB]" />
        )}
      </section>

      <section className="panel mt-5">
        <p className="panel-title">Account</p>
        <div className="mt-3 divide-y divide-[#F0F1F8] text-xs">
          <div className="flex justify-between py-2.5">
            <span className="text-[#6F789A]">Name</span>
            <span className="font-bold">{me.display_name}</span>
          </div>
          <div className="flex justify-between py-2.5">
            <span className="text-[#6F789A]">Username</span>
            <span className="font-bold">@{me.username}</span>
          </div>
          <div className="flex items-center justify-between py-2.5">
            <span className="text-[#6F789A]">Bank</span>
            <button className="font-bold text-[#FF8A5B] hover:underline" onClick={() => onGoTo("Accounts")} type="button">
              {me.bank_link ? "Linked · manage accounts →" : "Link a bank →"}
            </button>
          </div>
        </div>
        <button className="mt-4 rounded-lg border border-[#DADDF1] bg-white px-3.5 py-2 text-[11px] font-bold text-[#b4502f] transition hover:bg-[#fff4f0]" onClick={onLogout} type="button">
          Log out
        </button>
      </section>
    </div>
  );
}
