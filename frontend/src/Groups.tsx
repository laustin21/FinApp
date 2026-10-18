import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { initials } from "./Friends";
import { ChainBadge, VaultPanel, useVault } from "./Vault";
import { GoalCoach, NO_TERMS, Realism, TermsFields, describePenalty, type CoachPlan, type Terms } from "./GoalCoach";

// ---------- Types (match groups.py) ----------
type Person = { id: number; username: string; display_name: string };
type Status = "on_track" | "behind" | "complete" | "not_committed" | "missed";
type Schedule = {
  payment: number;
  payments_total: number;
  payments_due_so_far: number;
  next_due: string | null;
  next_amount: number;
  missed: number;
  penalty_owed: number;
  total_owed: number;
  dares_owed: number;
};
type MemberProgress = { person: Person; share: number | null; saved: number; expected_by_now: number; percent: number; status: Status; schedule: Schedule | null };
type Goal = {
  id: number;
  title: string;
  target: number;
  deadline: string;
  created_by: number;
  days_left: number;
  total_saved: number;
  former_members_saved: number;
  percent: number;
  expected_by_now: number;
  committed_total: number;
  uncommitted_count: number;
  status: Status;
  my_share: number | null;
  suggested_share: number;
  members: MemberProgress[];
  terms: Terms;
};
type GroupSummary = {
  id: number;
  name: string;
  members: Person[];
  goals: Pick<Goal, "id" | "title" | "target" | "total_saved" | "percent" | "status" | "days_left" | "my_share">[];
};
type Invite = { id: number; created_at: string; group: { id: number; name: string; member_count: number }; invited_by: Person };
type Funding = { linked: boolean; id?: string; nickname?: string; type?: string; balance: number };
type GroupDetail = {
  id: number;
  name: string;
  owner_id: number;
  members: (Person & { joined_at: string; is_owner: boolean })[];
  pending_invites: { id: number; person: Person; can_cancel: boolean }[];
  invitable_friends: Person[];
  goals: Goal[];
  my_contributions: { id: number; goal_id: number; amount: number; note: string; created_at: string }[];
  activity: { kind: string; message: string; created_at: string }[];
};

// ---------- Small pieces ----------
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const moneyShort = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const longDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const primaryBtn = "rounded-lg bg-[#275992] px-3.5 py-2 text-[11px] font-bold text-white transition hover:bg-[#1F4777] disabled:opacity-50";
const secondaryBtn = "rounded-lg border border-[#DADDF1] bg-white px-3.5 py-2 text-[11px] font-bold text-[#275992] transition hover:bg-[#E2E5F4] disabled:opacity-50";
const quietBtn = "rounded-lg px-2 py-2 text-[11px] font-bold text-[#8790AE] transition hover:text-[#b4502f] disabled:opacity-50";
const input = "w-full rounded-xl border border-[#DADDF1] bg-white px-3.5 py-2.5 text-xs outline-none transition focus:border-[#95A1D8]";
const fieldLabel = "mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-[#6F789A]";

const STATUS: Record<Status, { label: string; cls: string }> = {
  on_track: { label: "On track", cls: "bg-[#E3F7F0] text-[#209E86]" },
  behind: { label: "Behind", cls: "bg-[#fff0e9] text-[#b4502f]" },
  complete: { label: "Complete", cls: "bg-[#784CCB33] text-[#275992]" },
  not_committed: { label: "Not committed", cls: "bg-[#E2E5F4] text-[#6F789A]" },
  missed: { label: "Deadline passed", cls: "bg-[#fde8e4] text-[#9a3b22]" },
};

function Pill({ status }: { status: Status }) {
  const s = STATUS[status];
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${s.cls}`}>{s.label}</span>;
}

function Avatar({ person, size = "size-9" }: { person: Person; size?: string }) {
  return (
    <span className={`grid ${size} shrink-0 place-items-center rounded-full border-2 border-white bg-[#FFF0E2] text-[11px] font-bold text-[#FF8A5B]`} title={person.display_name}>
      {initials(person.display_name)}
    </span>
  );
}

function AvatarStack({ people }: { people: Person[] }) {
  return (
    <div className="flex -space-x-2">
      {people.slice(0, 5).map((p) => (
        <Avatar key={p.id} person={p} size="size-8" />
      ))}
      {people.length > 5 && <span className="grid size-8 place-items-center rounded-full border-2 border-white bg-[#E2E5F4] text-[10px] font-bold">+{people.length - 5}</span>}
    </div>
  );
}

