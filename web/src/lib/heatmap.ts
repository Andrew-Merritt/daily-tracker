/**
 * Pure helpers for the calendar heatmap: date ranges, color scales, overlay
 * markers and weekday/month pattern summaries. No React here so it can be
 * unit-tested directly.
 */

export type HeatmapMetricType = "number" | "checkbox" | "hhmm" | "time" | "score" | "count" | "text";
export type HeatmapDirection = "increase" | "decrease" | "neutral";
/** percentile = rank within the period (robust to outliers); range = min–max of the period. */
export type HeatScale = "percentile" | "range";
export type Bucket = 1 | 2 | 3 | 4 | 5;

export type HeatmapDataPoint = {
  date: string;
  value: number;
  goalMet?: boolean;
};

// ---------------------------------------------------------------------------
// Dates (all YYYY-MM-DD, local calendar)
// ---------------------------------------------------------------------------

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00`);
}

export function localToday(): string {
  return toDateStr(new Date());
}

export function shiftDate(s: string, days: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

/** Every date from start to end inclusive. */
export function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const d = parseDate(start);
  const last = parseDate(end);
  while (d <= last) {
    out.push(toDateStr(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** "YYYY-MM" for every month touched by [start, end]. */
export function eachMonth(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(parseDate(start).getFullYear(), parseDate(start).getMonth(), 1);
  const last = parseDate(end);
  while (d <= last) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export type Period = { key: string; label: string; start: string; end: string };

export const ROLLING_KEY = "12m";

/**
 * "Last 12 months": the current month plus the 11 before it (whole months, so
 * the month view shows 12 full cards), ending today.
 */
export function rollingPeriod(today = localToday()): Period {
  const t = parseDate(today);
  const start = new Date(t.getFullYear(), t.getMonth() - 11, 1);
  return { key: ROLLING_KEY, label: "Last 12 months", start: toDateStr(start), end: today };
}

export function yearPeriod(year: number, today = localToday()): Period {
  const end = `${year}-12-31`;
  return { key: String(year), label: String(year), start: `${year}-01-01`, end: end < today ? end : today };
}

export function buildPeriods(years: number[], today = localToday()): Period[] {
  return [rollingPeriod(today), ...years.map((y) => yearPeriod(y, today))];
}

// ---------------------------------------------------------------------------
// Color scale
// ---------------------------------------------------------------------------

/** Bucket a value into a quintile of [min, max]. */
export function rangeBucket(value: number, min: number, max: number): Bucket {
  const t = (value - min) / (max - min || 1);
  return (Math.min(4, Math.max(0, Math.floor(t * 5))) + 1) as Bucket;
}

function lowerBound(sorted: number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(sorted: number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Returns a value → bucket (1 = lowest … 5 = highest) function for the given
 * period values.
 *
 * Percentile mode uses the mid-rank percentile, (below + ½·equal) / n, so tied
 * values (common for 1–10 scores) land in the same bucket and the ramp still
 * spreads across all five colors. A single extreme day can no longer squash
 * every other day into one color, which min–max scaling does.
 */
export function makeBucketer(values: number[], scale: HeatScale): (v: number) => Bucket {
  if (values.length === 0) return () => 3;
  if (scale === "range") {
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return (v) => rangeBucket(v, min, max);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const distinct = new Set(sorted).size;
  if (distinct === 1) return () => 3;
  return (v) => {
    const below = lowerBound(sorted, v);
    const equal = upperBound(sorted, v) - below;
    const p = (below + 0.5 * equal) / n;
    return (Math.min(4, Math.floor(p * 5)) + 1) as Bucket;
  };
}

/** Cell background + text color for a logged value. */
export function heatColors(
  value: number,
  bucketOf: (v: number) => Bucket,
  metricType: HeatmapMetricType,
  direction: HeatmapDirection
): { bg: string; fg: string } {
  if (metricType === "checkbox") {
    if (value >= 0.5) {
      return direction === "decrease"
        ? { bg: "var(--status-danger)", fg: "var(--heat-fg-danger)" }
        : { bg: "var(--heat-4)", fg: "var(--heat-fg-4)" };
    }
    return { bg: "transparent", fg: "var(--heat-fg-4)" };
  }
  let b = bucketOf(value);
  // Better days are always the deeper color.
  if (direction === "decrease") b = (6 - b) as Bucket;
  return { bg: `var(--heat-${b})`, fg: `var(--heat-fg-${b})` };
}

export const LEGEND_COLORS = [1, 2, 3, 4, 5].map((b) => `var(--heat-${b})`);

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatHHMM(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes)) return "";
  const minutes = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

export function formatDuration(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes)) return "";
  const minutes = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}m` : `${h}:${String(m).padStart(2, "0")}`;
}

export function formatCellValue(value: number, metricType: HeatmapMetricType): string {
  switch (metricType) {
    case "hhmm":
      return formatHHMM(value);
    case "time":
      return formatDuration(value);
    case "checkbox":
      return value >= 0.5 ? "Yes" : "No";
    default:
      return String(Math.round(value * 100) / 100);
  }
}

/** Compact value for inside a tile (checkbox shows a check mark). */
export function formatTileValue(value: number, metricType: HeatmapMetricType): string {
  if (metricType === "checkbox") return value >= 0.5 ? "✓" : "";
  if (metricType === "hhmm" || metricType === "time") return formatCellValue(value, metricType);
  return String(Math.round(value * 10) / 10);
}

