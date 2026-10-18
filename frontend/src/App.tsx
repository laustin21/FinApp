import { useCallback, useEffect, useRef, useState } from "react";
import { api, cached, getToken, setToken, setUnauthorizedHandler, type Me } from "./api";
import Auth from "./Auth";
import Friends, { initials as initialsOf } from "./Friends";
import Groups from "./Groups";
import Transactions, { statementPath } from "./Transactions";
import AccountsPage, { LinkBankForm } from "./LinkBank";
import { SignInLoading } from "./Loading";
import { AiStatusBadge, GeminiThinking } from "./AiStatus";
import { useLive } from "./live";
import { GoalCelebrations } from "./Celebration";
import { ProofPage } from "./Proof";
import { Logo } from "./Logo";

type Customer = { id: string; first_name: string; last_name: string };
type CategoryTotal = { name: string; amount: number; count: number; percent: number };
type Purchase = { id: string; date: string; amount: number; merchant: string; category: string; description: string };
type Dashboard = {
  customer: Customer;
  period: { key: string; start: string; end: string };
  total: number;
  previous_total: number;
  change_percent: number | null;
  purchase_count: number;
  available_balance: number;
  goal_savings: number;
  top_category: CategoryTotal | null;
  categories: CategoryTotal[];
  daily: { unit: "day" | "week"; points: { date: string; amount: number }[] };
  transactions: Purchase[];
};

type AiInsights = { headline: string; persona: string; insights: string[]; tips: string[] };
type InsightsResponse = { available: boolean; reason?: string; insights?: AiInsights };
type Notification = { id: string; kind: string; title: string; body: string; created_at: string; target: string; unread: boolean };

const PERIODS = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_3_months", label: "Last 3 months" },
];


type IconName =
  | "bag"
  | "bell"
  | "car"
  | "cart"
  | "fork"
  | "card"
  | "chevron"
  | "close"
  | "gift"
  | "grid"
  | "help"
  | "home"
  | "insights"
  | "search"
  | "settings"
  | "sparkles"
  | "tag"
  | "trend"
  | "users"
  | "flag"
  | "wallet";

const iconPaths: Record<IconName, React.ReactNode> = {
  bag: (
    <>
      <path d="M5 8h14l-1 13H6L5 8Z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </>
  ),
  car: (
    <>
      <path d="m5 16 1.5-6h11l1.5 6" />
      <path d="M3 16h18v4H3zM6 20v1M18 20v1M7.5 10l1-3h7l1 3" />
    </>
  ),
  cart: (
    <>
      <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 2-1.6L21 8H6" />
      <circle cx="10" cy="20" r="1" />
      <circle cx="18" cy="20" r="1" />
    </>
  ),
  fork: (
    <>
      <path d="M6 3v4a3 3 0 0 0 6 0V3M9 3v18" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18M7 15h2" />
    </>
  ),
  chevron: <path d="m9 18 6-6-6-6" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  gift: (
    <>
      <rect x="3" y="8" width="18" height="13" rx="2" />
      <path d="M12 8v13M3 12h18M12 8H7.5a2.5 2.5 0 1 1 2.2-3.7L12 8Zm0 0h4.5a2.5 2.5 0 1 0-2.2-3.7L12 8Z" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.7 9a2.5 2.5 0 1 1 3.7 2.2c-.9.5-1.4 1-1.4 2.3M12 17h.01" />
    </>
  ),
  home: (
    <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v10h14V10M9 20v-6h6v6" />
    </>
  ),
  insights: (
    <>
      <path d="M4 19V9M10 19V5M16 19v-7M22 19V3" />
      <path d="M2 19h22" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3-1.2 3.3A3.8 3.8 0 0 1 8.5 8.6L5 10l3.5 1.4a3.8 3.8 0 0 1 2.3 2.3L12 17l1.2-3.3a3.8 3.8 0 0 1 2.3-2.3L19 10l-3.5-1.4a3.8 3.8 0 0 1-2.3-2.3L12 3Z" />
      <path d="m5 17-.5 1.3a2.2 2.2 0 0 1-1.3 1.3L2 20l1.2.4a2.2 2.2 0 0 1 1.3 1.3L5 23l.5-1.3a2.2 2.2 0 0 1 1.3-1.3L8 20l-1.2-.4a2.2 2.2 0 0 1-1.3-1.3L5 17Z" />
    </>
  ),
  tag: (
    <>
      <path d="M20.6 13.6 11 23.2 1.8 14V4.8H11l9.6 9.6a1.3 1.3 0 0 1 0 1.8Z" />
      <circle cx="7" cy="10" r="1.4" />
    </>
  ),
  trend: <path d="m3 17 6-6 4 4 8-9M15 6h6v6" />,
  wallet: (
    <>
      <path d="M4 6h14a2 2 0 0 1 2 2v11H4a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3h12v3" />
      <path d="M15 11h7v5h-7a2.5 2.5 0 0 1 0-5Z" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
    </>
  ),
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" />
    </>
  ),
};

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
    >
      {iconPaths[name]}
    </svg>
  );
}