/** Progress bar with a tick showing where you should be by now. */
function Bar({ percent, expectedPercent, tone = "green" }: { percent: number; expectedPercent?: number; tone?: "green" | "orange" | "purple" }) {
  const fill = tone === "orange" ? "bg-[#ef8a5f]" : tone === "purple" ? "bg-[#9a6bff]" : "bg-[#FF8A5B]";
  return (
    <div className="relative h-2.5 w-full overflow-visible rounded-full bg-[#E2E5F4]">
      <div className={`h-full rounded-full ${fill} transition-all`} style={{ width: `${Math.min(100, percent)}%` }} />
      {expectedPercent !== undefined && expectedPercent > 0 && expectedPercent < 100 && (
        <div className="absolute -top-1 h-[18px] w-0.5 rounded bg-[#275992]" style={{ left: `${expectedPercent}%` }} title="Where you should be by now" />
      )}
    </div>
  );
}

function Notice({ message }: { message: { kind: "ok" | "error"; text: string } | null }) {
  if (!message) return null;
  return (
    <div
      className={`mb-5 rounded-xl border px-4 py-3 text-xs font-semibold ${message.kind === "ok" ? "border-[#B8E6D6] bg-[#E3F7F0] text-[#209E86]" : "border-[#f3c9bd] bg-[#fff4f0] text-[#9a3b22]"}`}
      role={message.kind === "error" ? "alert" : "status"}
    >
      {message.text}
    </div>
  );
}

type Msg = { kind: "ok" | "error"; text: string } | null;

// Runs an API action, shows a message, reloads.
function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Msg>(null);
  const run = async (fn: () => Promise<any>, success: string | ((result: any) => string)) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await fn();
      setMessage({ kind: "ok", text: typeof success === "string" ? success : success(result) });
      reload();
      return true;
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, setMessage, run };
}

// ---------- Page ----------
export default function Groups({ meId }: { meId: number }) {
  const [openGroupId, setOpenGroupId] = useState<number | null>(null);
  return openGroupId === null ? (
    <GroupList onOpen={setOpenGroupId} />
  ) : (
    <GroupView groupId={openGroupId} meId={meId} onBack={() => setOpenGroupId(null)} />
  );
}