export function formatShortDate(date: string): string {
  return parseDate(date).toLocaleString("default", { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Overlay ("dot on days when X")
// ---------------------------------------------------------------------------

export type OverlaySpec = {
  /** Dates that get a marker. */
  dates: Set<string>;
  /** Human description of what a dot means, e.g. "Lifting done" / "Alcohol above 0". */
  label: string;
};

/**
 * Checkbox overlay → dot on checked days. Numeric overlay → dot on days the
 * value is above its median for the period (for mostly-zero metrics like
 * drinks, that means "any").
 */
export function buildOverlay(
  points: { date: string; value: number }[],
  metricName: string,
  metricType: HeatmapMetricType
): OverlaySpec {
  if (metricType === "checkbox") {
    return {
      dates: new Set(points.filter((p) => p.value >= 0.5).map((p) => p.date)),
      label: `${metricName} done`,
    };
  }
  if (points.length === 0) return { dates: new Set(), label: metricName };
  const sorted = points.map((p) => p.value).sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  return {
    dates: new Set(points.filter((p) => p.value > median).map((p) => p.date)),
    label: `${metricName} above ${formatCellValue(median, metricType)}`,
  };
}

export type OverlayComparison = {
  withAvg: number;
  withN: number;
  withoutAvg: number;
  withoutN: number;
};

/**
 * Average of the primary metric on overlay days vs other days. For checkbox
 * primaries the "average" is the share of days done (0–1) across every day in
 * range, since unchecked days have no row.
 */
export function compareOverlay(
  primary: HeatmapDataPoint[],
  overlay: OverlaySpec,
  metricType: HeatmapMetricType,
  rangeDates: string[]
): OverlayComparison | null {
  let wSum = 0;
  let wN = 0;
  let oSum = 0;
  let oN = 0;
  if (metricType === "checkbox") {
    const done = new Set(primary.filter((p) => p.value >= 0.5).map((p) => p.date));
    for (const d of rangeDates) {
      const v = done.has(d) ? 1 : 0;
      if (overlay.dates.has(d)) {
        wSum += v;
        wN++;
      } else {
        oSum += v;
        oN++;
      }
    }
  } else {
    for (const p of primary) {
      if (overlay.dates.has(p.date)) {
        wSum += p.value;
        wN++;
      } else {
        oSum += p.value;
        oN++;
      }
    }
  }
  if (wN < 3 || oN < 3) return null;
  return { withAvg: wSum / wN, withN: wN, withoutAvg: oSum / oN, withoutN: oN };
}

// ---------------------------------------------------------------------------
// Patterns (weekday / month summaries)
// ---------------------------------------------------------------------------

export type PatternBar = { key: string; label: string; value: number | null; n: number };

/**
 * Average by weekday (Sun–Sat) and by month across the period. Numeric metrics
 * average logged values; checkbox metrics give the share of days done, counted
 * over every day in range (from `since`, the metric's start date, if later).
 */
export function computePatterns(
  data: HeatmapDataPoint[],
  metricType: HeatmapMetricType,
  start: string,
  end: string,
  since?: string | null
): { weekday: PatternBar[]; month: PatternBar[] } {
  const from = since && since > start ? since : start;
  const dates = from <= end ? eachDate(from, end) : [];
  const valueByDate = new Map(data.map((d) => [d.date, d.value]));

  const wSum = new Array(7).fill(0);
  const wN = new Array(7).fill(0);
  const months = eachMonth(start, end);
  const mSum = new Map<string, number>();
  const mN = new Map<string, number>();

  for (const d of dates) {
    const v = valueByDate.get(d);
    let contrib: number | null;
    if (metricType === "checkbox") contrib = v != null && v >= 0.5 ? 1 : 0;
    else contrib = v ?? null;
    if (contrib == null) continue;
    const dow = parseDate(d).getDay();
    wSum[dow] += contrib;
    wN[dow]++;
    const m = d.slice(0, 7);
    mSum.set(m, (mSum.get(m) ?? 0) + contrib);
    mN.set(m, (mN.get(m) ?? 0) + 1);
  }

  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Monday-first reads more naturally for a week of habits.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const weekday = order.map((i) => ({
    key: String(i),
    label: WEEKDAYS[i],
    value: wN[i] > 0 ? wSum[i] / wN[i] : null,
    n: wN[i],
  }));
  const month = months.map((m) => {
    const n = mN.get(m) ?? 0;
    return {
      key: m,
      label: parseDate(`${m}-01`).toLocaleString("default", { month: "short" }),
      value: n > 0 ? (mSum.get(m) ?? 0) / n : null,
      n,
    };
  });
  return { weekday, month };
}

// ---------------------------------------------------------------------------
// Metric ordering (same as the Today form: group_order, group, metric_order)
// ---------------------------------------------------------------------------

type Orderable = {
  metric_id: string;
  group?: string | null;
  group_order?: number | null;
  metric_order?: number | null;
};

export function sortMetricsForDisplay<T extends Orderable>(list: T[]): T[] {
  const groupOrder = new Map<string, number>();
  for (const m of list) {
    const key = m.group || "";
    const cur = groupOrder.get(key);
    const cand = m.group_order ?? 0;
    if (cur === undefined || cand < cur) groupOrder.set(key, cand);
  }
  return [...list].sort((a, b) => {
    const ga = a.group || "";
    const gb = b.group || "";
    const d = (groupOrder.get(ga) ?? 0) - (groupOrder.get(gb) ?? 0);
    if (d !== 0) return d;
    if (ga !== gb) return ga.localeCompare(gb);
    const o = (a.metric_order ?? 0) - (b.metric_order ?? 0);
    if (o !== 0) return o;
    return a.metric_id.localeCompare(b.metric_id);
  });
}
