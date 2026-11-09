"use client";

import { memo, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  eachMonth,
  formatCellValue,
  formatShortDate,
  formatTileValue,
  heatColors,
  localToday,
  type Bucket,
  type HeatmapDataPoint,
  type HeatmapDirection,
  type HeatmapMetricType,
} from "@/lib/heatmap";

// Re-exported so existing imports keep working.
export {
  formatCellValue,
  formatTileValue,
  formatHHMM,
  formatDuration,
  type HeatmapDataPoint,
  type HeatmapDirection,
  type HeatmapMetricType,
} from "@/lib/heatmap";

/** Props shared by every heatmap view (weeks / months / year). */
export type HeatGridProps = {
  data: HeatmapDataPoint[];
  /** Inclusive YYYY-MM-DD range to draw. */
  start: string;
  end: string;
  metricType?: HeatmapMetricType;
  direction?: HeatmapDirection;
  /** Value → color bucket for the period (see makeBucketer). */
  bucketOf: (v: number) => Bucket;
  selectedDate?: string | null;
  /** Dates that get an overlay dot. */
  markers?: Set<string> | null;
  onHover?: (cell: { date: string; value: number } | null) => void;
  onCellClick?: (date: string, value: number | undefined) => void;
};

export type CellVariant = "year" | "month" | "week";

export type ResolvedCell = {
  date: string;
  value: number | undefined;
  bgColor: string;
  fgColor: string | undefined;
  text: string;
  title: string;
  isEmpty: boolean;
  isGoalMet: boolean;
  isFuture: boolean;
  hasMarker: boolean;
};

/** Lookup maps + a resolver that turns a date into everything a cell needs. */
export function useCellResolver({
  data,
  metricType = "number",
  direction = "increase",
  bucketOf,
  markers,
}: Pick<HeatGridProps, "data" | "metricType" | "direction" | "bucketOf" | "markers">) {
  const maps = useMemo(() => {
    const value = new Map<string, number>();
    const goal = new Map<string, boolean>();
    for (const d of data) {
      value.set(d.date, d.value);
      if (d.goalMet !== undefined) goal.set(d.date, d.goalMet);
    }
    return { value, goal };
  }, [data]);

  const today = localToday();

  return (date: string): ResolvedCell => {
    const value = maps.value.get(date);
    const hasValue = value !== undefined;
    const isChecked = metricType === "checkbox" && hasValue && value >= 0.5;
    const isEmpty = !hasValue || (metricType === "checkbox" && !isChecked);
    const isGoalMet = !!maps.goal.get(date);
    const colors = hasValue ? heatColors(value, bucketOf, metricType, direction) : null;
    const hasMarker = !!markers?.has(date);
    return {
      date,
      value,
      bgColor: colors?.bg ?? "var(--heat-empty)",
      fgColor: colors?.fg,
      text: hasValue && !isEmpty ? formatTileValue(value, metricType) : "",
      title:
        (hasValue
          ? `${formatShortDate(date)} — ${formatCellValue(value, metricType)}${isGoalMet ? " · Goal met" : ""}`
          : formatShortDate(date)) + (hasMarker ? " · ●" : ""),
      isEmpty,
      isGoalMet,
      isFuture: date > today,
      hasMarker,
    };
  };
}

type HeatCellProps = ResolvedCell & {
  variant: CellVariant;
  isSelected: boolean;
  onHover?: HeatGridProps["onHover"];
  onCellClick?: HeatGridProps["onCellClick"];
};

const VARIANT_STYLES: Record<CellVariant, { box: string; inner: string; dot: string }> = {
  year: { box: "w-3 h-3", inner: "rounded-[2px] text-[6px]", dot: "h-[4px] w-[4px] top-0 right-0" },
  month: { box: "aspect-square", inner: "rounded-[3px] text-[8px]", dot: "h-[5px] w-[5px] top-[1px] right-[1px]" },
  week: { box: "aspect-square", inner: "rounded-md text-xs", dot: "h-2 w-2 top-1 right-1" },
};

/** Memoized so a hover only re-renders the cells whose selected state changed. */
export const HeatCell = memo(function HeatCell({
  date,
  value,
  bgColor,
  fgColor,
  text,
  title,
  isEmpty,
  isGoalMet,
  isFuture,
  hasMarker,
  isSelected,
  variant,
  onHover,
  onCellClick,
}: HeatCellProps) {
  const hasValue = value !== undefined;
  // Any day up to today can be tapped (opens the day's full log); only days
  // with a value get the hover pop.
  const clickable = !!onCellClick && !isFuture;
  const v = VARIANT_STYLES[variant];
  // The outer element keeps the un-scaled hit box and owns all mouse events; the
  // inner element does the visual pop with pointer-events-none, so an enlarged
  // tile never steals hover from its neighbors during fast sweeps.
  return (
    <div
      title={title}
      className={`group relative ${v.box} ${clickable ? "cursor-pointer" : "cursor-default"} ${
        hasValue ? "hover:z-30" : ""
      } ${isSelected ? "z-20" : ""}`}
      onMouseEnter={() => hasValue && onHover?.({ date, value })}
      onMouseLeave={() => onHover?.(null)}
      onClick={() => clickable && onCellClick?.(date, value)}
    >
      <div
        className={`pointer-events-none absolute inset-0 flex items-center justify-center font-medium leading-none tabular-nums transition-transform duration-100 ${
          v.inner
        } ${
          hasValue ? "group-hover:scale-[1.33] group-hover:shadow-md group-hover:ring-1 group-hover:ring-foreground/40" : ""
        } ${isSelected ? "ring-2 ring-foreground" : ""}`}
        style={{
          backgroundColor: bgColor,
          color: fgColor,
          opacity: isFuture ? 0.12 : isEmpty ? 0.35 : 1,
          boxShadow: isGoalMet ? "inset 0 0 0 1.5px var(--status-good)" : undefined,
        }}
      >
        {variant === "week" && (
          <span className="absolute left-1 top-0.5 text-[9px] font-normal opacity-60" style={{ color: fgColor }}>
            {Number(date.slice(8))}
          </span>
        )}
        {/* Year tiles are 12px — color only; the value is in the tooltip / tap. */}
        {variant !== "year" && text}
        {hasMarker && (
          <span
            className={`absolute rounded-full ${v.dot}`}
            style={{ backgroundColor: "var(--status-warning)", boxShadow: "0 0 0 1px rgba(0,0,0,0.45)" }}
          />
        )}
      </div>
    </div>
  );
});

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

/** Grid of month cards (one per month in range). */
export function CalendarHeatmap(props: HeatGridProps) {
  const { start, end, selectedDate, onHover, onCellClick } = props;
  const resolve = useCellResolver(props);
  const months = useMemo(() => eachMonth(start, end), [start, end]);

  if (months.length === 0) {
    return <div className="text-sm text-muted-foreground text-center py-8">No data for this period.</div>;
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
      {months.map((month) => {
        const [y, m] = month.split("-").map(Number);
        const firstDay = new Date(y, m - 1, 1);
        const daysInMonth = new Date(y, m, 0).getDate();
        const cells: (string | null)[] = Array.from({ length: firstDay.getDay() }, () => null);
        for (let day = 1; day <= daysInMonth; day++) cells.push(`${month}-${String(day).padStart(2, "0")}`);

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
                {cells.map((date, i) => {
                  if (!date || date < start) return <div key={`e${i}`} />;
                  const c = resolve(date);
                  return (
                    <HeatCell
                      key={date}
                      {...c}
                      variant="month"
                      isSelected={selectedDate === date}
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
