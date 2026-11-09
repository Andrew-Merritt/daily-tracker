"use client";

import { useCallback, useEffect, useState } from "react";
import { getAuthHeaders } from "@/lib/authHeaders";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InsightDetailSheet } from "@/components/insight-detail-sheet";
import { CustomInsightBuilder } from "@/components/custom-insight-builder";
import { CustomInsightCard } from "@/components/custom-insight-card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type {
  Evidence,
  InsightEvidence,
  CorrelationInsight,
  CheckboxCheckboxInsight,
  NumericNumericInsight,
  TimeLaggedInsight,
  DayOfWeekInsight,
  TrendInsight,
  HistogramInsight,
  CumulativeInsight,
  YearOverYearInsight,
  StreakTimelineInsight,
  CandlestickInsight,
  InsightsResponse,
  CustomInsightConfig,
} from "@/types/insights";

const DISMISSED_KEY = "insights:dismissed";
const CUSTOM_KEY = "insights:custom";

function getDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<string>) {
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(ids)));
}

function getCustomInsights(): CustomInsightConfig[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCustomInsights(configs: CustomInsightConfig[]) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(configs));
}

function formatPercent(val: number): string {
  const sign = val > 0 ? "+" : "";
  return `${sign}${val.toFixed(1)}%`;
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

/** Signed difference in the metric's own units (minutes shown as h:mm / Xm). */
function formatDelta(val: number, metricType?: string): string {
  const sign = val > 0 ? "+" : val < 0 ? "−" : "±";
  const a = Math.abs(val);
  if (metricType === "time" || metricType === "hhmm") {
    const m = Math.round(a);
    return m >= 60 ? `${sign}${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}` : `${sign}${m}m`;
  }
  const digits = a >= 10 ? 0 : a >= 1 ? 1 : 2;
  return `${sign}${a.toFixed(digits)}`;
}

/** Percent change is only meaningful for amounts with a real zero and a non-tiny base. */
function showPercent(metricType: string | undefined, base: number): boolean {
  return metricType !== "hhmm" && metricType !== "time" && Math.abs(base) >= 1;
}

const EVIDENCE_STYLE: Record<Evidence, { label: string; cls: string; title: string }> = {
  strong: {
    label: "Strong evidence",
    cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    title: "Very unlikely to be chance, even after accounting for how many pairs were checked (q < 0.01).",
  },
  moderate: {
    label: "Good evidence",
    cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
    title: "Unlikely to be chance after accounting for how many pairs were checked (q < 0.05).",
  },
  suggestive: {
    label: "Suggestive",
    cls: "bg-muted text-muted-foreground",
    title: "Worth watching, but could still be noise (q < 0.10). More data will tell.",
  },
};

function EvidenceChip({ evidence }: { evidence: Evidence }) {
  const e = EVIDENCE_STYLE[evidence];
  return (
    <span title={e.title} className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${e.cls}`}>
      {e.label}
    </span>
  );
}

/** "likely between X and Y" line for a 95% interval. */
function RangeLine({ low, high, fmt }: { low: number; high: number; fmt: (v: number) => string }) {
  return (
    <p className="text-xs text-muted-foreground" title="95% interval: the true effect is plausibly anywhere in this range.">
      likely {fmt(low)} to {fmt(high)}
    </p>
  );
}

function pairKey(a: string, b: string): string {
  return `pair:${[a, b].sort().join("|")}`;
}

/** × menu: hide this insight, or every insight about this pair of metrics. */
function DismissBtn({
  id,
  onDismiss,
  pair,
}: {
  id: string;
  onDismiss: (id: string) => void;
  pair?: [string, string];
}) {
  if (!pair) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(id); }}
        className="text-muted-foreground/40 hover:text-muted-foreground transition-colors text-sm leading-none p-1 -m-1"
        title="Dismiss this insight"
      >
        &times;
      </button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className="text-muted-foreground/40 hover:text-muted-foreground transition-colors text-sm leading-none p-1 -m-1"
          title="Hide"
        >
          &times;
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => onDismiss(id)}>Hide this insight</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onDismiss(pairKey(pair[0], pair[1]))}>
          Hide everything about this pair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function privateBorder(involvesPrivate: boolean): string {
  return involvesPrivate ? "border-purple-300/50 dark:border-purple-700/50" : "";
}

function goodBad(isGood: boolean | null) {
  if (isGood === null) return { color: "text-foreground", bg: "bg-muted/60" };
  return isGood
    ? { color: "text-green-600 dark:text-green-400", bg: "bg-green-50 dark:bg-green-900/20" }
    : { color: "text-red-600 dark:text-red-400", bg: "bg-red-50 dark:bg-red-900/20" };
}

type CardProps<T> = { insight: T; onDismiss: (id: string) => void; onClick: () => void };

/**
 * Shared layout for "when X, Y is different" insights (same day or N days later).
 */
function GroupDiffCard({
  id,
  involvesPrivate,
  pair,
  lead,
  trigger,
  outcome,
  outcomeType,
  avgTrue,
  avgFalse,
  daysTrue,
  daysFalse,
  higherIsBetter,
  stats,
  trueLabel,
  falseLabel,
  onDismiss,
  onClick,
}: {
  id: string;
  involvesPrivate: boolean;
  pair: [string, string];
  lead: string;
  trigger: string;
  outcome: string;
  outcomeType: string;
  avgTrue: number;
  avgFalse: number;
  daysTrue: number;
  daysFalse: number;
  higherIsBetter: boolean;
  stats: InsightEvidence;
  trueLabel: string;
  falseLabel: string;
  onDismiss: (id: string) => void;
  onClick: () => void;
}) {
  const diff = stats.effect;
  const { color, bg } = goodBad(higherIsBetter ? diff > 0 : diff < 0);
  const fmt = (v: number) => formatDelta(v, outcomeType);
  return (
    <Card
      className={`overflow-hidden cursor-pointer hover:shadow-md transition-shadow ${privateBorder(involvesPrivate)}`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-muted-foreground">{lead}</p>
            <p className="font-semibold text-lg leading-tight">{trigger}</p>
            <p className="text-sm text-muted-foreground mt-1">your</p>
            <p className="font-medium">{outcome}</p>
            <div className="mt-2">
              <EvidenceChip evidence={stats.evidence} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <DismissBtn id={id} onDismiss={onDismiss} pair={pair} />
            <div className={`text-right ${bg} rounded-lg px-3 py-2`}>
              <p className={`text-2xl font-bold tabular-nums ${color}`}>{fmt(diff)}</p>
              {showPercent(outcomeType, avgFalse) && (
                <p className="text-xs text-muted-foreground">{formatPercent(((avgTrue - avgFalse) / Math.abs(avgFalse)) * 100)}</p>
              )}
              <RangeLine low={stats.low} high={stats.high} fmt={fmt} />
            </div>
          </div>
        </div>

        <div className="mt-4 pt-3 border-t grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">{trueLabel}</p>
            <p className="font-mono font-semibold">{formatValue(avgTrue, outcomeType)}</p>
            <p className="text-xs text-muted-foreground">({daysTrue} days)</p>
          </div>
          <div>
            <p className="text-muted-foreground">{falseLabel}</p>
            <p className="font-mono font-semibold">{formatValue(avgFalse, outcomeType)}</p>
            <p className="text-xs text-muted-foreground">({daysFalse} days)</p>
          </div>
          <p className="col-span-2 -mt-2 text-[11px] text-muted-foreground">
            The headline difference compares the same weekdays, so weekly routines don&apos;t skew it.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function InsightCard({ insight, onDismiss, onClick }: CardProps<CorrelationInsight>) {
  return (
    <GroupDiffCard
      id={insight.id}
      involvesPrivate={insight.involvesPrivate}
      pair={[insight.checkboxMetricId, insight.numericMetricId]}
      lead="On days you"
      trigger={insight.checkboxMetricName}
      outcome={insight.numericMetricName}
      outcomeType={insight.numericMetricType}
      avgTrue={insight.avgWhenTrue}
      avgFalse={insight.avgWhenFalse}
      daysTrue={insight.daysTrue}
      daysFalse={insight.daysFalse}
      higherIsBetter={insight.numericHigherIsBetter !== false}
      stats={insight.stats}
      trueLabel="Avg when done"
      falseLabel="Avg otherwise"
      onDismiss={onDismiss}
      onClick={onClick}
    />
  );
}

function TimeLaggedCard({ insight, onDismiss, onClick }: CardProps<TimeLaggedInsight>) {
  const when = insight.lag === 2 ? "2 days after you" : "The day after you";
  return (
    <GroupDiffCard
      id={insight.id}
      involvesPrivate={insight.involvesPrivate}
      pair={[insight.triggerMetricId, insight.outcomeMetricId]}
      lead={when}
      trigger={insight.triggerMetricName}
      outcome={insight.outcomeMetricName}
      outcomeType={insight.outcomeMetricType}
      avgTrue={insight.avgNextDayWhenTrue}
      avgFalse={insight.avgNextDayWhenFalse}
      daysTrue={insight.daysTrue}
      daysFalse={insight.daysFalse}
      higherIsBetter={insight.outcomeHigherIsBetter !== false}
      stats={insight.stats}
      trueLabel={insight.lag === 2 ? "Avg 2 days after" : "Avg the day after"}
      falseLabel="Avg otherwise"
      onDismiss={onDismiss}
      onClick={onClick}
    />
  );
}

function CheckboxInsightCard({ insight, onDismiss, onClick }: CardProps<CheckboxCheckboxInsight>) {
  const pts = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(Math.round(v * 100))} pts`;
  const more = insight.stats.effect > 0;
  return (
    <Card
      className={`cursor-pointer hover:shadow-md transition-shadow ${privateBorder(insight.involvesPrivate)}`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-muted-foreground">
              On days you <span className="font-medium text-foreground">{insight.metricAName}</span>, you{" "}
              {more ? "also" : "less often"}
            </p>
            <p className="font-semibold mt-1">{insight.metricBName}</p>
            <p className="text-sm mt-2">
              <span className="font-mono font-semibold">{insight.rateWhenATrue.toFixed(0)}%</span>
              <span className="text-muted-foreground"> of those days vs </span>
              <span className="font-mono font-semibold">{insight.rateWhenAFalse.toFixed(0)}%</span>
              <span className="text-muted-foreground"> otherwise</span>
            </p>
            <div className="mt-2">
              <EvidenceChip evidence={insight.stats.evidence} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <DismissBtn id={insight.id} onDismiss={onDismiss} pair={[insight.metricAId, insight.metricBId]} />
            <div className="text-right rounded-lg px-3 py-2 bg-muted/60">
              <p className="text-xl font-bold tabular-nums">{pts(insight.stats.effect)}</p>
              <RangeLine low={insight.stats.low} high={insight.stats.high} fmt={pts} />
            </div>
          </div>
        </div>
        <p className="mt-3 pt-3 border-t text-xs text-muted-foreground">
          {insight.daysATrue} days with, {insight.daysAFalse} days without {insight.metricAName} · difference
          compares the same weekdays
        </p>
      </CardContent>
    </Card>
  );
}

function NumericNumericCard({ insight, onDismiss, onClick }: CardProps<NumericNumericInsight>) {
  const r = insight.stats.effect;
  const isPositive = r > 0;
  const color = isPositive ? "text-blue-600 dark:text-blue-400" : "text-orange-600 dark:text-orange-400";
  // Size of the link (distinct from the evidence chip, which is about certainty).
  const strength = Math.abs(r) >= 0.5 ? "Strong link" : Math.abs(r) >= 0.3 ? "Moderate link" : "Slight link";
  const fmtR = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
  return (
    <Card
      className={`cursor-pointer hover:shadow-md transition-shadow ${privateBorder(insight.involvesPrivate)}`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="font-semibold">{insight.metricAName}</p>
            <p className="text-sm text-muted-foreground my-1">
              {insight.lag === 1
                ? isPositive
                  ? "is followed the next day by higher"
                  : "is followed the next day by lower"
                : isPositive
                ? "rises with"
                : "falls when this rises:"}
            </p>
            <p className="font-semibold">{insight.metricBName}</p>
            <div className="mt-2">
              <EvidenceChip evidence={insight.stats.evidence} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <DismissBtn id={insight.id} onDismiss={onDismiss} pair={[insight.metricAId, insight.metricBId]} />
            <div className="text-right">
              <p className={`text-2xl font-bold font-mono ${color}`}>r {fmtR(r)}</p>
              <p className="text-xs text-muted-foreground">
                {strength} &middot; {insight.daysOverlap} {insight.lag === 1 ? "day pairs" : "days"}
              </p>
              <RangeLine low={insight.stats.low} high={insight.stats.high} fmt={fmtR} />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DayOfWeekCard({ insight, onDismiss, onClick }: CardProps<DayOfWeekInsight>) {
  // Bars show each weekday's difference from the overall average, so small but
  // real differences (e.g. a 4:30 vs 4:50 wake-up) are visible.
  const devs = insight.dayAverages.map((d) => d.avg - insight.overallAvg);
  const maxDev = Math.max(...devs.map(Math.abs), 1e-9);
  const HALF = 28;
  return (
    <Card
      className={`cursor-pointer hover:shadow-md transition-shadow ${privateBorder(insight.involvesPrivate)}`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-semibold">{insight.metricName}</p>
            <p className="text-sm text-muted-foreground mt-1">
              Best:{" "}
              <span className="text-green-600 dark:text-green-400 font-medium">
                {insight.bestDay} ({formatValue(insight.bestAvg, insight.metricType)})
              </span>
              {" "}&middot; Worst:{" "}
              <span className="text-red-600 dark:text-red-400 font-medium">
                {insight.worstDay} ({formatValue(insight.worstAvg, insight.metricType)})
              </span>
            </p>
            <div className="mt-2">
              <EvidenceChip evidence={insight.evidence} />
            </div>
          </div>
          <DismissBtn id={insight.id} onDismiss={onDismiss} />
        </div>

        <div className="mt-4 pt-3 border-t flex items-stretch gap-1">
          {insight.dayAverages.map((d, i) => {
            const dev = devs[i];
            const h = Math.max(1, Math.round((Math.abs(dev) / maxDev) * HALF));
            const isBest = d.day === insight.bestDay;
            const isWorst = d.day === insight.worstDay;
            const barColor = isBest
              ? "bg-green-500 dark:bg-green-400"
              : isWorst
              ? "bg-red-400 dark:bg-red-500"
              : "bg-muted-foreground/30";
            return (
              <div key={d.day} className="flex-1 flex flex-col items-center" title={`${d.day}: ${formatValue(d.avg, insight.metricType)}`}>
                <div className="relative w-full" style={{ height: HALF * 2 }}>
                  <div className="absolute inset-x-0 border-t border-dashed border-muted-foreground/30" style={{ top: HALF }} />
                  <div
                    className={`absolute left-1/2 -translate-x-1/2 w-3/4 rounded-sm ${barColor}`}
                    style={{ height: h, top: dev >= 0 ? HALF - h : HALF }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground mt-0.5">{d.day.slice(0, 2)}</span>
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1 text-center">
          vs overall average {formatValue(insight.overallAvg, insight.metricType)}
        </p>
      </CardContent>
    </Card>
  );
}

function TrendCard({ insight, onDismiss, onClick }: CardProps<TrendInsight>) {
  const hib = insight.higherIsBetter !== false;
  const isUp = insight.direction === "up";
  const { color } = goodBad(hib ? isUp : !isUp);
  const arrow = isUp ? "↑" : "↓";
  const fmt = (v: number) => formatDelta(v, insight.metricType);

  return (
    <Card
      className={`cursor-pointer hover:shadow-md transition-shadow ${privateBorder(insight.involvesPrivate)}`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="font-semibold">{insight.metricName}</p>
            <p className="text-sm text-muted-foreground mt-1">Last 30 days vs the 30 before</p>
            <div className="mt-2">
              <EvidenceChip evidence={insight.stats.evidence} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <DismissBtn id={insight.id} onDismiss={onDismiss} />
            <p className={`text-2xl font-bold tabular-nums ${color}`}>
              {arrow} {fmt(insight.stats.effect)}
            </p>
            {showPercent(insight.metricType, insight.priorAvg) && (
              <p className="text-xs text-muted-foreground">{formatPercent(insight.percentChange)}</p>
            )}
            <RangeLine low={insight.stats.low} high={insight.stats.high} fmt={fmt} />
          </div>
        </div>

        <div className="mt-4 pt-3 border-t grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Recent avg</p>
            <p className="font-mono font-semibold">{formatValue(insight.recentAvg, insight.metricType)}</p>
            <p className="text-xs text-muted-foreground">({insight.recentDays} days)</p>
          </div>
          <div>
            <p className="text-muted-foreground">Prior avg</p>
            <p className="font-mono font-semibold">{formatValue(insight.priorAvg, insight.metricType)}</p>
            <p className="text-xs text-muted-foreground">({insight.priorDays} days)</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HistogramCard({
  insight,
  onDismiss,
  onClick,
}: {
  insight: HistogramInsight;
  onDismiss: (id: string) => void;
  onClick: () => void;
}) {
  return (
    <Card
      className={`cursor-pointer hover:shadow-md transition-shadow ${privateBorder(insight.involvesPrivate)}`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="font-semibold">{insight.metricName}</p>
            <p className="text-sm text-muted-foreground mt-1">Distribution</p>
          </div>
          <DismissBtn id={insight.id} onDismiss={onDismiss} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Mean</p>
            <p className="font-mono font-semibold">{formatValue(insight.mean, insight.metricType)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Std Dev</p>
            <p className="font-mono font-semibold">{formatValue(insight.stdDev, insight.metricType)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Count</p>
            <p className="font-mono font-semibold">{insight.count}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CumulativeCard({
  insight,
  onDismiss,
  onClick,
}: {
  insight: CumulativeInsight;
  onDismiss: (id: string) => void;
  onClick: () => void;
}) {
  return (
    <Card
      className={`cursor-pointer hover:shadow-md transition-shadow ${privateBorder(insight.involvesPrivate)}`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="font-semibold">{insight.metricName}</p>
            <p className="text-sm text-muted-foreground mt-1">Running Total</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <DismissBtn id={insight.id} onDismiss={onDismiss} />
            <p className="text-2xl font-bold font-mono">
              {formatValue(insight.currentTotal, insight.metricType)}
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Daily Rate</p>
            <p className="font-mono font-semibold">{formatValue(insight.dailyRate, insight.metricType)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Year-End Est.</p>
            <p className="font-mono font-semibold">{formatValue(insight.projectedYearEnd, insight.metricType)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function YearOverYearCard({
  insight,
  onDismiss,
  onClick,
}: {
  insight: YearOverYearInsight;
  onDismiss: (id: string) => void;
  onClick: () => void;
}) {
  const hib = insight.higherIsBetter !== false;
  const isUp = insight.percentChange > 0;
  const isGood = hib ? isUp : !isUp;
  const color = isGood
    ? "text-green-600 dark:text-green-400"
    : "text-red-600 dark:text-red-400";

  return (
    <Card
      className={`cursor-pointer hover:shadow-md transition-shadow ${privateBorder(insight.involvesPrivate)}`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="font-semibold">{insight.metricName}</p>
            <p className="text-sm text-muted-foreground mt-1">{insight.yearRange}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <DismissBtn id={insight.id} onDismiss={onDismiss} />
            <p className={`text-2xl font-bold ${color}`}>
              {formatPercent(insight.percentChange)}
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Current Year</p>
            <p className="font-mono font-semibold">{formatValue(insight.currentYearAvg, insight.metricType)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Prior Year</p>
            <p className="font-mono font-semibold">{formatValue(insight.priorYearAvg, insight.metricType)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StreakTimelineCard({
  insight,
  onDismiss,
  onClick,
}: {
  insight: StreakTimelineInsight;
  onDismiss: (id: string) => void;
  onClick: () => void;
}) {
  return (
    <Card
      className={`cursor-pointer hover:shadow-md transition-shadow ${privateBorder(insight.involvesPrivate)}`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="font-semibold">{insight.metricName}</p>
            <p className="text-sm text-muted-foreground mt-1">Streak Analysis</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <DismissBtn id={insight.id} onDismiss={onDismiss} />
            <p className="text-2xl font-bold font-mono">
              {insight.currentStreak}
              <span className="text-sm font-normal text-muted-foreground ml-1">current</span>
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Longest</p>
            <p className="font-mono font-semibold">{insight.longestStreak} days</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Average</p>
            <p className="font-mono font-semibold">{insight.averageStreak} days</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CandlestickCard({
  insight,
  onDismiss,
  onClick,
}: {
  insight: CandlestickInsight;
  onDismiss: (id: string) => void;
  onClick: () => void;
}) {
  return (
    <Card
      className={`cursor-pointer hover:shadow-md transition-shadow ${privateBorder(insight.involvesPrivate)}`}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="font-semibold">{insight.metricName}</p>
            <p className="text-sm text-muted-foreground mt-1">Volatility</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <DismissBtn id={insight.id} onDismiss={onDismiss} />
            <p className="text-2xl font-bold font-mono">
              {(insight.volatility * 100).toFixed(0)}%
              <span className="text-sm font-normal text-muted-foreground ml-1">CV</span>
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Recent Range</p>
            <p className="font-mono font-semibold">{formatValue(insight.recentRange, insight.metricType)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Recent Close</p>
            <p className="font-mono font-semibold">{formatValue(insight.recentClose, insight.metricType)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SectionHeader({
  title,
  subtitle,
  count,
  expanded,
  onToggle,
}: {
  title: string;
  subtitle: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 mb-2 w-full text-left"
      >
        <ChevronIcon expanded={expanded} />
        <h2 className="text-lg font-semibold">{title}</h2>
        <Badge variant="secondary">{count} found</Badge>
      </button>
      {expanded && (
        <p className="text-sm text-muted-foreground mb-4 ml-6">{subtitle}</p>
      )}
    </>
  );
}

export default function InsightsPage() {
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPrivate, setShowPrivate] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [customInsights, setCustomInsights] = useState<CustomInsightConfig[]>([]);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<CustomInsightConfig | null>(null);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    top: true,
    custom: true,
    trends: true,
    // Descriptive charts start collapsed so the feed leads with findings.
    cumulative: false,
    dayOfWeek: true,
    histograms: false,
    candlesticks: false,
    streakTimelines: false,
    numericNumeric: true,
    yearOverYear: false,
    timeLagged: true,
    checkboxNumeric: true,
    checkboxCheckbox: true,
  });

  const toggleSection = useCallback((key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedInsight, setSelectedInsight] = useState<{
    type: string;
    id: string;
    metricIds: string[];
    metricNames: string[];
  } | null>(null);

  const openDetail = useCallback(
    (type: string, id: string, metricIds: string[], metricNames: string[]) => {
      setSelectedInsight({ type, id, metricIds, metricNames });
      setSheetOpen(true);
    },
    []
  );

  useEffect(() => {
    setDismissed(getDismissed());
    setCustomInsights(getCustomInsights());
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      const next = new Set(dismissed);
      next.add(id);
      setDismissed(next);
      saveDismissed(next);
    },
    [dismissed]
  );

  const resetDismissed = useCallback(() => {
    setDismissed(new Set());
    saveDismissed(new Set());
  }, []);

  const handleSaveCustom = useCallback((config: CustomInsightConfig) => {
    setCustomInsights((prev) => {
      const existing = prev.findIndex((c) => c.id === config.id);
      let next: CustomInsightConfig[];
      if (existing >= 0) {
        next = [...prev];
        next[existing] = config;
      } else {
        next = [...prev, config];
      }
      saveCustomInsights(next);
      return next;
    });
    setEditingConfig(null);
  }, []);

  const handleDeleteCustom = useCallback((id: string) => {
    setCustomInsights((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveCustomInsights(next);
      return next;
    });
  }, []);

  const handleEditCustom = useCallback((config: CustomInsightConfig) => {
    setEditingConfig(config);
    setBuilderOpen(true);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const headers = await getAuthHeaders();
        const res = await fetch(
          `/api/insights${showPrivate ? "?showPrivate=true" : ""}`,
          { headers }
        );
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || "Failed to load insights");
        setData(json);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    })();
  }, [showPrivate]);

  if (loading) {
    return (
      <main className="max-w-5xl mx-auto px-4 py-6 sm:p-6">
        <h1 className="text-2xl font-bold mb-6">Insights</h1>
        <p className="text-muted-foreground">Analyzing your data...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="max-w-5xl mx-auto px-4 py-6 sm:p-6">
        <h1 className="text-2xl font-bold mb-6">Insights</h1>
        <div className="bg-destructive/10 text-destructive p-4 rounded-lg">
          {error}
        </div>
      </main>
    );
  }

  const hidden = (id: string, a?: string, b?: string) =>
    dismissed.has(id) || (a !== undefined && b !== undefined && dismissed.has(pairKey(a, b)));

  const allTrends = data?.trends?.filter((i) => !hidden(i.id)) ?? [];
  const allDOW = data?.dayOfWeek?.filter((i) => !hidden(i.id)) ?? [];
  const allNN = data?.numericNumeric?.filter((i) => !hidden(i.id, i.metricAId, i.metricBId)) ?? [];
  const allTimeLagged =
    data?.timeLagged?.filter((i) => !hidden(i.id, i.triggerMetricId, i.outcomeMetricId)) ?? [];
  const allNumeric =
    data?.checkboxNumeric?.filter((i) => !hidden(i.id, i.checkboxMetricId, i.numericMetricId)) ?? [];
  const allCheckbox = data?.checkboxCheckbox?.filter((i) => !hidden(i.id, i.metricAId, i.metricBId)) ?? [];

  // Top insights: the strongest findings across every analysis, ranked by
  // effect size × strength of evidence. Shown first; not repeated below.
  type Ranked =
    | { kind: "cn"; score: number; insight: CorrelationInsight }
    | { kind: "tl"; score: number; insight: TimeLaggedInsight }
    | { kind: "cc"; score: number; insight: CheckboxCheckboxInsight }
    | { kind: "nn"; score: number; insight: NumericNumericInsight }
    | { kind: "tr"; score: number; insight: TrendInsight }
    | { kind: "dow"; score: number; insight: DayOfWeekInsight };
  const ranked: Ranked[] = [
    ...allNumeric.map((insight) => ({ kind: "cn" as const, score: insight.stats.score, insight })),
    ...allTimeLagged.map((insight) => ({ kind: "tl" as const, score: insight.stats.score, insight })),
    ...allCheckbox.map((insight) => ({ kind: "cc" as const, score: insight.stats.score, insight })),
    ...allNN.map((insight) => ({ kind: "nn" as const, score: insight.stats.score, insight })),
    ...allTrends.map((insight) => ({ kind: "tr" as const, score: insight.stats.score, insight })),
    ...allDOW.map((insight) => ({ kind: "dow" as const, score: insight.score, insight })),
  ]
    .filter((r) => r.kind === "dow" || r.insight.stats.evidence !== "suggestive")
    .sort((a, b) => b.score - a.score);
  const topInsights = ranked.slice(0, 5);
  const topIds = new Set(topInsights.map((r) => r.insight.id));
  const notTop = <T extends { id: string }>(xs: T[]) => xs.filter((x) => !topIds.has(x.id));

  const visibleTrends = notTop(allTrends);
  const visibleDOW = notTop(allDOW);
  const visibleNN = notTop(allNN);
  const visibleTimeLagged = notTop(allTimeLagged);
  const visibleNumeric = notTop(allNumeric);
  const visibleCheckbox = notTop(allCheckbox);
  const visibleHistograms = data?.histograms?.filter((i) => !hidden(i.id)) ?? [];
  const visibleCumulative = data?.cumulative?.filter((i) => !hidden(i.id)) ?? [];
  const visibleYoY = data?.yearOverYear?.filter((i) => !hidden(i.id)) ?? [];
  const visibleStreaks = data?.streakTimelines?.filter((i) => !hidden(i.id)) ?? [];
  const visibleCandlesticks = data?.candlesticks?.filter((i) => !hidden(i.id)) ?? [];

  const renderRanked = (r: Ranked) => {
    switch (r.kind) {
      case "cn":
        return (
          <InsightCard
            key={r.insight.id}
            insight={r.insight}
            onDismiss={dismiss}
            onClick={() =>
              openDetail("checkbox_numeric", r.insight.id, [r.insight.checkboxMetricId, r.insight.numericMetricId], [r.insight.checkboxMetricName, r.insight.numericMetricName])
            }
          />
        );
      case "tl":
        return (
          <TimeLaggedCard
            key={r.insight.id}
            insight={r.insight}
            onDismiss={dismiss}
            onClick={() =>
              openDetail("time_lagged", r.insight.id, [r.insight.triggerMetricId, r.insight.outcomeMetricId], [r.insight.triggerMetricName, r.insight.outcomeMetricName])
            }
          />
        );
      case "cc":
        return (
          <CheckboxInsightCard
            key={r.insight.id}
            insight={r.insight}
            onDismiss={dismiss}
            onClick={() =>
              openDetail("checkbox_checkbox", r.insight.id, [r.insight.metricAId, r.insight.metricBId], [r.insight.metricAName, r.insight.metricBName])
            }
          />
        );
      case "nn":
        return (
          <NumericNumericCard
            key={r.insight.id}
            insight={r.insight}
            onDismiss={dismiss}
            onClick={() =>
              openDetail("numeric_numeric", r.insight.id, [r.insight.metricAId, r.insight.metricBId], [r.insight.metricAName, r.insight.metricBName])
            }
          />
        );
      case "tr":
        return (
          <TrendCard
            key={r.insight.id}
            insight={r.insight}
            onDismiss={dismiss}
            onClick={() => openDetail("trend", r.insight.id, [r.insight.metricId], [r.insight.metricName])}
          />
        );
      case "dow":
        return (
          <DayOfWeekCard
            key={r.insight.id}
            insight={r.insight}
            onDismiss={dismiss}
            onClick={() => openDetail("day_of_week", r.insight.id, [r.insight.metricId], [r.insight.metricName])}
          />
        );
    }
  };

  const hasInsights =
    customInsights.length > 0 ||
    topInsights.length > 0 ||
    visibleTrends.length > 0 ||
    visibleCumulative.length > 0 ||
    visibleDOW.length > 0 ||
    visibleHistograms.length > 0 ||
    visibleCandlesticks.length > 0 ||
    visibleStreaks.length > 0 ||
    visibleNN.length > 0 ||
    visibleYoY.length > 0 ||
    visibleTimeLagged.length > 0 ||
    visibleNumeric.length > 0 ||
    visibleCheckbox.length > 0;
  const dismissedCount = dismissed.size;

  return (
    <main className="max-w-5xl mx-auto px-4 py-6 sm:p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Insights</h1>
          {data?.dateRange && (
            <p className="text-sm text-muted-foreground mt-1">
              Based on {data.totalDays} days of data ({data.dateRange.first} to{" "}
              {data.dateRange.last})
            </p>
          )}
        </div>
        <div className="flex items-center gap-4">
          {dismissedCount > 0 && (
            <button
              onClick={resetDismissed}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Show {dismissedCount} dismissed
            </button>
          )}
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={showPrivate}
              onChange={(e) => setShowPrivate(e.target.checked)}
              className="h-4 w-4 rounded"
            />
            Show private
          </label>
        </div>
      </div>

      {!hasInsights ? (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground mb-2">
              No significant insights found yet.
            </p>
            <p className="text-sm text-muted-foreground">
              Keep tracking! Insights require sufficient data and meaningful
              differences to appear.
            </p>
            <button
              onClick={() => setBuilderOpen(true)}
              className="mt-4 text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              + Create a custom insight
            </button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {/* Top insights */}
          {topInsights.length > 0 && (
            <section>
              <SectionHeader
                title="Top insights"
                subtitle="Your strongest patterns, ranked by size of effect and strength of evidence"
                count={topInsights.length}
                expanded={expanded.top}
                onToggle={() => toggleSection("top")}
              />
              {expanded.top && <div className="grid gap-4 md:grid-cols-2">{topInsights.map(renderRanked)}</div>}
            </section>
          )}

          {/* 2. Recent Trends */}
          {visibleTrends.length > 0 && (
            <section>
              <SectionHeader
                title="Recent Trends"
                subtitle="Metrics shifting compared to the prior period"
                count={visibleTrends.length}
                expanded={expanded.trends}
                onToggle={() => toggleSection("trends")}
              />
              {expanded.trends && (
                <div className="grid gap-4 md:grid-cols-2">
                  {visibleTrends.map((insight) => (
                    <TrendCard
                      key={insight.id}
                      insight={insight}
                      onDismiss={dismiss}
                      onClick={() =>
                        openDetail("trend", insight.id, [insight.metricId], [insight.metricName])
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 11. Habits -> Metrics */}
          {visibleNumeric.length > 0 && (
            <section>
              <SectionHeader
                title="Habits &rarr; Metrics"
                subtitle="How your daily habits correlate with numeric metrics"
                count={visibleNumeric.length}
                expanded={expanded.checkboxNumeric}
                onToggle={() => toggleSection("checkboxNumeric")}
              />
              {expanded.checkboxNumeric && (
                <div className="grid gap-4 md:grid-cols-2">
                  {visibleNumeric.map((insight) => (
                    <InsightCard
                      key={insight.id}
                      insight={insight}
                      onDismiss={dismiss}
                      onClick={() =>
                        openDetail(
                          "checkbox_numeric",
                          insight.id,
                          [insight.checkboxMetricId, insight.numericMetricId],
                          [insight.checkboxMetricName, insight.numericMetricName]
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 10. Next-Day Effects */}
          {visibleTimeLagged.length > 0 && (
            <section>
              <SectionHeader
                title="Next-Day Effects"
                subtitle="How a habit relates to your metrics 1–2 days later"
                count={visibleTimeLagged.length}
                expanded={expanded.timeLagged}
                onToggle={() => toggleSection("timeLagged")}
              />
              {expanded.timeLagged && (
                <div className="grid gap-4 md:grid-cols-2">
                  {visibleTimeLagged.map((insight) => (
                    <TimeLaggedCard
                      key={insight.id}
                      insight={insight}
                      onDismiss={dismiss}
                      onClick={() =>
                        openDetail(
                          "time_lagged",
                          insight.id,
                          [insight.triggerMetricId, insight.outcomeMetricId],
                          [insight.triggerMetricName, insight.outcomeMetricName]
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 12. Habit Pairs */}
          {visibleCheckbox.length > 0 && (
            <section>
              <SectionHeader
                title="Habit Pairs"
                subtitle="Habits that tend to occur together (or not)"
                count={visibleCheckbox.length}
                expanded={expanded.checkboxCheckbox}
                onToggle={() => toggleSection("checkboxCheckbox")}
              />
              {expanded.checkboxCheckbox && (
                <div className="grid gap-4 md:grid-cols-2">
                  {visibleCheckbox.map((insight) => (
                    <CheckboxInsightCard
                      key={insight.id}
                      insight={insight}
                      onDismiss={dismiss}
                      onClick={() =>
                        openDetail(
                          "checkbox_checkbox",
                          insight.id,
                          [insight.metricAId, insight.metricBId],
                          [insight.metricAName, insight.metricBName]
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 8. Metric Correlations */}
          {visibleNN.length > 0 && (
            <section>
              <SectionHeader
                title="Metric Correlations"
                subtitle="Metrics that move together, on the same day or the next"
                count={visibleNN.length}
                expanded={expanded.numericNumeric}
                onToggle={() => toggleSection("numericNumeric")}
              />
              {expanded.numericNumeric && (
                <div className="grid gap-4 md:grid-cols-2">
                  {visibleNN.map((insight) => (
                    <NumericNumericCard
                      key={insight.id}
                      insight={insight}
                      onDismiss={dismiss}
                      onClick={() =>
                        openDetail(
                          "numeric_numeric",
                          insight.id,
                          [insight.metricAId, insight.metricBId],
                          [insight.metricAName, insight.metricBName]
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 4. Weekly Patterns */}
          {visibleDOW.length > 0 && (
            <section>
              <SectionHeader
                title="Weekly Patterns"
                subtitle="How your metrics vary by day of the week"
                count={visibleDOW.length}
                expanded={expanded.dayOfWeek}
                onToggle={() => toggleSection("dayOfWeek")}
              />
              {expanded.dayOfWeek && (
                <div className="grid gap-4 md:grid-cols-2">
                  {visibleDOW.map((insight) => (
                    <DayOfWeekCard
                      key={insight.id}
                      insight={insight}
                      onDismiss={dismiss}
                      onClick={() =>
                        openDetail("day_of_week", insight.id, [insight.metricId], [insight.metricName])
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 1. Custom Insights - always visible */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => toggleSection("custom")}
                className="flex items-center gap-2 text-left"
              >
                <ChevronIcon expanded={expanded.custom} />
                <h2 className="text-lg font-semibold">Custom Insights</h2>
              </button>
              <button
                onClick={() => { setEditingConfig(null); setBuilderOpen(true); }}
                className="ml-2 px-2 py-0.5 rounded text-sm border border-dashed border-muted-foreground/40 text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
              >
                + New
              </button>
              {customInsights.length > 0 && (
                <Badge variant="secondary">{customInsights.length}</Badge>
              )}
            </div>
            {expanded.custom && (
              <>
                {customInsights.length === 0 ? (
                  <p className="text-sm text-muted-foreground ml-6 mb-4">
                    Create custom charts for any metric. Click &quot;+ New&quot; to get started.
                  </p>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2">
                    {customInsights.map((config) => (
                      <CustomInsightCard
                        key={config.id}
                        config={config}
                        showPrivate={showPrivate}
                        onEdit={() => handleEditCustom(config)}
                        onDelete={() => handleDeleteCustom(config.id)}
                        onClick={() =>
                          openDetail(config.chartType, config.id, [config.metricId], [config.metricName])
                        }
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          <p className="text-xs uppercase tracking-wide text-muted-foreground pt-2">Charts &amp; summaries</p>

          {/* 3. Cumulative Totals */}
          {visibleCumulative.length > 0 && (
            <section>
              <SectionHeader
                title="Cumulative Totals"
                subtitle="Running totals and year-end projections"
                count={visibleCumulative.length}
                expanded={expanded.cumulative}
                onToggle={() => toggleSection("cumulative")}
              />
              {expanded.cumulative && (
                <div className="grid gap-4 md:grid-cols-2">
                  {visibleCumulative.map((insight) => (
                    <CumulativeCard
                      key={insight.id}
                      insight={insight}
                      onDismiss={dismiss}
                      onClick={() =>
                        openDetail("cumulative", insight.id, [insight.metricId], [insight.metricName])
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 5. Value Distribution (histogram) */}
          {visibleHistograms.length > 0 && (
            <section>
              <SectionHeader
                title="Value Distribution"
                subtitle="How your metric values are distributed"
                count={visibleHistograms.length}
                expanded={expanded.histograms}
                onToggle={() => toggleSection("histograms")}
              />
              {expanded.histograms && (
                <div className="grid gap-4 md:grid-cols-2">
                  {visibleHistograms.map((insight) => (
                    <HistogramCard
                      key={insight.id}
                      insight={insight}
                      onDismiss={dismiss}
                      onClick={() =>
                        openDetail("histogram", insight.id, [insight.metricId], [insight.metricName])
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 6. Volatility (candlestick) */}
          {visibleCandlesticks.length > 0 && (
            <section>
              <SectionHeader
                title="Volatility"
                subtitle="Metrics with high variation over time"
                count={visibleCandlesticks.length}
                expanded={expanded.candlesticks}
                onToggle={() => toggleSection("candlesticks")}
              />
              {expanded.candlesticks && (
                <div className="grid gap-4 md:grid-cols-2">
                  {visibleCandlesticks.map((insight) => (
                    <CandlestickCard
                      key={insight.id}
                      insight={insight}
                      onDismiss={dismiss}
                      onClick={() =>
                        openDetail("candlestick", insight.id, [insight.metricId], [insight.metricName])
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 7. Streak Analysis */}
          {visibleStreaks.length > 0 && (
            <section>
              <SectionHeader
                title="Streak Analysis"
                subtitle="Consecutive day patterns in your metrics"
                count={visibleStreaks.length}
                expanded={expanded.streakTimelines}
                onToggle={() => toggleSection("streakTimelines")}
              />
              {expanded.streakTimelines && (
                <div className="grid gap-4 md:grid-cols-2">
                  {visibleStreaks.map((insight) => (
                    <StreakTimelineCard
                      key={insight.id}
                      insight={insight}
                      onDismiss={dismiss}
                      onClick={() =>
                        openDetail("streak_timeline", insight.id, [insight.metricId], [insight.metricName])
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 9. Year-over-Year */}
          {visibleYoY.length > 0 && (
            <section>
              <SectionHeader
                title="Year-over-Year"
                subtitle="How metrics compare across calendar years"
                count={visibleYoY.length}
                expanded={expanded.yearOverYear}
                onToggle={() => toggleSection("yearOverYear")}
              />
              {expanded.yearOverYear && (
                <div className="grid gap-4 md:grid-cols-2">
                  {visibleYoY.map((insight) => (
                    <YearOverYearCard
                      key={insight.id}
                      insight={insight}
                      onDismiss={dismiss}
                      onClick={() =>
                        openDetail("year_over_year", insight.id, [insight.metricId], [insight.metricName])
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}

        </div>
      )}

      {/* Methodology note */}
      <div className="mt-12 p-4 bg-muted/50 rounded-lg text-sm text-muted-foreground">
        <p className="font-medium mb-2">How this works</p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            <strong>Recent Trends:</strong> Compares the last 30 days to the
            prior 30 days.
          </li>
          <li>
            <strong>Cumulative Totals:</strong> Running totals with daily rate
            and year-end projections.
          </li>
          <li>
            <strong>Weekly Patterns:</strong> Compares each day&apos;s average
            to the overall average (needs 4+ data points per day).
          </li>
          <li>
            <strong>Value Distribution:</strong> Histogram showing how metric
            values are spread (needs 30+ data points).
          </li>
          <li>
            <strong>Volatility:</strong> Candlestick charts showing weekly/monthly
            open-high-low-close patterns.
          </li>
          <li>
            <strong>Streak Analysis:</strong> Consecutive day patterns showing
            current, longest, and average streaks.
          </li>
          <li>
            <strong>Metric Correlations:</strong> Pearson correlation between
            numeric metrics, same day or one metric today vs the other tomorrow.
          </li>
          <li>
            <strong>Year-over-Year:</strong> Compares metric averages across
            calendar years (needs 60+ days per year).
          </li>
          <li>
            <strong>Next-Day Effects:</strong> Compares a metric 1 or 2 days
            after a habit with its average otherwise.
          </li>
          <li>
            <strong>Habits &rarr; Metrics:</strong> Compares the average of a
            numeric metric on days when a checkbox is checked vs unchecked.
          </li>
          <li>
            <strong>Habit Pairs:</strong> Shows how often two habits occur
            together vs separately.
          </li>
          <li>
            <strong>Evidence levels:</strong> every relationship is tested for
            significance, allowing for the fact that consecutive days resemble
            each other, and then corrected for how many pairs were checked
            {data?.testedPairs ? ` (${data.testedPairs.toLocaleString()} this time)` : ""}. Only
            patterns unlikely to be chance are shown. &ldquo;Likely X to Y&rdquo;
            is the 95% range for the true effect. Pairs linked by a formula
            (e.g. a calculated metric and its inputs) are skipped.
          </li>
          <li>
            Habits are compared within the same weekday (Mondays with Mondays),
            so routines like weekend sleep-ins or scheduled workouts don&apos;t
            show up as fake effects. Days count from each metric&apos;s start date. An unchecked box
            counts as &ldquo;not done&rdquo; on any day you logged your required metrics.
          </li>
          <li>
            <em>Correlation &ne; causation.</em> These patterns suggest
            relationships but don&apos;t prove one thing causes another.
          </li>
        </ul>
      </div>

      <InsightDetailSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        insightType={selectedInsight?.type ?? null}
        insightId={selectedInsight?.id ?? null}
        metricIds={selectedInsight?.metricIds ?? []}
        metricNames={selectedInsight?.metricNames ?? []}
        showPrivate={showPrivate}
      />

      <CustomInsightBuilder
        open={builderOpen}
        onOpenChange={(open) => {
          setBuilderOpen(open);
          if (!open) setEditingConfig(null);
        }}
        onSave={handleSaveCustom}
        editingConfig={editingConfig}
      />
    </main>
  );
}
