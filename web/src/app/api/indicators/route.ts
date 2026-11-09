import { NextResponse } from "next/server";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { supabaseServerFromRequest } from "@/lib/supabaseServer";
import { getLocalDateString, addDays, getServerTimezone } from "@/lib/dateUtils";
import { calculateAllGoalProgress, Goal, GoalProgress } from "@/lib/goals";

type TrendData = {
  direction: "up" | "down" | "flat";
  current_avg: number;
  previous_avg: number;
  change_pct: number;
  period_days: number;
};

type StreakData = {
  // Streak as of yesterday (before today's potential log)
  // Positive = consecutive days with value, Negative = consecutive days without
  yesterday: number;
  // Whether reference date has a logged value
  logged_today: boolean;
  // Current streak (including today if logged)
  current: number;
  // Pre-log days to add to display (for lifetime streaks)
  seed: number;
};

type GoalIndicator = {
  goal_id: string;
  name: string;
  progress_pct: number;
  status: "on_track" | "at_risk" | "met" | "missed" | "not_started";
  current: number;
  target: number;
  frequency: "daily" | "weekly" | "monthly";
};

type MetricIndicators = {
  trend?: TrendData;
  streak?: StreakData;
  goals?: GoalIndicator[];
};

type IndicatorsResponse = {
  generated_at: string;
  reference_date: string;
  metrics: Record<string, MetricIndicators>;
};

type MetricConfig = {
  metric_id: string;
  type: string;
  analytics_config: Record<string, unknown> | null;
  goals_config: { goals?: Goal[] } | null;
  start_date: string | null;
  is_calculated: boolean;
};

// Default trend period (days)
const DEFAULT_TREND_PERIOD = 7;

// Threshold for considering a change "flat" (within +/- 5%)
const FLAT_THRESHOLD = 0.05;