// Look of each category (the data itself now comes from the backend).
const categoryStyles: Record<string, { color: string; iconColor: string; icon: IconName | null; badge: string }> = {
  Dining: { color: "#9a6bff", iconColor: "#8054DB", icon: "fork", badge: "bg-[#f2e9ff] text-[#7749c4]" },
  Groceries: { color: "#2ec7a6", iconColor: "#209E86", icon: "bag", badge: "bg-[#e3f7f0] text-[#16866e]" },
  Shopping: { color: "#ff9b6a", iconColor: "#D9774A", icon: "cart", badge: "bg-[#fff2df] text-[#ae7020]" },
  Transport: { color: "#ffcc57", iconColor: "#C09022", icon: "car", badge: "bg-[#fff0e9] text-[#d85f36]" },
  Other: { color: "#a9b6c8", iconColor: "#7D8AA0", icon: null, badge: "bg-[#E2E5F4] text-[#6F789A]" },
};

function CategoryIcon({ name, size }: { name: string; size: number }) {
  const style = styleFor(name);
  if (!style.icon) return <>••</>;
  // the fork glyph sits left of centre, so nudge it like the design does
  return style.icon === "fork" ? <span className="translate-x-[2px]"><Icon name="fork" size={size} /></span> : <Icon name={style.icon} size={size} />;
}
const styleFor = (category: string) => categoryStyles[category] ?? categoryStyles.Other;

const money = (n: number, cents = true) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const longDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

