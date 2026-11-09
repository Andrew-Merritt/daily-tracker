"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  computePatterns,
  formatCellValue,
  type HeatmapDataPoint,
  type HeatmapDirection,
  type HeatmapMetricType,
  type PatternBar,
} from "@/lib/heatmap";

type Props = {
  data: HeatmapDataPoint[];
  metricType: HeatmapMetricType;
  direction: HeatmapDirection;
  start: string;
  end: string;
  /** Metric start_date — checkbox shares only count days since tracking began. */
  since?: string | null;
};

const BETTER = "var(--heat-4)";
const WORSE = "hsl(var(--muted-foreground) / 0.55)";

function fmt(v: number, metricType: HeatmapMetricType): string {
  if (metricType === "checkbox") return `${Math.round(v * 100)}%`;
  if (metricType === "hhmm" || metricType === "time") return formatCellValue(v, metricType);
  return String(Math.round(v * 10) / 10);
}

/**
 * Weekday and month averages, drawn as deviations from the period average so
 * small but real differences (a 7.4 vs 6.9 sleep score, 4:30 vs 4:50 wake-up)
 * are visible — a zero-based bar would make them all look identical.
 */
export function HeatmapPatterns({ data, metricType, direction, start, end, since }: Props) {
  const { weekday, month, overall } = useMemo(() => {
    const p = computePatterns(data, metricType, start, end, since);
    let sum = 0;
    let n = 0;
    for (const b of p.weekday) {
      if (b.value != null) {
        sum += b.value * b.n;
        n += b.n;
      }
    }
    return { ...p, overall: n > 0 ? sum / n : null };
  }, [data, metricType, start, end, since]);

  if (overall == null) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Patterns</CardTitle>
        <p className="text-xs text-muted-foreground">
          {metricType === "checkbox" ? "Share of days done" : "Average"} vs the period average of{" "}
          <span className="font-mono text-foreground">{fmt(overall, metricType)}</span>
          {direction !== "neutral" && (
            <>
              {" · "}
              <span className="inline-block h-2 w-2 rounded-sm align-middle" style={{ background: BETTER }} />{" "}
              better{" "}
              <span className="inline-block h-2 w-2 rounded-sm align-middle ml-1" style={{ background: WORSE }} />{" "}
              worse
            </>
          )}
        </p>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2">
        <DeviationBars title="By weekday" bars={weekday} overall={overall} metricType={metricType} direction={direction} />
        {month.length > 1 && (
          <DeviationBars title="By month" bars={month} overall={overall} metricType={metricType} direction={direction} />
        )}
      </CardContent>
    </Card>
  );
}

function DeviationBars({
  title,
  bars,
  overall,
  metricType,
  direction,
}: {
  title: string;
  bars: PatternBar[];
  overall: number;
  metricType: HeatmapMetricType;
  direction: HeatmapDirection;
}) {
  const maxDev = Math.max(...bars.map((b) => (b.value == null ? 0 : Math.abs(b.value - overall))), 1e-9);
  const HALF = 36; // px of bar room above and below the average line

  // Best / worst label (respects direction; neutral → highest / lowest).
  const valued = bars.filter((b) => b.value != null);
  const hi = valued.reduce<PatternBar | null>((a, b) => (!a || b.value! > a.value! ? b : a), null);
  const lo = valued.reduce<PatternBar | null>((a, b) => (!a || b.value! < a.value! ? b : a), null);
  const best = direction === "decrease" ? lo : hi;
  const worst = direction === "decrease" ? hi : lo;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs font-medium text-muted-foreground">{title}</div>
        {best && worst && best !== worst && (
          <div className="text-[11px] text-muted-foreground">
            {direction === "neutral" ? "High" : "Best"} <span className="text-foreground">{best.label}</span> ·{" "}
            {direction === "neutral" ? "Low" : "Worst"} <span className="text-foreground">{worst.label}</span>
          </div>
        )}
      </div>
      <div className="flex items-stretch gap-1">
        {bars.map((b) => {
          const dev = b.value == null ? 0 : b.value - overall;
          const h = Math.round((Math.abs(dev) / maxDev) * HALF);
          const good = direction === "neutral" ? null : direction === "decrease" ? dev < 0 : dev > 0;
          const color = good == null ? "var(--chart-1)" : good ? BETTER : WORSE;
          return (
            <div
              key={b.key}
              className="flex-1 min-w-0 flex flex-col items-center"
              title={b.value == null ? `${b.label}: no data` : `${b.label}: ${fmt(b.value, metricType)} (${b.n} days)`}
            >
              <div className="relative w-full" style={{ height: HALF * 2 }}>
                <div className="absolute inset-x-0 border-t border-dashed border-muted-foreground/40" style={{ top: HALF }} />
                {b.value != null && (
                  <div
                    className="absolute left-1/2 -translate-x-1/2 w-[70%] max-w-6 rounded-sm"
                    style={{
                      background: color,
                      height: Math.max(h, 1),
                      top: dev >= 0 ? HALF - Math.max(h, 1) : HALF,
                    }}
                  />
                )}
              </div>
              <div className="text-[10px] font-mono tabular-nums text-foreground/80 mt-1 truncate w-full text-center">
                {b.value == null ? "–" : fmt(b.value, metricType)}
              </div>
              <div className="text-[10px] text-muted-foreground">{b.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
