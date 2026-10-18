import { useCallback, useEffect, useState } from "react";
import { useLive } from "./live";
import { api as call } from "./api";

type Person = { id: number; username: string; display_name: string };
type Link = { request_id: number; person: Person; since: string };
type Overview = { friends: Link[]; incoming: Link[]; outgoing: Link[] };

const fullName = (p: Person) => p.display_name;
const firstName = (p: Person) => p.display_name.split(" ")[0];
export const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
const sinceDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function Avatar({ person }: { person: Person }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#FFF0E2] text-xs font-bold text-[#FF8A5B]">
      {initials(person.display_name)}
    </span>
  );
}

function PersonRow({ person, detail, children }: { person: Person; detail?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-t border-[#DADDF1] px-5 py-3.5 first:border-t-0 sm:px-6">
      <Avatar person={person} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-bold">
          {fullName(person)} <span className="font-semibold text-[#8790AE]">@{person.username}</span>
        </p>
        {detail && <p className="text-[10px] text-[#8790AE]">{detail}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

const primaryBtn = "rounded-lg bg-[#275992] px-3 py-2 text-[11px] font-bold text-white transition hover:bg-[#1F4777] disabled:opacity-50";
const secondaryBtn = "rounded-lg border border-[#DADDF1] bg-white px-3 py-2 text-[11px] font-bold text-[#275992] transition hover:bg-[#E2E5F4] disabled:opacity-50";
const quietBtn = "rounded-lg px-2 py-2 text-[11px] font-bold text-[#8790AE] transition hover:text-[#b4502f] disabled:opacity-50";

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-6 text-xs text-[#8790AE] sm:px-6">{children}</p>;
}

export default function Friends({ myUsername }: { myUsername: string }) {
  const [data, setData] = useState<Overview | null>(null);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    call<Overview>("GET", "/api/friends")
      .then(setData)
      .catch((e) => setMessage({ kind: "error", text: `Couldn't load friends: ${e.message}` }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  // Someone sent / accepted / removed a friend request: update without a refresh.
  useLive(["friends"], load);

  async function act(key: string, run: () => Promise<unknown>, success: string | ((result: any) => string)) {
    setBusy(key);
    setMessage(null);
    try {
      const result = await run();
      setMessage({ kind: "ok", text: typeof success === "string" ? success : success(result) });
      load();
      return true;
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function sendRequest(e: React.FormEvent) {
    e.preventDefault();
    const ok = await act(
      "add",
      () => call<{ status: string; person: Person }>("POST", "/api/friend-requests", { username }),
      (r: { status: string; person: Person }) =>
        r.status === "accepted"
          ? `@${r.person.username} had already asked you, so you're now friends.`
          : `Friend request sent to ${firstName(r.person)} (@${r.person.username}).`,
    );
    if (ok) setUsername("");
  }

  function copyUsername() {
    navigator.clipboard
      ?.writeText(`@${myUsername}`)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }
  const accept = (l: Link) =>
    act(`accept-${l.request_id}`, () => call("POST", `/api/friend-requests/${l.request_id}/accept`), `You and ${firstName(l.person)} are now friends.`);
  const decline = (l: Link, cancel = false) =>
    act(
      `decline-${l.request_id}`,
      () => call("POST", `/api/friend-requests/${l.request_id}/decline`),
      cancel ? `Request to ${firstName(l.person)} cancelled.` : `Request from ${firstName(l.person)} declined.`,
    );
  const remove = (l: Link) =>
    act(`remove-${l.person.id}`, () => call("DELETE", `/api/friends/${l.person.id}`), `Removed ${firstName(l.person)} from your friends.`);

  return (
    <div>
      <div className="mb-7">
        <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#6F789A]">Friends</p>
        <h1 className="text-[28px] font-bold tracking-[-0.045em] sm:text-[34px]">Your people</h1>
        <p className="mt-1 text-sm text-[#6F789A]">Add friends now so you can save toward shared goals together.</p>
      </div>

      {message && (
        <div
          className={`mb-5 rounded-xl border px-4 py-3 text-xs font-semibold ${message.kind === "ok" ? "border-[#B8E6D6] bg-[#E3F7F0] text-[#209E86]" : "border-[#f3c9bd] bg-[#fff4f0] text-[#9a3b22]"}`}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <div className="space-y-5">
          <section className="panel !p-0">
            <div className="panel-heading px-5 pt-5 sm:px-6">
              <div>
                <p className="panel-title">Friend requests</p>
                <p className="panel-subtitle">People who want to connect with you</p>
              </div>
              {data && data.incoming.length > 0 && (
                <span className="rounded-full bg-[#ef6b4a] px-2 py-0.5 text-[10px] font-bold text-white">{data.incoming.length}</span>
              )}
            </div>
            <div className="mt-3">
              {data?.incoming.length === 0 && <Empty>No pending requests.</Empty>}
              {data?.incoming.map((l) => (
                <PersonRow detail={`Sent ${sinceDate(l.since)}`} key={l.request_id} person={l.person}>
                  <button className={secondaryBtn} disabled={busy !== null} onClick={() => decline(l)}>
                    Decline
                  </button>
                  <button className={primaryBtn} disabled={busy !== null} onClick={() => accept(l)}>
                    Accept
                  </button>
                </PersonRow>
              ))}
            </div>
          </section>

          <section className="panel !p-0">
            <div className="panel-heading px-5 pt-5 sm:px-6">
              <div>
                <p className="panel-title">Your friends</p>
                <p className="panel-subtitle">
                  {data ? `${data.friends.length} ${data.friends.length === 1 ? "friend" : "friends"}` : "Loading…"}
                </p>
              </div>
            </div>
            <div className="mt-3">
              {data?.friends.length === 0 && <Empty>No friends yet. Add someone by their username.</Empty>}
              {data?.friends.map((l) => (
                <PersonRow detail={`Friends since ${sinceDate(l.since)}`} key={l.request_id} person={l.person}>
                  <button className={quietBtn} disabled={busy !== null} onClick={() => remove(l)}>
                    Remove
                  </button>
                </PersonRow>
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-5">
          <section className="panel">
            <p className="panel-title">Add a friend</p>
            <p className="panel-subtitle">Enter their username to send a friend request</p>
            <form className="mt-4 flex gap-2" onSubmit={sendRequest}>
              <label className="relative block flex-1">
                <span className="sr-only">Friend's username</span>
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xs text-[#8790AE]">@</span>
                <input
                  autoCapitalize="none"
                  className="w-full rounded-xl border border-[#DADDF1] bg-white py-2.5 pl-8 pr-4 text-xs outline-none focus:border-[#95A1D8]"
                  maxLength={21}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="username"
                  required
                  spellCheck={false}
                  value={username}
                />
              </label>
              <button className={`${primaryBtn} !px-4`} disabled={busy !== null || !username.trim()} type="submit">
                {busy === "add" ? "Sending…" : "Send request"}
              </button>
            </form>
            <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-[#F4F5FB] px-4 py-3">
              <p className="text-[11px] text-[#6F789A]">
                Your username is <strong className="text-[#275992]">@{myUsername}</strong>. Share it so friends can add you.
              </p>
              <button className={secondaryBtn} onClick={copyUsername} type="button">
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </section>

          <section className="panel !p-0">
            <div className="px-5 pt-5 sm:px-6">
              <p className="panel-title">Sent requests</p>
              <p className="panel-subtitle">Waiting for them to accept</p>
            </div>
            <div className="mt-3">
              {data?.outgoing.length === 0 && <Empty>No requests waiting.</Empty>}
              {data?.outgoing.map((l) => (
                <PersonRow detail={`Sent ${sinceDate(l.since)}`} key={l.request_id} person={l.person}>
                  <button className={secondaryBtn} disabled={busy !== null} onClick={() => decline(l, true)}>
                    Cancel
                  </button>
                </PersonRow>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
