import { NextResponse } from "next/server";
import { supabaseServerFromRequest } from "@/lib/supabaseServer";
import { getLocalDateString, getServerTimezone } from "@/lib/dateUtils";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { buildSeries, metricHigherIsBetter, pairPoints, trackedDaysFrom, type EngineMetric } from "@/lib/insights/engine";
import { demeanByStratum, pearson } from "@/lib/insights/stats";

type LogRow = {
  metric_id: string;
  date: string;
  value: number | null;
};

type MetricConfig = {
  metric_id: string;
  metric_name: string | null;
  type: string;
  analytics_config: { higher_is_better?: boolean; direction?: string } | null;
  start_date?: string | null;
};

const RELATIONSHIP_TYPES = new Set(["numeric_numeric", "checkbox_numeric", "time_lagged", "checkbox_checkbox"]);

const avg = (xs: number[]) => (xs.length > 0 ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : 0);

/** Detail payloads for the four relationship insights (same shapes the sheet expects). */
function relationshipDetail(
  type: string,
  lag: number,
  a: EngineMetric,
  b: EngineMetric,
  pts: { date: string; a: number; b: number }[]
) {
  if (type === "numeric_numeric") {
    // Same weekday-adjusted (partial) correlation as the feed card.
    const strata = pts.map((p) => new Date(`${p.date}T00:00:00`).getDay());
    const r = pearson(demeanByStratum(pts.map((p) => p.a), strata), demeanByStratum(pts.map((p) => p.b), strata));
    return NextResponse.json({
      points: pts.map((p) => ({ date: p.date, valueA: p.a, valueB: p.b })),
      metricAName: a.metric_name,
      metricBName: b.metric_name,
      correlation: Number.isFinite(r) ? Math.round(r * 1000) / 1000 : 0,
      metricAHigherIsBetter: a.higherIsBetter,
      metricBHigherIsBetter: b.higherIsBetter,
      lag,
    });
  }
  if (type === "checkbox_checkbox") {
    const t = pts.filter((p) => p.a === 1);
    const f = pts.filter((p) => p.a === 0);
    const rate = (xs: typeof pts) => (xs.length > 0 ? Math.round((xs.filter((p) => p.b === 1).length / xs.length) * 1000) / 10 : 0);
    return NextResponse.json({
      rateWhenATrue: rate(t),
      rateWhenAFalse: rate(f),
      daysATrue: t.length,
      daysAFalse: f.length,
      dailyData: pts.map((p) => ({ date: p.date, a: p.a === 1, b: p.b === 1 })),
      metricAName: a.metric_name,
      metricBName: b.metric_name,
    });
  }
  const whenTrue = pts.filter((p) => p.a === 1).map((p) => p.b);
  const whenFalse = pts.filter((p) => p.a === 0).map((p) => p.b);
  if (type === "time_lagged") {
    return NextResponse.json({
      avgNextDayWhenTrue: avg(whenTrue),
      avgNextDayWhenFalse: avg(whenFalse),
      daysTrue: whenTrue.length,
      daysFalse: whenFalse.length,
      distribution: pts.map((p) => ({ date: p.date, nextDayValue: p.b, checkedToday: p.a === 1 })),
      triggerName: a.metric_name,
      outcomeName: b.metric_name,
      outcomeHigherIsBetter: b.higherIsBetter,
      lag,
    });
  }
  return NextResponse.json({
    avgWhenTrue: avg(whenTrue),
    avgWhenFalse: avg(whenFalse),
    daysTrue: whenTrue.length,
    daysFalse: whenFalse.length,
    distribution: pts.map((p) => ({ date: p.date, value: p.b, checked: p.a === 1 })),
    checkboxName: a.metric_name,
    numericName: b.metric_name,
    numericHigherIsBetter: b.higherIsBetter,
  });
}

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
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const metricsParam = url.searchParams.get("metrics");
  const range = url.searchParams.get("range") || "all";

  if (!type || !metricsParam) {
    return NextResponse.json(
      { error: "Missing type or metrics parameter" },
      { status: 400 }
    );
  }

  const metricIds = metricsParam.split(",").filter(Boolean);
  if (metricIds.length === 0 || metricIds.length > 2) {
    return NextResponse.json(
      { error: "Must provide 1 or 2 metric IDs" },
      { status: 400 }
    );
  }

  // Validate metrics belong to user and get config
  const { data: configs, error: configError } = await supabase
    .from("config")
    .select("metric_id, metric_name, type, analytics_config, start_date")
    .eq("owner_id", user.id)
    .in("metric_id", metricIds);

  if (configError) {
    return NextResponse.json(
      { error: `Failed to load config: ${configError.message}` },
      { status: 500 }
    );
  }

  const metricConfigs = (configs ?? []) as MetricConfig[];
  if (metricConfigs.length !== metricIds.length) {
    return NextResponse.json(
      { error: "One or more metrics not found" },
      { status: 404 }
    );
  }

  const configMap = new Map<string, MetricConfig>();
  for (const c of metricConfigs) {
    configMap.set(c.metric_id, c);
  }

  // Calculate date cutoff based on range
  let dateFilter: string | null = null;
  if (range !== "all") {
    const now = new Date();
    const days = range === "30d" ? 30 : range === "90d" ? 90 : range === "1y" ? 365 : 0;
    if (days > 0) {
      now.setDate(now.getDate() - days);
      dateFilter = getLocalDateString(now, tz);
    }
  }

  // Fetch logs for these specific metrics only
  const allLogs: LogRow[] = [];
  const PAGE_SIZE = 1000;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from("log")
      .select("metric_id, date, value")
      .eq("owner_id", user.id)
      .in("metric_id", metricIds)
      .order("date", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (dateFilter) {
      query = query.gte("date", dateFilter);
    }

    const { data: logs, error: logError } = await query;

    if (logError) {
      return NextResponse.json(
        { error: `Failed to load logs: ${logError.message}` },
        { status: 500 }
      );
    }

    const rows = (logs ?? []) as LogRow[];
    allLogs.push(...rows);
    hasMore = rows.length === PAGE_SIZE;
    offset += PAGE_SIZE;
    if (offset > 500000) break;
  }

  // Build per-metric date->value maps
  const byMetric = new Map<string, Map<string, number | null>>();
  const allDates = new Set<string>();

  for (const row of allLogs) {
    if (!byMetric.has(row.metric_id)) {
      byMetric.set(row.metric_id, new Map());
    }
    byMetric.get(row.metric_id)!.set(row.date, row.value);
    allDates.add(row.date);
  }

  const sortedDates = Array.from(allDates).sort();

  // Relationship types share the Insights engine so the sheet matches the card
  // (tracked days, checkbox "not done" handling, lags).
  if (RELATIONSHIP_TYPES.has(type) && metricIds.length === 2) {
    const lag = Math.max(0, Math.min(2, parseInt(url.searchParams.get("lag") || "", 10) || (type === "time_lagged" ? 1 : 0)));
    try {
      const { data: req } = await supabase
        .from("config")
        .select("metric_id")
        .eq("owner_id", user.id)
        .eq("active", true)
        .eq("required", true);
      const requiredIds = new Set<string>((req ?? []).map((r: { metric_id: string }) => r.metric_id));
      const loadIds = [...new Set([...metricIds, ...requiredIds])];
      const rows = await fetchAllRows<LogRow>((withCount) =>
        supabase
          .from("log")
          .select("metric_id, date, value", withCount ? { count: "exact" } : undefined)
          .eq("owner_id", user.id)
          .in("metric_id", loadIds)
          .order("date", { ascending: true })
          .order("metric_id", { ascending: true })
      );
      const engineMetrics: EngineMetric[] = metricIds.map((id) => {
        const c = configMap.get(id)!;
        return {
          metric_id: id,
          metric_name: c.metric_name || id,
          type: c.type,
          private: false,
          higherIsBetter: metricHigherIsBetter(c.analytics_config),
          trackedFrom: c.start_date ?? null,
        };
      });
      const series = buildSeries(engineMetrics, rows, trackedDaysFrom(rows, requiredIds));
      const [a, b] = engineMetrics;
      const pts = pairPoints(series.get(a.metric_id) ?? new Map(), series.get(b.metric_id) ?? new Map(), lag);
      return relationshipDetail(type, lag, a, b, pts);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  switch (type) {
    case "trend":
      return handleTrend(metricIds[0], configMap, byMetric, sortedDates);
    case "day_of_week":
      return handleDayOfWeek(metricIds[0], configMap, byMetric, sortedDates, dateFilter);
    case "histogram":
      return handleHistogram(metricIds[0], configMap, byMetric, sortedDates);
    case "cumulative":
      return handleCumulative(metricIds[0], configMap, byMetric, sortedDates);
    case "year_over_year":
      return handleYearOverYear(metricIds[0], configMap, byMetric, sortedDates);
    case "streak_timeline":
      return handleStreakTimeline(metricIds[0], configMap, byMetric, sortedDates);
    case "candlestick":
      return handleCandlestick(metricIds[0], configMap, byMetric, sortedDates, url.searchParams.get("period") || "weekly");
    default:
      return NextResponse.json({ error: "Unknown insight type" }, { status: 400 });
  }
}

function handleTrend(
  metricId: string,
  configMap: Map<string, MetricConfig>,
  byMetric: Map<string, Map<string, number | null>>,
  sortedDates: string[]
) {
  const data = byMetric.get(metricId);
  const cfg = configMap.get(metricId)!;
  const metricType = cfg.type;

  const points: { date: string; value: number }[] = [];
  let total = 0;

  if (metricType === "count" && sortedDates.length > 0) {
    const start = new Date(sortedDates[0] + "T00:00:00");
    const end = new Date(sortedDates[sortedDates.length - 1] + "T00:00:00");
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      const val = data?.get(ds) ?? 0;
      points.push({ date: ds, value: val });
      total += val;
    }
  } else {
    for (const date of sortedDates) {
      const val = data?.get(date);
      if (val != null) {
        points.push({ date, value: val });
        total += val;
      }
    }
  }

  const overallAvg = points.length > 0 ? Math.round((total / points.length) * 100) / 100 : 0;

  return NextResponse.json({
    points,
    metricName: cfg.metric_name || metricId,
    metricType: cfg.type,
    overallAvg,
    higherIsBetter: metricHigherIsBetter(cfg.analytics_config),
  });
}