function donutGradient(categories: CategoryTotal[], total: number) {
  if (!total) return "conic-gradient(#DADDF1 0deg 360deg)";
  let angle = 0;
  const stops = categories.map((c) => {
    const start = angle;
    angle += (c.amount / total) * 360;
    return `${styleFor(c.name).color} ${start}deg ${angle}deg`;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

// start.bat opens the app with ?signout so every fresh launch begins at the login
// screen instead of the last account used. Runs once, before the app draws: ends
// the old session on the server (the request picks up the token right away),
// forgets it here, and tidies the URL.
{
  const url = new URL(window.location.href);
  if (url.searchParams.has("signout")) {
    url.searchParams.delete("signout");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    if (getToken()) {
      api("POST", "/api/auth/logout").catch(() => {});
      setToken(null);
    }
  }
}

// ---------- Login gate ----------
// Shows the login screen until there's a valid session, then the app.
function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [startupError, setStartupError] = useState("");
  // True right after logging in / creating a profile: show the loading screen while data preloads.
  const [booting, setBooting] = useState(false);

  /** Resolves true when you're logged in. */
  const loadMe = useCallback((): Promise<boolean> => {
    if (!getToken()) {
      setMe(null);
      setChecking(false);
      return Promise.resolve(false);
    }
    return api<Me>("GET", "/api/me")
      .then((m) => {
        setMe(m);
        setStartupError("");
        return true;
      })
      .catch((e) => {
        setMe(null);
        if (e.status === 0) setStartupError(e.message);
        return false;
      })
      .finally(() => setChecking(false));
  }, []);

  function loggedIn() {
    setBooting(true);
    loadMe().then((ok) => !ok && setBooting(false));
  }

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    loadMe();
  }, [loadMe]);

  async function logout() {
    await api("POST", "/api/auth/logout").catch(() => {});
    setToken(null);
    setMe(null);
  }

  if (checking) return <div className="min-h-screen bg-[#FFFAED]" />;
  if (!me && !booting)
    return (
      <>
        {startupError && (
          <p className="fixed inset-x-0 top-0 z-50 bg-[#fff4f0] px-4 py-2 text-center text-xs font-semibold text-[#9a3b22]" role="alert">
            {startupError}
          </p>
        )}
        <Auth onLoggedIn={loggedIn} />
      </>
    );
  // The app draws underneath the loading screen, so it's ready when the screen fades out.
  return (
    <>
      {me && <Shell me={me} onLogout={logout} onMeChanged={loadMe} />}
      {booting && <SignInLoading me={me} onDone={() => setBooting(false)} />}
    </>
  );
}

