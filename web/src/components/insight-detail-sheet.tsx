"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { getAuthHeaders } from "@/lib/authHeaders";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from "recharts";
import { ChartTooltip } from "@/components/chart-tooltip";

type InsightDetailSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  insightType: string | null;
  insightId: string | null;
  metricIds: string[];
  metricNames: string[];
  showPrivate?: boolean;
};

type RangeOption = "30d" | "90d" | "1y" | "all";
type GroupOption = "week" | "month" | "year";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DetailData = Record<string, any>;

/** Lag encoded in relationship insight ids: tl:a:b (1 day), tl:a:b:2, nn1:a:b. */
function lagFromInsightId(id: string | null): number | null {
  if (!id) return null;
  if (id.startsWith("nn1:")) return 1;
  if (id.startsWith("nn:")) return 0;
  if (id.startsWith("tl:")) {
    const parts = id.split(":");
    return parts.length > 3 ? Number(parts[3]) || 1 : 1;
  }
  return null;
}

function laterLabel(lag: number): string {
  return lag === 1 ? "The day after" : `${lag} days after`;
}

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  return `${month}/${day}/${year}`;
}

function formatShortDate(dateStr: string): string {
  return dateStr.slice(5); // MM-DD
}

export function InsightDetailSheet({
  open,
  onOpenChange,
  insightType,
  insightId,
  metricIds,
  metricNames,
  showPrivate,
}: InsightDetailSheetProps) {
  const isMobile = useMediaQuery("(max-width: 639px)");
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeOption>("all");
  const [groupBy, setGroupBy] = useState<GroupOption>("month");
  const [candlestickPeriod, setCandlestickPeriod] = useState<"weekly" | "monthly">("weekly");

  // Mobile swipe-to-close
  const touchStartY = useRef(0);
  const touchDeltaY = useRef(0);
  const swipeActive = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    touchDeltaY.current = 0;
    swipeActive.current = false;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    touchDeltaY.current = e.touches[0].clientY - touchStartY.current;
    if (touchDeltaY.current > 10 && scrollRef.current?.scrollTop === 0) {
      swipeActive.current = true;
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (swipeActive.current && touchDeltaY.current > 100) {
      onOpenChange(false);
    }
  }, [onOpenChange]);

  // Reset candlestick period when sheet opens for a new insight
  useEffect(() => {
    if (open && insightType === "candlestick") {
      setCandlestickPeriod("weekly");
    }
  }, [open, insightType, insightId]);

  useEffect(() => {
    if (!open || !insightType || metricIds.length === 0) {
      setData(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const headers = await getAuthHeaders();
        const params = new URLSearchParams({ type: insightType, metrics: metricIds.join(",") });
        if (insightType === "trend" || insightType === "histogram" || insightType === "cumulative") {
          params.set("range", range);
        }
        if (insightType === "candlestick") {
          params.set("period", candlestickPeriod);
        }
        const lag = lagFromInsightId(insightId);
        if (lag !== null) params.set("lag", String(lag));
        if (showPrivate) params.set("showPrivate", "true");

        const res = await fetch(`/api/insights/detail?${params}`, { headers });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || "Failed to load detail");
        if (!cancelled) setData(json);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, insightType, insightId, metricIds, range, showPrivate, candlestickPeriod]);

  const title = insightType
    ? {
        trend: "Trend Detail",
        day_of_week: "Weekly Pattern",
        numeric_numeric: "Metric Correlation",
        time_lagged: "Next-Day Effect",
        checkbox_numeric: "Habit Impact",
        checkbox_checkbox: "Habit Pair",
        histogram: "Value Distribution",
        cumulative: "Cumulative Total",
        year_over_year: "Year-over-Year",
        streak_timeline: "Streak Analysis",
        candlestick: "Volatility Analysis",
      }[insightType] || "Insight Detail"
    : "Insight Detail";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={
          isMobile
            ? "h-[90vh] overflow-hidden flex flex-col rounded-t-xl"
            : "sm:max-w-[560px] overflow-hidden flex flex-col"
        }
        storageKey="insight_detail_sheet_width"
        defaultWidth={560}
      >
        {isMobile && (
          <div className="flex justify-center pt-2 pb-1">
            <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
          </div>
        )}
        <SheetHeader className="flex-shrink-0">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {metricNames.join(" & ")}
          </SheetDescription>
        </SheetHeader>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto mt-4 space-y-4"
          onTouchStart={isMobile ? handleTouchStart : undefined}
          onTouchMove={isMobile ? handleTouchMove : undefined}
          onTouchEnd={isMobile ? handleTouchEnd : undefined}
        >
          {loading && !data && (
            <p className="text-muted-foreground text-sm py-8 text-center">
              Loading...
            </p>
          )}
          {error && (
            <div className="bg-destructive/10 text-destructive p-4 rounded-lg text-sm">
              {error}
            </div>
          )}
          {data && (
            <div className={loading ? "opacity-50 pointer-events-none transition-opacity duration-200" : "transition-opacity duration-200"}>
              {insightType === "trend" && (
                <TrendDetail data={data} range={range} setRange={setRange} groupBy={groupBy} setGroupBy={setGroupBy} />
              )}
              {insightType === "day_of_week" && <DayOfWeekDetail data={data} />}
              {insightType === "numeric_numeric" && <NumericNumericDetail data={data} />}
              {insightType === "checkbox_numeric" && <CheckboxNumericDetail data={data} />}
              {insightType === "time_lagged" && <TimeLaggedDetail data={data} />}
              {insightType === "checkbox_checkbox" && <CheckboxCheckboxDetail data={data} />}
              {insightType === "histogram" && <HistogramDetail data={data} />}
              {insightType === "cumulative" && <CumulativeDetail data={data} />}
              {insightType === "year_over_year" && <YearOverYearDetail data={data} />}
              {insightType === "streak_timeline" && <StreakTimelineDetail data={data} />}
              {insightType === "candlestick" && (
                <CandlestickDetail
                  data={data}
                  period={candlestickPeriod}
                  setPeriod={setCandlestickPeriod}
                />
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function formatValue(val: number, metricType?: string): string {
  if (metricType === "time" || metricType === "hhmm") {
    const totalMins = Math.round(val);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    return `${hrs}:${String(mins).padStart(2, "0")}`;
  }
  return String(Math.round(val * 100) / 100);
}

function formatPeriod(period: string, group: GroupOption): string {
  if (group === "week") {
    const d = new Date(period + "T00:00:00");
    const month = d.toLocaleString("default", { month: "short" });
    return `Week of ${month} ${d.getDate()}, ${d.getFullYear()}`;
  } else if (group === "month") {
    const d = new Date(period + "-01T00:00:00");
    return d.toLocaleString("default", { month: "long", year: "numeric" });
  } else {
    return period;
  }
}

function aggregatePoints(
  points: { date: string; value: number }[],
  group: GroupOption
): { period: string; avg: number; total: number; count: number }[] {
  const buckets = new Map<string, { sum: number; count: number }>();
  for (const p of points) {
    let key: string;
    const d = new Date(p.date + "T00:00:00");
    if (group === "week") {
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d);
      monday.setDate(diff);
      key = monday.toISOString().slice(0, 10);
    } else if (group === "year") {
      key = p.date.slice(0, 4);
    } else {
      key = p.date.slice(0, 7);
    }
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.sum += p.value;
      bucket.count++;
    } else {
      buckets.set(key, { sum: p.value, count: 1 });
    }
  }
  return Array.from(buckets.entries())
    .map(([period, { sum, count }]) => ({
      period,
      avg: Math.round((sum / count) * 100) / 100,
      total: Math.round(sum * 100) / 100,
      count,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

// --- Trend Detail ---
function TrendDetail({
  data,
  range,
  setRange,
  groupBy,
  setGroupBy,
}: {
  data: DetailData;
  range: RangeOption;
  setRange: (r: RangeOption) => void;
  groupBy: GroupOption;
  setGroupBy: (g: GroupOption) => void;
}) {
  const hib = data.higherIsBetter !== false;
  const metricType = data.metricType as string | undefined;
  const isCount = metricType === "count";
  const ranges: RangeOption[] = ["30d", "90d", "1y", "all"];
  const groups: GroupOption[] = ["week", "month", "year"];
  const [aggMode, setAggMode] = useState<"avg" | "total">("avg");

  const aggregated = useMemo(() => {
    if (!data?.points) return [];
    return aggregatePoints(data.points, groupBy);
  }, [data?.points, groupBy]);

  const aggDataKey = isCount && aggMode === "total" ? "total" : "avg";
  const aggLabel = isCount && aggMode === "total" ? "Total" : "Avg";

  const ma7Points = useMemo(() => {
    const pts = data.points as { date: string; value: number }[] | undefined;
    if (!pts || pts.length < 7) return pts || [];
    return pts.map((p: { date: string; value: number }, i: number) => {
      if (i < 6) return { ...p, ma7: undefined };
      const window = pts.slice(i - 6, i + 1);
      const avg = window.reduce((s: number, w: { value: number }) => s + w.value, 0) / 7;
      return { ...p, ma7: Math.round(avg * 100) / 100 };
    });
  }, [data?.points]);

  const showMa7 = ma7Points.length > 14;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {ranges.map((r) => (
          <Button
            key={r}
            variant={range === r ? "default" : "outline"}
            size="sm"
            onClick={() => setRange(r)}
          >
            {r === "all" ? "All" : r}
          </Button>
        ))}
      </div>

      {data.points?.length > 0 && (
        <Card>
          <CardContent className="px-2 pt-4 pb-2">
            <p className="text-sm font-medium mb-2 px-2">Daily Values</p>
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={ma7Points}
                  margin={{ top: 5, right: 10, left: -10, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    tickFormatter={formatShortDate}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => formatValue(v, metricType)} />
                  <Tooltip
                    content={<ChartTooltip formatter={(e) => {
                      const label = e.name === "ma7" ? "7-day avg" : "Value";
                      return `${label}: ${formatValue(Number(e.value), metricType)}`;
                    }} />}
                  />
                  <ReferenceLine
                    y={data.overallAvg}
                    stroke="#888"
                    strokeDasharray="3 3"
                    label={{ value: `Avg: ${formatValue(data.overallAvg, metricType)}`, fontSize: 10, fill: "#888" }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="var(--chart-1)"
                    dot={false}
                    strokeWidth={1.5}
                    animationDuration={300}
                  />
                  {showMa7 && (
                    <Line
                      type="monotone"
                      dataKey="ma7"
                      stroke="var(--chart-4)"
                      dot={false}
                      strokeWidth={2}
                      strokeDasharray="5 5"
                      name="ma7"
                      connectNulls
                      animationDuration={300}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Group by:</span>
          {groups.map((g) => (
            <Button
              key={g}
              variant={groupBy === g ? "default" : "outline"}
              size="sm"
              onClick={() => setGroupBy(g)}
            >
              {g.charAt(0).toUpperCase() + g.slice(1)}
            </Button>
          ))}
        </div>

        {isCount && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Show:</span>
            {(["avg", "total"] as const).map((m) => (
              <Button
                key={m}
                variant={aggMode === m ? "default" : "outline"}
                size="sm"
                onClick={() => setAggMode(m)}
              >
                {m === "avg" ? "Average" : "Total"}
              </Button>
            ))}
          </div>
        )}
      </div>

      {aggregated.length > 0 && (
        <Card>
          <CardContent className="px-2 pt-4 pb-2">
            <p className="text-sm font-medium mb-2 px-2">
              {groupBy.charAt(0).toUpperCase() + groupBy.slice(1)}ly {aggLabel}s
            </p>
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={aggregated}
                  margin={{ top: 5, right: 10, left: -10, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="period"
                    tick={{ fontSize: 10 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => formatValue(v, metricType)} />
                  <Tooltip
                    content={({ payload, label }) => {
                      if (!payload?.[0]) return null;
                      return (
                        <div className="bg-background border rounded p-2 text-xs shadow">
                          <p className="text-muted-foreground">{formatPeriod(String(label), groupBy)}</p>
                          <p className="font-medium">{aggLabel}: {formatValue(payload[0].value as number, metricType)}</p>
                          {payload[0].payload?.count != null && (
                            <p className="text-muted-foreground">{payload[0].payload.count} days</p>
                          )}
                        </div>
                      );
                    }}
                  />
                  {aggDataKey === "avg" && (
                    <ReferenceLine
                      y={data.overallAvg}
                      stroke="#888"
                      strokeDasharray="3 3"
                    />
                  )}
                  <Bar dataKey={aggDataKey} radius={[3, 3, 0, 0]} animationDuration={300}>
                    {aggregated.map(
                      (entry, i) => {
                        const refVal = aggDataKey === "avg" ? data.overallAvg : undefined;
                        const aboveAvg = refVal != null ? entry[aggDataKey] >= refVal : true;
                        const isGood = hib ? aboveAvg : !aboveAvg;
                        return (
                          <Cell
                            key={i}
                            fill={refVal != null ? (isGood ? "var(--status-good)" : "var(--status-danger)") : "var(--chart-1)"}
                            fillOpacity={0.7}
                          />
                        );
                      }
                    )}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-muted-foreground px-2 mt-1">
              {aggregated.length} periods &middot; Overall avg: {formatValue(data.overallAvg, metricType)}
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}

// --- Day of Week Detail ---
type DowView = "weekly" | "monthly";

function DayOfWeekDetail({ data }: { data: DetailData }) {
  const hib = data.higherIsBetter !== false;
  const metricType = data.metricType as string | undefined;
  const isCount = metricType === "count";
  const dayAverages = data.dayAverages as { day: string; avg: number; total: number; count: number }[];
  const overallAvg = data.overallAvg as number;
  const [aggMode, setAggMode] = useState<"avg" | "total">("avg");
  const [view, setView] = useState<DowView>("weekly");
  const [hoveredCell, setHoveredCell] = useState<{ date: string; value: number } | null>(null);

  const dataKey = isCount && aggMode === "total" ? "total" : "avg";
  const label = isCount && aggMode === "total" ? "Total" : "Avg";

  return (
    <>
      <div className="sticky top-0 z-10 bg-background pb-2 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">View:</span>
          {(["weekly", "monthly"] as const).map((v) => (
            <Button key={v} variant={view === v ? "default" : "outline"} size="sm" onClick={() => setView(v)}>
              {v === "weekly" ? "Weekly" : "Calendar"}
            </Button>
          ))}
        </div>
        {view === "monthly" && (
          <p className="text-sm min-h-[20px]">
            {hoveredCell ? (
              <>
                <span className="text-muted-foreground">{formatDate(hoveredCell.date)}: </span>
                <span className="font-semibold">{formatValue(hoveredCell.value, metricType)}</span>
              </>
            ) : (
              <span className="text-muted-foreground">Hover a date to see its value</span>
            )}
          </p>
        )}

        {isCount && view === "weekly" && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Show:</span>
            {(["avg", "total"] as const).map((m) => (
              <Button key={m} variant={aggMode === m ? "default" : "outline"} size="sm" onClick={() => setAggMode(m)}>
                {m === "avg" ? "Average" : "Total"}
              </Button>
            ))}
          </div>
        )}
      </div>

      {view === "weekly" && (
        <Card>
          <CardContent className="px-2 pt-4 pb-2">
            <p className="text-sm font-medium mb-2 px-2">
              {data.metricName} by Day of Week
            </p>
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={dayAverages}
                  margin={{ top: 5, right: 10, left: -10, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} tickFormatter={(d) => d.slice(0, 3)} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => formatValue(v, metricType)} />
                  <Tooltip
                    formatter={(value: number, _name: string, props: { payload?: { count?: number } }) => [
                      `${formatValue(value, metricType)} (${props.payload?.count} days)`,
                      label,
                    ]}
                  />
                  {dataKey === "avg" && (
                    <ReferenceLine
                      y={overallAvg}
                      stroke="#888"
                      strokeDasharray="3 3"
                      label={{ value: `Avg: ${formatValue(overallAvg, metricType)}`, fontSize: 10, fill: "#888" }}
                    />
                  )}
                  <Bar dataKey={dataKey} radius={[3, 3, 0, 0]} animationDuration={300}>
                    {dayAverages.map((entry, i) => {
                      const refVal = dataKey === "avg" ? overallAvg : undefined;
                      const aboveAvg = refVal != null ? entry[dataKey] >= refVal : true;
                      const isGood = hib ? aboveAvg : !aboveAvg;
                      return (
                        <Cell
                          key={i}
                          fill={refVal != null ? (isGood ? "var(--status-good)" : "var(--status-danger)") : "var(--chart-1)"}
                          fillOpacity={0.7}
                        />
                      );
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {view === "monthly" && data.dailyValues && (
        <CalendarHeatmap
          data={data.dailyValues as { date: string; value: number }[]}
          metricType={metricType}
          higherIsBetter={hib}
          hoveredCell={hoveredCell}
          onHover={setHoveredCell}
        />
      )}
    </>
  );
}

function CalendarHeatmap({
  data,
  higherIsBetter,
  hoveredCell,
  onHover,
}: {
  data: { date: string; value: number }[];
  metricType?: string;
  higherIsBetter: boolean;
  hoveredCell: { date: string; value: number } | null;
  onHover: (cell: { date: string; value: number } | null) => void;
}) {
  const valueMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data) m.set(d.date, d.value);
    return m;
  }, [data]);

  const months = useMemo(() => {
    if (data.length === 0) return [];
    const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));
    const first = sorted[0].date;
    const last = sorted[sorted.length - 1].date;
    const result: string[] = [];
    const d = new Date(first.slice(0, 7) + "-01T00:00:00");
    const end = new Date(last.slice(0, 7) + "-01T00:00:00");
    while (d <= end) {
      result.push(d.toISOString().slice(0, 7));
      d.setMonth(d.getMonth() + 1);
    }
    return result.sort().reverse();
  }, [data]);

  const allValues = data.map((d) => d.value);
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const valRange = maxVal - minVal || 1;

  function getColor(value: number): string {
    const t = (value - minVal) / valRange;
    if (higherIsBetter) {
      if (t < 0.5) {
        const s = t * 2;
        const r = Math.round(220 - s * 40);
        const g = Math.round(60 + s * 160);
        const b = Math.round(60 + s * 10);
        return `rgb(${r}, ${g}, ${b})`;
      } else {
        const s = (t - 0.5) * 2;
        const r = Math.round(180 - s * 140);
        const g = Math.round(220 - s * 25);
        const b = Math.round(70 + s * 30);
        return `rgb(${r}, ${g}, ${b})`;
      }
    } else {
      if (t < 0.5) {
        const s = t * 2;
        const r = Math.round(40 + s * 140);
        const g = Math.round(195 - s * 25);
        const b = Math.round(100 - s * 30);
        return `rgb(${r}, ${g}, ${b})`;
      } else {
        const s = (t - 0.5) * 2;
        const r = Math.round(180 + s * 40);
        const g = Math.round(170 - s * 110);
        const b = Math.round(70 - s * 10);
        return `rgb(${r}, ${g}, ${b})`;
      }
    }
  }

  const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

  return (
    <div className="grid grid-cols-2 gap-3">
      {months.map((month) => {
        const [y, m] = month.split("-").map(Number);
        const firstDay = new Date(y, m - 1, 1);
        const daysInMonth = new Date(y, m, 0).getDate();
        const startDow = firstDay.getDay();
        const cells: (null | { day: number; date: string; value: number | undefined })[] = [];
        for (let i = 0; i < startDow; i++) cells.push(null);
        for (let day = 1; day <= daysInMonth; day++) {
          const ds = `${month}-${String(day).padStart(2, "0")}`;
          cells.push({ day, date: ds, value: valueMap.get(ds) });
        }

        return (
          <Card key={month} className="overflow-hidden">
            <CardContent className="px-2 pt-2 pb-1.5">
              <p className="text-[10px] font-medium mb-1 text-muted-foreground">
                {firstDay.toLocaleString("default", { month: "short" })} {y}
              </p>
              <div className="grid grid-cols-7 gap-px">
                {DAY_LABELS.map((d, i) => (
                  <div key={`${d}${i}`} className="text-[7px] text-muted-foreground/60 text-center">{d}</div>
                ))}
                {cells.map((cell, i) => {
                  if (!cell) return <div key={`e${i}`} />;
                  const hasValue = cell.value !== undefined;
                  const isHovered = hoveredCell?.date === cell.date;
                  return (
                    <div
                      key={cell.date}
                      className={`aspect-square rounded-[2px] flex items-center justify-center text-[7px] cursor-default transition-transform duration-100 ${isHovered ? "ring-2 ring-foreground shadow-lg" : ""}`}
                      style={{
                        backgroundColor: hasValue ? getColor(cell.value!) : "var(--muted)",
                        opacity: hasValue ? 1 : 0.2,
                        transform: isHovered ? "scale(1.8)" : "scale(1)",
                        zIndex: isHovered ? 10 : 0,
                        position: "relative",
                        color: hasValue ? "rgba(0,0,0,0.5)" : undefined,
                      }}
                      onMouseEnter={() => hasValue && onHover({ date: cell.date, value: cell.value! })}
                      onMouseLeave={() => onHover(null)}
                    >
                      {cell.day}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// --- Numeric Numeric Detail (Scatter) ---
function NumericNumericDetail({ data }: { data: DetailData }) {
  const points = data.points as { date: string; valueA: number; valueB: number }[];
  const correlation = data.correlation as number;
  const strength =
    Math.abs(correlation) >= 0.5 ? "Strong" : Math.abs(correlation) >= 0.3 ? "Moderate" : "Slight";
  const dir = correlation > 0 ? "positive" : "negative";

  return (
    <>
      <div className="text-center">
        <p className="text-3xl font-bold font-mono">
          r = {correlation > 0 ? "+" : ""}
          {correlation.toFixed(3)}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          {strength} {dir} link &middot; {points.length} {data.lag ? "day pairs" : "overlapping days"}
        </p>
        <p className="text-xs text-muted-foreground mt-1">Compares the same weekdays, so weekly routines don&apos;t skew it.</p>
        {data.lag ? (
          <p className="text-xs text-muted-foreground mt-1">
            {data.metricAName} on a day vs {data.metricBName} the next day
          </p>
        ) : null}
      </div>
      <Card>
        <CardContent className="px-2 pt-4 pb-2">
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 10, left: -10, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis
                  dataKey="valueA"
                  type="number"
                  domain={["auto", "auto"]}
                  name={data.metricAName}
                  tick={{ fontSize: 10 }}
                  label={{ value: data.metricAName, position: "insideBottom", offset: -15, fontSize: 11 }}
                />
                <YAxis
                  dataKey="valueB"
                  type="number"
                  domain={["auto", "auto"]}
                  name={data.metricBName}
                  tick={{ fontSize: 10 }}
                  label={{
                    value: data.metricBName,
                    angle: -90,
                    position: "insideLeft",
                    fontSize: 11,
                    offset: 15,
                  }}
                />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  content={({ payload }) => {
                    if (!payload?.[0]) return null;
                    const p = payload[0].payload;
                    return (
                      <div className="bg-background border rounded p-2 text-xs shadow">
                        <p className="text-muted-foreground">{formatDate(p.date)}</p>
                        <p>{data.metricAName}: {p.valueA}</p>
                        <p>{data.metricBName}: {p.valueB}</p>
                      </div>
                    );
                  }}
                />
                <Scatter data={points} fill="var(--chart-1)" fillOpacity={0.6} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

// --- Checkbox Numeric Detail ---
function CheckboxNumericDetail({ data }: { data: DetailData }) {
  const hib = data.numericHigherIsBetter !== false;
  const barData = [
    { label: "Checked", avg: data.avgWhenTrue, count: data.daysTrue },
    { label: "Not Checked", avg: data.avgWhenFalse, count: data.daysFalse },
  ];
  const higher = data.avgWhenTrue > data.avgWhenFalse;
  const diff = data.avgWhenTrue - data.avgWhenFalse;

  return (
    <>
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          When you <span className="font-medium text-foreground">{data.checkboxName}</span>
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          <span className="font-medium text-foreground">{data.numericName}</span> is{" "}
          <span className="font-bold">
            {higher ? "+" : ""}{Math.round(diff * 100) / 100}
          </span>{" "}
          ({higher ? "higher" : "lower"})
        </p>
      </div>
      <Card>
        <CardContent className="px-2 pt-4 pb-2">
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip formatter={(value: number, _: string, props: { payload?: { count?: number } }) => [`${value} (${props.payload?.count} days)`, "Avg"]} />
                <Bar dataKey="avg" radius={[3, 3, 0, 0]}>
                  {barData.map((entry, i) => {
                    const isHigher = entry.avg >= barData[1 - i].avg;
                    const isGood = hib ? isHigher : !isHigher;
                    return <Cell key={i} fill={isGood ? "var(--status-good)" : "var(--status-danger)"} fillOpacity={0.7} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {data.distribution?.length > 0 && (
        <Card>
          <CardContent className="px-2 pt-4 pb-2">
            <p className="text-sm font-medium mb-2 px-2">Daily Distribution</p>
            <div style={{ width: "100%", height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="date" tick={{ fontSize: 9 }} tickFormatter={formatShortDate} interval="preserveStartEnd" />
                  <YAxis dataKey="value" tick={{ fontSize: 10 }} />
                  <Tooltip content={<ChartTooltip formatter={(e) => `${e.name}: ${e.value}`} />} />
                  <Scatter
                    data={(data.distribution as { date: string; value: number; checked: boolean }[]).filter((d) => d.checked)}
                    fill="var(--status-good)"
                    fillOpacity={0.6}
                    name="Checked"
                  />
                  <Scatter
                    data={(data.distribution as { date: string; value: number; checked: boolean }[]).filter((d) => !d.checked)}
                    fill="var(--chart-axis)"
                    fillOpacity={0.4}
                    name="Not checked"
                  />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}

// --- Time Lagged Detail ---
function TimeLaggedDetail({ data }: { data: DetailData }) {
  const hib = data.outcomeHigherIsBetter !== false;
  const barData = [
    { label: "After Checked", avg: data.avgNextDayWhenTrue, count: data.daysTrue },
    { label: "After Not Checked", avg: data.avgNextDayWhenFalse, count: data.daysFalse },
  ];

  return (
    <>
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          {laterLabel(data.lag ?? 1)} <span className="font-medium text-foreground">{data.triggerName}</span>
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          <span className="font-medium text-foreground">{data.outcomeName}</span> averages
        </p>
      </div>
      <Card>
        <CardContent className="px-2 pt-4 pb-2">
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip formatter={(value: number, _: string, props: { payload?: { count?: number } }) => [`${value} (${props.payload?.count} days)`, "Avg"]} />
                <Bar dataKey="avg" radius={[3, 3, 0, 0]}>
                  {barData.map((entry, i) => {
                    const isHigher = entry.avg >= barData[1 - i].avg;
                    const isGood = hib ? isHigher : !isHigher;
                    return <Cell key={i} fill={isGood ? "var(--status-good)" : "var(--status-danger)"} fillOpacity={0.7} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

// --- Checkbox Checkbox Detail ---
function CheckboxCheckboxDetail({ data }: { data: DetailData }) {
  const barData = [
    { label: `When ${data.metricAName}`, rate: data.rateWhenATrue, count: data.daysATrue },
    { label: `Without ${data.metricAName}`, rate: data.rateWhenAFalse, count: data.daysAFalse },
  ];

  return (
    <>
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          Rate of <span className="font-medium text-foreground">{data.metricBName}</span>
        </p>
      </div>
      <Card>
        <CardContent className="px-2 pt-4 pb-2">
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                <Tooltip formatter={(value: number, _: string, props: { payload?: { count?: number } }) => [`${value}% (${props.payload?.count} days)`, "Rate"]} />
                <Bar dataKey="rate" radius={[3, 3, 0, 0]}>
                  {barData.map((entry, i) => (
                    <Cell
                      key={i}
                      fill={i === 0 ? "var(--chart-1)" : "var(--chart-axis)"}
                      fillOpacity={0.7}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

// --- Histogram Detail ---
function HistogramDetail({ data }: { data: DetailData }) {
  const bins = data.bins as { binStart: number; binEnd: number; count: number; label: string }[];
  const stats = data.stats as {
    mean: number; median: number; stdDev: number; min: number; max: number;
    count: number; skewness: number; p25: number; p75: number;
  } | null;
  const metricType = data.metricType as string | undefined;

  if (!bins || bins.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-4">No data available</p>;
  }

  return (
    <>
      <Card>
        <CardContent className="px-2 pt-4 pb-2">
          <p className="text-sm font-medium mb-2 px-2">{data.metricName} Distribution</p>
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bins} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={0} angle={-30} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip
                  content={({ payload }) => {
                    if (!payload?.[0]) return null;
                    const p = payload[0].payload;
                    return (
                      <div className="bg-background border rounded p-2 text-xs shadow">
                        <p className="font-medium">{formatValue(p.binStart, metricType)} - {formatValue(p.binEnd, metricType)}</p>
                        <p>{p.count} days</p>
                      </div>
                    );
                  }}
                />
                {stats && (
                  <ReferenceLine
                    x={bins.findIndex((b) => stats.mean >= b.binStart && stats.mean < b.binEnd) >= 0
                      ? bins[bins.findIndex((b) => stats.mean >= b.binStart && stats.mean < b.binEnd)].label
                      : undefined}
                    stroke="var(--chart-4)"
                    strokeDasharray="5 5"
                    label={{ value: `Mean: ${formatValue(stats.mean, metricType)}`, fontSize: 9, fill: "var(--chart-4)", position: "top" }}
                  />
                )}
                <Bar dataKey="count" fill="var(--chart-1)" fillOpacity={0.7} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {stats && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium mb-3">Statistics</p>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground text-xs">Mean</p>
                <p className="font-mono font-semibold">{formatValue(stats.mean, metricType)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Median</p>
                <p className="font-mono font-semibold">{formatValue(stats.median, metricType)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Std Dev</p>
                <p className="font-mono font-semibold">{formatValue(stats.stdDev, metricType)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Min</p>
                <p className="font-mono font-semibold">{formatValue(stats.min, metricType)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Max</p>
                <p className="font-mono font-semibold">{formatValue(stats.max, metricType)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Count</p>
                <p className="font-mono font-semibold">{stats.count}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">P25</p>
                <p className="font-mono font-semibold">{formatValue(stats.p25, metricType)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">P75</p>
                <p className="font-mono font-semibold">{formatValue(stats.p75, metricType)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Skewness</p>
                <p className="font-mono font-semibold">{stats.skewness}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}

// --- Cumulative Detail ---
function CumulativeDetail({ data }: { data: DetailData }) {
  const points = data.points as { date: string; dailyValue: number; cumulativeTotal: number }[];
  const metricType = data.metricType as string | undefined;

  // Build pace line data
  const paceData = useMemo(() => {
    if (!points || points.length < 2) return [];
    const lastPoint = points[points.length - 1];
    const lastDate = new Date(lastPoint.date + "T00:00:00");
    const yearEnd = new Date(lastDate.getFullYear(), 11, 31);

    return [
      { date: lastPoint.date, cumulativeTotal: lastPoint.cumulativeTotal, pace: lastPoint.cumulativeTotal },
      { date: yearEnd.toISOString().slice(0, 10), cumulativeTotal: undefined, pace: data.projectedYearEnd },
    ];
  }, [points, data.projectedYearEnd]);

  return (
    <>
      <div className="grid grid-cols-3 gap-3 text-center">
        <div>
          <p className="text-xs text-muted-foreground">Total</p>
          <p className="text-xl font-bold font-mono">{formatValue(data.currentTotal, metricType)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Daily Rate</p>
          <p className="text-xl font-bold font-mono">{formatValue(data.dailyRate, metricType)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Year-End Est.</p>
          <p className="text-xl font-bold font-mono">{formatValue(data.projectedYearEnd, metricType)}</p>
        </div>
      </div>

      {points.length > 0 && (
        <Card>
          <CardContent className="px-2 pt-4 pb-2">
            <p className="text-sm font-medium mb-2 px-2">Cumulative Total</p>
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={points}
                  margin={{ top: 5, right: 10, left: -10, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    tickFormatter={formatShortDate}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => formatValue(v, metricType)} />
                  <Tooltip
                    content={<ChartTooltip formatter={(e) => {
                      const label = e.name === "cumulativeTotal" ? "Total" : "Daily";
                      return `${label}: ${formatValue(Number(e.value), metricType)}`;
                    }} />}
                  />
                  <Area
                    type="monotone"
                    dataKey="cumulativeTotal"
                    stroke="var(--chart-1)"
                    fill="var(--chart-1)"
                    fillOpacity={0.15}
                    strokeWidth={2}
                    animationDuration={300}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {paceData.length > 0 && (
        <Card>
          <CardContent className="px-2 pt-4 pb-2">
            <p className="text-sm font-medium mb-2 px-2">Year-End Projection</p>
            <div style={{ width: "100%", height: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={paceData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={formatShortDate} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => formatValue(v, metricType)} />
                  <Tooltip content={<ChartTooltip formatter={(e) => `${formatValue(Number(e.value), metricType)}`} />} />
                  <Line type="monotone" dataKey="pace" stroke="var(--chart-4)" strokeDasharray="8 4" strokeWidth={2} dot animationDuration={300} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-muted-foreground px-2 mt-1">
              At {formatValue(data.dailyRate, metricType)}/day, projected year-end: {formatValue(data.projectedYearEnd, metricType)}
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}

// --- Year-over-Year Detail ---
function YearOverYearDetail({ data }: { data: DetailData }) {
  const years = data.years as {
    year: number; color: string;
    dataPoints: { dayOfYear: number; date: string; value: number; ma7?: number }[];
    avg: number; count: number;
  }[];
  const metricType = data.metricType as string | undefined;
  const [enabledYears, setEnabledYears] = useState<Set<number>>(() => new Set(years.map((y) => y.year)));
  const [showMa7, setShowMa7] = useState(false);

  const MONTH_TICKS = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Merge all year data into a single series per year for the chart
  const chartData = useMemo(() => {
    const dayMap = new Map<number, Record<string, number | undefined>>();
    for (const yearInfo of years) {
      if (!enabledYears.has(yearInfo.year)) continue;
      for (const dp of yearInfo.dataPoints) {
        const existing = dayMap.get(dp.dayOfYear) || { dayOfYear: dp.dayOfYear };
        existing[`y${yearInfo.year}`] = dp.value;
        if (showMa7 && dp.ma7 !== undefined) {
          existing[`ma7_${yearInfo.year}`] = dp.ma7;
        }
        dayMap.set(dp.dayOfYear, existing);
      }
    }
    return Array.from(dayMap.values()).sort((a, b) => (a.dayOfYear as number) - (b.dayOfYear as number));
  }, [years, enabledYears, showMa7]);

  const toggleYear = (year: number) => {
    setEnabledYears((prev) => {
      const next = new Set(prev);
      if (next.has(year)) {
        if (next.size > 1) next.delete(year);
      } else {
        next.add(year);
      }
      return next;
    });
  };

  return (
    <>
      <div className="flex flex-wrap gap-2 items-center">
        {years.map((y) => (
          <button
            key={y.year}
            onClick={() => toggleYear(y.year)}
            className={`px-3 py-1 rounded-full text-sm font-medium border transition-colors ${
              enabledYears.has(y.year) ? "text-white" : "opacity-40"
            }`}
            style={{
              backgroundColor: enabledYears.has(y.year) ? y.color : "transparent",
              borderColor: y.color,
              color: enabledYears.has(y.year) ? "white" : y.color,
            }}
          >
            {y.year} ({formatValue(y.avg, metricType)})
          </button>
        ))}
        <Button
          variant={showMa7 ? "default" : "outline"}
          size="sm"
          onClick={() => setShowMa7(!showMa7)}
        >
          MA7
        </Button>
      </div>

      <Card>
        <CardContent className="px-2 pt-4 pb-2">
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis
                  dataKey="dayOfYear"
                  tick={{ fontSize: 9 }}
                  ticks={MONTH_TICKS}
                  tickFormatter={(v) => MONTH_LABELS[MONTH_TICKS.indexOf(v)] || ""}
                />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => formatValue(v, metricType)} />
                <Tooltip
                  content={({ payload }) => {
                    if (!payload || payload.length === 0) return null;
                    return (
                      <div className="bg-background border rounded p-2 text-xs shadow">
                        {payload.map((p) => {
                          if (p.value == null) return null;
                          const name = String(p.dataKey);
                          const isMa = name.startsWith("ma7_");
                          const year = name.replace("y", "").replace("ma7_", "");
                          return (
                            <p key={name} style={{ color: p.color }}>
                              {year}{isMa ? " (MA7)" : ""}: {formatValue(p.value as number, metricType)}
                            </p>
                          );
                        })}
                      </div>
                    );
                  }}
                />
                {years.filter((y) => enabledYears.has(y.year)).map((y) => (
                  <Line
                    key={y.year}
                    type="monotone"
                    dataKey={`y${y.year}`}
                    stroke={y.color}
                    dot={false}
                    strokeWidth={1.5}
                    connectNulls
                    animationDuration={300}
                  />
                ))}
                {showMa7 && years.filter((y) => enabledYears.has(y.year)).map((y) => (
                  <Line
                    key={`ma7_${y.year}`}
                    type="monotone"
                    dataKey={`ma7_${y.year}`}
                    stroke={y.color}
                    dot={false}
                    strokeWidth={2.5}
                    strokeDasharray="5 3"
                    connectNulls
                    animationDuration={300}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <p className="text-sm font-medium mb-3">Year Averages</p>
          <div className="space-y-2">
            {years.map((y) => (
              <div key={y.year} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: y.color }} />
                  <span className="font-medium">{y.year}</span>
                </div>
                <div className="text-right">
                  <span className="font-mono">{formatValue(y.avg, metricType)}</span>
                  <span className="text-xs text-muted-foreground ml-2">({y.count} days)</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

// --- Streak Timeline Detail ---
function StreakTimelineDetail({ data }: { data: DetailData }) {
  const streaks = data.streaks as { startDate: string; endDate: string; length: number; type: "active" | "gap" }[];
  const stats = data.stats as {
    currentStreak: number; longestStreak: number; averageStreak: number;
    totalStreaks: number; totalActiveDays: number; totalTrackedDays: number; activeRate: number;
  };

  // Streak length distribution for bar chart
  const activeStreaks = streaks.filter((s) => s.type === "active");
  const streakLengths = activeStreaks.map((s) => s.length);
  const maxLen = Math.max(...streakLengths, 1);
  const buckets: { range: string; count: number }[] = [];
  const bucketSize = maxLen <= 10 ? 1 : maxLen <= 30 ? 5 : 10;
  for (let i = 1; i <= maxLen; i += bucketSize) {
    const end = Math.min(i + bucketSize - 1, maxLen);
    const label = bucketSize === 1 ? `${i}` : `${i}-${end}`;
    const count = streakLengths.filter((l) => l >= i && l <= end).length;
    buckets.push({ range: label, count });
  }

  // Timeline visualization: show last 180 days of segments
  const timelineStreaks = useMemo(() => {
    if (streaks.length === 0) return [];
    const lastDate = streaks[streaks.length - 1].endDate;
    const cutoff = new Date(lastDate + "T00:00:00");
    cutoff.setDate(cutoff.getDate() - 180);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return streaks.filter((s) => s.endDate >= cutoffStr);
  }, [streaks]);

  const totalTimelineDays = useMemo(() => {
    if (timelineStreaks.length === 0) return 1;
    const first = new Date(timelineStreaks[0].startDate + "T00:00:00");
    const last = new Date(timelineStreaks[timelineStreaks.length - 1].endDate + "T00:00:00");
    return Math.max(1, (last.getTime() - first.getTime()) / 86400000 + 1);
  }, [timelineStreaks]);

  return (
    <>
      <div className="grid grid-cols-4 gap-3 text-center">
        <div>
          <p className="text-xs text-muted-foreground">Current</p>
          <p className="text-2xl font-bold font-mono">{stats.currentStreak}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Longest</p>
          <p className="text-2xl font-bold font-mono">{stats.longestStreak}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Average</p>
          <p className="text-2xl font-bold font-mono">{stats.averageStreak}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Active %</p>
          <p className="text-2xl font-bold font-mono">{stats.activeRate}%</p>
        </div>
      </div>

      {/* Timeline bars */}
      <Card>
        <CardContent className="p-4">
          <p className="text-sm font-medium mb-3">Streak Timeline (last 180 days)</p>
          <div className="flex rounded overflow-hidden" style={{ height: 32 }}>
            {timelineStreaks.map((s, i) => {
              const widthPct = (s.length / totalTimelineDays) * 100;
              return (
                <div
                  key={i}
                  className="relative group"
                  style={{
                    width: `${Math.max(widthPct, 0.5)}%`,
                    backgroundColor: s.type === "active" ? "var(--status-good)" : "var(--chart-grid)",
                    minWidth: 2,
                  }}
                  title={`${s.type === "active" ? "Streak" : "Gap"}: ${s.length}d (${s.startDate} to ${s.endDate})`}
                >
                  <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-background border rounded p-1 text-[10px] shadow hidden group-hover:block whitespace-nowrap z-10">
                    {s.type === "active" ? "Streak" : "Gap"}: {s.length}d
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
            <span>{timelineStreaks[0]?.startDate}</span>
            <span>{timelineStreaks[timelineStreaks.length - 1]?.endDate}</span>
          </div>
        </CardContent>
      </Card>

      {/* Streak length distribution */}
      {buckets.length > 0 && (
        <Card>
          <CardContent className="px-2 pt-4 pb-2">
            <p className="text-sm font-medium mb-2 px-2">Streak Length Distribution</p>
            <div style={{ width: "100%", height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={buckets} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="range" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                  <Tooltip formatter={(value: number) => [`${value} streaks`, "Count"]} />
                  <Bar dataKey="count" fill="var(--status-good)" fillOpacity={0.7} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4">
          <p className="text-sm font-medium mb-3">Summary</p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-muted-foreground text-xs">Total Streaks</p>
              <p className="font-mono font-semibold">{stats.totalStreaks}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Active Days</p>
              <p className="font-mono font-semibold">{stats.totalActiveDays} / {stats.totalTrackedDays}</p>
            </div>
            {data.threshold !== undefined && (
              <div className="col-span-2">
                <p className="text-muted-foreground text-xs">Threshold (median)</p>
                <p className="font-mono font-semibold">{formatValue(data.threshold, data.metricType)}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

// --- Candlestick Detail ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CandleShape(props: any) {
  const { x, y, width, payload, yScale } = props;
  if (!payload || !yScale) return null;

  const { open, high, low, close } = payload;
  const isGreen = close >= open;
  const color = isGreen ? "var(--status-good)" : "var(--status-danger)";

  const bodyTop = yScale(Math.max(open, close));
  const bodyBottom = yScale(Math.min(open, close));
  const bodyHeight = Math.max(Math.abs(bodyBottom - bodyTop), 1);

  const wickTop = yScale(high);
  const wickBottom = yScale(low);
  const centerX = x + width / 2;

  return (
    <g>
      {/* Wick */}
      <line
        x1={centerX}
        y1={wickTop}
        x2={centerX}
        y2={wickBottom}
        stroke={color}
        strokeWidth={1}
      />
      {/* Body */}
      <rect
        x={x + width * 0.15}
        y={bodyTop}
        width={width * 0.7}
        height={bodyHeight}
        fill={isGreen ? color : color}
        fillOpacity={isGreen ? 0.8 : 0.8}
        stroke={color}
        strokeWidth={1}
      />
    </g>
  );
}

function CandlestickDetail({
  data,
  period,
  setPeriod,
}: {
  data: DetailData;
  period: "weekly" | "monthly";
  setPeriod: (p: "weekly" | "monthly") => void;
}) {
  const candles = data.candles as {
    period: string; periodStart: string; periodEnd: string;
    open: number; high: number; low: number; close: number; count: number;
  }[];
  const metricType = data.metricType as string | undefined;

  // Compute Y domain
  const allHighs = candles.map((c) => c.high);
  const allLows = candles.map((c) => c.low);
  const yMin = Math.min(...allLows) * 0.95;
  const yMax = Math.max(...allHighs) * 1.05;

  // Build a yScale function that matches Recharts domain
  const yScale = useCallback(
    (value: number) => {
      const chartHeight = 260;
      const margin = 10;
      const plotHeight = chartHeight - margin * 2;
      const ratio = (value - yMin) / (yMax - yMin || 1);
      return chartHeight - margin - ratio * plotHeight;
    },
    [yMin, yMax]
  );

  // Augment candle data with yScale reference
  const chartData = candles.map((c) => ({
    ...c,
    // dummy bar value to give each bar a position
    barValue: c.high,
    yScale,
  }));

  return (
    <>
      <div className="flex gap-2">
        {(["weekly", "monthly"] as const).map((p) => (
          <Button
            key={p}
            variant={period === p ? "default" : "outline"}
            size="sm"
            onClick={() => setPeriod(p)}
          >
            {p.charAt(0).toUpperCase() + p.slice(1)}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className="px-2 pt-4 pb-2">
          <p className="text-sm font-medium mb-2 px-2">{data.metricName} - {period === "weekly" ? "Weekly" : "Monthly"} Candles</p>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                margin={{ top: 10, right: 10, left: -10, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis
                  dataKey="period"
                  tick={{ fontSize: 9 }}
                  interval="preserveStartEnd"
                  tickFormatter={(v) => {
                    if (period === "monthly") {
                      const d = new Date(v + "-01T00:00:00");
                      return d.toLocaleString("default", { month: "short", year: "2-digit" });
                    }
                    return v.slice(5); // MM-DD
                  }}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  domain={[yMin, yMax]}
                  tickFormatter={(v) => formatValue(v, metricType)}
                />
                <Tooltip
                  content={({ payload }) => {
                    if (!payload?.[0]) return null;
                    const p = payload[0].payload;
                    return (
                      <div className="bg-background border rounded p-2 text-xs shadow">
                        <p className="font-medium">{p.period}</p>
                        <p>Open: {formatValue(p.open, metricType)}</p>
                        <p>High: {formatValue(p.high, metricType)}</p>
                        <p>Low: {formatValue(p.low, metricType)}</p>
                        <p>Close: {formatValue(p.close, metricType)}</p>
                        <p className="text-muted-foreground">{p.count} days</p>
                      </div>
                    );
                  }}
                />
                <ReferenceLine
                  y={data.overallAvg}
                  stroke="#888"
                  strokeDasharray="3 3"
                  label={{ value: `Avg: ${formatValue(data.overallAvg, metricType)}`, fontSize: 9, fill: "#888" }}
                />
                <Bar
                  dataKey="barValue"
                  shape={<CandleShape yScale={yScale} />}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
