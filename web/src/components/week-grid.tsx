"use client";

import { useMemo } from "react";
import { HeatCell, useCellResolver, type HeatGridProps } from "@/components/calendar-heatmap";
import { parseDate, toDateStr } from "@/lib/heatmap";

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

type WeekRow = { key: string; monthLabel: string | null; days: { date: string; inRange: boolean }[] };

/** Week rows (Sun–Sat) covering [start, end], newest week first. */
function buildWeeks(start: string, end: string): WeekRow[] {
  const first = parseDate(start);
  first.setDate(first.getDate() - first.getDay());
  const last = parseDate(end);

  const rows: WeekRow[] = [];
  const cur = new Date(first);
  while (cur <= last) {
    const days: WeekRow["days"] = [];
    let monthLabel: string | null = null;
    for (let i = 0; i < 7; i++) {
      const date = toDateStr(cur);
      const inRange = date >= start && date <= end;
      days.push({ date, inRange });
      // Label the row containing the 1st of a month (or the first row).
      if (inRange && (cur.getDate() === 1 || (rows.length === 0 && monthLabel === null))) {
        monthLabel = cur.toLocaleString("default", { month: "short" });
        if (cur.getMonth() === 0 || rows.length === 0) monthLabel += ` '${String(cur.getFullYear()).slice(2)}`;
      }
      cur.setDate(cur.getDate() + 1);
    }
    rows.push({ key: days[0].date, monthLabel, days });
  }
  return rows.reverse();
}

/**
 * Portrait-friendly calendar: 7 wide columns, one row per week, newest at the
 * top so today is visible without scrolling. Values are readable in each cell.
 */
export function WeekGrid(props: HeatGridProps) {
  const { start, end, selectedDate, onHover, onCellClick } = props;
  const resolve = useCellResolver(props);
  const weeks = useMemo(() => buildWeeks(start, end), [start, end]);

  return (
    <div className="max-w-md mx-auto">
      <div className="grid grid-cols-[2.25rem_repeat(7,minmax(0,1fr))] gap-1 sticky top-0 bg-card z-10 pb-1">
        <div />
        {DAY_LABELS.map((d, i) => (
          <div key={i} className="text-[11px] text-muted-foreground text-center">
            {d}
          </div>
        ))}
      </div>
      <div className="space-y-1">
        {weeks.map((w) => (
          <div key={w.key} className="grid grid-cols-[2.25rem_repeat(7,minmax(0,1fr))] gap-1 items-center">
            <div className="text-[10px] leading-tight text-muted-foreground">{w.monthLabel}</div>
            {w.days.map((d) =>
              d.inRange ? (
                <HeatCell
                  key={d.date}
                  {...resolve(d.date)}
                  variant="week"
                  isSelected={selectedDate === d.date}
                  onHover={onHover}
                  onCellClick={onCellClick}
                />
              ) : (
                <div key={d.date} className="aspect-square" />
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
