import { useCallback, useEffect, useState } from "react";
import { api, cached } from "./api";
import { Leaderboard } from "./Budget";
import Friends, { initials } from "./Friends";
import { useLive } from "./live";
import { timeAgo, type FeedItem } from "./week";

// ---------- Social (social.py): what your friends are up to, the leaderboard, and your friends ----------

type Tab = "feed" | "board" | "friends";
type FriendsOverview = { friends: unknown[]; incoming: unknown[]; outgoing: unknown[] };
type Board = { entries: { user_id: number; name: string; is_me: boolean; rank: number; points: number; streak: number }[] };
const MEDAL = ["🥇", "🥈", "🥉"];

export default function Social({ me, onGoTo }: { me: { username: string }; onGoTo: (nav: string) => void }) {
  const [tab, setTab] = useState<Tab>("feed");
  const [friends, setFriends] = useState<FriendsOverview | null>(() => cached<FriendsOverview>("/api/friends") ?? null);
  const loadFriends = useCallback(() => {
    api<FriendsOverview>("GET", "/api/friends").then(setFriends).catch(() => {});
  }, []);
  useEffect(loadFriends, [loadFriends]);
  useLive(["friends"], loadFriends);
  const requests = friends?.incoming.length ?? 0;

  return (
    <div>
      <div className="mb-6">
        <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#6F789A]">Social</p>
        <h1 className="text-[28px] font-bold tracking-[-0.045em] sm:text-[34px]">Better with friends</h1>
        <p className="mt-1 text-sm text-[#6F789A]">See what your friends are saving toward, cheer them on, and climb the weekly leaderboard.</p>
      </div>

      <div className="mb-6 inline-flex rounded-xl bg-[#E2E5F4] p-1" role="tablist">
        {(
          [
            ["feed", "Activity"],
            ["board", "Leaderboard"],
            ["friends", `Friends${friends ? ` (${friends.friends.length})` : ""}`],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            aria-selected={tab === key}
            className={`relative rounded-lg px-4 py-2 text-xs font-bold transition ${tab === key ? "bg-white text-[#275992] shadow-sm" : "text-[#6F789A] hover:text-[#275992]"}`}
            key={key}
            onClick={() => setTab(key)}
            role="tab"
            type="button"
          >
            {label}
            {key === "friends" && requests > 0 && (
              <span className="absolute -right-1 -top-1 grid min-w-[16px] place-items-center rounded-full bg-[#ef6b4a] px-1 text-[9px] font-bold leading-4 text-white">{requests}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "feed" && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
          <Feed onAddFriends={() => setTab("friends")} />
          <div className="space-y-4">
            <TopThree onOpen={() => setTab("board")} />
            {requests > 0 && (
              <button className="panel flex w-full items-center justify-between text-left transition hover:bg-[#F4F5FB]" onClick={() => setTab("friends")} type="button">
                <span>
                  <span className="block text-xs font-bold">
                    {requests} friend request{requests === 1 ? "" : "s"}
                  </span>
                  <span className="block text-[11px] text-[#8790AE]">Tap to accept or decline</span>
                </span>
                <span className="rounded-full bg-[#ef6b4a] px-2 py-0.5 text-[10px] font-bold text-white">{requests}</span>
              </button>
            )}
            <section className="panel">
              <p className="panel-title">Invite a friend</p>
              <p className="mt-1 text-[11px] leading-4 text-[#6F789A]">
                Your username is <strong className="text-[#275992]">@{me.username}</strong>. Friends can add you with it, or add them by theirs.
              </p>
              <button className="mt-3 rounded-lg bg-[#275992] px-3.5 py-2 text-[11px] font-bold text-white transition hover:bg-[#1F4777]" onClick={() => setTab("friends")} type="button">
                Add a friend
              </button>
            </section>
            <section className="panel">
              <p className="panel-title">Save together</p>
              <p className="mt-1 text-[11px] leading-4 text-[#6F789A]">Start a group with friends and set a shared goal, like a trip or concert tickets.</p>
              <button className="mt-3 rounded-lg border border-[#DADDF1] bg-white px-3.5 py-2 text-[11px] font-bold text-[#275992] transition hover:bg-[#E2E5F4]" onClick={() => onGoTo("Groups")} type="button">
                Go to Groups
              </button>
            </section>
          </div>
        </div>
      )}
      {tab === "board" && <Leaderboard onGoTo={(nav) => (nav === "Friends" ? setTab("friends") : onGoTo(nav))} />}
      {tab === "friends" && <Friends embedded myUsername={me.username} />}
    </div>
  );
}

function Feed({ onAddFriends }: { onAddFriends: () => void }) {
  const [items, setItems] = useState<FeedItem[] | null>(() => cached<{ items: FeedItem[] }>("/api/social/feed")?.items ?? null);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState<string | null>(null);
  const [shown, setShown] = useState(12);
  const load = useCallback(() => {
    api<{ items: FeedItem[] }>("GET", "/api/social/feed")
      .then((r) => {
        setItems(r.items);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useLive(["friends", "groups", "budget", "money"], load);

  function react(item: FeedItem, emoji: string) {
    // Show it right away; the server confirms in the background.
    setItems((list) =>
      list?.map((i) =>
        i.id !== item.id ? i : { ...i, reactions: i.reactions.map((r) => (r.emoji !== emoji ? r : { ...r, mine: !r.mine, count: r.count + (r.mine ? -1 : 1) })) },
      ) ?? null,
    );
    setPicker(null);
    api("POST", "/api/social/react", { item_id: item.id, emoji }).catch(load);
  }

  return (
    <section className="panel">
      <div className="panel-heading mb-2">
        <div>
          <p className="panel-title">Friend activity</p>
          <p className="text-[11px] text-[#8790AE]">The last 30 days from you and your friends</p>
        </div>
      </div>
      {error && !items && <p className="rounded-lg bg-[#fff4f0] px-3 py-2 text-[11px] font-semibold text-[#9a3b22]">{error}</p>}
      {!items && !error && (
        <div className="space-y-3 pt-2">
          {[0, 1, 2, 3].map((i) => (
            <div className="h-14 animate-pulse rounded-xl bg-[#F4F5FB]" key={i} />
          ))}
        </div>
      )}
      {items && items.length === 0 && (
        <div className="rounded-xl bg-[#F4F5FB] p-6 text-center">
          <p className="text-2xl">👋</p>
          <p className="mt-1 text-sm font-bold">Nothing here yet</p>
          <p className="mx-auto mt-1 max-w-xs text-[11px] text-[#6F789A]">Add friends and their savings, streaks and lessons show up here.</p>
          <button className="mt-3 rounded-lg bg-[#275992] px-3.5 py-2 text-[11px] font-bold text-white transition hover:bg-[#1F4777]" onClick={onAddFriends} type="button">
            Add a friend
          </button>
        </div>
      )}
      <ul className="divide-y divide-[#F0F1F8]">
        {items?.slice(0, shown).map((i) => (
          <li className="flex gap-3 py-3.5" key={i.id}>
            <span className="relative block size-10 shrink-0">
              <span className={`grid size-10 place-items-center rounded-full text-xs font-bold ${i.actor.is_me ? "bg-[#E2E5F4] text-[#275992]" : "bg-[#FFF0E2] text-[#FF8A5B]"}`}>
                {i.actor.id ? initials(i.actor.name) : "★"}
              </span>
              <span className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full bg-white text-[11px] shadow-sm">{i.emoji}</span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs leading-5 text-[#275992]">{i.text}</p>
              <p className="text-[10px] text-[#8790AE]">
                {timeAgo(i.created_at)}
                {i.detail && ` · ${i.detail}`}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {i.reactions
                  .filter((r) => r.count > 0)
                  .map((r) => (
                    <button
                      aria-label={`${r.emoji} ${r.count}`}
                      aria-pressed={r.mine}
                      className={`rounded-full border px-2 py-0.5 text-[11px] transition ${r.mine ? "border-[#95A1D8] bg-[#E2E5F4] font-bold text-[#275992]" : "border-[#DADDF1] bg-white text-[#6F789A] hover:bg-[#F4F5FB]"}`}
                      disabled={i.actor.is_me}
                      key={r.emoji}
                      onClick={() => react(i, r.emoji)}
                      type="button"
                    >
                      {r.emoji} <span className="text-[10px]">{r.count}</span>
                    </button>
                  ))}
                {!i.actor.is_me &&
                  (picker === i.id ? (
                    <span className="flex gap-0.5 rounded-full border border-[#DADDF1] bg-white px-1 py-0.5 shadow-sm">
                      {i.reactions.map((r) => (
                        <button aria-label={`React ${r.emoji}`} className="rounded-full px-1.5 text-sm transition hover:scale-125" key={r.emoji} onClick={() => react(i, r.emoji)} type="button">
                          {r.emoji}
                        </button>
                      ))}
                    </span>
                  ) : (
                    <button
                      aria-label="Add a reaction"
                      className="rounded-full border border-dashed border-[#C4CAE3] px-2 py-0.5 text-[10px] font-bold text-[#8790AE] transition hover:border-[#95A1D8] hover:text-[#275992]"
                      onClick={() => setPicker(i.id)}
                      type="button"
                    >
                      + React
                    </button>
                  ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {items && items.length > shown && (
        <button className="mt-2 w-full rounded-xl bg-[#F4F5FB] py-2.5 text-[11px] font-bold text-[#275992] transition hover:bg-[#E2E5F4]" onClick={() => setShown((n) => n + 12)} type="button">
          Show more
        </button>
      )}
      <p className="mt-2 text-[10px] text-[#8790AE]">Friends outside your groups see your goal progress as percentages, unless you share amounts in Settings.</p>
    </section>
  );
}

function TopThree({ onOpen }: { onOpen: () => void }) {
  const [board, setBoard] = useState<Board | null>(() => cached<Board>("/api/budget/leaderboard") ?? null);
  const load = useCallback(() => {
    api<Board>("GET", "/api/budget/leaderboard").then(setBoard).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useLive(["budget", "money"], load);
  const me = board?.entries.find((e) => e.is_me);
  return (
    <button className="panel w-full text-left transition hover:bg-[#F4F5FB]" onClick={onOpen} type="button">
      <div className="flex items-center justify-between">
        <p className="panel-title">This week's leaders</p>
        <span className="text-[11px] font-bold text-[#FF8A5B]">See all →</span>
      </div>
      {!board ? (
        <div className="mt-3 h-24 animate-pulse rounded-xl bg-[#F4F5FB]" />
      ) : (
        <ol className="mt-3 space-y-2">
          {board.entries.slice(0, 3).map((e) => (
            <li className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 ${e.is_me ? "bg-[#E2E5F4]" : "bg-[#F4F5FB]"}`} key={e.user_id}>
              <span className="w-5 text-center">{MEDAL[e.rank - 1]}</span>
              <span className="min-w-0 flex-1 truncate text-xs font-bold">
                {e.is_me ? "You" : e.name}
                {e.streak >= 2 && <span className="ml-1 font-normal text-[#d85f36]">🔥{e.streak}</span>}
              </span>
              <span className="text-xs font-bold">{e.points} pts</span>
            </li>
          ))}
          {me && me.rank > 3 && (
            <li className="flex items-center gap-2.5 rounded-xl bg-[#E2E5F4] px-2.5 py-2">
              <span className="w-5 text-center text-xs font-bold text-[#8790AE]">{me.rank}</span>
              <span className="flex-1 text-xs font-bold">You</span>
              <span className="text-xs font-bold">{me.points} pts</span>
            </li>
          )}
        </ol>
      )}
    </button>
  );
}