function handleDayOfWeek(
  metricId: string,
  configMap: Map<string, MetricConfig>,
  byMetric: Map<string, Map<string, number | null>>,
  sortedDates: string[],
  dateFilter: string | null
) {
  const data = byMetric.get(metricId);
  const cfg = configMap.get(metricId)!;

  const DAY_NAMES = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  ];

  const byDay: number[][] = [[], [], [], [], [], [], []];
  const dailyValues: { date: string; value: number }[] = [];

  for (const date of sortedDates) {
    if (dateFilter && date < dateFilter) continue;
    const val = data?.get(date);
    if (val != null) {
      const dow = new Date(date + "T00:00:00").getDay();
      byDay[dow].push(val);
      dailyValues.push({ date, value: val });
    }
  }

  const allVals = byDay.flat();
  const overallAvg = allVals.length > 0
    ? Math.round((allVals.reduce((a, b) => a + b, 0) / allVals.length) * 100) / 100
    : 0;

  const dayAverages = DAY_NAMES.map((name, i) => ({
    day: name,
    avg: byDay[i].length > 0
      ? Math.round((byDay[i].reduce((a, b) => a + b, 0) / byDay[i].length) * 100) / 100
      : 0,
    total: Math.round(byDay[i].reduce((a, b) => a + b, 0) * 100) / 100,
    count: byDay[i].length,
  }));

  return NextResponse.json({
    dayAverages,
    dailyValues,
    metricName: cfg.metric_name || metricId,
    metricType: cfg.type,
    overallAvg,
    higherIsBetter: metricHigherIsBetter(cfg.analytics_config),
  });
}

