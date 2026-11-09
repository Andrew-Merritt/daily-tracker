"use client";

import { useMemo } from "react";
import {
  getHeatCellColor,
  formatCellValue,
  formatTileValue,
  HeatCell,
  getHeatCellTextColor,
  type HeatmapDataPoint,
  type HeatmapMetricType,
  type HeatmapDirection,
} from "@/components/calendar-heatmap";

export type YearGridProps = {
  data: HeatmapDataPoint[];
  metricType?: HeatmapMetricType;
  direction?: HeatmapDirection;
  year?: number;
  selectedDate?: string | null;
  onHover?: (cell: { date: string; value: number } | null) => void;
  onCellClick?: (date: string, value: number | undefined) => void;
};

const DAY_LABELS = ["", "M", "", "W", "", "F", ""];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatCellDate(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleString("default", { month: "short", day: "numeric" });
}

type DayCell = { date: string; inYear: boolean };

function buildColumns(year: number): DayCell[][] {
  const jan1 = new Date(year, 0, 1);
  const dec31 = new Date(year, 11, 31);
  const start = new Date(jan1);
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(dec31);
  end.setDate(end.getDate() + (6 - end.getDay()));

  const columns: DayCell[][] = [];
  let col: DayCell[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    col.push({ date: toDateStr(cur), inYear: cur.getFullYear() === year });
    if (cur.getDay() === 6) {
      columns.push(col);
      col = [];
    }
    cur.setDate(cur.getDate() + 1);
  }
  if (col.length) columns.push(col);
  return columns;
}

export function YearGrid({
  data,
  metricType = "number",
  direction = "increase",
  year = new Date().getFullYear(),
  selectedDate,
  onHover,
  onCellClick,
}: YearGridProps) {
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

  const yearValues = useMemo(
    () => data.filter((d) => d.date.startsWith(String(year))).map((d) => d.value),
    [data, year]
  );
  const minVal = yearValues.length > 0 ? Math.min(...yearValues) : 0;
  const maxVal = yearValues.length > 0 ? Math.max(...yearValues) : 1;

  const columns = useMemo(() => buildColumns(year), [year]);

  const monthLabels = useMemo(() => {
    const labels: { col: number; label: string }[] = [];
    let lastMonth = -1;
    columns.forEach((col, colIdx) => {
      const firstInYear = col.find((c) => c.inYear);
      if (!firstInYear) return;
      const month = new Date(`${firstInYear.date}T00:00:00`).getMonth();
      if (month !== lastMonth) {
        labels.push({ col: colIdx, label: MONTH_NAMES[month] });
        lastMonth = month;
      }
    });
    return labels;
  }, [columns]);

  return (
    <div className="overflow-x-auto">
      <div className="inline-flex flex-col gap-1" style={{ minWidth: columns.length * 14 + 20 }}>
        <div className="flex" style={{ paddingLeft: 16 }}>
          {columns.map((_, colIdx) => {
            const label = monthLabels.find((m) => m.col === colIdx);
            return (
              <div key={colIdx} className="text-[10px] text-muted-foreground relative" style={{ width: 13 }}>
                {label && <span className="absolute left-0 whitespace-nowrap">{label.label}</span>}
              </div>
            );
          })}
        </div>
        <div className="flex gap-[2px]">
          <div className="flex flex-col gap-[2px]" style={{ width: 14 }}>
            {DAY_LABELS.map((d, i) => (
              <div key={i} className="text-[10px] text-muted-foreground flex items-center" style={{ height: 12 }}>
                {d}
              </div>
            ))}
          </div>
          {columns.map((col, colIdx) => (
            <div
              key={colIdx}
              className="flex flex-col gap-[2px] motion-safe:[animation:fadeIn_.3s_ease_both]"
              style={{ animationDelay: `${colIdx * 6}ms` }}
            >
              {col.map((cell) => {
                if (!cell.inYear) {
                  return <div key={cell.date} style={{ width: 12, height: 12 }} />;
                }
                const value = valueMap.get(cell.date);
                const hasValue = value !== undefined;
                const isChecked = metricType === "checkbox" && hasValue && value! >= 0.5;
                const isEmpty = !hasValue || (metricType === "checkbox" && !isChecked);
                const isGoalMet = goalMetMap.get(cell.date);
                const isSelected = selectedDate === cell.date;

                const bgColor = hasValue
                  ? getHeatCellColor(value!, minVal, maxVal, metricType, direction)
                  : "var(--heat-empty)";

                const title = hasValue
                  ? `${formatCellDate(cell.date)} — ${formatCellValue(value!, metricType)}${
                      isGoalMet ? " · Goal met" : ""
                    }`
                  : formatCellDate(cell.date);

                return (
                  <HeatCell
                    key={cell.date}
                    date={cell.date}
                    value={value}
                    bgColor={bgColor}
                    fgColor={
                      hasValue ? getHeatCellTextColor(value!, minVal, maxVal, metricType, direction) : undefined
                    }
                    text={hasValue && !isEmpty ? formatTileValue(value!, metricType) : ""}
                    title={title}
                    isEmpty={isEmpty}
                    isGoalMet={!!isGoalMet}
                    isSelected={isSelected}
                    onHover={onHover}
                    onCellClick={onCellClick}
                    size={12}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
