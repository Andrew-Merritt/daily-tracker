import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recalculateFromDate } from "@/lib/recalculate";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { addDays } from "@/lib/dateUtils";

/**
 * Daily-log write path, shared by the web UI (/api/save-log) and the agent
 * tool layer (/api/ai/log, MCP logMetrics).
 *
 * Both callers get the same side effects: start_date backfill,
 * streak-notification reset, forward recalculation of dependent calculated
 * metrics, and achievement checks. Only metrics whose stored value actually
 * changes are written and run through those side effects.
 */

export type LogEntryInput = {
  metric_id: string;
  value: number | null;
  value_text?: string | null;
};

export type SaveLogResult = {
  upserted: number;
  deleted: number;
  recalculated: number;
  new_achievements: NewAchievement[];
};

type NewAchievement = {
  achievement_id: string;
  metric_id?: string;
  definition?: { name: string; icon: string };
};

function normalizeText(s: unknown): string | null {
  if (s == null) return null;
  const t = String(s);
  return t.trim() === "" ? null : t;
}

export async function saveLogEntries(
  db: SupabaseClient,
  ownerId: string,
  date: string,
  entries: LogEntryInput[]
): Promise<SaveLogResult> {
  const wantsRow = (e: LogEntryInput) => e.value !== null || normalizeText(e.value_text) !== null;

  // Compare against what's already stored so we only write (and run side
  // effects for) metrics that actually changed. The Today form sends every
  // metric on every save, so without this an edit to one field re-processes ~40.
  const { data: existingRows, error: existingErr } = await db
    .from("log")
    .select("metric_id, value, value_text")
    .eq("owner_id", ownerId)
    .eq("date", date);
  if (existingErr) throw new Error(existingErr.message);

  const existing = new Map(
    (existingRows ?? []).map((r: { metric_id: string; value: number | null; value_text: string | null }) => [
      r.metric_id,
      r,
    ])
  );

  const toUpsert = entries.filter((e) => {
    if (!wantsRow(e)) return false;
    const cur = existing.get(e.metric_id);
    if (!cur) return true;
    const curVal = cur.value == null ? null : Number(cur.value);
    return curVal !== e.value || normalizeText(cur.value_text) !== normalizeText(e.value_text);
  });

  // Entries with neither a number nor text are a clear instruction to remove
  // the row — only issue the delete for rows that exist.
  const toDelete = entries.filter((e) => !wantsRow(e) && existing.has(e.metric_id));

  await Promise.all([
    (async () => {
      if (toUpsert.length === 0) return;
      const { error } = await db.from("log").upsert(
        toUpsert.map((e) => ({
          owner_id: ownerId,
          date,
          metric_id: e.metric_id,
          value: e.value,
          value_text: normalizeText(e.value_text),
        })),
        { onConflict: "owner_id,date,metric_id" }
      );
      if (error) throw new Error(error.message);
    })(),
    (async () => {
      if (toDelete.length === 0) return;
      const { error } = await db
        .from("log")
        .delete()
        .eq("owner_id", ownerId)
        .eq("date", date)
        .in("metric_id", toDelete.map((e) => e.metric_id));
      if (error) throw new Error(error.message);
    })(),
  ]);

  // Reported counts describe what the caller asked for (values now stored /
  // cleared), not how many rows needed touching.
  const savedCount = entries.filter(wantsRow).length;
  const clearedCount = entries.length - savedCount;

  if (toUpsert.length === 0 && toDelete.length === 0) {
    return { upserted: savedCount, deleted: clearedCount, recalculated: 0, new_achievements: [] };
  }

  const metricIds = Array.from(new Set(toUpsert.map((e) => e.metric_id)));

  const [, , recalcResult, newAchievements] = await Promise.all([
    // Auto-populate start_date for metrics that don't have it yet
    (async () => {
      if (metricIds.length === 0) return;
      const { error } = await supabaseAdmin
        .from("config")
        .update({ start_date: date })
        .eq("owner_id", ownerId)
        .is("start_date", null)
        .in("metric_id", metricIds);
      if (error) throw new Error(error.message);
    })(),
    resetNegativeStreakAlerts(ownerId, metricIds),
    // Recalculate forward so formulas using prev() pick up today's values.
    recalculateFromDate(db, ownerId, date),
    checkAchievements(db, ownerId, date, metricIds),
  ]);

  if (recalcResult.errors.length > 0) {
    console.warn("Recalculation warnings:", recalcResult.errors);
  }

  return {
    upserted: savedCount,
    deleted: clearedCount,
    recalculated: recalcResult.daysProcessed,
    new_achievements: newAchievements,
  };
}

