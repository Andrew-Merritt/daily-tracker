/**
 * Insights engine: turns raw log rows into daily series and runs the
 * relationship / weekday / trend analyses with proper significance testing.
 *
 * Shared by /api/insights (the feed) and /api/insights/detail (the drill-down
 * sheet) so the numbers on a card and in its detail view always agree.
 *
 * Key rules
 * - A "tracked day" is a day on which any required metric was logged (the same
 *   notion the Today page's missing-days check uses). If no metrics are
 *   required, any day with any log counts.
 * - Checkboxes are stored row = done / no row = not done. On a tracked day on
 *   or after the metric's start date, a missing row means 0 — never "unknown".
 * - Numeric metrics only have values on days they were logged.
 * - Pairs linked by a formula (one is calculated from the other, or both from
 *   a shared input) are skipped: their relationship is true by construction.
 * - Relationships are compared within the same weekday (Mondays vs Mondays)
 *   and pooled, so weekly routines — weekend sleep-ins, scheduled workouts —
 *   don't show up as fake effects.
 * - Every relationship gets a p-value adjusted for day-to-day autocorrelation,
 *   then Benjamini–Hochberg across all pairs tested. Only q < 0.10 with at
 *   least a small effect is reported.
 */

import { addDays } from "@/lib/dateUtils";
import {
  anovaP,
  benjaminiHochberg,
  correlationTest,
  demeanByStratum,
  effectiveN,
  evidenceFor,
  lag1Autocorrelation,
  mean,
  stratifiedDiff,
  stratifiedRiskDiff,
  variance,
  welch,
  type Evidence,
  type TestResult,
} from "./stats";

export type EngineMetric = {
  metric_id: string;
  metric_name: string;
  type: string;
  private: boolean;
  higherIsBetter: boolean;
  /** First day the metric counts (config start_date, else first logged day). */
  trackedFrom: string | null;
};

export type Series = Map<string, number>;

export type InsightStats = {
  /** Effect estimate in natural units (difference, rate diff 0–1, or r). */
  effect: number;
  low: number;
  high: number;
  p: number;
  q: number;
  evidence: Evidence;
  /** |standardized effect| weighted by evidence — used to rank the feed. */
  score: number;
};

const NUMERIC_TYPES = new Set(["number", "score", "time", "hhmm", "count", "calculated"]);
export const isNumericType = (t: string) => NUMERIC_TYPES.has(t);

// Minimum effect sizes worth showing even when statistically significant.
const MIN_D = 0.2; // Cohen's d / h  ("small")
const MIN_R = 0.15;
const MAX_Q = 0.1;
const MIN_GROUP = 7;
const MIN_PAIRS = 14;

const nextDay = (d: string) => addDays(d, 1);
const dowCache = new Map<string, number>();
function dow(d: string): number {
  let v = dowCache.get(d);
  if (v === undefined) {
    if (dowCache.size > 50_000) dowCache.clear();
    dowCache.set(d, (v = new Date(`${d}T00:00:00`).getDay()));
  }
  return v;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function metricHigherIsBetter(analytics: { higher_is_better?: boolean; direction?: string } | null): boolean {
  if (analytics?.direction) return analytics.direction !== "decrease";
  return analytics?.higher_is_better !== false;
}

/**
 * Transitive base inputs of each calculated metric (calc of calc resolved).
 * Non-calculated metrics map to an empty set.
 */
export function calcInputs(
  metrics: { metric_id: string; is_calculated?: boolean | null; calc_expr?: string | null }[]
): Map<string, Set<string>> {
  const ids = new Set(metrics.map((m) => m.metric_id));
  const direct = new Map<string, Set<string>>();
  for (const m of metrics) {
    const refs = new Set<string>();
    if (m.is_calculated && m.calc_expr) {
      for (const tok of m.calc_expr.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []) {
        if (ids.has(tok) && tok !== m.metric_id) refs.add(tok);
      }
    }
    direct.set(m.metric_id, refs);
  }
  const resolved = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const done = resolved.get(id);
    if (done) return done;
    const out = new Set<string>();
    for (const r of direct.get(id) ?? []) {
      out.add(r);
      if (!stack.has(r)) {
        stack.add(r);
        for (const x of visit(r, stack)) out.add(x);
        stack.delete(r);
      }
    }
    resolved.set(id, out);
    return out;
  };
  for (const id of ids) visit(id, new Set([id]));
  return resolved;
}