export async function GET(req: Request) {
  const supabase = supabaseServerFromRequest(req);

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const tz = await getServerTimezone();

  // Parse query params
  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date");
  const referenceDate = dateParam || getLocalDateString(new Date(), tz);

  // 1) Get all active metrics for this user (including calculated for goals)
  const { data: metrics, error: configError } = await supabase
    .from("config")
    .select("metric_id, type, analytics_config, goals_config, start_date, is_calculated")
    .eq("owner_id", user.id)
    .eq("active", true);

  if (configError) {
    return NextResponse.json(
      { error: `Failed to load config: ${configError.message}` },
      { status: 500 }
    );
  }

  const allMetrics: MetricConfig[] = (metrics ?? []) as MetricConfig[];
  if (allMetrics.length === 0) {
    const empty: IndicatorsResponse = {
      generated_at: new Date().toISOString(),
      reference_date: referenceDate,
      metrics: {},
    };
    return NextResponse.json(empty);
  }

  // Separate metrics for different calculations
  // Note: count type excluded from trend - it shows checkbox-like frequency stats instead
  const numericMetrics = allMetrics.filter((m) =>
    ["number", "score", "time", "hhmm"].includes(m.type)
  );
  // All non-text metrics can have streaks
  const streakEligibleMetrics = allMetrics.filter((m) => m.type !== "text");

  // Separate lifetime vs regular streak metrics
  const lifetimeMetrics = streakEligibleMetrics.filter((m) => {
    const config = (m.analytics_config as Record<string, unknown>) || {};
    return config.lifetime_streak === true;
  });
  const regularMetrics = streakEligibleMetrics.filter((m) => {
    const config = (m.analytics_config as Record<string, unknown>) || {};
    return config.lifetime_streak !== true;
  });

  // Calculate date ranges
  const trendPeriod = DEFAULT_TREND_PERIOD * 2 + 1;
  const streakPeriod = 365;

  const regularMetricIds = regularMetrics.map((m) => m.metric_id);
  const lifetimeMetricIds = lifetimeMetrics.map((m) => m.metric_id);

  type LogRow = { metric_id: string; date: string; value: number | null };
  const byMetric = new Map<string, LogRow[]>();

  const userId = user.id;

  // Helper to load logs with pagination
  async function loadLogs(metricIds: string[], startDate: string | null) {
    if (metricIds.length === 0) return;

    // Pages fetched in parallel; metric_id tiebreaker keeps offset paging stable.
    const logs = await fetchAllRows<LogRow>(
      (withCount) => {
        let query = supabase
          .from("log")
          .select("metric_id, date, value", withCount ? { count: "exact" } : undefined)
          .eq("owner_id", userId)
          .in("metric_id", metricIds)
          .lte("date", referenceDate)
          .order("date", { ascending: true })
          .order("metric_id", { ascending: true });
        // Only apply start date filter if provided (not lifetime)
        if (startDate) query = query.gte("date", startDate);
        return query;
      },
      { maxRows: 100_000 }
    );

    for (const row of logs) {
      if (!byMetric.has(row.metric_id)) byMetric.set(row.metric_id, []);
      byMetric.get(row.metric_id)!.push(row);
    }
  }

  // 2a) Load logs for regular metrics (365-day lookback)
  try {
    const streakStartDate = addDays(referenceDate, -streakPeriod);
    await loadLogs(regularMetricIds, streakStartDate);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }

  // 2b) Load ALL logs for lifetime metrics (no date limit)
  try {
    await loadLogs(lifetimeMetricIds, null);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }

  // 2c) Load logs for metrics with goals that haven't been loaded yet
  const metricsWithGoals = allMetrics.filter((m) => {
    const goalsConfig = m.goals_config as { goals?: unknown[] } | null;
    return goalsConfig?.goals && goalsConfig.goals.length > 0;
  });
  const goalMetricIds = metricsWithGoals
    .map((m) => m.metric_id)
    .filter((id) => !byMetric.has(id)); // Only load if not already loaded

  if (goalMetricIds.length > 0) {
    try {
      // Load 90 days for goals (covers monthly periods)
      const goalStartDate = addDays(referenceDate, -90);
      await loadLogs(goalMetricIds, goalStartDate);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  // 3) Calculate indicators for each metric
  const result: Record<string, MetricIndicators> = {};

  // Streaks for all eligible metrics
  for (const m of streakEligibleMetrics) {
    const analyticsConfig = (m.analytics_config as Record<string, unknown>) || {};

    // Check if streaks are enabled
    const showStreak = analyticsConfig.show_streak ??
      (analyticsConfig.hide_streak === true ? false : true);
    if (!showStreak) continue;

    const rows = byMetric.get(m.metric_id) ?? [];
    const streak = calculateStreak(rows, referenceDate, m.start_date, m.type);

    // Add streak_seed for lifetime metrics
    const seed = (analyticsConfig.streak_seed as number) ?? 0;
    streak.seed = seed;

    if (!result[m.metric_id]) result[m.metric_id] = {};
    result[m.metric_id].streak = streak;
  }

  // Trends for numeric metrics
  for (const m of numericMetrics) {
    const analyticsConfig = (m.analytics_config as Record<string, unknown>) || {};
    if (analyticsConfig.hide_trend) continue;

    const rows = byMetric.get(m.metric_id) ?? [];
    const period = (analyticsConfig.trend_period as number) || DEFAULT_TREND_PERIOD;
    const trend = calculateTrend(rows, referenceDate, period);

    if (trend) {
      if (!result[m.metric_id]) result[m.metric_id] = {};
      result[m.metric_id].trend = trend;
    }
  }

  // Goals for metrics with goals_config
  for (const m of allMetrics) {
    const goalsConfig = m.goals_config as { goals?: Goal[] } | null;
    if (!goalsConfig?.goals || goalsConfig.goals.length === 0) continue;

    const rows = byMetric.get(m.metric_id) ?? [];
    // Determine if today is logged (from streak data if available)
    const todayLogged = result[m.metric_id]?.streak?.logged_today ??
      rows.some(r => r.date === referenceDate && r.value != null);

    const goalProgressList = calculateAllGoalProgress(
      goalsConfig.goals,
      rows,
      referenceDate,
      todayLogged
    );

    if (goalProgressList.length > 0) {
      if (!result[m.metric_id]) result[m.metric_id] = {};
      result[m.metric_id].goals = goalProgressList.map((gp: GoalProgress) => ({
        goal_id: gp.goal_id,
        name: gp.name,
        progress_pct: gp.progress_pct,
        status: gp.status,
        current: gp.current,
        target: gp.target,
        frequency: gp.frequency,
      }));
    }
  }

  const response: IndicatorsResponse = {
    generated_at: new Date().toISOString(),
    reference_date: referenceDate,
    metrics: result,
  };

  return NextResponse.json(response);
}

/**
 * Calculate streak for any metric type
 * Returns symmetric +N/-N values:
 * - Positive: N consecutive days WITH a logged value
 * - Negative: N consecutive days WITHOUT a logged value
 *
 * For checkbox: only truthy values (>= 0.5) count
 * For count: only non-zero values count
 * For other types: any non-null value counts
 *
 * Returns both yesterday's streak (for muted display) and current streak (if today is logged)
 */
function calculateStreak(
  rows: { date: string; value: number | null }[],
  referenceDate: string,
  startDate?: string | null,
  metricType?: string
): StreakData {
  // Build set of "logged" dates based on metric type
  const loggedDates = new Set<string>();
  for (const r of rows) {
    if (r.value === null) continue;

    if (metricType === "checkbox") {
      // For checkbox, only truthy values count
      if (r.value >= 0.5) {
        loggedDates.add(r.date);
      }
    } else if (metricType === "count") {
      // For count, only non-zero values count
      const num = Number(r.value);
      if (!isNaN(num) && num !== 0) {
        loggedDates.add(r.date);
      }
    } else {
      // For number/score/time/hhmm, any non-null value counts
      loggedDates.add(r.date);
    }
  }

  const yesterday = addDays(referenceDate, -1);
  const loggedToday = loggedDates.has(referenceDate);

  // Determine earliest date to consider (don't count negative streaks before metric existed)
  const earliestLog = rows.length > 0
    ? rows.reduce((min, r) => (r.date < min ? r.date : min), referenceDate)
    : referenceDate;
  const earliestDate = startDate && startDate < earliestLog ? startDate : earliestLog;

  // Calculate yesterday's streak by walking backwards from yesterday
  const yesterdayStreak = calculateStreakValue(loggedDates, yesterday, earliestDate);

  // Calculate current streak (including today)
  let currentStreak: number;
  if (loggedToday) {
    // Today is logged - continue or start positive streak
    if (yesterdayStreak >= 0) {
      // Was positive or zero, add one
      currentStreak = yesterdayStreak + 1;
    } else {
      // Was negative, broke the negative streak, start fresh at +1
      currentStreak = 1;
    }
  } else {
    // Today is not logged - continue or start negative streak
    if (yesterdayStreak > 0) {
      // Was positive, just broke it - go to -1
      currentStreak = -1;
    } else if (yesterdayStreak < 0) {
      // Was negative, continue
      currentStreak = yesterdayStreak - 1;
    } else {
      // Was zero (edge case), start negative
      currentStreak = -1;
    }
  }

  return {
    yesterday: yesterdayStreak,
    logged_today: loggedToday,
    current: currentStreak,
    seed: 0, // Will be set by caller based on analytics_config
  };
}

/**
 * Calculate the streak value ending at a specific date
 * Walk backwards counting consecutive same-state days
 */
function calculateStreakValue(
  loggedDates: Set<string>,
  endDate: string,
  earliestDate: string
): number {
  if (endDate < earliestDate) {
    return 0;
  }

  const endDateLogged = loggedDates.has(endDate);
  let count = 0;
  let checkDate = endDate;

  if (endDateLogged) {
    // Count consecutive logged days
    while (checkDate >= earliestDate && loggedDates.has(checkDate)) {
      count++;
      checkDate = addDays(checkDate, -1);
    }
    return count; // Positive
  } else {
    // Count consecutive not-logged days
    while (checkDate >= earliestDate && !loggedDates.has(checkDate)) {
      count++;
      checkDate = addDays(checkDate, -1);
    }
    return -count; // Negative
  }
}

/**
 * Calculate trend for a numeric metric
 * Compares average of current period to average of previous period
 */
function calculateTrend(
  rows: { date: string; value: number | null }[],
  referenceDate: string,
  periodDays: number
): TrendData | null {
  // Current period: (referenceDate - periodDays + 1) to referenceDate
  const currentPeriodStart = addDays(referenceDate, -(periodDays - 1));

  // Previous period: before current period
  const previousPeriodEnd = addDays(currentPeriodStart, -1);
  const previousPeriodStart = addDays(previousPeriodEnd, -(periodDays - 1));

  // Filter rows for each period
  const currentPeriodValues: number[] = [];
  const previousPeriodValues: number[] = [];

  for (const r of rows) {
    if (r.value === null) continue;

    if (r.date >= currentPeriodStart && r.date <= referenceDate) {
      currentPeriodValues.push(r.value);
    } else if (r.date >= previousPeriodStart && r.date <= previousPeriodEnd) {
      previousPeriodValues.push(r.value);
    }
  }

  // Need at least one value in current period to show a trend
  if (currentPeriodValues.length === 0) {
    return null;
  }

  // Calculate averages
  const currentAvg =
    currentPeriodValues.reduce((a, b) => a + b, 0) / currentPeriodValues.length;

  // If no previous data, show flat trend with no percentage
  if (previousPeriodValues.length === 0) {
    return {
      direction: "flat",
      current_avg: currentAvg,
      previous_avg: currentAvg,
      change_pct: 0,
      period_days: periodDays,
    };
  }

  const previousAvg =
    previousPeriodValues.reduce((a, b) => a + b, 0) / previousPeriodValues.length;

  // Calculate percentage change
  let changePct = 0;
  if (previousAvg !== 0) {
    changePct = (currentAvg - previousAvg) / Math.abs(previousAvg);
  } else if (currentAvg !== 0) {
    // Previous was 0, current is not - infinite increase, cap at 100%
    changePct = 1;
  }

  // Determine direction
  let direction: "up" | "down" | "flat";
  if (Math.abs(changePct) <= FLAT_THRESHOLD) {
    direction = "flat";
  } else if (changePct > 0) {
    direction = "up";
  } else {
    direction = "down";
  }

  return {
    direction,
    current_avg: currentAvg,
    previous_avg: previousAvg,
    change_pct: changePct,
    period_days: periodDays,
  };
}