// ---------- The app once logged in ----------
function Shell({ me, onLogout, onMeChanged }: { me: Me; onLogout: () => void; onMeChanged: () => void }) {
  const [period, setPeriod] = useState("this_month");
  const [activeNav, setActiveNav] = useState("Overview");
  const activeNavRef = useRef(activeNav);
  activeNavRef.current = activeNav;
  const [ai, setAi] = useState<InsightsResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const linked = me.bank_link !== null;

  // Load your dashboard (from your linked bank) whenever the period or bank link changes.
  useEffect(() => {
    if (!linked) {
      setData(null);
      return;
    }
    const path = `/api/me/dashboard?period=${period}`;
    const seen = cached<Dashboard>(path);
    if (seen) setData(seen); // a period you've already viewed: show it now, refresh quietly
    else setLoading(true);
    setError("");
    api<Dashboard>("GET", path)
      .then(setData)
      .catch((e) => setError(`Couldn't load your spending data (${e.message})`))
      .finally(() => setLoading(false));
    // Preload the Insights tab's statement so it opens instantly (the server reuses the same bank data).
    api("GET", statementPath("last_30_days")).catch(() => {});
    // Live: refresh quietly every few seconds while the dashboard is open.
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible" || activeNavRef.current !== "Overview") return;
      api<Dashboard>("GET", `/api/me/dashboard?period=${period}`).then(setData).catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [period, linked, me.bank_link?.nessie_customer_id]);
  // Money moved (a goal contribution, a simulated purchase...): refresh the numbers.
  useLive(["money"], () => {
    if (linked) api<Dashboard>("GET", `/api/me/dashboard?period=${period}`).then(setData).catch(() => {});
  });

  // Gemini insights: once per period (the server caches answers for the same numbers).
  const loadInsights = useCallback(() => {
    if (!linked) return;
    const path = `/api/me/insights?period=${period}`;
    const seen = cached<InsightsResponse>(path);
    if (seen) setAi(seen);
    else setAiLoading(true);
    api<InsightsResponse>("GET", path)
      .then(setAi)
      .catch((e) => setAi({ available: false, reason: e.message }))
      .finally(() => setAiLoading(false));
  }, [period, linked]);
  useEffect(() => {
    setAi(null);
    loadInsights();
  }, [loadInsights, me.bank_link?.nessie_customer_id]);

  // Coming back to the dashboard (e.g. after adding money to a goal): refresh right away.
  useEffect(() => {
    if (activeNav === "Overview" && linked) {
      api<Dashboard>("GET", `/api/me/dashboard?period=${period}`).then(setData).catch(() => {});
    }
  }, [activeNav]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstName = me.display_name.split(" ")[0] || "there";
  const initials = initialsOf(me.display_name) || "··";
  const total = data?.total ?? 0;
  const categories = data?.categories ?? [];
  const top = data?.top_category ?? null;
  const points = data?.daily.points ?? [];
  const peak = points.reduce((best, p, i) => (p.amount > (points[best]?.amount ?? 0) ? i : best), 0);
  const chartMax = Math.max(40, Math.ceil((points[peak]?.amount ?? 0) / 40) * 40);
  const periodLabel = PERIODS.find((p) => p.key === period)?.label.toLowerCase() ?? "";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const change = data?.change_percent ?? null;
  const labelIndexes = points.length ? [...new Set([0, 1, 2, 3, 4].map((k) => Math.round((k * (points.length - 1)) / 4)))] : [];

  // Shared by Overview and Insights, so both pages stay on the same period.
  const periodPicker = (
    <label className="relative">
      <span className="sr-only">Select reporting period</span>
      <select
        className="appearance-none rounded-xl border border-[#DADDF1] bg-white py-2.5 pl-4 pr-10 text-xs font-bold text-[#275992] shadow-sm outline-none focus:border-[#95A1D8]"
        onChange={(event) => setPeriod(event.target.value)}
        value={period}
      >
        {PERIODS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 top-2.5 rotate-90 text-[#6F789A]">
        <Icon name="chevron" size={16} />
      </span>
    </label>
  );

  return (
    <div className="min-h-screen bg-[#FFFAED] text-[#275992]">
      {/* Confetti when a group goal is reached (shown once per member, anywhere in the app). */}
      <GoalCelebrations onViewGroups={() => setActiveNav("Groups")} />
      <header className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-[#DADDF1] bg-[#FFFDF7] px-5 lg:px-8">
        <div className="flex items-center gap-3">
          <Logo size={40} />
          <span className="text-[19px] font-bold tracking-[-0.04em]">Gatorstar</span>
          <span className="hidden rounded-full bg-[#E2E5F4] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#6F789A] sm:block">
            Banking
          </span>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          <AiStatusBadge />
          <NotificationBell onOpenTarget={setActiveNav} />
          <div className="mx-1 hidden h-7 w-px bg-[#DADDF1] sm:block" />
          <div className="flex items-center gap-2 rounded-full p-1 pr-2">
            <span className="grid size-9 place-items-center rounded-full bg-[#FFF0E2] text-sm font-bold text-[#FF8A5B]">{initials}</span>
            <span className="hidden leading-tight sm:block">
              <span className="block text-sm font-semibold text-[#FF8A5B]">{me.display_name}</span>
              <span className="block text-[11px] text-[#8790AE]">@{me.username}</span>
            </span>
          </div>
          <button className="rounded-lg border border-[#DADDF1] px-3 py-2 text-[11px] font-bold text-[#275992] transition hover:bg-[#E2E5F4]" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1600px]">
        <aside className="fixed bottom-0 left-0 right-0 z-20 flex h-16 items-center justify-around border-t border-[#DADDF1] bg-[#FFFDF7] px-2 lg:sticky lg:top-[72px] lg:h-[calc(100vh-72px)] lg:w-[232px] lg:flex-col lg:items-stretch lg:justify-between lg:border-r lg:border-t-0 lg:p-4">
          <nav className="flex w-full justify-around lg:flex-col lg:gap-1" aria-label="Main navigation">
            {[
              ["Overview", "grid"],
              ["Insights", "insights"],
              ["Friends", "users"],
              ["Groups", "flag"],
              ["Accounts", "wallet"],
            ].map(([label, icon]) => (
              <button
                className={`nav-item ${activeNav === label ? "nav-item-active" : ""}`}
                key={label}
                onClick={() => setActiveNav(label)}
              >
                <Icon name={icon as IconName} size={19} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="hidden lg:block">
            <div className="mb-4 rounded-2xl bg-[#E2E5F4] p-4">
              <div className="mb-3 grid size-8 place-items-center rounded-lg bg-white text-[#FF8A5B] shadow-sm">
                <Icon name="help" size={17} />
              </div>
              <p className="text-xs font-bold">Need a hand?</p>
              <p className="mt-1 text-[11px] leading-4 text-[#6F789A]">Our support team is here around the clock.</p>
              <button className="mt-3 text-[11px] font-bold text-[#FF8A5B]">Get support →</button>
            </div>
            <button className="nav-item w-full">
              <Icon name="settings" size={19} />
              Settings
            </button>
          </div>
        </aside>

        <main className="w-full min-w-0 px-5 pb-24 pt-7 sm:px-7 lg:px-10 lg:pb-10 lg:pt-10">
          {activeNav === "Friends" ? (
            <Friends myUsername={me.username} />
          ) : activeNav === "Groups" ? (
            <Groups meId={me.id} />
          ) : activeNav === "Accounts" ? (
            <AccountsPage linked={linked} onChange={onMeChanged} />
          ) : !linked ? (
            <>
              <div className="mb-7">
                <h1 className="text-[28px] font-bold tracking-[-0.045em] sm:text-[34px]">Welcome, {firstName}</h1>
                <p className="mt-1 text-sm text-[#6F789A]">One more step: link your bank to see your spending. You can add friends right away.</p>
              </div>
              <LinkBankForm onLinked={onMeChanged} />
            </>
          ) : activeNav === "Insights" ? (
            <>
              <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
                <div>
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#6F789A]">Insights</p>
                  <h1 className="text-[28px] font-bold tracking-[-0.045em] sm:text-[34px]">Your money, explained</h1>
                  <p className="mt-1 text-sm text-[#6F789A]">What Gemini sees in your spending, plus every transaction behind it.</p>
                </div>
                {periodPicker}
              </div>

              <AiInsightsPanel ai={ai} loading={aiLoading} onRefresh={loadInsights} />
              <p className="mt-3 text-center text-[10px] leading-4 text-[#8790AE]">
                AI insights are generated by Gemini from your spending totals and are for education, not financial advice.
              </p>

              <div className="mt-10 border-t border-[#DADDF1] pt-8">
                <Transactions embedded />
              </div>
            </>
          ) : (
          <>
          <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#6F789A]">
                {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </p>
              <h1 className="text-[28px] font-bold tracking-[-0.045em] sm:text-[34px]">{greeting}, {firstName}</h1>
              <p className="mt-1 text-sm text-[#6F789A]">Here’s where your money went—and where it can take you.</p>
            </div>
            {periodPicker}
          </div>

          {error && (
            <div className="mb-5 rounded-xl border border-[#f3c9bd] bg-[#fff4f0] px-4 py-3 text-xs font-semibold text-[#9a3b22]" role="alert">
              {error}
            </div>
          )}

          <section className={`mb-5 grid gap-4 md:grid-cols-3 transition-opacity ${loading ? "opacity-50" : ""}`} aria-busy={loading}>
            <article className="metric-card">
              <div className="flex items-start justify-between">
                <div>
                  <p className="eyebrow">Total spending</p>
                  <p className="metric-number">{money(total)}</p>
                </div>
                <span className="metric-icon" style={{ backgroundColor: "#27685833", color: "#276858" }}><Icon name="wallet" size={18} /></span>
              </div>
              <div className="mt-5 flex items-center gap-2 text-xs">
                {change === null ? (
                  <span className="text-[#8790AE]">No spending in the previous period to compare</span>
                ) : (
                  <>
                    <span className={`rounded-full px-2 py-1 font-bold ${change <= 0 ? "bg-[#FFF0E2] text-[#F6C28E]" : "bg-[#fff0e9] text-[#b4502f]"}`}>
                      {change <= 0 ? "↓" : "↑"} {Math.abs(change)}%
                    </span>
                    <span className="text-[#8790AE]">vs. previous period</span>
                  </>
                )}
              </div>
            </article>
            <article className="metric-card">
              <div className="flex items-start justify-between">
                <div>
                  <p className="eyebrow">Top category</p>
                  <p className="metric-number">{top?.name ?? "—"}</p>
                </div>
                {top ? (
                  <span className="metric-icon" style={{ backgroundColor: `${styleFor(top.name).iconColor}33`, color: styleFor(top.name).iconColor }}><CategoryIcon name={top.name} size={18} /></span>
                ) : (
                  <span className="metric-icon" style={{ backgroundColor: "#784CCB33", color: "#784CCB" }}><Icon name="sparkles" size={18} /></span>
                )}
              </div>
              <div className="mt-5 flex items-center gap-2 text-xs">
                {top ? (
                  <>
                    <span className="font-bold text-[#F6C28E]">{money(top.amount)}</span>
                    <span className="text-[#8790AE]">across {top.count} {top.count === 1 ? "purchase" : "purchases"}</span>
                  </>
                ) : (
                  <span className="text-[#8790AE]">No purchases in this period</span>
                )}
              </div>
            </article>
            <article className="metric-card overflow-hidden text-white">
              <div className="absolute -right-8 -top-10 size-32 rounded-full border-[18px] border-white/5" />
              <div className="relative flex items-start justify-between">
                <div>
                  <p className="eyebrow">Available balance</p>
                  <p className="metric-number text-[#275992]">{money(data?.available_balance ?? 0)}</p>
                </div>
                <span className="metric-icon" style={{ backgroundColor: "#94C8B633", color: "#94C8B6" }}><Icon name="gift" size={18} /></span>
              </div>
              <div className="relative mt-5 flex items-center gap-2 text-xs text-[#8790AE]">
                <span className="font-bold text-[#F6C28E]">{money(data?.goal_savings ?? 0)}</span>
                <span>moved into group goals</span>
              </div>
            </article>
          </section>

          <section className="mb-5 grid gap-5 xl:grid-cols-[1.55fr_1fr]">
            <article className="panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-title">Spending overview</p>
                  <p className="panel-subtitle">Your {data?.daily.unit === "week" ? "weekly" : "daily"} purchase activity, {periodLabel}</p>
                </div>
                <button className="text-xs font-bold text-[#FF8A5B]">View report</button>
              </div>
              <div className="mt-7 flex gap-4">
                <div className="flex h-[200px] flex-col justify-between pb-6 text-[10px] text-[#8D95B1]">
                  {[4, 3, 2, 1, 0].map((k) => (
                    <span key={k}>{money((chartMax * k) / 4, false)}</span>
                  ))}
                </div>
                <div className="chart-grid relative flex h-[200px] flex-1 items-end justify-between gap-1 px-1 pb-6 sm:gap-1.5">
                  {points.map((point, index) => (
                    <div className="group relative flex h-full flex-1 items-end" key={point.date} title={`${shortDate(point.date)}: ${money(point.amount)}`}>
                      <div
                        className={`w-full min-w-[3px] rounded-t-[4px] transition-all group-hover:opacity-75 ${index === peak && point.amount > 0 ? "bg-[#FF8A5B]" : "bg-[#C8CEEB]"}`}
                        style={{ height: `${(point.amount / chartMax) * 100}%` }}
                      />
                      {index === peak && point.amount > 0 && (
                        <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-[#275992] px-1.5 py-1 text-[9px] font-bold text-white">{money(point.amount, false)}</span>
                      )}
                    </div>
                  ))}
                  <div className="absolute bottom-0 left-0 right-0 flex justify-between text-[10px] text-[#8D95B1]">
                    {labelIndexes.map((i) => (
                      <span key={i}>{shortDate(points[i].date)}</span>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-5 flex items-start gap-3 rounded-xl bg-[#E2E5F4] p-3.5">
                <span className="mt-0.5 text-[#275992]"><Icon name="sparkles" size={17} /></span>
                <p className="text-xs leading-5 text-[#6F789A]">
                  <strong className="text-[#275992]">Smart insight:</strong>{" "}
                  {ai?.available && ai.insights
                    ? ai.insights.headline
                    : points[peak]?.amount
                    ? `Your biggest spending ${data?.daily.unit === "week" ? "week started" : "day was"} ${longDate(points[peak].date)}, at ${money(points[peak].amount)}. You made ${data?.purchase_count} purchases ${periodLabel}.`
                    : `No purchases ${periodLabel} yet.`}
                </p>
              </div>
            </article>

            <article className="panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-title">Where your money goes</p>
                  <p className="panel-subtitle">Spending by category</p>
                </div>
                <button aria-label="More category options" className="text-lg font-bold text-[#FF8A5B]">•••</button>
              </div>
              <div className="mt-6 flex flex-col items-center gap-7 sm:flex-row xl:flex-col 2xl:flex-row">
                <div className="donut-chart grid size-40 shrink-0 place-items-center rounded-full" style={{ background: donutGradient(categories, total) }}>
                  <div className="grid size-[104px] place-items-center rounded-full bg-[#FFFDF7] text-center shadow-[0_0_0_1px_#DADDF1]">
                    <div>
                      <p className="text-[10px] font-semibold text-[#8790AE]">Total</p>
                      <p className="text-lg font-bold tracking-[-0.04em] text-[#F6C28E]">{money(total, false)}</p>
                    </div>
                  </div>
                </div>
                <div className="w-full space-y-3.5">
                  {categories.length === 0 && <p className="text-xs text-[#8790AE]">No purchases in this period.</p>}
                  {categories.map((category) => {
                    const style = styleFor(category.name);
                    return (
                      <div className="flex items-center gap-3" key={category.name}>
                        <span className="grid size-7 place-items-center rounded-lg text-xs font-bold" style={{ backgroundColor: `${style.iconColor}33`, color: style.iconColor }}>
                          <CategoryIcon name={category.name} size={14} />
                        </span>
                        <span className="flex-1 text-xs font-semibold">{category.name}</span>
                        <span className="text-xs font-bold text-[#F6C28E]">{money(category.amount, false)}</span>
                        <span className="w-8 text-right text-[10px] text-[#8790AE]">{category.percent}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </article>
          </section>
          </>
          )}
        </main>
      </div>
    </div>
  );
}

const timeAgo = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const notificationIcon: Record<string, IconName> = {
  friend_request: "users",
  friend_accepted: "users",
  group_invite: "flag",
  group_activity: "flag",
};

function NotificationBell({ onOpenTarget }: { onOpenTarget: (target: string) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api<{ unread_count: number; items: Notification[] }>("GET", "/api/notifications")
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread_count);
      })
      .catch(() => {});
  }, []);

  // Check for new notifications every 15 seconds while the tab is visible.
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 30000);
    return () => clearInterval(timer);
  }, [load]);
  // Friend requests, invites and group activity appear in the bell within ~2 s.
  useLive(["friends", "groups"], load);

  // Close when clicking outside the panel.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      setUnread(0);
      api("POST", "/api/notifications/seen").catch(() => {});
    }
    if (!next) setItems((list) => list.map((i) => ({ ...i, unread: false })));
  }

  return (
    <div className="relative" ref={boxRef}>
      <button aria-expanded={open} aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} className="icon-button relative" onClick={toggle}>
        <Icon name="bell" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-[18px] place-items-center rounded-full border-2 border-white bg-[#ef6b4a] px-1 text-[9px] font-bold leading-[14px] text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-40 w-[340px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-[#DADDF1] bg-[#FFFDF7] shadow-xl">
          <div className="flex items-center justify-between border-b border-[#DADDF1] px-4 py-3">
            <p className="text-sm font-bold">Notifications</p>
            <button className="text-[11px] font-bold text-[#FF8A5B]" onClick={load}>Refresh</button>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {items.length === 0 && <p className="px-4 py-8 text-center text-xs text-[#8790AE]">You're all caught up.</p>}
            {items.map((n) => (
              <button
                className={`flex w-full gap-3 border-b border-[#F4F5FB] px-4 py-3 text-left transition hover:bg-[#F4F5FB] ${n.unread ? "bg-[#F4F5FB]" : ""}`}
                key={n.id}
                onClick={() => {
                  onOpenTarget(n.target);
                  setOpen(false);
                }}
              >
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-[#E2E5F4] text-[#FF8A5B]">
                  <Icon name={notificationIcon[n.kind] ?? "bell"} size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold leading-4 text-[#275992]">{n.title}</span>
                  <span className="mt-0.5 block text-[11px] text-[#6F789A]">
                    {n.body} · {timeAgo(n.created_at)}
                  </span>
                </span>
                {n.unread && <span className="mt-2 size-2 shrink-0 rounded-full bg-[#ef6b4a]" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AiInsightsPanel({ ai, loading, onRefresh }: { ai: InsightsResponse | null; loading: boolean; onRefresh: () => void }) {
  return (
    <section className="relative mb-5 overflow-hidden rounded-[20px] bg-[#E2E5F4] p-5 sm:p-6">
      <div className="absolute -bottom-20 -right-8 size-56 rounded-full border-[32px] border-[#9a6bff]/10" />
      <div className="relative">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#275992] text-white shadow-lg shadow-[#275992]/20">
              <Icon name="sparkles" size={20} />
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#275992]">AI insights · Gemini</p>
              {ai?.available && ai.insights ? (
                <h2 className="text-lg font-bold tracking-[-0.025em] text-[#275992]">{ai.insights.headline}</h2>
              ) : (
                <h2 className="text-lg font-bold tracking-[-0.025em] text-[#275992]">{loading ? "Reading your spending…" : "Insights aren't available yet"}</h2>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {ai?.available && ai.insights && (
              <span className="hidden rounded-full bg-white/70 px-2.5 py-1 text-[10px] font-bold text-[#4C6099] sm:block">{ai.insights.persona}</span>
            )}
            <button className="rounded-lg bg-white/70 px-3 py-1.5 text-[11px] font-bold text-[#275992] transition hover:bg-white disabled:opacity-50" disabled={loading} onClick={onRefresh}>
              {loading ? "Thinking…" : "Refresh"}
            </button>
          </div>
        </div>
        {loading && !ai && (
          <GeminiThinking steps={["Reading your transactions", "Totaling spending by category", "Comparing with last period", "Writing your insights"]} />
        )}
        {ai && !ai.available && !loading && <p className="text-xs text-[#6F789A]">{ai.reason}</p>}
        {ai?.available && ai.insights && (
          <div className="grid gap-4 sm:grid-cols-2">
            <ul className="space-y-2">
              {ai.insights.insights.map((text, i) => (
                <li className="flex gap-2 text-xs leading-5 text-[#6F789A]" key={i}>
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[#9a6bff]" />
                  {text}
                </li>
              ))}
            </ul>
            <div className="rounded-xl bg-white/70 p-3.5">
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[#275992]">Try this</p>
              <ul className="space-y-1.5">
                {ai.insights.tips.map((tip, i) => (
                  <li className="text-xs leading-5 text-[#6F789A]" key={i}>{tip}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// A shared proof link (/?proof=<token>) opens the public vault page, no login needed.
function Root() {
  const proof = new URLSearchParams(window.location.search).get("proof");
  return proof ? <ProofPage token={proof} /> : <App />;
}

export default Root;