/** True when a and b are linked by a formula (directly or via a shared input). */
export function formulaRelated(a: string, b: string, inputs: Map<string, Set<string>>): boolean {
  const ia = inputs.get(a) ?? new Set<string>();
  const ib = inputs.get(b) ?? new Set<string>();
  if (ia.has(b) || ib.has(a)) return true;
  for (const x of ia) if (ib.has(x)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

export type RawRow = { metric_id: string; date: string; value: number | null };

/**
 * Build one daily series per metric.
 * @param trackedDays sorted days that count as "tracked" (see module doc)
 */
export function buildSeries(metrics: EngineMetric[], rows: RawRow[], trackedDays: string[]): Map<string, Series> {
  const raw = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.value == null) continue;
    let m = raw.get(r.metric_id);
    if (!m) raw.set(r.metric_id, (m = new Map()));
    m.set(r.date, r.value);
  }
  const out = new Map<string, Series>();
  for (const m of metrics) {
    const vals = raw.get(m.metric_id) ?? new Map<string, number>();
    if (m.type === "checkbox") {
      const from = m.trackedFrom ?? [...vals.keys()].sort()[0];
      const s: Series = new Map();
      if (from) {
        for (const d of trackedDays) if (d >= from) s.set(d, (vals.get(d) ?? 0) >= 0.5 ? 1 : 0);
        // A checked day that wasn't otherwise a tracked day still happened.
        for (const [d, v] of vals) if (d >= from && !s.has(d)) s.set(d, v >= 0.5 ? 1 : 0);
      }
      out.set(m.metric_id, s);
    } else if (isNumericType(m.type)) {
      out.set(m.metric_id, vals);
    }
  }
  return out;
}

/** Days from rows that count as tracked: any required metric logged (fallback: any log). */
export function trackedDaysFrom(rows: RawRow[], requiredIds: Set<string>): string[] {
  const days = new Set<string>();
  const useRequired = requiredIds.size > 0;
  for (const r of rows) {
    if (useRequired ? requiredIds.has(r.metric_id) : true) days.add(r.date);
  }
  return [...days].sort();
}

// Pair building runs for every metric pair × lag, so cache the sorted dates of
// each series and the date arithmetic.
const sortedKeys = new WeakMap<Series, string[]>();
function datesOf(s: Series): string[] {
  let k = sortedKeys.get(s);
  if (!k) sortedKeys.set(s, (k = [...s.keys()].sort()));
  return k;
}
const shiftCache = new Map<string, string>();
function shift(d: string, lag: number): string {
  const key = `${d}|${lag}`;
  let v = shiftCache.get(key);
  if (v === undefined) {
    if (shiftCache.size > 200_000) shiftCache.clear();
    shiftCache.set(key, (v = addDays(d, lag)));
  }
  return v;
}

