"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { getAuthHeaders } from "@/lib/authHeaders";
import {
  CalendarHeatmap,
  HeatmapDataPoint,
  getHeatmapLegendColors,
  formatHHMM,
  formatDuration,
} from "@/components/calendar-heatmap";
import { YearGrid } from "@/components/year-grid";
import { DayDetailSheet } from "@/components/day-detail-sheet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatTile, StatTileRow } from "@/components/ui/stat-tile";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  type: "number" | "checkbox" | "hhmm" | "time" | "score" | "count" | "text";
  active: boolean;
  group?: string | null;
  group_order?: number | null;
  metric_order?: number | null;
  private?: boolean;
  start_date?: string | null;
  analytics_config?: {
    higher_is_better?: boolean;
    direction?: "increase" | "decrease" | "neutral";
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

type LogRow = {
  date: string;
  metric_id: string;
  value: number | null;
};

function formatValue(value: number, type: string): string {
  switch (type) {
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

// Check if a value meets a daily goal
function checkDailyGoal(value: number, goal: DailyGoal, metricType: string): boolean {
  switch (goal.type) {
    case "numeric":
      if (goal.direction === "lte") {
        return value <= (goal.target ?? 0);
      }
      return value >= (goal.target ?? 0);
    case "numeric_threshold":
      if (goal.direction === "lte") {
        return value <= (goal.threshold ?? 0);
      }
      return value >= (goal.threshold ?? 0);
    case "checkbox":
      return value >= 0.5;
    case "hhmm_target":
      if (goal.direction === "before") {
        return value <= (goal.target_time ?? 0);
      }
      return value >= (goal.target_time ?? 0);
    default:
      return false;
  }
}

export default function HeatmapPage() {
  const [config, setConfig] = useState<ConfigRow[]>([]);
  // All active metrics incl. text (notes) — used by the day detail sheet.
  const [allActive, setAllActive] = useState<ConfigRow[]>([]);
  const [detailDate, setDetailDate] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [logData, setLogData] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedMetric, setSelectedMetric] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [hoveredCell, setHoveredCell] = useState<{ date: string; value: number } | null>(null);
  const [view, setView] = useState<"months" | "year">("months");

  useEffect(() => {
    const stored = localStorage.getItem("heatmap:view");
    if (stored === "months" || stored === "year") setView(stored);
  }, []);

  const handleViewChange = useCallback((next: "months" | "year") => {
    setView(next);
    localStorage.setItem("heatmap:view", next);
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

        const allActiveMetrics = (cfgData as ConfigRow[])
          .filter((m) => m.active)
          .map((m) => ({ ...m, metric_name: (m.metric_name ?? m.metric_id).replace(/\s*\[[0-9a-f]{8}\]$/, "") }));
        setAllActive(allActiveMetrics);

        // Heatmap selector: active non-text metrics
        const activeMetrics = allActiveMetrics.filter((m) => m.type !== "text");
        setConfig(activeMetrics);

        // Default to first metric if not selected
        if (activeMetrics.length > 0 && !selectedMetric) {
          setSelectedMetric(activeMetrics[0].metric_id);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Load just the selected metric for the selected year. Results are cached per
  // year+metric so flipping back and forth doesn't refetch.
  const logCache = useRef(new Map<string, LogRow[]>());
  useEffect(() => {
    if (!selectedMetric) return;
    const key = `${selectedYear}:${selectedMetric}`;
    const cached = logCache.current.get(key);
    if (cached) {
      setLogData(cached);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const params = new URLSearchParams({ year: String(selectedYear), metric_id: selectedMetric });
        const logRes = await fetch(`/api/log?${params}`, { headers });
        const logDataRes = await logRes.json();

        if (!logRes.ok) throw new Error(logDataRes?.error || "Failed to load logs");
        logCache.current.set(key, logDataRes);
        if (!cancelled) setLogData(logDataRes);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedYear, selectedMetric]);

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
  const minYear = availableYears[availableYears.length - 1];
  const maxYear = availableYears[0];

  // Get selected metric config
  const selectedConfig = useMemo(() => {
    return config.find((c) => c.metric_id === selectedMetric);
  }, [config, selectedMetric]);

  // Get daily goal for selected metric (if any)
  const dailyGoal = useMemo((): DailyGoal | null => {
    const goals = selectedConfig?.goals_config?.goals;
    if (!goals) return null;

    const daily = goals.find((g) => g.frequency === "daily" && g.enabled);
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

  // Prepare heatmap data for selected metric with goal achievement info
  const heatmapData = useMemo((): HeatmapDataPoint[] => {
    if (!selectedMetric) return [];
    const metricType = selectedConfig?.type || "number";

    return logData
      .filter((l) => l.metric_id === selectedMetric && l.value != null)
      .map((l) => ({
        date: l.date,
        value: l.value!,
        goalMet: dailyGoal ? checkDailyGoal(l.value!, dailyGoal, metricType) : undefined,
      }));
  }, [logData, selectedMetric, selectedConfig, dailyGoal]);

  // Determine direction (default to "increase" for backwards compat)
  const direction = useMemo((): "increase" | "decrease" | "neutral" => {
    if (selectedConfig?.analytics_config?.direction) {
      return selectedConfig.analytics_config.direction;
    }
    // Backwards compat: higher_is_better false means decrease
    if (selectedConfig?.analytics_config?.higher_is_better === false) {
      return "decrease";
    }
    return "increase";
  }, [selectedConfig]);

  const metricType = selectedConfig?.type || "number";

  // Stats for selected year
  const yearStats = useMemo(() => {
    const yearStr = String(selectedYear);
    const yearData = heatmapData.filter((d) => d.date.startsWith(yearStr));
    if (yearData.length === 0) return null;

    const values = yearData.map((d) => d.value);
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const goalMetCount = yearData.filter((d) => d.goalMet).length;

    return {
      count: yearData.length,
      sum,
      avg,
      min,
      max,
      goalMetCount,
    };
  }, [heatmapData, selectedYear]);

  // Legend colors
  const legendColors = useMemo(() => {
    if (!yearStats || metricType === "checkbox") return null;
    return getHeatmapLegendColors(direction);
  }, [yearStats, direction, metricType]);

  // Header stat tiles: days logged, current streak, longest streak, goal met %
  const headerStats = useMemo(() => {
    if (!yearStats) return null;
    const dateSet = new Set(heatmapData.filter((d) => d.date.startsWith(String(selectedYear))).map((d) => d.date));
    const sortedDates = [...dateSet].sort();

    const toDateStr = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    let longest = 0;
    let run = 0;
    let prevDate: string | null = null;
    for (const d of sortedDates) {
      if (prevDate) {
        const diffDays = Math.round(
          (new Date(`${d}T00:00:00`).getTime() - new Date(`${prevDate}T00:00:00`).getTime()) / 86400000
        );
        run = diffDays === 1 ? run + 1 : 1;
      } else {
        run = 1;
      }
      longest = Math.max(longest, run);
      prevDate = d;
    }

    const now = new Date();
    const isCurrentYear = selectedYear === now.getFullYear();
    const cur = isCurrentYear ? new Date(now) : new Date(selectedYear, 11, 31);
    if (!dateSet.has(toDateStr(cur))) cur.setDate(cur.getDate() - 1);
    let current = 0;
    while (dateSet.has(toDateStr(cur))) {
      current++;
      cur.setDate(cur.getDate() - 1);
    }

    const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const elapsed = isCurrentYear
      ? Math.floor((now.getTime() - new Date(selectedYear, 0, 1).getTime()) / 86400000) + 1
      : isLeap(selectedYear)
      ? 366
      : 365;

    const goalMetPct =
      dailyGoal && dateSet.size > 0 ? Math.round((yearStats.goalMetCount / dateSet.size) * 100) : null;

    return {
      loggedText: `${dateSet.size}/${elapsed}`,
      longest,
      current,
      goalMetPct,
    };
  }, [heatmapData, selectedYear, yearStats, dailyGoal]);

  const handleHover = useCallback((cell: { date: string; value: number } | null) => {
    setHoveredCell(cell);
  }, []);

  // Tap a day: select it and open that day's full log.
  const handleCellClick = useCallback((date: string, value: number | undefined) => {
    if (value !== undefined) setHoveredCell({ date, value });
    setDetailDate(date);
    setDetailOpen(true);
  }, []);

  if (loading) {
    return (
      <main className="p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-semibold mb-4">Calendar Heatmap</h1>
        <div className="text-sm text-muted-foreground">Loading...</div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-semibold mb-4">Calendar Heatmap</h1>
        <div className="text-sm text-red-600">Error: {error}</div>
      </main>
    );
  }

  if (config.length === 0) {
    return (
      <main className="p-6 max-w-6xl mx-auto">
        <h1 className="text-2xl font-semibold mb-4">Calendar Heatmap</h1>
        <div className="text-sm text-muted-foreground">No metrics available.</div>
      </main>
    );
  }

  // Determine which stats to show based on type
  const showTotal = metricType !== "hhmm" && metricType !== "checkbox";
  const showAvg = metricType !== "checkbox";
  const showMinMax = metricType !== "checkbox";

  return (
    <main className="px-3 sm:px-6 py-4 sm:py-6 max-w-6xl mx-auto space-y-4 overflow-x-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-xl sm:text-2xl font-semibold">Calendar Heatmap</h1>

        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          {/* Metric selector */}
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground hidden sm:inline">Metric:</label>
            <Select value={selectedMetric ?? ""} onValueChange={setSelectedMetric}>
              <SelectTrigger className="w-[140px] sm:w-[180px]">
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
          </div>

          {/* Year selector */}
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedYear((y) => y - 1)}
              disabled={selectedYear <= minYear}
            >
              &lt;
            </Button>
            <Select
              value={String(selectedYear)}
              onValueChange={(v) => setSelectedYear(parseInt(v, 10))}
            >
              <SelectTrigger className="w-[80px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableYears.map((year) => (
                  <SelectItem key={year} value={String(year)}>
                    {year}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedYear((y) => y + 1)}
              disabled={selectedYear >= maxYear}
            >
              &gt;
            </Button>
          </div>

          {/* View toggle */}
          <div className="flex items-center gap-1 border rounded-md p-0.5">
            <Button
              variant={view === "months" ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2"
              onClick={() => handleViewChange("months")}
            >
              Months
            </Button>
            <Button
              variant={view === "year" ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2"
              onClick={() => handleViewChange("year")}
            >
              Year
            </Button>
          </div>
        </div>
      </div>

      {/* Header stat tiles */}
      {headerStats && (
        <StatTileRow>
          <StatTile label="Days logged" value={headerStats.loggedText} />
          <StatTile label="Current streak" value={`${headerStats.current} days`} />
          <StatTile label="Longest streak" value={`${headerStats.longest} days`} />
          {headerStats.goalMetPct !== null && (
            <StatTile label="Goal met" value={`${headerStats.goalMetPct}%`} />
          )}
        </StatTileRow>
      )}

      {/* Stats card with legend and tap info */}
      <Card>
        <CardContent className="py-3 px-3 sm:px-6">
          <div className="flex flex-col gap-3">
            {/* Top row: Selected day info */}
            <div className="flex items-center justify-between min-h-8">
              <div className="text-sm whitespace-nowrap">
                {hoveredCell ? (
                  <span>
                    <span className="font-mono font-medium">
                      {formatValue(hoveredCell.value, metricType)}
                    </span>
                    <span className="text-muted-foreground ml-2">{hoveredCell.date}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Tap a day to see everything logged</span>
                )}
              </div>
              {/* Legend - compact */}
              {legendColors && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="hidden sm:inline">{direction === "neutral" ? "less" : "worse"}</span>
                  <div className="flex gap-0.5">
                    {legendColors.map((color, idx) => (
                      <div
                        key={idx}
                        className="w-3 h-3 sm:w-4 sm:h-4 rounded-sm"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                  <span className="hidden sm:inline">{direction === "neutral" ? "more" : "better"}</span>
                </div>
              )}
              {metricType === "checkbox" && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <div
                    className="w-3 h-3 rounded-sm"
                    style={{
                      backgroundColor: direction === "decrease" ? "var(--status-danger)" : "var(--heat-4)",
                    }}
                  />
                  <span>Done</span>
                </div>
              )}
            </div>

            {/* Bottom row: Year stats */}
            {yearStats && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <div>
                  <span className="font-mono">{yearStats.count}</span>
                  <span className="text-muted-foreground ml-1">days</span>
                </div>
                {showAvg && (
                  <div>
                    <span className="font-mono">{formatValue(yearStats.avg, metricType)}</span>
                    <span className="text-muted-foreground ml-1">avg</span>
                  </div>
                )}
                {showTotal && (
                  <div>
                    <span className="font-mono">{formatValue(yearStats.sum, metricType)}</span>
                    <span className="text-muted-foreground ml-1">total</span>
                  </div>
                )}
                {showMinMax && (
                  <>
                    <div>
                      <span className="font-mono">{formatValue(yearStats.min, metricType)}</span>
                      <span className="text-muted-foreground ml-1">min</span>
                    </div>
                    <div>
                      <span className="font-mono">{formatValue(yearStats.max, metricType)}</span>
                      <span className="text-muted-foreground ml-1">max</span>
                    </div>
                  </>
                )}
                {dailyGoal && yearStats.goalMetCount > 0 && (
                  <div>
                    <span className="font-mono">{yearStats.goalMetCount}</span>
                    <span className="text-muted-foreground ml-1">🏆 goals</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Heatmap */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {selectedConfig?.metric_name} - {selectedYear}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {view === "months" ? (
            <CalendarHeatmap
              data={heatmapData}
              year={selectedYear}
              metricType={metricType}
              direction={direction}
              selectedDate={detailOpen ? detailDate : hoveredCell?.date}
              onHover={handleHover}
              onCellClick={handleCellClick}
            />
          ) : (
            <YearGrid
              data={heatmapData}
              year={selectedYear}
              metricType={metricType}
              direction={direction}
              selectedDate={detailOpen ? detailDate : hoveredCell?.date}
              onHover={handleHover}
              onCellClick={handleCellClick}
            />
          )}
        </CardContent>
      </Card>

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
