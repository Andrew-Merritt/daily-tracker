import { NextResponse } from "next/server";
import { supabaseServerFromRequest } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/fetchAllRows";
import {
  analyzeDayOfWeek,
  analyzeRelationships,
  analyzeTrends,
  buildSeries,
  calcInputs,
  isNumericType,
  metricHigherIsBetter,
  trackedDaysFrom,
  type EngineMetric,
} from "@/lib/insights/engine";
import type {
  Metric,
  LogRow,
  CorrelationInsight,
  CheckboxCheckboxInsight,
  NumericNumericInsight,
  TimeLaggedInsight,
  DayOfWeekInsight,
  TrendInsight,
  HistogramInsight,
  CumulativeInsight,
  YearOverYearInsight,
  StreakTimelineInsight,
  CandlestickInsight,
  InsightsResponse,
} from "@/types/insights";

export async function GET(req: Request) {
  const supabase = supabaseServerFromRequest(req);

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const showPrivate = url.searchParams.get("showPrivate") === "true";

  const { data: metrics, error: configError } = await supabase
    .from("config")
    .select("metric_id, metric_name, type, private, is_calculated, calc_expr, analytics_config, start_date, required")
    .eq("owner_id", user.id)
    .eq("active", true);

  if (configError) {
    return NextResponse.json({ error: `Failed to load config: ${configError.message}` }, { status: 500 });
  }

  const allRawMetrics = (metrics ?? []) as Metric[];
  const privateMetricIds = new Set(allRawMetrics.filter((m) => m.private).map((m) => m.metric_id));
  const higherIsBetterMap = new Map<string, boolean>();
  for (const m of allRawMetrics) higherIsBetterMap.set(m.metric_id, metricHigherIsBetter(m.analytics_config));
  const allMetrics = allRawMetrics.filter((m) => showPrivate || !m.private);

  const checkboxMetrics = allMetrics.filter((m) => m.type === "checkbox");
  const numericMetrics = allMetrics.filter((m) => isNumericType(m.type));

  const empty: InsightsResponse = {
    checkboxNumeric: [],
    checkboxCheckbox: [],
    numericNumeric: [],
    timeLagged: [],
    dayOfWeek: [],
    trends: [],
    histograms: [],
    cumulative: [],
    yearOverYear: [],
    streakTimelines: [],
    candlesticks: [],
    totalDays: 0,
    dateRange: null,
  };
  if (allMetrics.length === 0) return NextResponse.json(empty);

  // Load every active metric's logs (private ones too: a required private
  // metric still marks a day as tracked). Pages are fetched in parallel.
  const activeIds = allRawMetrics.map((m) => m.metric_id);
  let logRows: LogRow[];
  try {
    logRows = await fetchAllRows<LogRow>((withCount) =>
      supabase
        .from("log")
        .select("metric_id, date, value", withCount ? { count: "exact" } : undefined)
        .eq("owner_id", user.id)
        .in("metric_id", activeIds)
        .order("date", { ascending: true })
        .order("metric_id", { ascending: true })
    );
  } catch (e) {
    return NextResponse.json({ error: `Failed to load logs: ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }

  // Raw per-metric maps for the descriptive sections below.
  const visibleIds = new Set(allMetrics.map((m) => m.metric_id));
  const byMetric = new Map<string, Map<string, number | null>>();
  const allDates = new Set<string>();
  for (const row of logRows) {
    if (!visibleIds.has(row.metric_id)) continue;
    allDates.add(row.date);
    let m = byMetric.get(row.metric_id);
    if (!m) byMetric.set(row.metric_id, (m = new Map()));
    m.set(row.date, row.value);
  }

  const sortedDates = Array.from(allDates).sort();
  const totalDays = sortedDates.length;
  const dateRange = totalDays > 0 ? { first: sortedDates[0], last: sortedDates[totalDays - 1] } : null;

  // ---------------------------------------------------------------------------
  // Relationships, weekday patterns and trends — see lib/insights/engine.ts
  // ---------------------------------------------------------------------------
  const engineMetrics: EngineMetric[] = allMetrics.map((m) => ({
    metric_id: m.metric_id,
    metric_name: m.metric_name || m.metric_id,
    type: m.type,
    private: !!m.private,
    higherIsBetter: higherIsBetterMap.get(m.metric_id) ?? true,
    trackedFrom: m.start_date ?? null,
  }));
  const requiredIds = new Set(allRawMetrics.filter((m) => m.required).map((m) => m.metric_id));
  const trackedDays = trackedDaysFrom(logRows, requiredIds);
  const series = buildSeries(engineMetrics, logRows, trackedDays);
  const inputs = calcInputs(allRawMetrics);

  const priv = (...ids: string[]) => ids.some((id) => privateMetricIds.has(id));
  const pctDiff = (a: number, b: number) =>
    b !== 0 ? ((a - b) / Math.abs(b)) * 100 : a > 0 ? 100 : a < 0 ? -100 : 0;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const r1 = (x: number) => Math.round(x * 10) / 10;

  const checkboxNumericInsights: CorrelationInsight[] = [];
  const timeLaggedInsights: TimeLaggedInsight[] = [];
  const checkboxCheckboxInsights: CheckboxCheckboxInsight[] = [];
  const numericNumericInsights: NumericNumericInsight[] = [];

  const { results: relationships, tested: testedPairs } = analyzeRelationships(engineMetrics, series, inputs);
  for (const r of relationships) {
    if (r.kind === "checkbox_numeric") {
      const pd = pctDiff(r.avgTrue, r.avgFalse);
      const common = {
        involvesPrivate: priv(r.trigger.metric_id, r.outcome.metric_id),
        direction: (r.avgTrue >= r.avgFalse ? "higher" : "lower") as "higher" | "lower",
        percentDiff: r1(pd),
        daysTrue: r.nTrue,
        daysFalse: r.nFalse,
        stats: r.stats,
      };
      if (r.lag === 0) {
        checkboxNumericInsights.push({
          type: "checkbox_numeric",
          id: `cn:${r.trigger.metric_id}:${r.outcome.metric_id}`,
          checkboxMetricId: r.trigger.metric_id,
          checkboxMetricName: r.trigger.metric_name,
          numericMetricId: r.outcome.metric_id,
          numericMetricName: r.outcome.metric_name,
          numericMetricType: r.outcome.type,
          avgWhenTrue: r2(r.avgTrue),
          avgWhenFalse: r2(r.avgFalse),
          numericHigherIsBetter: r.outcome.higherIsBetter,
          ...common,
        });
      } else {
        timeLaggedInsights.push({
          type: "time_lagged",
          // Lag-1 keeps the original id so earlier dismissals still apply.
          id: `tl:${r.trigger.metric_id}:${r.outcome.metric_id}${r.lag === 1 ? "" : `:${r.lag}`}`,
          lag: r.lag,
          triggerMetricId: r.trigger.metric_id,
          triggerMetricName: r.trigger.metric_name,
          outcomeMetricId: r.outcome.metric_id,
          outcomeMetricName: r.outcome.metric_name,
          outcomeMetricType: r.outcome.type,
          avgNextDayWhenTrue: r2(r.avgTrue),
          avgNextDayWhenFalse: r2(r.avgFalse),
          outcomeHigherIsBetter: r.outcome.higherIsBetter,
          ...common,
        });
      }
    } else if (r.kind === "checkbox_checkbox") {
      checkboxCheckboxInsights.push({
        type: "checkbox_checkbox",
        id: `cc:${r.a.metric_id}:${r.b.metric_id}`,
        metricAId: r.a.metric_id,
        metricAName: r.a.metric_name,
        metricBId: r.b.metric_id,
        metricBName: r.b.metric_name,
        rateWhenATrue: r1(r.rateTrue * 100),
        rateWhenAFalse: r1(r.rateFalse * 100),
        percentDiff: r1((r.rateTrue - r.rateFalse) * 100),
        daysATrue: r.nTrue,
        daysAFalse: r.nFalse,
        involvesPrivate: priv(r.a.metric_id, r.b.metric_id),
        stats: r.stats,
      });
    } else {
      numericNumericInsights.push({
        type: "numeric_numeric",
        id: `${r.lag === 0 ? "nn" : "nn1"}:${r.a.metric_id}:${r.b.metric_id}`,
        lag: r.lag,
        metricAId: r.a.metric_id,
        metricAName: r.a.metric_name,
        metricAType: r.a.type,
        metricBId: r.b.metric_id,
        metricBName: r.b.metric_name,
        metricBType: r.b.type,
        correlation: Math.round(r.stats.effect * 1000) / 1000,
        direction: r.stats.effect > 0 ? "positive" : "negative",
        daysOverlap: r.n,
        involvesPrivate: priv(r.a.metric_id, r.b.metric_id),
        metricAHigherIsBetter: r.a.higherIsBetter,
        metricBHigherIsBetter: r.b.higherIsBetter,
        stats: r.stats,
      });
    }
  }

  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayOfWeekInsights: DayOfWeekInsight[] = analyzeDayOfWeek(engineMetrics, series).map((d) => ({
    type: "day_of_week",
    id: `dow:${d.metric.metric_id}`,
    metricId: d.metric.metric_id,
    metricName: d.metric.metric_name,
    metricType: d.metric.type,
    bestDay: DAY_NAMES[d.best],
    worstDay: DAY_NAMES[d.worst],
    bestAvg: r2(d.dayAverages[d.best]),
    worstAvg: r2(d.dayAverages[d.worst]),
    overallAvg: r2(d.overall),
    dayAverages: DAY_NAMES.map((day, i) => ({ day, avg: r2(d.dayAverages[i]) })),
    involvesPrivate: priv(d.metric.metric_id),
    higherIsBetter: d.metric.higherIsBetter,
    q: d.q,
    evidence: d.evidence,
    score: d.score,
  }));

  const trendInsights: TrendInsight[] = dateRange
    ? analyzeTrends(engineMetrics, series, dateRange.last).map((t) => ({
        type: "trend",
        id: `tr:${t.metric.metric_id}`,
        metricId: t.metric.metric_id,
        metricName: t.metric.metric_name,
        metricType: t.metric.type,
        recentAvg: r2(t.recentAvg),
        priorAvg: r2(t.priorAvg),
        percentChange: r1(pctDiff(t.recentAvg, t.priorAvg)),
        direction: t.recentAvg >= t.priorAvg ? "up" : "down",
        recentDays: t.nRecent,
        priorDays: t.nPrior,
        involvesPrivate: priv(t.metric.metric_id),
        higherIsBetter: t.metric.higherIsBetter,
        stats: t.stats,
      }))
    : [];

  // 7) Histogram / Distribution
  const histogramInsights: HistogramInsight[] = [];

  for (const m of numericMetrics) {
    const mData = byMetric.get(m.metric_id);
    if (!mData) continue;

    const values: number[] = [];
    for (const date of sortedDates) {
      const val = mData.get(date);
      if (val != null) values.push(val);
    }

    if (values.length < 30) continue;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);

    histogramInsights.push({
      type: "histogram",
      id: `hi:${m.metric_id}`,
      metricId: m.metric_id,
      metricName: m.metric_name || m.metric_id,
      metricType: m.type,
      mean: Math.round(mean * 100) / 100,
      stdDev: Math.round(stdDev * 100) / 100,
      count: values.length,
      involvesPrivate: privateMetricIds.has(m.metric_id),
      higherIsBetter: higherIsBetterMap.get(m.metric_id) ?? true,
    });
  }

  // Sort by count desc
  histogramInsights.sort((a, b) => b.count - a.count);

  // 8) Cumulative / Running Total
  const cumulativeInsights: CumulativeInsight[] = [];

  for (const m of [...numericMetrics, ...checkboxMetrics.filter(() => false)]) {
    const mData = byMetric.get(m.metric_id);
    if (!mData) continue;

    const isCount = m.type === "count";
    const hib = higherIsBetterMap.get(m.metric_id) ?? true;

    // Count metrics always qualify; others need higher_is_better=true and >= 14 data points
    if (!isCount && (!hib || mData.size < 14)) continue;
    if (isCount && mData.size < 1) continue;
    if (!isCount && mData.size < 14) continue;

    let total = 0;
    let count = 0;
    for (const date of sortedDates) {
      const val = mData.get(date);
      if (val != null) {
        total += val;
        count++;
      }
    }

    if (count === 0) continue;

    // Calculate daily rate based on actual calendar span
    const firstDate = sortedDates.find((d) => mData.has(d));
    const lastDate = [...sortedDates].reverse().find((d) => mData.has(d));
    if (!firstDate || !lastDate) continue;

    const spanDays = Math.max(1,
      (new Date(lastDate + "T00:00:00").getTime() - new Date(firstDate + "T00:00:00").getTime()) / 86400000 + 1
    );
    const dailyRate = total / spanDays;

    // Project to year end
    const now = new Date();
    const yearEnd = new Date(now.getFullYear(), 11, 31);
    const daysRemaining = Math.max(0, (yearEnd.getTime() - now.getTime()) / 86400000);
    const projectedYearEnd = total + dailyRate * daysRemaining;

    cumulativeInsights.push({
      type: "cumulative",
      id: `cu:${m.metric_id}`,
      metricId: m.metric_id,
      metricName: m.metric_name || m.metric_id,
      metricType: m.type,
      currentTotal: Math.round(total * 100) / 100,
      dailyRate: Math.round(dailyRate * 100) / 100,
      projectedYearEnd: Math.round(projectedYearEnd),
      involvesPrivate: privateMetricIds.has(m.metric_id),
      higherIsBetter: hib,
    });
  }

  // Count metrics first, then by total desc
  cumulativeInsights.sort((a, b) => {
    if (a.metricType === "count" && b.metricType !== "count") return -1;
    if (a.metricType !== "count" && b.metricType === "count") return 1;
    return b.currentTotal - a.currentTotal;
  });

  // 9) Year-over-Year Comparison
  const yearOverYearInsights: YearOverYearInsight[] = [];

  for (const m of numericMetrics) {
    const mData = byMetric.get(m.metric_id);
    if (!mData) continue;

    // Group data by year
    const yearData = new Map<number, { sum: number; count: number }>();
    for (const date of sortedDates) {
      const val = mData.get(date);
      if (val == null) continue;
      const year = parseInt(date.slice(0, 4));
      const existing = yearData.get(year);
      if (existing) {
        existing.sum += val;
        existing.count++;
      } else {
        yearData.set(year, { sum: val, count: 1 });
      }
    }

    // Need >= 2 years with 60+ days each
    const qualifyingYears = Array.from(yearData.entries())
      .filter(([, d]) => d.count >= 60)
      .sort((a, b) => a[0] - b[0]);

    if (qualifyingYears.length < 2) continue;

    const currentYear = qualifyingYears[qualifyingYears.length - 1];
    const priorYear = qualifyingYears[qualifyingYears.length - 2];

    const currentAvg = currentYear[1].sum / currentYear[1].count;
    const priorAvg = priorYear[1].sum / priorYear[1].count;

    if (priorAvg === 0 && currentAvg === 0) continue;

    const percentChange =
      priorAvg !== 0
        ? ((currentAvg - priorAvg) / Math.abs(priorAvg)) * 100
        : currentAvg > 0
        ? 100
        : -100;

    yearOverYearInsights.push({
      type: "year_over_year",
      id: `yoy:${m.metric_id}`,
      metricId: m.metric_id,
      metricName: m.metric_name || m.metric_id,
      metricType: m.type,
      yearRange: `${qualifyingYears[0][0]}-${currentYear[0]}`,
      currentYearAvg: Math.round(currentAvg * 100) / 100,
      priorYearAvg: Math.round(priorAvg * 100) / 100,
      percentChange: Math.round(percentChange * 10) / 10,
      involvesPrivate: privateMetricIds.has(m.metric_id),
      higherIsBetter: higherIsBetterMap.get(m.metric_id) ?? true,
    });
  }

  // Sort by |percentChange| desc
  yearOverYearInsights.sort(
    (a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange)
  );

  // 10) Streak Timeline
  const streakTimelineInsights: StreakTimelineInsight[] = [];
  const allTrackableMetrics = [...checkboxMetrics, ...numericMetrics];

  for (const m of allTrackableMetrics) {
    const mData = byMetric.get(m.metric_id);
    if (!mData) continue;

    const isCheckbox = m.type === "checkbox";

    // Get sorted values for this metric
    const metricDates = sortedDates.filter((d) => mData.has(d));
    if (metricDates.length < 30) continue;

    // Determine threshold
    let threshold = 0;
    if (!isCheckbox) {
      const vals: number[] = [];
      for (const d of metricDates) {
        const v = mData.get(d);
        if (v != null) vals.push(v);
      }
      vals.sort((a, b) => a - b);
      threshold = vals[Math.floor(vals.length / 2)]; // median
    }

    // Build streaks
    let currentStreak = 0;
    let longestStreak = 0;
    let streakCount = 0;
    let totalStreakLength = 0;
    let inStreak = false;

    for (const date of metricDates) {
      const val = mData.get(date);
      const isActive = isCheckbox
        ? (val != null && val !== 0)
        : (val != null && val >= threshold);

      if (isActive) {
        if (!inStreak) {
          inStreak = true;
          currentStreak = 1;
        } else {
          currentStreak++;
        }
        if (currentStreak > longestStreak) longestStreak = currentStreak;
      } else {
        if (inStreak) {
          streakCount++;
          totalStreakLength += currentStreak;
          inStreak = false;
          currentStreak = 0;
        }
      }
    }
    // Handle final streak
    if (inStreak) {
      streakCount++;
      totalStreakLength += currentStreak;
    } else {
      currentStreak = 0;
    }

    // Need >= 3 completed streaks
    if (streakCount < 3) continue;

    const averageStreak = totalStreakLength / streakCount;

    streakTimelineInsights.push({
      type: "streak_timeline",
      id: `st:${m.metric_id}`,
      metricId: m.metric_id,
      metricName: m.metric_name || m.metric_id,
      metricType: m.type,
      currentStreak,
      longestStreak,
      averageStreak: Math.round(averageStreak * 10) / 10,
      isCheckbox,
      involvesPrivate: privateMetricIds.has(m.metric_id),
      higherIsBetter: higherIsBetterMap.get(m.metric_id) ?? true,
    });
  }

  // Sort by longest streak desc
  streakTimelineInsights.sort((a, b) => b.longestStreak - a.longestStreak);

  // 11) Candlestick Charts
  const candlestickInsights: CandlestickInsight[] = [];

  for (const m of numericMetrics) {
    const mData = byMetric.get(m.metric_id);
    if (!mData) continue;

    // Need >= 8 weeks of data
    const values: number[] = [];
    const metricDates = sortedDates.filter((d) => mData.has(d) && mData.get(d) != null);
    for (const d of metricDates) {
      values.push(mData.get(d)!);
    }

    if (metricDates.length < 56) continue; // ~8 weeks

    // Check coefficient of variation
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (mean === 0) continue;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / Math.abs(mean);

    if (cv <= 0.15) continue;

    // Get recent week's data for card display
    const recentDates = metricDates.slice(-7);
    const recentVals = recentDates.map((d) => mData.get(d)!);
    const recentRange = recentVals.length > 0
      ? Math.max(...recentVals) - Math.min(...recentVals)
      : 0;
    const recentClose = recentVals.length > 0 ? recentVals[recentVals.length - 1] : 0;

    candlestickInsights.push({
      type: "candlestick",
      id: `cs:${m.metric_id}`,
      metricId: m.metric_id,
      metricName: m.metric_name || m.metric_id,
      metricType: m.type,
      recentRange: Math.round(recentRange * 100) / 100,
      recentClose: Math.round(recentClose * 100) / 100,
      volatility: Math.round(cv * 1000) / 1000,
      involvesPrivate: privateMetricIds.has(m.metric_id),
      higherIsBetter: higherIsBetterMap.get(m.metric_id) ?? true,
    });
  }

  // Sort by volatility desc
  candlestickInsights.sort((a, b) => b.volatility - a.volatility);

  const response: InsightsResponse = {
    checkboxNumeric: checkboxNumericInsights.slice(0, 20),
    checkboxCheckbox: checkboxCheckboxInsights.slice(0, 10),
    numericNumeric: numericNumericInsights.slice(0, 15),
    timeLagged: timeLaggedInsights.slice(0, 15),
    dayOfWeek: dayOfWeekInsights.slice(0, 10),
    trends: trendInsights.slice(0, 10),
    histograms: histogramInsights.slice(0, 10),
    cumulative: cumulativeInsights.slice(0, 8),
    yearOverYear: yearOverYearInsights.slice(0, 8),
    streakTimelines: streakTimelineInsights.slice(0, 8),
    candlesticks: candlestickInsights.slice(0, 8),
    totalDays,
    dateRange,
    testedPairs,
  };

  return NextResponse.json(response);
}
