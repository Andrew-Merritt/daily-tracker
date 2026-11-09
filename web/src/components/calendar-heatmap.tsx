"use client";

import { memo, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";

export type HeatmapDataPoint = {
  date: string;
  value: number;
  goalMet?: boolean;
};

export type HeatmapMetricType = "number" | "checkbox" | "hhmm" | "time" | "score" | "count" | "text";
export type HeatmapDirection = "increase" | "decrease" | "neutral";

export type CalendarHeatmapProps = {
  data: HeatmapDataPoint[];
  metricType?: HeatmapMetricType;
  direction?: HeatmapDirection;
  year?: number;
  selectedDate?: string | null;
  onHover?: (cell: { date: string; value: number } | null) => void;
  onCellClick?: (date: string, value: number | undefined) => void;
};

function formatHHMM(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes)) return "";
  const minutes = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

function formatDuration(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes)) return "";
  const minutes = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** Bucket a value into a quintile of the visible range, 1 (lowest) to 5 (highest). */
export function heatBucket(value: number, min: number, max: number): 1 | 2 | 3 | 4 | 5 {
  const t = (value - min) / (max - min || 1);
  return (Math.min(4, Math.floor(t * 5)) + 1) as 1 | 2 | 3 | 4 | 5;
}

/** Resolve the CSS color for a data cell given its value and the metric's config. */
export function getHeatCellColor(
  value: number,
  min: number,
  max: number,
  metricType: HeatmapMetricType,
  direction: HeatmapDirection
): string {
  if (metricType === "checkbox") {
    if (value >= 0.5) {
      return direction === "decrease" ? "var(--status-danger)" : "var(--heat-4)";
    }
    return "transparent";
  }
  let bucket = heatBucket(value, min, max);
  if (direction === "decrease") bucket = (6 - bucket) as 1 | 2 | 3 | 4 | 5;
  return `var(--heat-${bucket})`;
}

/** Text color readable against the cell's background (mirrors getHeatCellColor). */
export function getHeatCellTextColor(
  value: number,
  min: number,
  max: number,
  metricType: HeatmapMetricType,
  direction: HeatmapDirection
): string {
  if (metricType === "checkbox") {
    return direction === "decrease" ? "var(--heat-fg-danger)" : "var(--heat-fg-4)";
  }
  let bucket = heatBucket(value, min, max);
  if (direction === "decrease") bucket = (6 - bucket) as 1 | 2 | 3 | 4 | 5;
  return `var(--heat-fg-${bucket})`;
}