function handleHistogram(
  metricId: string,
  configMap: Map<string, MetricConfig>,
  byMetric: Map<string, Map<string, number | null>>,
  sortedDates: string[]
) {
  const data = byMetric.get(metricId);
  const cfg = configMap.get(metricId)!;

  const values: number[] = [];
  for (const date of sortedDates) {
    const val = data?.get(date);
    if (val != null) values.push(val);
  }

  if (values.length === 0) {
    return NextResponse.json({ bins: [], stats: null, metricName: cfg.metric_name || metricId, metricType: cfg.type, higherIsBetter: metricHigherIsBetter(cfg.analytics_config) });
  }

  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const p25 = sorted[Math.floor(n * 0.25)];
  const p75 = sorted[Math.floor(n * 0.75)];

  // Skewness
  const skewness = n > 2
    ? (values.reduce((a, b) => a + ((b - mean) / (stdDev || 1)) ** 3, 0) * n) / ((n - 1) * (n - 2))
    : 0;

  // Sturges' rule for bin count, capped at 15
  let binCount = Math.ceil(1 + 3.322 * Math.log10(n));
  binCount = Math.min(binCount, 15);
  binCount = Math.max(binCount, 3);

  const range = max - min;
  const binWidth = range > 0 ? range / binCount : 1;

  const bins: { binStart: number; binEnd: number; count: number; label: string }[] = [];
  for (let i = 0; i < binCount; i++) {
    const binStart = min + i * binWidth;
    const binEnd = i === binCount - 1 ? max + 0.001 : min + (i + 1) * binWidth;
    bins.push({
      binStart: Math.round(binStart * 100) / 100,
      binEnd: Math.round(binEnd * 100) / 100,
      count: 0,
      label: `${Math.round(binStart * 10) / 10}-${Math.round(binEnd * 10) / 10}`,
    });
  }

  for (const v of values) {
    let idx = range > 0 ? Math.floor((v - min) / binWidth) : 0;
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx].count++;
  }

  return NextResponse.json({
    bins,
    stats: {
      mean: Math.round(mean * 100) / 100,
      median: Math.round(median * 100) / 100,
      stdDev: Math.round(stdDev * 100) / 100,
      min: Math.round(min * 100) / 100,
      max: Math.round(max * 100) / 100,
      count: n,
      skewness: Math.round(skewness * 100) / 100,
      p25: Math.round(p25 * 100) / 100,
      p75: Math.round(p75 * 100) / 100,
    },
    metricName: cfg.metric_name || metricId,
    metricType: cfg.type,
    higherIsBetter: metricHigherIsBetter(cfg.analytics_config),
  });
}