/**
 * Saving a value breaks a negative streak, so clear the notification state and
 * let the next cron run evaluate the new streak from scratch.
 */
async function resetNegativeStreakAlerts(ownerId: string, metricIds: string[]): Promise<void> {
  if (metricIds.length === 0) return;

  const { data: alertConfigs } = await supabaseAdmin
    .from("config")
    .select("metric_id, notification_config")
    .eq("owner_id", ownerId)
    .in("metric_id", metricIds)
    .not("notification_config", "is", null);

  await Promise.all(
    (alertConfigs ?? []).map(async (row) => {
      const alerts = row.notification_config?.streak_alerts;
      if (!(alerts?.enabled && alerts.last_streak_sign === "negative")) return;
      await supabaseAdmin
        .from("config")
        .update({
          notification_config: {
            ...row.notification_config,
            streak_alerts: {
              ...alerts,
              last_notified_threshold: null,
              last_streak_sign: null,
            },
          },
        })
        .eq("owner_id", ownerId)
        .eq("metric_id", row.metric_id);
    })
  );
}

const STREAK_ACHIEVEMENTS = [
  { id: "streak_7", threshold: 7 },
  { id: "streak_14", threshold: 14 },
  { id: "streak_30", threshold: 30 },
  { id: "streak_100", threshold: 100 },
  { id: "streak_365", threshold: 365 },
];

/**
 * Award streak achievements for the metrics just saved.
 *
 * Previously this called a `check-achievements` edge function (not in this
 * repo) once per metric and fell back to a per-metric query — ~2 sequential
 * round trips per metric on every save. Now: one query for all metrics' recent
 * history, streaks computed in memory, one upsert.
 *
 * Non-blocking by contract: never throws, worst case returns [].
 */
async function checkAchievements(
  db: SupabaseClient,
  ownerId: string,
  date: string,
  metricIds: string[]
): Promise<NewAchievement[]> {
  if (metricIds.length === 0) return [];

  try {
    const lookbackStart = addDays(date, -400);
    const logs = await fetchAllRows<{ date: string; metric_id: string }>((withCount) =>
      db
        .from("log")
        .select("date, metric_id", withCount ? { count: "exact" } : undefined)
        .eq("owner_id", ownerId)
        .in("metric_id", metricIds)
        .gte("date", lookbackStart)
        .not("value", "is", null)
        .order("date", { ascending: false })
        .order("metric_id", { ascending: true })
    );

    const datesByMetric = new Map<string, string[]>();
    for (const l of logs) {
      const list = datesByMetric.get(l.metric_id);
      if (list) list.push(l.date);
      else datesByMetric.set(l.metric_id, [l.date]);
    }

    const candidates: { owner_id: string; achievement_id: string; metric_id: string; value: { streak: number }; notified: boolean }[] = [];
    for (const metric_id of metricIds) {
      const dates = datesByMetric.get(metric_id) ?? []; // newest first
      if (dates.length < 7) continue;

      let streak = 1;
      for (let i = 1; i < dates.length; i++) {
        const diffDays = Math.round(
          (Date.parse(dates[i - 1] + "T00:00:00Z") - Date.parse(dates[i] + "T00:00:00Z")) / 86400000
        );
        if (diffDays === 1) streak++;
        else break;
      }

      for (const sa of STREAK_ACHIEVEMENTS) {
        if (streak < sa.threshold) continue;
        candidates.push({
          owner_id: ownerId,
          achievement_id: sa.id,
          metric_id,
          value: { streak },
          notified: false,
        });
      }
    }

    if (candidates.length === 0) return [];

    const { data } = await db
      .from("user_achievements")
      .upsert(candidates, { onConflict: "owner_id,achievement_id,metric_id", ignoreDuplicates: true })
      .select("achievement_id, metric_id");

    return (data ?? []).map((r: { achievement_id: string; metric_id: string | null }) => ({
      achievement_id: r.achievement_id,
      metric_id: r.metric_id ?? undefined,
    }));
  } catch (e) {
    console.warn("Achievement check failed (non-blocking):", e);
    return [];
  }
}