/** Aligned pairs: A on day d, B on day d + lag. */
export function pairPoints(a: Series, b: Series, lag = 0): { date: string; a: number; b: number }[] {
  const out: { date: string; a: number; b: number }[] = [];
  for (const d of datesOf(a)) {
    const bd = lag === 0 ? d : shift(d, lag);
    const bv = b.get(bd);
    if (bv !== undefined) out.push({ date: d, a: a.get(d)!, b: bv });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Relationship analysis
// ---------------------------------------------------------------------------

export type CheckboxNumericResult = {
  kind: "checkbox_numeric";
  lag: 0 | 1 | 2;
  trigger: EngineMetric;
  outcome: EngineMetric;
  avgTrue: number;
  avgFalse: number;
  nTrue: number;
  nFalse: number;
  stats: InsightStats;
};

export type CheckboxCheckboxResult = {
  kind: "checkbox_checkbox";
  a: EngineMetric;
  b: EngineMetric;
  rateTrue: number; // 0..1
  rateFalse: number;
  nTrue: number;
  nFalse: number;
  stats: InsightStats;
};

export type NumericNumericResult = {
  kind: "numeric_numeric";
  lag: 0 | 1;
  a: EngineMetric;
  b: EngineMetric;
  n: number;
  stats: InsightStats;
};

export type RelationshipResult = CheckboxNumericResult | CheckboxCheckboxResult | NumericNumericResult;

type Candidate = {
  build: (stats: InsightStats) => RelationshipResult;
  test: TestResult;
  bigEnough: boolean;
};

function withStats(test: TestResult, q: number): InsightStats | null {
  const evidence = evidenceFor(q);
  if (!evidence) return null;
  const weight = evidence === "strong" ? 1 : evidence === "moderate" ? 0.85 : 0.6;
  return {
    effect: test.estimate,
    low: test.low,
    high: test.high,
    p: test.p,
    q,
    evidence,
    score: Math.abs(test.standardized) * weight,
  };
}

export function analyzeRelationships(
  metrics: EngineMetric[],
  series: Map<string, Series>,
  inputs: Map<string, Set<string>>
): { results: RelationshipResult[]; tested: number } {
  const checkboxes = metrics.filter((m) => m.type === "checkbox" && (series.get(m.metric_id)?.size ?? 0) > 0);
  const numerics = metrics.filter((m) => isNumericType(m.type) && (series.get(m.metric_id)?.size ?? 0) > 0);
  const rho = new Map<string, number>();
  for (const m of [...checkboxes, ...numerics]) rho.set(m.metric_id, lag1Autocorrelation(series.get(m.metric_id)!, nextDay));

  const candidates: Candidate[] = [];

  // Checkbox → numeric, same day and 1–2 days later.
  for (const cb of checkboxes) {
    for (const num of numerics) {
      if (formulaRelated(cb.metric_id, num.metric_id, inputs)) continue;
      for (const lag of [0, 1, 2] as const) {
        const pts = pairPoints(series.get(cb.metric_id)!, series.get(num.metric_id)!, lag);
        const t = pts.filter((p) => p.a === 1).map((p) => p.b);
        const f = pts.filter((p) => p.a === 0).map((p) => p.b);
        if (t.length < MIN_GROUP || f.length < MIN_GROUP) continue;
        const n = t.length + f.length;
        const inflation = n / effectiveN(n, rho.get(cb.metric_id)!, rho.get(num.metric_id)!);
        const test = stratifiedDiff(
          pts.map((p) => ({ stratum: dow(p.date), t: p.a === 1, y: p.b })),
          inflation
        );
        // Need enough done / not-done days on weekdays where both occur.
        if (!test || test.nT < MIN_GROUP || test.nF < MIN_GROUP) continue;
        const avgTrue = mean(t);
        const avgFalse = mean(f);
        candidates.push({
          test,
          bigEnough: Math.abs(test.standardized) >= MIN_D,
          build: (stats) => ({
            kind: "checkbox_numeric",
            lag,
            trigger: cb,
            outcome: num,
            avgTrue,
            avgFalse,
            nTrue: t.length,
            nFalse: f.length,
            stats,
          }),
        });
      }
    }
  }

  // Checkbox ↔ checkbox (same day). Each unordered pair once.
  for (let i = 0; i < checkboxes.length; i++) {
    for (let j = i + 1; j < checkboxes.length; j++) {
      const a = checkboxes[i];
      const b = checkboxes[j];
      if (formulaRelated(a.metric_id, b.metric_id, inputs)) continue;
      const pts = pairPoints(series.get(a.metric_id)!, series.get(b.metric_id)!, 0);
      const t = pts.filter((p) => p.a === 1);
      const f = pts.filter((p) => p.a === 0);
      if (t.length < MIN_GROUP || f.length < MIN_GROUP) continue;
      const xT = t.filter((p) => p.b === 1).length;
      const xF = f.filter((p) => p.b === 1).length;
      // Need some variation in B, otherwise there's nothing to compare.
      if (xT + xF < 3 || xT + xF > pts.length - 3) continue;
      const n = pts.length;
      const inflation = n / effectiveN(n, rho.get(a.metric_id)!, rho.get(b.metric_id)!);
      const test = stratifiedRiskDiff(
        pts.map((p) => ({ stratum: dow(p.date), t: p.a === 1, y: p.b })),
        inflation
      );
      if (!test) continue;
      candidates.push({
        test,
        bigEnough: Math.abs(test.standardized) >= MIN_D,
        build: (stats) => ({
          kind: "checkbox_checkbox",
          a,
          b,
          rateTrue: xT / t.length,
          rateFalse: xF / f.length,
          nTrue: t.length,
          nFalse: f.length,
          stats,
        }),
      });
    }
  }

  // Numeric ↔ numeric: same day (unordered) and A today → B tomorrow (ordered).
  for (let i = 0; i < numerics.length; i++) {
    for (let j = 0; j < numerics.length; j++) {
      if (i === j) continue;
      const a = numerics[i];
      const b = numerics[j];
      if (formulaRelated(a.metric_id, b.metric_id, inputs)) continue;
      for (const lag of [0, 1] as const) {
        if (lag === 0 && j < i) continue; // same-day pairs are symmetric
        const pts = pairPoints(series.get(a.metric_id)!, series.get(b.metric_id)!, lag);
        if (pts.length < MIN_PAIRS) continue;
        // Partial correlation controlling for weekday: remove each series'
        // weekday means first (B's weekday is A's shifted by the lag).
        const strata = pts.map((p) => dow(p.date));
        const xs = demeanByStratum(pts.map((p) => p.a), strata);
        const ys = demeanByStratum(pts.map((p) => p.b), strata);
        if (variance(xs) === 0 || variance(ys) === 0) continue;
        const nEff = effectiveN(pts.length, rho.get(a.metric_id)!, rho.get(b.metric_id)!) - 6;
        const test = correlationTest(xs, ys, nEff);
        if (!test) continue;
        const n = pts.length;
        candidates.push({
          test,
          bigEnough: Math.abs(test.estimate) >= MIN_R,
          build: (stats) => ({ kind: "numeric_numeric", lag, a, b, n, stats }),
        });
      }
    }
  }

  // One family: control false discoveries across everything we tested.
  const qs = benjaminiHochberg(candidates.map((c) => c.test.p));
  const results: RelationshipResult[] = [];
  candidates.forEach((c, i) => {
    if (!c.bigEnough || qs[i] >= MAX_Q) return;
    const stats = withStats(c.test, qs[i]);
    if (stats) results.push(c.build(stats));
  });
  results.sort((x, y) => y.stats.score - x.stats.score);
  return { results, tested: candidates.length };
}

// ---------------------------------------------------------------------------
// Day-of-week and trend analyses (own families)
// ---------------------------------------------------------------------------

export type DayOfWeekResult = {
  metric: EngineMetric;
  dayAverages: number[]; // Sun..Sat
  overall: number;
  best: number; // index
  worst: number;
  p: number;
  q: number;
  evidence: Evidence;
  score: number;
};

export function analyzeDayOfWeek(metrics: EngineMetric[], series: Map<string, Series>): DayOfWeekResult[] {
  const cands: Omit<DayOfWeekResult, "q" | "evidence" | "score">[] = [];
  const sizes: number[] = [];
  for (const m of metrics) {
    if (!isNumericType(m.type)) continue;
    const s = series.get(m.metric_id);
    if (!s || s.size < 28) continue;
    const groups: number[][] = [[], [], [], [], [], [], []];
    for (const [d, v] of s) groups[new Date(`${d}T00:00:00`).getDay()].push(v);
    if (groups.some((g) => g.length < 4)) continue;
    const avgs = groups.map(mean);
    const all = groups.flat();
    const overall = mean(all);
    let best = 0;
    let worst = 0;
    for (let i = 1; i < 7; i++) {
      const better = m.higherIsBetter ? avgs[i] > avgs[best] : avgs[i] < avgs[best];
      const worse = m.higherIsBetter ? avgs[i] < avgs[worst] : avgs[i] > avgs[worst];
      if (better) best = i;
      if (worse) worst = i;
    }
    const sd = Math.sqrt(variance(all));
    sizes.push(sd > 0 ? Math.abs(avgs[best] - avgs[worst]) / sd : 0);
    cands.push({ metric: m, dayAverages: avgs, overall, best, worst, p: anovaP(groups) });
  }
  const qs = benjaminiHochberg(cands.map((c) => c.p));
  const out: DayOfWeekResult[] = [];
  cands.forEach((c, i) => {
    const evidence = evidenceFor(qs[i]);
    if (!evidence || sizes[i] < MIN_D * 2) return; // best-vs-worst spread ≥ 0.4 SD
    out.push({ ...c, q: qs[i], evidence, score: sizes[i] / 2 });
  });
  return out.sort((a, b) => b.score - a.score);
}

export type TrendResult = {
  metric: EngineMetric;
  recentAvg: number;
  priorAvg: number;
  nRecent: number;
  nPrior: number;
  stats: InsightStats;
};

/** Last `window` days vs the `window` days before, ending at `endDate`. */
export function analyzeTrends(
  metrics: EngineMetric[],
  series: Map<string, Series>,
  endDate: string,
  window = 30
): TrendResult[] {
  const recentFrom = addDays(endDate, -(window - 1));
  const priorFrom = addDays(recentFrom, -window);
  const cands: { metric: EngineMetric; r: number[]; p: number[]; test: TestResult }[] = [];
  for (const m of metrics) {
    if (!isNumericType(m.type)) continue;
    const s = series.get(m.metric_id);
    if (!s) continue;
    const r: number[] = [];
    const pr: number[] = [];
    for (const [d, v] of s) {
      if (d >= recentFrom && d <= endDate) r.push(v);
      else if (d >= priorFrom && d < recentFrom) pr.push(v);
    }
    if (r.length < 14 || pr.length < 14) continue;
    // Time blocks are maximally autocorrelated groupings: inflate by (1+ρ)/(1−ρ).
    const rho = lag1Autocorrelation(s, nextDay);
    const test = welch(r, pr, (1 + rho) / (1 - rho));
    if (test) cands.push({ metric: m, r, p: pr, test });
  }
  const qs = benjaminiHochberg(cands.map((c) => c.test.p));
  const out: TrendResult[] = [];
  cands.forEach((c, i) => {
    if (Math.abs(c.test.standardized) < MIN_D) return;
    const stats = withStats(c.test, qs[i]);
    if (!stats) return;
    out.push({ metric: c.metric, recentAvg: mean(c.r), priorAvg: mean(c.p), nRecent: c.r.length, nPrior: c.p.length, stats });
  });
  return out.sort((a, b) => b.stats.score - a.stats.score);
}