// ---------- List of groups, invites, create ----------
function GroupList({ onOpen }: { onOpen: (id: number) => void }) {
  const [data, setData] = useState<{ groups: GroupSummary[]; invites: Invite[] } | null>(null);
  const [friends, setFriends] = useState<Person[]>([]);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api<{ groups: GroupSummary[]; invites: Invite[] }>("GET", "/api/groups").then(setData).catch((e) => setMessage({ kind: "error", text: e.message }));
    api<{ friends: { person: Person }[] }>("GET", "/api/friends").then((f) => setFriends(f.friends.map((x) => x.person))).catch(() => {});
  }, []);
  const { busy, message, setMessage, run } = useAction(load);
  useEffect(load, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    let newId = 0;
    const ok = await run(async () => {
      newId = (await api<{ id: number }>("POST", "/api/groups", { name, invite_user_ids: picked })).id;
    }, `Created “${name.trim()}”${picked.length ? ` and invited ${picked.length} ${picked.length === 1 ? "friend" : "friends"}` : ""}.`);
    if (ok) {
      setName("");
      setPicked([]);
      setCreating(false);
      onOpen(newId);
    }
  }

  return (
    <div>
      <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#6F789A]">Groups</p>
          <h1 className="text-[28px] font-bold tracking-[-0.045em] sm:text-[34px]">Save together</h1>
          <p className="mt-1 text-sm text-[#6F789A]">Start a group with friends, set a shared goal, and keep each other on track.</p>
        </div>
        {!creating && (
          <button className={`${primaryBtn} !px-5 !py-3`} onClick={() => setCreating(true)}>
            + New group
          </button>
        )}
      </div>

      <Notice message={message} />

      {data && data.invites.length > 0 && (
        <section className="panel mb-5 !p-0">
          <div className="px-5 pt-5 sm:px-6">
            <p className="panel-title">Group invites</p>
            <p className="panel-subtitle">Friends who want you to save with them</p>
          </div>
          <div className="mt-3">
            {data.invites.map((inv) => (
              <div className="flex flex-wrap items-center gap-3 border-t border-[#DADDF1] px-5 py-3.5 sm:px-6" key={inv.id}>
                <Avatar person={inv.invited_by} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold">{inv.group.name}</p>
                  <p className="text-[10px] text-[#8790AE]">
                    {inv.invited_by.display_name} (@{inv.invited_by.username}) invited you · {inv.group.member_count} {inv.group.member_count === 1 ? "member" : "members"}
                  </p>
                </div>
                <button className={secondaryBtn} disabled={busy} onClick={() => run(() => api("POST", `/api/group-invites/${inv.id}/decline`), `Declined the invite to ${inv.group.name}.`)}>
                  Decline
                </button>
                <button
                  className={primaryBtn}
                  disabled={busy}
                  onClick={async () => {
                    if (await run(() => api("POST", `/api/group-invites/${inv.id}/accept`), `You joined ${inv.group.name}.`)) onOpen(inv.group.id);
                  }}
                >
                  Join group
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {creating && (
        <section className="panel mb-5">
          <form onSubmit={create}>
            <p className="panel-title">New group</p>
            <p className="panel-subtitle">You can add goals once the group exists.</p>
            <label className="mt-4 block max-w-md">
              <span className={fieldLabel}>Group name</span>
              <input autoFocus className={input} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Spring Break Crew" required value={name} />
            </label>
            <p className={`${fieldLabel} mt-4`}>Invite friends</p>
            {friends.length === 0 ? (
              <p className="text-xs text-[#8790AE]">You don't have any friends added yet. Add them by username on the Friends page, or invite them later.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {friends.map((f) => {
                  const on = picked.includes(f.id);
                  return (
                    <button
                      aria-pressed={on}
                      className={`flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-xs font-semibold transition ${on ? "border-[#FF8A5B] bg-[#E3F7F0] text-[#209E86]" : "border-[#DADDF1] bg-white text-[#275992] hover:bg-[#E2E5F4]"}`}
                      key={f.id}
                      onClick={() => setPicked(on ? picked.filter((x) => x !== f.id) : [...picked, f.id])}
                      type="button"
                    >
                      <Avatar person={f} size="size-7" />
                      {f.display_name}
                      {on && <span aria-hidden="true">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="mt-5 flex gap-2">
              <button className={primaryBtn} disabled={busy} type="submit">
                Create group
              </button>
              <button className={secondaryBtn} onClick={() => setCreating(false)} type="button">
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      {data && data.groups.length === 0 && !creating && (
        <section className="panel text-center">
          <p className="text-sm font-bold">No groups yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-[#8790AE]">Create one for a trip, a concert, or anything you're saving for with friends.</p>
        </section>
      )}

      <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
        {data?.groups.map((g) => (
          <button className="panel text-left transition hover:border-[#C8CEEB] hover:shadow-md" key={g.id} onClick={() => onOpen(g.id)}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-base font-bold tracking-[-0.02em]">{g.name}</p>
                <p className="mt-0.5 text-[11px] text-[#8790AE]">
                  {g.members.length} {g.members.length === 1 ? "member" : "members"} · {g.goals.length} {g.goals.length === 1 ? "goal" : "goals"}
                </p>
              </div>
              <AvatarStack people={g.members} />
            </div>
            <div className="mt-5 space-y-4">
              {g.goals.length === 0 && <p className="text-xs text-[#8790AE]">No goals yet. Open the group to add one.</p>}
              {g.goals.slice(0, 2).map((goal) => (
                <div key={goal.id}>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold">{goal.title}</span>
                    <Pill status={goal.status} />
                  </div>
                  <Bar percent={goal.percent} tone={goal.status === "behind" ? "orange" : goal.status === "complete" ? "purple" : "green"} />
                  <p className="mt-1.5 text-[10px] text-[#8790AE]">
                    {moneyShort(goal.total_saved)} of {moneyShort(goal.target)} · {goal.days_left >= 0 ? `${goal.days_left} days left` : "deadline passed"}
                  </p>
                </div>
              ))}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- One group ----------
function GroupView({ groupId, meId, onBack }: { groupId: number; meId: number; onBack: () => void }) {
  const [g, setG] = useState<GroupDetail | null>(null);
  const [inviteId, setInviteId] = useState("");
  // New goal: "coach" = Gemini guided chat, "form" = the goal form (maybe prefilled by the coach).
  const [newGoal, setNewGoal] = useState<null | "coach" | "form">(null);
  const [coachPlan, setCoachPlan] = useState<CoachPlan | null>(null);
  const showNewGoal = newGoal !== null;
  const openNewGoal = (mode: "coach" | "form") => {
    setCoachPlan(null);
    setNewGoal(mode);
  };
  const [confirmLeave, setConfirmLeave] = useState(false);

  const [funding, setFunding] = useState<Funding | null>(null);

  const load = useCallback(() => {
    api<GroupDetail>("GET", `/api/groups/${groupId}`)
      .then(setG)
      .catch((e) => setMessage({ kind: "error", text: e.message }));
    api<Funding>("GET", "/api/me/funding-account").then(setFunding).catch(() => setFunding(null));
  }, [groupId]);
  const { busy, message, setMessage, run } = useAction(load);
  useEffect(() => {
    load();
    // Live: pick up friends' savings and balance changes without a refresh.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 8000);
    return () => clearInterval(timer);
  }, [load]);

  if (!g)
    return (
      <div>
        <BackLink onBack={onBack} />
        <Notice message={message} />
      </div>
    );

  const isOwner = g.owner_id === meId;

  return (
    <div>
      <BackLink onBack={onBack} />
      <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#6F789A]">Group</p>
          <h1 className="text-[28px] font-bold tracking-[-0.045em] sm:text-[34px]">{g.name}</h1>
          <div className="mt-2 flex items-center gap-3">
            <AvatarStack people={g.members} />
            <span className="text-xs text-[#6F789A]">{g.members.map((m) => m.display_name.split(" ")[0]).join(", ")}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button className={`${secondaryBtn} !px-4 !py-3`} onClick={() => openNewGoal("form")}>
            + New goal
          </button>
          <button className={`${primaryBtn} !px-5 !py-3`} onClick={() => openNewGoal("coach")}>
            ✦ Plan a goal with Gemini
          </button>
        </div>
      </div>

      <Notice message={message} />

      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-5">
          {newGoal === "coach" && (
            <GoalCoach
              groupId={g.id}
              key={`coach-${g.id}`}
              onSkip={() => setNewGoal("form")}
              onUsePlan={(plan) => {
                setCoachPlan(plan);
                setNewGoal("form");
              }}
            />
          )}
          {newGoal === "form" && (
            <NewGoalForm
              busy={busy}
              fromCoach={coachPlan}
              key={coachPlan ? `plan-${coachPlan.title}-${coachPlan.deadline}` : "blank"}
              onBackToCoach={() => setNewGoal("coach")}
              onCancel={() => setNewGoal(null)}
              onCreate={async (body) => {
                if (await run(() => api("POST", `/api/groups/${g.id}/goals`, body), `Created the goal “${body.title}”. Everyone can now commit their share.`)) setNewGoal(null);
              }}
            />
          )}

          {g.goals.length === 0 && !showNewGoal && (
            <section className="panel text-center">
              <p className="text-sm font-bold">No shared goals yet</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-[#8790AE]">Set a target, a deadline and the rules, and everyone in the group commits their share.</p>
              <div className="mt-4 flex justify-center gap-2">
                <button className={primaryBtn} onClick={() => openNewGoal("coach")}>
                  ✦ Plan it with Gemini
                </button>
                <button className={secondaryBtn} onClick={() => openNewGoal("form")}>
                  Fill it in myself
                </button>
              </div>
            </section>
          )}

          {g.goals.map((goal) => (
            <GoalCard
              busy={busy}
              canDelete={goal.created_by === meId || isOwner}
              contributions={g.my_contributions.filter((c) => c.goal_id === goal.id)}
              funding={funding}
              goal={goal}
              key={goal.id}
              meId={meId}
              run={run}
            />
          ))}
        </div>

        <div className="space-y-5">
          <section className="panel">
            <p className="panel-title">Members</p>
            <div className="mt-3 space-y-3">
              {g.members.map((m) => (
                <div className="flex items-center gap-3" key={m.id}>
                  <Avatar person={m} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-bold">
                      {m.display_name}
                      {m.id === meId && <span className="font-normal text-[#8790AE]"> (you)</span>}
                    </p>
                    <p className="text-[10px] text-[#8790AE]">
                      @{m.username} · {m.is_owner ? "Owner" : `Joined ${when(m.joined_at)}`}
                    </p>
                  </div>
                </div>
              ))}
              {g.pending_invites.map((i) => (
                <div className="flex items-center gap-3 opacity-70" key={i.id}>
                  <Avatar person={i.person} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-bold">{i.person.display_name}</p>
                    <p className="text-[10px] text-[#8790AE]">@{i.person.username} · Invited, hasn't joined yet</p>
                  </div>
                  {i.can_cancel && (
                    <button className={quietBtn} disabled={busy} onClick={() => run(() => api("POST", `/api/group-invites/${i.id}/decline`), `Cancelled the invite to ${i.person.display_name}.`)}>
                      Cancel
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-5 border-t border-[#DADDF1] pt-4">
              <p className={fieldLabel}>Invite a friend</p>
              {g.invitable_friends.length === 0 ? (
                <p className="text-[11px] text-[#8790AE]">All your friends are already here or invited. Add more on the Friends page.</p>
              ) : (
                <form
                  className="flex gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const friend = g.invitable_friends.find((f) => String(f.id) === inviteId);
                    if (!friend) return;
                    if (await run(() => api("POST", `/api/groups/${g.id}/invites`, { user_id: friend.id }), `Invited ${friend.display_name}.`)) setInviteId("");
                  }}
                >
                  <select className={input} onChange={(e) => setInviteId(e.target.value)} required value={inviteId}>
                    <option value="">Choose a friend…</option>
                    {g.invitable_friends.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.display_name} (@{f.username})
                      </option>
                    ))}
                  </select>
                  <button className={primaryBtn} disabled={busy || !inviteId} type="submit">
                    Invite
                  </button>
                </form>
              )}
            </div>
          </section>

          <section className="panel">
            <p className="panel-title">Activity</p>
            <p className="panel-subtitle">Everything the group has done</p>
            <ol className="mt-4 space-y-3.5">
              {g.activity.length === 0 && <li className="text-xs text-[#8790AE]">Nothing yet.</li>}
              {g.activity.map((a, i) => (
                <li className="flex gap-3" key={i}>
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${a.kind === "contribution" ? "bg-[#FF8A5B]" : a.kind === "commit" ? "bg-[#9a6bff]" : a.kind === "leave" || a.kind === "decline" ? "bg-[#ef8a5f]" : "bg-[#C4CAE3]"}`} />
                  <div>
                    <p className="text-xs leading-5">{a.message}</p>
                    <p className="text-[10px] text-[#8790AE]">{when(a.created_at)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <div className="text-center">
            {confirmLeave ? (
              <div className="flex items-center justify-center gap-2">
                <span className="text-xs text-[#6F789A]">{g.members.length === 1 ? "You're the last member. Leaving deletes the group." : "Leave this group?"}</span>
                <button className={secondaryBtn} onClick={() => setConfirmLeave(false)}>
                  Stay
                </button>
                <button
                  className="rounded-lg bg-[#b4502f] px-3.5 py-2 text-[11px] font-bold text-white"
                  disabled={busy}
                  onClick={async () => {
                    if (await run(() => api("POST", `/api/groups/${g.id}/leave`), `You left ${g.name}.`)) onBack();
                  }}
                >
                  Leave
                </button>
              </div>
            ) : (
              <button className={quietBtn} onClick={() => setConfirmLeave(true)}>
                Leave group
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button className="mb-4 text-xs font-bold text-[#FF8A5B] hover:underline" onClick={onBack}>
      ← All groups
    </button>
  );
}

type NewGoalBody = { title: string; target_amount: number; deadline: string } & Terms;

function NewGoalForm({
  busy,
  fromCoach,
  onCreate,
  onCancel,
  onBackToCoach,
}: {
  busy: boolean;
  fromCoach: CoachPlan | null;
  onCreate: (b: NewGoalBody) => void;
  onCancel: () => void;
  onBackToCoach: () => void;
}) {
  // Gemini's plan (if any) fills in the blanks; everything stays editable.
  const [title, setTitle] = useState(fromCoach?.title ?? "");
  const [target, setTarget] = useState(fromCoach ? String(fromCoach.target_amount) : "");
  const [deadline, setDeadline] = useState(fromCoach?.deadline ?? "");
  const [terms, setTerms] = useState<Terms>(
    fromCoach
      ? {
          frequency: fromCoach.frequency,
          penalty_type: fromCoach.frequency === "none" ? "none" : fromCoach.penalty_type,
          penalty_percent: fromCoach.penalty_percent,
          penalty_dare: fromCoach.penalty_dare,
          pace: fromCoach.pace,
          realism_score: fromCoach.realism_score,
          realism_note: fromCoach.realism_note,
          coach_summary: fromCoach.summary,
        }
      : NO_TERMS,
  );
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return (
    <section className="panel">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate({ title: title.trim(), target_amount: Number(target), deadline, ...terms, penalty_type: terms.frequency === "none" ? "none" : terms.penalty_type });
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="panel-title">New shared goal</p>
            <p className="panel-subtitle">{fromCoach ? "Filled in by Gemini from your chat. Change anything before you create it." : "Everyone in the group can commit a share once it's created."}</p>
          </div>
          <button className="text-[11px] font-bold text-[#FF8A5B] hover:underline" onClick={onBackToCoach} type="button">
            {fromCoach ? "← Back to the coach" : "✦ Plan it with Gemini instead"}
          </button>
        </div>

        {fromCoach && (
          <div className="mt-4 rounded-xl bg-[#F4F5FB] p-3.5">
            <Realism note={fromCoach.realism_note} score={fromCoach.realism_score} />
          </div>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-[1.4fr_1fr_1fr]">
          <label className="block">
            <span className={fieldLabel}>What are you saving for?</span>
            <input autoFocus className={input} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Miami spring break" required value={title} />
          </label>
          <label className="block">
            <span className={fieldLabel}>Target ($)</span>
            <input className={input} inputMode="decimal" min="1" onChange={(e) => setTarget(e.target.value)} placeholder="3000" required step="0.01" type="number" value={target} />
          </label>
          <label className="block">
            <span className={fieldLabel}>Deadline</span>
            <input className={input} min={tomorrow} onChange={(e) => setDeadline(e.target.value)} required type="date" value={deadline} />
          </label>
        </div>

        <div className="mt-5 border-t border-[#DADDF1] pt-4">
          <p className="mb-3 text-xs font-bold">The rules</p>
          <TermsFields onChange={setTerms} terms={terms} />
        </div>

        <div className="mt-5 flex gap-2">
          <button className={primaryBtn} disabled={busy} type="submit">
            Create goal
          </button>
          <button className={secondaryBtn} onClick={onCancel} type="button">
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

function GoalCard({
  goal,
  meId,
  canDelete,
  contributions,
  funding,
  busy,
  run,
}: {
  goal: Goal;
  meId: number;
  canDelete: boolean;
  contributions: GroupDetail["my_contributions"];
  funding: Funding | null;
  busy: boolean;
  run: (fn: () => Promise<any>, success: string | ((result: any) => string)) => Promise<boolean>;
}) {
  const [share, setShare] = useState(String(goal.my_share ?? goal.suggested_share));
  const [editingShare, setEditingShare] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingTerms, setEditingTerms] = useState(false);
  const [terms, setTerms] = useState<Terms>(goal.terms);

  const committed = goal.my_share !== null;
  const mine = goal.members.find((m) => m.person.id === meId)?.schedule ?? null;
  // The goal's on-chain vault (Solana); reloads whenever the amount saved changes.
  const vault = useVault(goal.id, `${goal.total_saved}-${contributions.length}`);
  const hasSchedule = goal.terms.frequency !== "none";
  const every = goal.terms.frequency === "weekly" ? "week" : goal.terms.frequency === "biweekly" ? "2 weeks" : "month";
  const expectedPct = goal.target ? (100 * goal.expected_by_now) / goal.target : 0;
  const memberCount = goal.members.length;
  const committedCount = memberCount - goal.uncommitted_count;
  const tone = goal.status === "behind" ? "orange" : goal.status === "complete" ? "purple" : "green";

  return (
    <section className="panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-lg font-bold tracking-[-0.025em]">{goal.title}</p>
            <Pill status={goal.status} />
          </div>
          <p className="mt-0.5 text-[11px] text-[#8790AE]">
            Due {longDate(goal.deadline)} · {goal.days_left >= 0 ? `${goal.days_left} days left` : `${-goal.days_left} days ago`}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[22px] font-bold tracking-[-0.04em]">{money(goal.total_saved)}</p>
          <p className="text-[11px] text-[#8790AE]">of {money(goal.target)} · {goal.percent}%</p>
        </div>
      </div>

      <div className="mt-4">
        <Bar expectedPercent={expectedPct} percent={goal.percent} tone={tone} />
        <div className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] text-[#8790AE]">
          <span>The tick marks where the group should be by now: {money(goal.expected_by_now)}</span>
          <span>
            {committedCount} of {memberCount} committed · {money(goal.committed_total)} pledged
          </span>
        </div>
        {goal.committed_total < goal.target && committedCount === memberCount && (
          <p className="mt-2 rounded-lg bg-[#fff7e6] px-3 py-2 text-[11px] font-semibold text-[#8a5a12]">
            Everyone's committed, but shares add up to {money(goal.target - goal.committed_total)} less than the goal. Someone may want to raise their share.
          </p>
        )}
      </div>

      {/* The rules: payment schedule + missed-payment penalty */}
      <div className="mt-4 rounded-xl border border-[#DADDF1] bg-[#FFFDF7] px-3.5 py-3">
        {editingTerms ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const body = { ...terms, penalty_type: terms.frequency === "none" ? "none" : terms.penalty_type };
              if (await run(() => api("PUT", `/api/goals/${goal.id}/terms`, body), `Updated the rules for ${goal.title}.`)) setEditingTerms(false);
            }}
          >
            <TermsFields onChange={setTerms} terms={terms} />
            <div className="mt-3 flex gap-2">
              <button className={primaryBtn} disabled={busy} type="submit">
                Save rules
              </button>
              <button className={secondaryBtn} onClick={() => setEditingTerms(false)} type="button">
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] text-[#275992]">
              {hasSchedule ? (
                <>
                  <strong>Pay every {every}</strong> · {describePenalty(goal.terms)}
                  {goal.terms.realism_score !== null && <span className="text-[#8790AE]"> · Gemini rated it {goal.terms.realism_score}/10</span>}
                </>
              ) : (
                <span className="text-[#6F789A]">No payment schedule or penalty yet.</span>
              )}
            </div>
            {canDelete && (
              <button
                className="text-[11px] font-bold text-[#FF8A5B] hover:underline"
                onClick={() => {
                  setTerms(goal.terms);
                  setEditingTerms(true);
                }}
                type="button"
              >
                {hasSchedule ? "Edit rules" : "Set rules"}
              </button>
            )}
          </div>
        )}
        {mine && committed && !editingTerms && (
          <p className="mt-2 border-t border-[#DADDF1] pt-2 text-[11px] text-[#6F789A]">
            {mine.next_due ? (
              <>
                Your next payment: <strong className="text-[#275992]">{money(mine.next_amount)}</strong> by {longDate(mine.next_due)}
              </>
            ) : (
              "All your payments are due."
            )}
            {mine.penalty_owed > 0 && <span className="font-semibold text-[#b4502f]"> · includes {money(mine.penalty_owed)} for missed payments</span>}
            {mine.dares_owed > 0 && <span className="font-semibold text-[#b4502f]"> · you owe the group {mine.dares_owed === 1 ? "a dare" : `${mine.dares_owed} dares`}</span>}
          </p>
        )}
      </div>

      <VaultPanel vault={vault} />

      {/* Per-member accountability */}
      <div className="mt-5 space-y-3 border-t border-[#DADDF1] pt-4">
        {goal.members.map((m) => (
          <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[180px_1fr_auto]" key={m.person.id}>
            <div className="flex min-w-0 items-center gap-2.5">
              <Avatar person={m.person} size="size-8" />
              <span className="truncate text-xs font-bold">
                {m.person.display_name.split(" ")[0]}
                {m.person.id === meId && <span className="font-normal text-[#8790AE]"> (you)</span>}
              </span>
            </div>
            <div className="order-3 col-span-2 sm:order-none sm:col-span-1">
              {m.share !== null ? (
                <>
                  <Bar
                    expectedPercent={(100 * m.expected_by_now) / m.share}
                    percent={m.percent}
                    tone={m.status === "behind" ? "orange" : m.status === "complete" ? "purple" : "green"}
                  />
                  <p className="mt-1 text-[10px] text-[#8790AE]">
                    {money(m.saved)} of {money(m.schedule ? m.schedule.total_owed : m.share)} · should be at {money(m.expected_by_now)}
                    {m.schedule && ` · ${m.schedule.payments_due_so_far} of ${m.schedule.payments_total} payments due`}
                  </p>
                  {m.schedule && m.schedule.missed > 0 && (
                    <p className="mt-1 inline-block rounded-md bg-[#fff0e9] px-2 py-0.5 text-[10px] font-bold text-[#b4502f]">
                      Missed {m.schedule.missed} payment{m.schedule.missed === 1 ? "" : "s"}
                      {m.schedule.penalty_owed > 0 && ` · +${money(m.schedule.penalty_owed)} penalty`}
                      {m.schedule.dares_owed > 0 && ` · owes ${m.schedule.dares_owed === 1 ? "a dare" : `${m.schedule.dares_owed} dares`}: ${goal.terms.penalty_dare}`}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[10px] text-[#8790AE]">Hasn't committed a share yet{m.saved > 0 ? ` (saved ${money(m.saved)})` : ""}</p>
              )}
            </div>
            <Pill status={m.status} />
          </div>
        ))}
        {goal.former_members_saved > 0 && (
          <p className="text-[10px] text-[#8790AE]">Includes {money(goal.former_members_saved)} saved by people who have left the group.</p>
        )}
      </div>

      {/* Your actions */}
      <div className="mt-5 rounded-2xl bg-[#F4F5FB] p-4">
        {!committed || editingShare ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(
                () => api("POST", `/api/goals/${goal.id}/commit`, { share_amount: Number(share) }),
                committed ? `Your share is now ${money(Number(share))}.` : `You're in! You committed ${money(Number(share))}.`,
              );
              if (ok) setEditingShare(false);
            }}
          >
            <div className="min-w-[160px] flex-1">
              <p className="text-xs font-bold">{committed ? "Change your share" : "Are you in?"}</p>
              <p className="text-[11px] text-[#6F789A]">
                {committed ? "Your progress will be measured against the new amount." : `Commit your share so the group knows you're in. An even split is ${money(goal.suggested_share)}.`}
              </p>
            </div>
            <label className="block w-36">
              <span className={fieldLabel}>Your share ($)</span>
              <input className={input} inputMode="decimal" min="0.01" onChange={(e) => setShare(e.target.value)} required step="0.01" type="number" value={share} />
            </label>
            <button className={primaryBtn} disabled={busy} type="submit">
              {committed ? "Save share" : "Commit"}
            </button>
            {committed && (
              <button className={secondaryBtn} onClick={() => setEditingShare(false)} type="button">
                Cancel
              </button>
            )}
          </form>
        ) : (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(
                () => api("POST", `/api/goals/${goal.id}/contributions`, { amount: Number(amount), note }),
                (r: { from_account: string; new_balance: number }) =>
                  `Moved ${money(Number(amount))} from ${r.from_account} into ${goal.title}. ${r.from_account} balance is now ${money(r.new_balance)}.`,
              );
              if (ok) {
                setAmount("");
                setNote("");
              }
            }}
          >
            <div className="min-w-[160px] flex-1">
              <p className="text-xs font-bold">Add money to this goal</p>
              <p className="text-[11px] text-[#6F789A]">
                {funding?.linked ? (
                  <>
                    From <strong>{funding.nickname}</strong> · balance {money(funding.balance)}
                    <br />
                  </>
                ) : (
                  <>
                    Link your bank on the Accounts page to move money.
                    <br />
                  </>
                )}
                Your share: {money(goal.my_share!)} ·{" "}
                <button className="font-bold text-[#FF8A5B] hover:underline" onClick={() => setEditingShare(true)} type="button">
                  change
                </button>
              </p>
            </div>
            <label className="block w-28">
              <span className={fieldLabel}>Amount ($)</span>
              <input className={input} inputMode="decimal" min="0.01" onChange={(e) => setAmount(e.target.value)} placeholder="50" required step="0.01" type="number" value={amount} />
            </label>
            <label className="block w-44">
              <span className={fieldLabel}>Note (optional)</span>
              <input className={input} maxLength={120} onChange={(e) => setNote(e.target.value)} placeholder="Skipped takeout" value={note} />
            </label>
            <button className={primaryBtn} disabled={busy || !funding?.linked} type="submit">
              Add money
            </button>
          </form>
        )}

        {contributions.length > 0 && (
          <div className="mt-4 border-t border-[#DADDF1] pt-3">
            <p className={fieldLabel}>Your recent entries</p>
            {contributions.slice(0, 4).map((c) => (
              <div className="flex items-center justify-between py-1 text-[11px]" key={c.id}>
                <span>
                  <strong>{money(c.amount)}</strong> <span className="text-[#8790AE]">{c.note && `· ${c.note} `}· {when(c.created_at)}</span>
                  <ChainBadge entry={vault?.by_contribution?.[String(c.id)]} />
                </span>
                <button className={quietBtn} disabled={busy} onClick={() => run(() => api("DELETE", `/api/contributions/${c.id}`), `Took back ${money(c.amount)}. It's back in your bank balance.`)}>
                  Undo
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {canDelete && (
        <div className="mt-3 text-right">
          {confirmDelete ? (
            <span className="inline-flex items-center gap-2">
              <span className="text-[11px] text-[#6F789A]">Delete this goal and all its entries?</span>
              <button className={secondaryBtn} onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
              <button className="rounded-lg bg-[#b4502f] px-3 py-2 text-[11px] font-bold text-white" disabled={busy} onClick={() => run(() => api("DELETE", `/api/goals/${goal.id}`), `Deleted ${goal.title}.`)}>
                Delete
              </button>
            </span>
          ) : (
            <button className={quietBtn} onClick={() => setConfirmDelete(true)}>
              Delete goal
            </button>
          )}
        </div>
      )}
    </section>
  );
}
