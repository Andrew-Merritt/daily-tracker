"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getAuthHeaders } from "@/lib/authHeaders";
import { CalendarHeatmap } from "@/components/calendar-heatmap";
import { YearGrid } from "@/components/year-grid";
import { WeekGrid } from "@/components/week-grid";
import { HeatmapPatterns } from "@/components/heatmap-patterns";
import { DayDetailSheet } from "@/components/day-detail-sheet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatTile, StatTileRow } from "@/components/ui/stat-tile";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  buildOverlay,
  buildPeriods,
  compareOverlay,
  eachDate,
  formatCellValue,
  formatShortDate,
  LEGEND_COLORS,
  makeBucketer,
  ROLLING_KEY,
  shiftDate,
  sortMetricsForDisplay,
  type HeatScale,
  type HeatmapDataPoint,
  type HeatmapDirection,
  type HeatmapMetricType,
} from "@/lib/heatmap";

type DailyGoal = {
  type: "numeric" | "numeric_threshold" | "checkbox" | "hhmm_target";
  target?: number;
  threshold?: number;
  target_time?: number;
  target_count?: number;
  direction?: "gte" | "lte" | "before" | "after";
  measure?: "sum" | "average";
};

type ConfigRow = {
  metric_id: string;
  metric_name: string;
  type: HeatmapMetricType;
  active: boolean;
  group?: string | null;
  group_order?: number | null;
  metric_order?: number | null;
  private?: boolean;
  start_date?: string | null;
  analytics_config?: {
    higher_is_better?: boolean;
    direction?: HeatmapDirection;
  } | null;
  goals_config?: {
    goals?: Array<{
      id: string;
      name: string;
      frequency: "daily" | "weekly" | "monthly";
      enabled: boolean;
      type: string;
      target?: number;
      threshold?: number;
      target_time?: number;
      target_count?: number;
      direction?: string;
      measure?: string;
    }>;
  } | null;
};

type LogRow = { date: string; metric_id: string; value: number | null };
type View = "weeks" | "months" | "year";

const NO_OVERLAY = "__none__";
const LS = {
  view: "heatmap:view",
  metric: "heatmap:metric",
  period: "heatmap:period",
  scale: "heatmap:scale",
  overlay: "heatmap:overlay",
  overlayLag: "heatmap:overlayLag",
};

// Check if a value meets a daily goal
function checkDailyGoal(value: number, goal: DailyGoal): boolean {
  switch (goal.type) {
    case "numeric":
      return goal.direction === "lte" ? value <= (goal.target ?? 0) : value >= (goal.target ?? 0);
    case "numeric_threshold":
      return goal.direction === "lte" ? value <= (goal.threshold ?? 0) : value >= (goal.threshold ?? 0);
    case "checkbox":
      return value >= 0.5;
    case "hhmm_target":
      return goal.direction === "before" ? value <= (goal.target_time ?? 0) : value >= (goal.target_time ?? 0);
    default:
      return false;
  }
}

function metricDirection(c: ConfigRow | undefined): HeatmapDirection {
  if (c?.analytics_config?.direction) return c.analytics_config.direction;
  // Backwards compat: higher_is_better false means decrease
  if (c?.analytics_config?.higher_is_better === false) return "decrease";
  return "increase";
}

function fmtAvg(v: number, metricType: HeatmapMetricType): string {
  if (metricType === "checkbox") return `${Math.round(v * 100)}%`;
  return formatCellValue(v, metricType);
}