function handleCumulative(
  metricId: string,
  configMap: Map<string, MetricConfig>,
  byMetric: Map<string, Map<string, number | null>>,
  sortedDates: string[]
) {
  const data = byMetric.get(metricId);
  const cfg = configMap.get(metricId)!;
  const isCount = cfg.type === "count";

  const points: { date: string; dailyValue: number; cumulativeTotal: number }[] = [];
  let cumulative = 0;

  if (isCount && sortedDates.length > 0) {
    // Fill missing dates with 0 for count metrics
    const start = new Date(sortedDates[0] + "T00:00:00");
    const end = new Date(sortedDates[sortedDates.length - 1] + "T00:00:00");
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      const val = data?.get(ds) ?? 0;
      cumulative += val;
      points.push({ date: ds, dailyValue: val, cumulativeTotal: Math.round(cumulative * 100) / 100 });
    }
  } else {
    for (const date of sortedDates) {
      const val = data?.get(date);
      if (val != null) {
        cumulative += val;
        points.push({ date, dailyValue: val, cumulativeTotal: Math.round(cumulative * 100) / 100 });
      }
    }
  }

  // Calculate daily rate and year-end projection
  const currentTotal = cumulative;
  let dailyRate = 0;
  if (points.length >= 2) {
    const firstDate = new Date(points[0].date + "T00:00:00");
    const lastDate = new Date(points[points.length - 1].date + "T00:00:00");
    const spanDays = Math.max(1, (lastDate.getTime() - firstDate.getTime()) / 86400000 + 1);
    dailyRate = currentTotal / spanDays;
  }

  const now = new Date();
  const yearEnd = new Date(now.getFullYear(), 11, 31);
  const daysRemaining = Math.max(0, (yearEnd.getTime() - now.getTime()) / 86400000);
  const projectedYearEnd = currentTotal + dailyRate * daysRemaining;

  return NextResponse.json({
    points,
    metricName: cfg.metric_name || metricId,
    metricType: cfg.type,
    higherIsBetter: metricHigherIsBetter(cfg.analytics_config),
    currentTotal: Math.round(currentTotal * 100) / 100,
    dailyRate: Math.round(dailyRate * 100) / 100,
    projectedYearEnd: Math.round(projectedYearEnd),
  });
}

