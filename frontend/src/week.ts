import { useCallback, useEffect, useState } from "react";
import { api, cached } from "./api";
import { useLive } from "./live";

// "Your week" (social.py GET /api/me/week): points, streak, budget left, next goal payment and
// the latest friend update. Shared by the header points pill, the sidebar and Home.

export type FeedItem = {
  id: string;
  kind: string;
  actor: { id: number | null; name: string; is_me: boolean };
  emoji: string;
  text: string;
  detail: string;
  created_at: string;
  reactions: { emoji: string; count: number; mine: boolean }[];
};
export type Week = {
  points: number;
  streak: number;
  total_points: number;
  days_left: number;
  budget: { limit: number; spent: number; left: number; used_pct: number | null } | null;
  next_payment: { goal_id: number; group_id: number; title: string; my_pct: number; due: string | null; amount: number | null } | null;
  latest_update: FeedItem | null;
};

const PATH = "/api/me/week";

export function useWeek() {
  const [week, setWeek] = useState<Week | null>(() => cached<Week>(PATH) ?? null);
  const load = useCallback(() => {
    api<Week>("GET", PATH).then(setWeek).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useLive(["money", "budget", "groups", "friends"], load);
  return week;
}

export const timeAgo = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
};