/** Small segmented control. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 border rounded-md p-0.5">
      {options.map((o) => (
        <Button
          key={o.value}
          variant={value === o.value ? "default" : "ghost"}
          size="sm"
          className="h-7 px-2"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

export default function HeatmapPage() {
  const [config, setConfig] = useState<ConfigRow[]>([]);
  // All active metrics incl. text (notes) — used by the day detail sheet.
  const [allActive, setAllActive] = useState<ConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedMetric, setSelectedMetric] = useState<string | null>(null);
  const [periodKey, setPeriodKey] = useState<string>(ROLLING_KEY);
  const [view, setView] = useState<View>("months");
  const [scale, setScale] = useState<HeatScale>("percentile");
  const [overlayMetric, setOverlayMetric] = useState<string>(NO_OVERLAY);
  // "next": dot lands on the day AFTER the overlay event (e.g. sleep the night after drinking).
  const [overlayLag, setOverlayLag] = useState<"same" | "next">("same");
  const [hoveredCell, setHoveredCell] = useState<{ date: string; value: number } | null>(null);
  const [detailDate, setDetailDate] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // Restore per-device preferences. Phones default to the Weeks view.
  useEffect(() => {
    const v = localStorage.getItem(LS.view);
    if (v === "weeks" || v === "months" || v === "year") setView(v);
    else if (window.matchMedia("(max-width: 639px)").matches) setView("weeks");
    const s = localStorage.getItem(LS.scale);
    if (s === "percentile" || s === "range") setScale(s);
    const p = localStorage.getItem(LS.period);
    if (p) setPeriodKey(p);
    const o = localStorage.getItem(LS.overlay);
    if (o) setOverlayMetric(o);
    if (localStorage.getItem(LS.overlayLag) === "next") setOverlayLag("next");
  }, []);

  const persist = <T extends string>(key: string, set: (v: T) => void) => (v: T) => {
    set(v);
    localStorage.setItem(key, v);
  };
  const changeView = persist<View>(LS.view, setView);
  const changeScale = persist<HeatScale>(LS.scale, setScale);
  const changePeriod = persist<string>(LS.period, setPeriodKey);
  const changeOverlay = persist<string>(LS.overlay, setOverlayMetric);
  const changeOverlayLag = persist<"same" | "next">(LS.overlayLag, setOverlayLag);
  const changeMetric = useCallback((id: string) => {
    setSelectedMetric(id);
    setHoveredCell(null);
    localStorage.setItem(LS.metric, id);
  }, []);

  // Load config on mount
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const headers = await getAuthHeaders();
        const cfgRes = await fetch("/api/config", { headers });
        const cfgData = await cfgRes.json();
        if (!cfgRes.ok) throw new Error(cfgData?.error || "Failed to load config");

        const allActiveMetrics = sortMetricsForDisplay(
          (cfgData as ConfigRow[])
            .filter((m) => m.active)
            .map((m) => ({ ...m, metric_name: (m.metric_name ?? m.metric_id).replace(/\s*\[[0-9a-f]{8}\]$/, "") }))
        );
        setAllActive(allActiveMetrics);

        // Heatmap selector: active non-text metrics
        const activeMetrics = allActiveMetrics.filter((m) => m.type !== "text");
        setConfig(activeMetrics);

        const stored = localStorage.getItem(LS.metric);
        const initial = activeMetrics.find((m) => m.metric_id === stored) ?? activeMetrics[0];
        if (initial) setSelectedMetric(initial.metric_id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Years that actually have data (newest first). Falls back to the last 6 years.
  const [availableYears, setAvailableYears] = useState<number[]>(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 6 }, (_, i) => currentYear - i);
  });
  useEffect(() => {
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch("/api/log?years=1", { headers });
        if (!res.ok) return;
        const years = (await res.json()) as number[];
        if (Array.isArray(years) && years.length > 0) setAvailableYears(years);
      } catch {
        // keep fallback
      }
    })();
  }, []);

  const periods = useMemo(() => buildPeriods(availableYears), [availableYears]);
  const period = periods.find((p) => p.key === periodKey) ?? periods[0];
  const periodIdx = periods.indexOf(period);

  // ---------------------------------------------------------------------------
  // Data: one metric over one period, cached by key for the life of the page.
  // ---------------------------------------------------------------------------
  const [rangeData, setRangeData] = useState<Record<string, LogRow[]>>({});
  const inFlight = useRef(new Set<string>());
  const ensureLoaded = useCallback(
    (metricId: string | null) => {
      if (!metricId) return;
      const key = `${metricId}|${period.start}|${period.end}`;
      if (rangeData[key] || inFlight.current.has(key)) return;
      inFlight.current.add(key);
      (async () => {
        try {
          const headers = await getAuthHeaders();
          const params = new URLSearchParams({ metric_id: metricId, start: period.start, end: period.end });
          const res = await fetch(`/api/log?${params}`, { headers });
          const json = await res.json();
          if (!res.ok) throw new Error(json?.error || "Failed to load logs");
          setRangeData((prev) => ({ ...prev, [key]: json as LogRow[] }));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          inFlight.current.delete(key);
        }
      })();
    },
    [period.start, period.end, rangeData]
  );
  const rowsFor = (metricId: string | null) =>
    metricId ? rangeData[`${metricId}|${period.start}|${period.end}`] : undefined;

  const overlayId = overlayMetric !== NO_OVERLAY && overlayMetric !== selectedMetric ? overlayMetric : null;
  useEffect(() => {
    ensureLoaded(selectedMetric);
    ensureLoaded(overlayId);
  }, [ensureLoaded, selectedMetric, overlayId]);

  const primaryRows = rowsFor(selectedMetric);
  const overlayRows = rowsFor(overlayId);
  const dataLoading = !!selectedMetric && !primaryRows;

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------
  const selectedConfig = config.find((c) => c.metric_id === selectedMetric);
  const overlayConfig = config.find((c) => c.metric_id === overlayId);
  const metricType: HeatmapMetricType = selectedConfig?.type || "number";
  const direction = metricDirection(selectedConfig);

  const dailyGoal = useMemo((): DailyGoal | null => {
    const daily = selectedConfig?.goals_config?.goals?.find((g) => g.frequency === "daily" && g.enabled);
    if (!daily) return null;
    return {
      type: daily.type as DailyGoal["type"],
      target: daily.target,
      threshold: daily.threshold,
      target_time: daily.target_time,
      target_count: daily.target_count,
      direction: daily.direction as DailyGoal["direction"],
      measure: daily.measure as DailyGoal["measure"],
    };
  }, [selectedConfig]);

  const heatmapData = useMemo((): HeatmapDataPoint[] => {
    return (primaryRows ?? [])
      .filter((l) => l.value != null)
      .map((l) => ({
        date: l.date,
        value: l.value!,
        goalMet: dailyGoal ? checkDailyGoal(l.value!, dailyGoal) : undefined,
      }));
  }, [primaryRows, dailyGoal]);

  const bucketOf = useMemo(
    () => makeBucketer(heatmapData.map((d) => d.value), scale),
    [heatmapData, scale]
  );

  // Days the metric could have been logged in this period (from its start_date).
  const trackedDates = useMemo(() => {
    const since = selectedConfig?.start_date;
    const from = since && since > period.start ? since : period.start;
    return from <= period.end ? eachDate(from, period.end) : [];
  }, [selectedConfig, period.start, period.end]);

  const overlay = useMemo(() => {
    if (!overlayConfig || !overlayRows) return null;
    const pts = overlayRows.filter((r) => r.value != null).map((r) => ({ date: r.date, value: r.value! }));
    const base = buildOverlay(pts, overlayConfig.metric_name, overlayConfig.type);
    if (overlayLag === "same") return base;
    return {
      dates: new Set([...base.dates].map((d) => shiftDate(d, 1))),
      label: `Day after: ${base.label}`,
    };
  }, [overlayConfig, overlayRows, overlayLag]);

  const overlayCompare = useMemo(
    () => (overlay ? compareOverlay(heatmapData, overlay, metricType, trackedDates) : null),
    [overlay, heatmapData, metricType, trackedDates]
  );

  const stats = useMemo(() => {
    if (heatmapData.length === 0) return null;
    const values = heatmapData.map((d) => d.value);
    const sum = values.reduce((a, b) => a + b, 0);
    // For checkboxes only checked days count as "logged" (unchecked has no row).
    const loggedDates = new Set(
      heatmapData.filter((d) => metricType !== "checkbox" || d.value >= 0.5).map((d) => d.date)
    );
    const sorted = [...loggedDates].sort();

    let longest = 0;
    let run = 0;
    let prev: string | null = null;
    for (const d of sorted) {
      run = prev && shiftDate(prev, 1) === d ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = d;
    }
    // Current streak counts back from the period's end (today, for current periods),
    // allowing today to still be unlogged.
    let cur = period.end;
    if (!loggedDates.has(cur)) cur = shiftDate(cur, -1);
    let current = 0;
    while (loggedDates.has(cur)) {
      current++;
      cur = shiftDate(cur, -1);
    }

    const goalMetCount = heatmapData.filter((d) => d.goalMet).length;
    return {
      count: loggedDates.size,
      possible: trackedDates.length,
      sum,
      avg: sum / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      longest,
      current,
      goalMetCount,
      goalMetPct: dailyGoal && loggedDates.size > 0 ? Math.round((goalMetCount / loggedDates.size) * 100) : null,
    };
  }, [heatmapData, metricType, period.end, trackedDates, dailyGoal]);

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------
  const handleHover = useCallback((cell: { date: string; value: number } | null) => setHoveredCell(cell), []);

  // Tap a day: select it and open that day's full log.
  const handleCellClick = useCallback((date: string, value: number | undefined) => {
    if (value !== undefined) setHoveredCell({ date, value });
    setDetailDate(date);
    setDetailOpen(true);
  }, []);

  const metricIdx = config.findIndex((c) => c.metric_id === selectedMetric);
  const stepMetric = (delta: number) => {
    if (config.length === 0) return;
    const next = config[(metricIdx + delta + config.length) % config.length];
    changeMetric(next.metric_id);
  };

  // Swipe left/right on the heatmap to change metric (not in Year view, which
  // scrolls horizontally).
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touchStart.current;
    touchStart.current = null;
    if (!s || view === "year") return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    stepMetric(dx < 0 ? 1 : -1);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (loading || error || config.length === 0) {
    return (
      <main className="p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-semibold mb-4">Heatmap</h1>
        <div className={`text-sm ${error ? "text-red-600" : "text-muted-foreground"}`}>
          {error ? `Error: ${error}` : loading ? "Loading..." : "No metrics available."}
        </div>
      </main>
    );
  }

  const showTotal = metricType !== "hhmm" && metricType !== "checkbox";
  const isNumeric = metricType !== "checkbox";
  const selectedDate = detailOpen ? detailDate : hoveredCell?.date;
  const gridProps = {
    data: heatmapData,
    start: period.start,
    end: period.end,
    metricType,
    direction,
    bucketOf,
    selectedDate,
    markers: overlay?.dates ?? null,
    onHover: handleHover,
    onCellClick: handleCellClick,
  };

  return (
    <main className="px-3 sm:px-6 py-4 sm:py-6 max-w-6xl mx-auto space-y-4 overflow-x-hidden">
      {/* Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <h1 className="text-xl sm:text-2xl font-semibold">Heatmap</h1>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 flex-1 min-w-0 sm:flex-none">
            <Button variant="outline" size="sm" className="h-9 w-9 p-0 shrink-0" onClick={() => stepMetric(-1)} aria-label="Previous metric">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Select value={selectedMetric ?? ""} onValueChange={changeMetric}>
              <SelectTrigger className="flex-1 min-w-0 sm:w-[200px]">
                <SelectValue placeholder="Select metric" />
              </SelectTrigger>
              <SelectContent>
                {config.map((m) => (
                  <SelectItem key={m.metric_id} value={m.metric_id}>
                    {m.metric_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" className="h-9 w-9 p-0 shrink-0" onClick={() => stepMetric(1)} aria-label="Next metric">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <div className="flex items-center gap-1 flex-1 sm:flex-none">
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-9 p-0"
                onClick={() => changePeriod(periods[periodIdx + 1].key)}
                disabled={periodIdx >= periods.length - 1}
                aria-label="Earlier period"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Select value={period.key} onValueChange={changePeriod}>
                <SelectTrigger className="flex-1 sm:w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {periods.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-9 p-0"
                onClick={() => changePeriod(periods[periodIdx - 1].key)}
                disabled={periodIdx <= 0}
                aria-label="Later period"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Header stat tiles */}
      {stats && (
        <StatTileRow>
          <StatTile label={metricType === "checkbox" ? "Days done" : "Days logged"} value={`${stats.count}/${stats.possible}`} />
          <StatTile label="Current streak" value={`${stats.current} days`} />
          <StatTile label="Longest streak" value={`${stats.longest} days`} />
          {stats.goalMetPct !== null && <StatTile label="Goal met" value={`${stats.goalMetPct}%`} />}
        </StatTileRow>
      )}

      {/* Info card: selection, legend, stats, color + overlay options */}
      <Card>
        <CardContent className="py-3 px-3 sm:px-6 space-y-3">
          <div className="flex items-center justify-between gap-2 min-h-8">
            <div className="text-sm whitespace-nowrap">
              {hoveredCell ? (
                <span>
                  <span className="font-mono font-medium">{formatCellValue(hoveredCell.value, metricType)}</span>
                  <span className="text-muted-foreground ml-2">{formatShortDate(hoveredCell.date)}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">Tap a day to see everything logged</span>
              )}
            </div>
            {isNumeric ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="hidden sm:inline">{direction === "neutral" ? "less" : "worse"}</span>
                <div className="flex gap-0.5">
                  {LEGEND_COLORS.map((color) => (
                    <div key={color} className="w-3 h-3 sm:w-4 sm:h-4 rounded-sm" style={{ backgroundColor: color }} />
                  ))}
                </div>
                <span className="hidden sm:inline">{direction === "neutral" ? "more" : "better"}</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <div
                  className="w-3 h-3 rounded-sm"
                  style={{ backgroundColor: direction === "decrease" ? "var(--status-danger)" : "var(--heat-4)" }}
                />
                <span>Done</span>
              </div>
            )}
          </div>

          {stats && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {isNumeric && (
                <>
                  <span>
                    <span className="font-mono">{formatCellValue(stats.avg, metricType)}</span>
                    <span className="text-muted-foreground ml-1">avg</span>
                  </span>
                  {showTotal && (
                    <span>
                      <span className="font-mono">{formatCellValue(stats.sum, metricType)}</span>
                      <span className="text-muted-foreground ml-1">total</span>
                    </span>
                  )}
                  <span>
                    <span className="font-mono">{formatCellValue(stats.min, metricType)}</span>
                    <span className="text-muted-foreground ml-1">min</span>
                  </span>
                  <span>
                    <span className="font-mono">{formatCellValue(stats.max, metricType)}</span>
                    <span className="text-muted-foreground ml-1">max</span>
                  </span>
                </>
              )}
              {dailyGoal && stats.goalMetCount > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ boxShadow: "inset 0 0 0 1.5px var(--status-good)" }} />
                  <span className="font-mono">{stats.goalMetCount}</span>
                  <span className="text-muted-foreground">goal days</span>
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2 border-t text-xs">
            {isNumeric && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Color</span>
                <Segmented<HeatScale>
                  value={scale}
                  onChange={changeScale}
                  options={[
                    { value: "percentile", label: "Percentile" },
                    { value: "range", label: "Min–max" },
                  ]}
                />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span className="text-muted-foreground">Overlay</span>
              <Select value={overlayId ?? NO_OVERLAY} onValueChange={changeOverlay}>
                <SelectTrigger className="h-8 w-[170px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_OVERLAY}>None</SelectItem>
                  {config
                    .filter((m) => m.metric_id !== selectedMetric)
                    .map((m) => (
                      <SelectItem key={m.metric_id} value={m.metric_id}>
                        {m.metric_name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {overlayId && (
                <Segmented<"same" | "next">
                  value={overlayLag}
                  onChange={changeOverlayLag}
                  options={[
                    { value: "same", label: "Same day" },
                    { value: "next", label: "Next day" },
                  ]}
                />
              )}
            </div>
          </div>

          {overlay && (
            <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="inline-flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: "var(--status-warning)", boxShadow: "0 0 0 1px rgba(0,0,0,0.45)" }}
                />
                {overlay.label}
              </span>
              {overlayCompare ? (
                <span>
                  · {selectedConfig?.metric_name}{" "}
                  <span className="font-mono text-foreground">{fmtAvg(overlayCompare.withAvg, metricType)}</span> on dot days
                  ({overlayCompare.withN}) vs{" "}
                  <span className="font-mono text-foreground">{fmtAvg(overlayCompare.withoutAvg, metricType)}</span> other
                  days ({overlayCompare.withoutN})
                </span>
              ) : (
                <span>· not enough overlapping days to compare</span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Heatmap */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <CardTitle className="text-base truncate">{selectedConfig?.metric_name}</CardTitle>
              <div className="text-xs text-muted-foreground">
                {dataLoading
                  ? "Loading…"
                  : `${period.label} · ${formatShortDate(period.start)} – ${formatShortDate(period.end)}`}
              </div>
            </div>
            <Segmented<View>
              value={view}
              onChange={changeView}
              options={[
                { value: "weeks", label: "Weeks" },
                { value: "months", label: "Months" },
                { value: "year", label: "Year" },
              ]}
            />
          </div>
        </CardHeader>
        <CardContent onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          {view === "weeks" ? (
            <WeekGrid {...gridProps} />
          ) : view === "months" ? (
            <CalendarHeatmap {...gridProps} />
          ) : (
            <YearGrid {...gridProps} />
          )}
          {view !== "year" && (
            <p className="sm:hidden mt-3 text-center text-[11px] text-muted-foreground">Swipe to change metric</p>
          )}
        </CardContent>
      </Card>

      {!dataLoading && (
        <HeatmapPatterns
          data={heatmapData}
          metricType={metricType}
          direction={direction}
          start={period.start}
          end={period.end}
          since={selectedConfig?.start_date}
        />
      )}

      <DayDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        date={detailDate}
        onDateChange={setDetailDate}
        metrics={allActive}
        highlightMetricId={selectedMetric}
      />
    </main>
  );
}