function handleYearOverYear(
  metricId: string,
  configMap: Map<string, MetricConfig>,
  byMetric: Map<string, Map<string, number | null>>,
  sortedDates: string[]
) {
  const data = byMetric.get(metricId);
  const cfg = configMap.get(metricId)!;

  const YOY_COLORS = ["#3b82f6", "#f59e0b", "#22c55e", "#a855f7", "#ef4444"];

  // Group data by year
  const yearMap = new Map<number, { date: string; value: number }[]>();
  for (const date of sortedDates) {
    const val = data?.get(date);
    if (val == null) continue;
    const year = parseInt(date.slice(0, 4));
    if (!yearMap.has(year)) yearMap.set(year, []);
    yearMap.get(year)!.push({ date, value: val });
  }

  const years = Array.from(yearMap.keys()).sort();

  const yearsData = years.map((year, idx) => {
    const entries = yearMap.get(year)!;
    const sum = entries.reduce((a, b) => a + b.value, 0);
    const avg = sum / entries.length;

    // Convert to day-of-year for alignment
    const dataPoints = entries.map((e) => {
      const d = new Date(e.date + "T00:00:00");
      const startOfYear = new Date(d.getFullYear(), 0, 1);
      const dayOfYear = Math.floor((d.getTime() - startOfYear.getTime()) / 86400000) + 1;
      return { dayOfYear, date: e.date, value: e.value };
    });

    // Compute MA7
    const sortedPoints = [...dataPoints].sort((a, b) => a.dayOfYear - b.dayOfYear);
    const withMa7 = sortedPoints.map((p, i) => {
      if (i < 6) return { ...p, ma7: undefined };
      const window = sortedPoints.slice(i - 6, i + 1);
      const ma7 = window.reduce((s, w) => s + w.value, 0) / 7;
      return { ...p, ma7: Math.round(ma7 * 100) / 100 };
    });

    return {
      year,
      color: YOY_COLORS[idx % YOY_COLORS.length],
      dataPoints: withMa7,
      avg: Math.round(avg * 100) / 100,
      count: entries.length,
    };
  });

  return NextResponse.json({
    years: yearsData,
    metricName: cfg.metric_name || metricId,
    metricType: cfg.type,
    higherIsBetter: metricHigherIsBetter(cfg.analytics_config),
  });
}

