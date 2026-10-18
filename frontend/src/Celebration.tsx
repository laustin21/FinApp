import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useLive } from "./live";

// "Goal reached!" celebration (groups.py: /api/me/celebrations). When a group goal
// hits its target, every member gets a confetti screen the next time the app is open,
// wherever they are, and it shows once per person. The bell also gets a notification.

type Celebration = {
  goal_id: number;
  title: string;
  group_name: string;
  target: number;
  saved: number;
  contributors: { name: string; saved: number }[];
};

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const COLORS = ["#FF8A5B", "#95A1D8", "#275992", "#209E86", "#FFCC57", "#9A6BFF"];

function Confetti() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      c.width = window.innerWidth * dpr;
      c.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const w = () => window.innerWidth;
    // Two bursts from the bottom corners, plus a gentle rain from the top.
    const pieces = Array.from({ length: 220 }, (_, i) => {
      const burst = i < 140;
      const left = i % 2 === 0;
      return {
        x: burst ? (left ? 0 : w()) : Math.random() * w(),
        y: burst ? window.innerHeight * 0.85 : -20 - Math.random() * window.innerHeight * 0.6,
        vx: burst ? (left ? 1 : -1) * (4 + Math.random() * 9) : (Math.random() - 0.5) * 2,
        vy: burst ? -(11 + Math.random() * 10) : 2 + Math.random() * 3,
        size: 6 + Math.random() * 7,
        rot: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.3,
        color: COLORS[i % COLORS.length],
        round: Math.random() < 0.3,
      };
    });
    const start = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      const t = now - start;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.globalAlpha = t > 4200 ? Math.max(0, 1 - (t - 4200) / 1300) : 1;
      for (const p of pieces) {
        p.vy += 0.25;          // gravity
        p.vx *= 0.99;          // air
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.spin;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2.5, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        }
        ctx.restore();
      }
      if (t < 5500) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);
  return <canvas aria-hidden="true" className="pointer-events-none fixed inset-0 z-[61] h-full w-full" ref={canvas} />;
}

/** Mounted once for the logged-in app. Shows any goal celebrations you haven't seen yet. */
export function GoalCelebrations({ onViewGroups }: { onViewGroups: () => void }) {
  const [queue, setQueue] = useState<Celebration[]>([]);
  const load = useCallback(() => {
    api<Celebration[]>("GET", "/api/me/celebrations").then(setQueue).catch(() => {});
  }, []);
  useEffect(load, [load]);
  // Someone else's contribution finished the goal: celebrate within ~2 s.
  useLive(["groups"], load);

  const current = queue[0];
  if (!current) return null;

  const done = (then?: () => void) => {
    setQueue((q) => q.slice(1));
    api("POST", `/api/goals/${current.goal_id}/celebrated`).catch(() => {});
    then?.();
  };

  return (
    <>
      <Confetti key={current.goal_id} />
      <div aria-labelledby="celebrate-title" aria-modal="true" className="fixed inset-0 z-[60] grid place-items-center bg-[#275992]/40 px-4 backdrop-blur-[2px]" role="dialog">
        <div className="w-full max-w-[420px] rounded-[24px] border border-[#DADDF1] bg-[#FFFDF7] p-7 text-center shadow-2xl sm:p-8">
          <div className="mx-auto grid size-16 place-items-center rounded-full bg-[#FFF0E2] text-3xl">🎉</div>
          <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.14em] text-[#FF8A5B]">Goal reached · {current.group_name}</p>
          <h2 className="mt-1 text-[26px] font-bold tracking-[-0.04em] text-[#275992]" id="celebrate-title">
            {current.title}
          </h2>
          <p className="mt-1 text-sm text-[#6F789A]">
            Your group saved <strong className="text-[#275992]">{money(current.saved)}</strong> of {money(current.target)}. You did it together.
          </p>

          {current.contributors.length > 0 && (
            <div className="mt-5 rounded-2xl bg-[#F4F5FB] p-4 text-left">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#6F789A]">Who chipped in</p>
              {current.contributors.map((p) => (
                <div className="flex items-center justify-between py-1 text-xs" key={p.name}>
                  <span className="font-semibold text-[#275992]">{p.name}</span>
                  <span className="font-bold">{money(p.saved)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <button autoFocus className="rounded-xl bg-[#275992] px-6 py-3 text-sm font-bold text-white transition hover:bg-[#1F4777]" onClick={() => done()} type="button">
              Woohoo!
            </button>
            <button className="rounded-xl border border-[#DADDF1] bg-white px-6 py-3 text-sm font-bold text-[#275992] transition hover:bg-[#E2E5F4]" onClick={() => done(onViewGroups)} type="button">
              See the group
            </button>
          </div>
          {queue.length > 1 && <p className="mt-3 text-[10px] text-[#8790AE]">+{queue.length - 1} more goal{queue.length > 2 ? "s" : ""} reached</p>}
        </div>
      </div>
    </>
  );
}
