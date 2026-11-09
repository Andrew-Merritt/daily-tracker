"use client";

import { useMemo } from "react";
import { HeatCell, useCellResolver, type HeatGridProps } from "@/components/calendar-heatmap";
import { parseDate, toDateStr } from "@/lib/heatmap";

const DAY_LABELS = ["", "M", "", "W", "", "F", ""];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type DayCell = { date: string; inRange: boolean };

/** Week columns (Sun–Sat) covering [start, end]. */
function buildColumns(start: string, end: string): DayCell[][] {
  const first = parseDate(start);
  first.setDate(first.getDate() - first.getDay());
  const last = parseDate(end);
  last.setDate(last.getDate() + (6 - last.getDay()));

  const columns: DayCell[][] = [];
  let col: DayCell[] = [];
  const cur = new Date(first);
  while (cur <= last) {
    const date = toDateStr(cur);
    col.push({ date, inRange: date >= start && date <= end });
    if (cur.getDay() === 6) {
      columns.push(col);
      col = [];
    }
    cur.setDate(cur.getDate() + 1);
  }
  if (col.length) columns.push(col);
  return columns;
}

/** GitHub-style strip: one column per week, scrolls horizontally on phones. */
export function YearGrid(props: HeatGridProps) {
  const { start, end, selectedDate, onHover, onCellClick } = props;
  const resolve = useCellResolver(props);
  const columns = useMemo(() => buildColumns(start, end), [start, end]);

  const monthLabels = useMemo(() => {
    const labels = new Map<number, string>();
    let lastMonth = -1;
    columns.forEach((col, colIdx) => {
      const firstInRange = col.find((c) => c.inRange);
      if (!firstInRange) return;
      const month = parseDate(firstInRange.date).getMonth();
      if (month !== lastMonth) {
        labels.set(colIdx, MONTH_NAMES[month]);
        lastMonth = month;
      }
    });
    return labels;
  }, [columns]);

  return (
    <div className="overflow-x-auto">
      <div className="inline-flex flex-col gap-1" style={{ minWidth: columns.length * 14 + 20 }}>
        <div className="flex h-3.5" style={{ paddingLeft: 16 }}>
          {columns.map((_, colIdx) => (
            <div key={colIdx} className="text-[10px] text-muted-foreground relative" style={{ width: 14 }}>
              {monthLabels.has(colIdx) && (
                <span className="absolute left-0 whitespace-nowrap">{monthLabels.get(colIdx)}</span>
              )}
            </div>
          ))}
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
              {col.map((cell) =>
                cell.inRange ? (
                  <HeatCell
                    key={cell.date}
                    {...resolve(cell.date)}
                    variant="year"
                    isSelected={selectedDate === cell.date}
                    onHover={onHover}
                    onCellClick={onCellClick}
                  />
                ) : (
                  <div key={cell.date} className="w-3 h-3" />
                )
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