function handleStreakTimeline(
  metricId: string,
  configMap: Map<string, MetricConfig>,
  byMetric: Map<string, Map<string, number | null>>,
  sortedDates: string[]
) {
  const data = byMetric.get(metricId);
  const cfg = configMap.get(metricId)!;
  const isCheckbox = cfg.type === "checkbox";

  const metricDates = sortedDates.filter((d) => data?.has(d));

  // Determine threshold for numeric metrics
  let threshold: number | undefined;
  if (!isCheckbox) {
    const vals: number[] = [];
    for (const d of metricDates) {
      const v = data?.get(d);
      if (v != null) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    threshold = vals.length > 0 ? vals[Math.floor(vals.length / 2)] : 0;
  }

  // Build streak segments
  const streaks: { startDate: string; endDate: string; length: number; type: "active" | "gap" }[] = [];
  let currentStart: string | null = null;
  let currentType: "active" | "gap" | null = null;
  let prevDate: string | null = null;

  for (const date of metricDates) {
    const val = data?.get(date);
    const isActive = isCheckbox
      ? (val != null && val !== 0)
      : (val != null && val >= (threshold ?? 0));

    const segType = isActive ? "active" : "gap";

    if (segType !== currentType) {
      if (currentType && currentStart && prevDate) {
        streaks.push({
          startDate: currentStart,
          endDate: prevDate,
          length: daysBetween(currentStart, prevDate) + 1,
          type: currentType,
        });
      }
      currentStart = date;
      currentType = segType;
    }
    prevDate = date;
  }

  // Close final segment
  if (currentType && currentStart && prevDate) {
    streaks.push({
      startDate: currentStart,
      endDate: prevDate,
      length: daysBetween(currentStart, prevDate) + 1,
      type: currentType,
    });
  }

  // Compute stats
  const activeStreaks = streaks.filter((s) => s.type === "active");
  const currentStreak = activeStreaks.length > 0 && streaks[streaks.length - 1]?.type === "active"
    ? streaks[streaks.length - 1].length
    : 0;
  const longestStreak = activeStreaks.length > 0
    ? Math.max(...activeStreaks.map((s) => s.length))
    : 0;
  const averageStreak = activeStreaks.length > 0
    ? activeStreaks.reduce((a, b) => a + b.length, 0) / activeStreaks.length
    : 0;
  const totalActiveDays = activeStreaks.reduce((a, b) => a + b.length, 0);
  const totalTrackedDays = metricDates.length;

  return NextResponse.json({
    streaks,
    stats: {
      currentStreak,
      longestStreak,
      averageStreak: Math.round(averageStreak * 10) / 10,
      totalStreaks: activeStreaks.length,
      totalActiveDays,
      totalTrackedDays,
      activeRate: totalTrackedDays > 0 ? Math.round((totalActiveDays / totalTrackedDays) * 1000) / 10 : 0,
    },
    metricName: cfg.metric_name || metricId,
    metricType: cfg.type,
    isCheckbox,
    threshold,
  });
}

function handleCandlestick(
  metricId: string,
  configMap: Map<string, MetricConfig>,
  byMetric: Map<string, Map<string, number | null>>,
  sortedDates: string[],
  period: string
) {
  const data = byMetric.get(metricId);
  const cfg = configMap.get(metricId)!;

  // Group dates into periods (weekly or monthly)
  const periodMap = new Map<string, { dates: string[]; values: number[] }>();

  for (const date of sortedDates) {
    const val = data?.get(date);
    if (val == null) continue;

    let periodKey: string;
    let periodStart: string;

    if (period === "monthly") {
      periodKey = date.slice(0, 7);
      periodStart = periodKey + "-01";
    } else {
      // Weekly — get Monday of the week
      const d = new Date(date + "T00:00:00");
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d);
      monday.setDate(diff);
      periodKey = monday.toISOString().slice(0, 10);
      periodStart = periodKey;
    }

    if (!periodMap.has(periodKey)) {
      periodMap.set(periodKey, { dates: [], values: [] });
    }
    const bucket = periodMap.get(periodKey)!;
    bucket.dates.push(date);
    bucket.values.push(val);
  }

  const candles = Array.from(periodMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([periodKey, { dates, values }]) => {
      const sortedValues = [...values];
      const periodEnd = dates[dates.length - 1];

      return {
        period: periodKey,
        periodStart: periodKey.length === 7 ? periodKey + "-01" : periodKey,
        periodEnd,
        open: values[0],
        high: Math.max(...sortedValues),
        low: Math.min(...sortedValues),
        close: values[values.length - 1],
        count: values.length,
      };
    });

  // Overall average
  const allValues: number[] = [];
  for (const date of sortedDates) {
    const val = data?.get(date);
    if (val != null) allValues.push(val);
  }
  const overallAvg = allValues.length > 0
    ? Math.round((allValues.reduce((a, b) => a + b, 0) / allValues.length) * 100) / 100
    : 0;

  return NextResponse.json({
    candles,
    metricName: cfg.metric_name || metricId,
    metricType: cfg.type,
    higherIsBetter: metricHigherIsBetter(cfg.analytics_config),
    overallAvg,
  });
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000
  );
}