/** Compact value for inside a tile (checkbox shows a check mark). */
export function formatTileValue(value: number, metricType: HeatmapMetricType): string {
  if (metricType === "checkbox") return value >= 0.5 ? "✓" : "";
  if (metricType === "hhmm" || metricType === "time") return formatCellValue(value, metricType);
  const rounded = Math.round(value * 10) / 10;
  return String(rounded);
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

function formatCellDate(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleString("default", { month: "short", day: "numeric" });
}

type HeatCellProps = {
  date: string;
  value: number | undefined;
  bgColor: string;
  fgColor: string | undefined;
  text: string;
  title: string;
  isEmpty: boolean;
  isGoalMet: boolean;
  isSelected: boolean;
  onHover?: (cell: { date: string; value: number } | null) => void;
  onCellClick?: (date: string, value: number | undefined) => void;
  /** Fixed pixel size (year view); omit for aspect-square fill. */
  size?: number;
};

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Memoized so a hover only re-renders the cells whose selected state changed. */
export const HeatCell = memo(function HeatCell({
  date, value, bgColor, fgColor, text, title, isEmpty, isGoalMet, isSelected, onHover, onCellClick, size,
}: HeatCellProps) {
  const hasValue = value !== undefined;
  // Any day up to today can be tapped (opens the day's full log); only days
  // with a value get the hover pop.
  const clickable = !!onCellClick && date <= localToday();
  // The outer element keeps the un-scaled hit box and owns all mouse events; the
  // inner element does the visual pop with pointer-events-none, so an enlarged
  // tile never steals hover from its neighbors during fast sweeps.
  return (
    <div
      title={title}
      className={`group relative ${size ? "" : "aspect-square"} ${
        clickable ? "cursor-pointer" : "cursor-default"
      } ${hasValue ? "hover:z-30" : ""} ${isSelected ? "z-20" : ""}`}
      style={{ width: size, height: size }}
      onMouseEnter={() => hasValue && onHover?.({ date, value })}
      onMouseLeave={() => onHover?.(null)}
      onClick={() => clickable && onCellClick?.(date, value)}
    >
      <div
        className={`pointer-events-none absolute inset-0 flex items-center justify-center font-medium leading-none tabular-nums transition-transform duration-100 ${
          size ? "rounded-[2px] text-[6px]" : "rounded-[3px] text-[8px]"
        } ${
          hasValue ? "group-hover:scale-[1.33] group-hover:shadow-md group-hover:ring-1 group-hover:ring-foreground/40" : ""
        } ${isSelected ? "ring-2 ring-foreground" : ""}`}
        style={{
          backgroundColor: bgColor,
          color: fgColor,
          opacity: isEmpty ? 0.35 : 1,
          boxShadow: isGoalMet ? "inset 0 0 0 1.5px var(--status-good)" : undefined,
        }}
      >
        {text}
      </div>
    </div>
  );
});

export function CalendarHeatmap({
  data,
  metricType = "number",
  direction = "increase",
  year,
  selectedDate,
  onHover,
  onCellClick,
}: CalendarHeatmapProps) {
  const valueMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data) m.set(d.date, d.value);
    return m;
  }, [data]);

  const goalMetMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const d of data) {
      if (d.goalMet !== undefined) m.set(d.date, d.goalMet);
    }
    return m;
  }, [data]);

  // Filter data by year if specified
  const filteredData = useMemo(() => {
    if (!year) return data;
    const yearStr = String(year);
    return data.filter((d) => d.date.startsWith(yearStr));
  }, [data, year]);

  // Months in chronological order (Jan-Dec)
  const months = useMemo(() => {
    if (year) {
      // Always show all 12 months for the selected year
      const result: string[] = [];
      for (let m = 1; m <= 12; m++) {
        result.push(`${year}-${String(m).padStart(2, "0")}`);
      }
      return result; // Jan to Dec order
    }
    if (filteredData.length === 0) return [];

    const sorted = [...filteredData].sort((a, b) => a.date.localeCompare(b.date));
    const first = sorted[0].date;
    const last = sorted[sorted.length - 1].date;
    const result: string[] = [];
    const d = new Date(first.slice(0, 7) + "-01T00:00:00");
    const end = new Date(last.slice(0, 7) + "-01T00:00:00");
    while (d <= end) {
      result.push(d.toISOString().slice(0, 7));
      d.setMonth(d.getMonth() + 1);
    }
    return result.sort(); // Chronological order
  }, [filteredData, year]);

  const allValues = filteredData.map((d) => d.value);
  const minVal = allValues.length > 0 ? Math.min(...allValues) : 0;
  const maxVal = allValues.length > 0 ? Math.max(...allValues) : 1;

  const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

  if (months.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-8">
        No data available for the selected period.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
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
          <Card key={month}>
            <CardContent className="px-2 pt-2 pb-1.5">
              <p className="text-[10px] font-medium mb-1 text-muted-foreground">
                {firstDay.toLocaleString("default", { month: "short" })} {y}
              </p>
              <div className="grid grid-cols-7 gap-[2px]">
                {DAY_LABELS.map((d, i) => (
                  <div key={`${d}${i}`} className="text-[7px] text-muted-foreground/60 text-center">
                    {d}
                  </div>
                ))}
                {cells.map((cell, i) => {
                  if (!cell) return <div key={`e${i}`} />;
                  const hasValue = cell.value !== undefined;
                  const isChecked = metricType === "checkbox" && hasValue && cell.value! >= 0.5;
                  const isEmpty = !hasValue || (metricType === "checkbox" && !isChecked);
                  const isGoalMet = goalMetMap.get(cell.date);
                  const isSelected = selectedDate === cell.date;

                  const bgColor = hasValue
                    ? getHeatCellColor(cell.value!, minVal, maxVal, metricType, direction)
                    : "var(--heat-empty)";

                  const title = hasValue
                    ? `${formatCellDate(cell.date)} — ${formatCellValue(cell.value!, metricType)}${
                        isGoalMet ? " · Goal met" : ""
                      }`
                    : formatCellDate(cell.date);

                  return (
                    <HeatCell
                      key={cell.date}
                      date={cell.date}
                      value={cell.value}
                      bgColor={bgColor}
                      fgColor={
                        hasValue
                          ? getHeatCellTextColor(cell.value!, minVal, maxVal, metricType, direction)
                          : undefined
                      }
                      text={hasValue && !isEmpty ? formatTileValue(cell.value!, metricType) : ""}
                      title={title}
                      isEmpty={isEmpty}
                      isGoalMet={!!isGoalMet}
                      isSelected={isSelected}
                      onHover={onHover}
                      onCellClick={onCellClick}
                    />
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

/**
 * 5 swatches reading low → high intensity. Per-cell colors already apply the
 * direction inversion (see getHeatCellColor), so worst → best always reads
 * as heat-1 → heat-5 regardless of direction; `direction` is accepted for
 * API symmetry with the per-cell rule and potential future use.
 */
export function getHeatmapLegendColors(_direction: HeatmapDirection): string[] {
  return [1, 2, 3, 4, 5].map((b) => `var(--heat-${b})`);
}

export { formatHHMM, formatDuration };
