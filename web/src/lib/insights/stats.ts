/**
 * Small statistics toolkit for the Insights engine. Pure functions, no deps.
 *
 * Daily habit data is autocorrelated (today's sleep looks like yesterday's), so
 * treating N days as N independent observations overstates certainty. Tests
 * here accept an "effective n" computed with Bartlett's approximation for two
 * lag-1 autocorrelated series:  n_eff = n · (1 − ρx·ρy) / (1 + ρx·ρy).
 */

// ---------------------------------------------------------------------------
// Special functions
// ---------------------------------------------------------------------------

/** ln Γ(x), Lanczos approximation (g=7, n=9). */
export function logGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (Numerical Recipes betacf). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 300;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p-value for Student's t with df degrees of freedom. */
export function tTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  if (df <= 0) return 1;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/** Upper-tail p-value for F(d1, d2). */
export function fUpperP(f: number, d1: number, d2: number): number {
  if (!(f > 0)) return 1;
  return incompleteBeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
}

/** Two-sided p-value for a standard normal z. */
export function zTwoSidedP(z: number): number {
  // erfc via the t-distribution with a huge df is accurate and reuses code.
  return tTwoSidedP(z, 1e7);
}

/** t critical value for a two-sided interval with the given confidence. */
export function tCritical(df: number, confidence = 0.95): number {
  const alpha = 1 - confidence;
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoSidedP(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Descriptives
// ---------------------------------------------------------------------------

export function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (n − 1). */
export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
}

/**
 * Lag-1 autocorrelation of a daily series given as date → value, using only
 * pairs of consecutive calendar days. Clamped to [0, 0.95]: negative
 * autocorrelation would *increase* effective n, which we don't credit.
 */
export function lag1Autocorrelation(series: Map<string, number>, nextDay: (d: string) => string): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [d, v] of series) {
    const n = series.get(nextDay(d));
    if (n !== undefined) {
      xs.push(v);
      ys.push(n);
    }
  }
  if (xs.length < 10) return 0;
  const r = pearson(xs, ys);
  if (!Number.isFinite(r)) return 0;
  return Math.max(0, Math.min(0.95, r));
}

/** Bartlett effective sample size for two lag-1 autocorrelated series. */
export function effectiveN(n: number, rhoX: number, rhoY: number): number {
  const p = Math.max(0, rhoX) * Math.max(0, rhoY);
  return Math.max(3, (n * (1 - p)) / (1 + p));
}

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxy += xs[i] * ys[i];
    sx2 += xs[i] * xs[i];
    sy2 += ys[i] * ys[i];
  }
  const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  return den === 0 ? NaN : (n * sxy - sx * sy) / den;
}

// ---------------------------------------------------------------------------
// Tests. Each returns the estimate, a 95% interval and a two-sided p-value.
// `inflation` = n / n_eff (≥ 1) widens standard errors for autocorrelation.
// ---------------------------------------------------------------------------

export type TestResult = {
  /** Point estimate in natural units (difference of means / rates, or r). */
  estimate: number;
  low: number;
  high: number;
  p: number;
  /** Standardized effect size (Cohen's d / h, or d-equivalent of r) for ranking. */
  standardized: number;
};

/** Welch two-sample t-test on means (a − b). */
export function welch(a: number[], b: number[], inflation = 1): TestResult | null {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) return null;
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a);
  const vb = variance(b);
  const se2 = (va / na + vb / nb) * inflation;
  const diff = ma - mb;
  const pooledSd = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  if (se2 <= 0) {
    // No variance at all: identical constant groups → no evidence either way.
    return diff === 0 ? { estimate: 0, low: 0, high: 0, p: 1, standardized: 0 } : null;
  }
  const se = Math.sqrt(se2);
  const dfRaw = (va / na + vb / nb) ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
  const df = Math.max(1, dfRaw / inflation);
  const t = diff / se;
  const tc = tCritical(df);
  return {
    estimate: diff,
    low: diff - tc * se,
    high: diff + tc * se,
    p: tTwoSidedP(t, df),
    standardized: pooledSd > 0 ? diff / pooledSd : 0,
  };
}

/** Two-proportion z-test (rate when A − rate when not A), rates in 0..1. */
export function twoProportion(x1: number, n1: number, x2: number, n2: number, inflation = 1): TestResult | null {
  if (n1 < 1 || n2 < 1) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pool = (x1 + x2) / (n1 + n2);
  const seTest = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2) * inflation);
  const seCi = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2) * Math.sqrt(inflation);
  const diff = p1 - p2;
  const p = seTest > 0 ? zTwoSidedP(diff / seTest) : diff === 0 ? 1 : 0;
  // Cohen's h
  const h = 2 * Math.asin(Math.sqrt(p1)) - 2 * Math.asin(Math.sqrt(p2));
  return { estimate: diff, low: diff - 1.96 * seCi, high: diff + 1.96 * seCi, p, standardized: h };
}

/** Pearson correlation test with Fisher-z interval, using an effective n. */
export function correlationTest(xs: number[], ys: number[], nEff = xs.length): TestResult | null {
  const r = pearson(xs, ys);
  if (!Number.isFinite(r)) return null;
  const n = Math.max(4, nEff);
  const rc = Math.max(-0.999999, Math.min(0.999999, r));
  const t = rc * Math.sqrt((n - 2) / (1 - rc * rc));
  const z = Math.atanh(rc);
  const se = 1 / Math.sqrt(n - 3);
  return {
    estimate: r,
    low: Math.tanh(z - 1.96 * se),
    high: Math.tanh(z + 1.96 * se),
    p: tTwoSidedP(t, n - 2),
    standardized: (2 * rc) / Math.sqrt(1 - rc * rc),
  };
}

/** One-way ANOVA p-value across groups. */
export function anovaP(groups: number[][]): number {
  const k = groups.length;
  const all = groups.flat();
  const N = all.length;
  if (k < 2 || N <= k) return 1;
  const grand = mean(all);
  let ssb = 0;
  let ssw = 0;
  for (const g of groups) {
    if (g.length === 0) continue;
    const m = mean(g);
    ssb += g.length * (m - grand) ** 2;
    for (const x of g) ssw += (x - m) ** 2;
  }
  if (ssw === 0) return ssb > 0 ? 0 : 1;
  const f = ssb / (k - 1) / (ssw / (N - k));
  return fUpperP(f, k - 1, N - k);
}

// ---------------------------------------------------------------------------
// Multiple comparisons
// ---------------------------------------------------------------------------

/**
 * Benjamini–Hochberg adjusted p-values (q-values), same order as input.
 * Controls the expected share of false discoveries among what we show.
 */
export function benjaminiHochberg(ps: number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const q = new Array<number>(m);
  let min = 1;
  for (let rank = m; rank >= 1; rank--) {
    const [p, i] = order[rank - 1];
    min = Math.min(min, (p * m) / rank);
    q[i] = Math.min(1, min);
  }
  return q;
}

export type Evidence = "strong" | "moderate" | "suggestive";

/** Plain-language evidence level from a q-value (null = don't show). */
export function evidenceFor(q: number): Evidence | null {
  if (q < 0.01) return "strong";
  if (q < 0.05) return "moderate";
  if (q < 0.1) return "suggestive";
  return null;
}

// ---------------------------------------------------------------------------
// Weekday-adjusted (stratified) tests
//
// Weekly routines confound naive comparisons: if you lift on weekdays and sleep
// in on weekends, "lifting days" look like early-wake days even if lifting has
// nothing to do with it. These versions compare like with like — Mondays with
// Mondays — then pool across weekdays (regression with weekday fixed effects).
// ---------------------------------------------------------------------------

export type StratPoint = { stratum: number; t: boolean; y: number };

/**
 * Difference in means (done − not done) within strata, pooled with weights
 * w = nT·nF/(nT+nF). Equivalent to OLS with stratum fixed effects for a binary
 * treatment. SE uses the pooled within-cell variance.
 */
export function stratifiedDiff(points: StratPoint[], inflation = 1): (TestResult & { nT: number; nF: number }) | null {
  const cells = new Map<number, { t: number[]; f: number[] }>();
  for (const p of points) {
    let c = cells.get(p.stratum);
    if (!c) cells.set(p.stratum, (c = { t: [], f: [] }));
    (p.t ? c.t : c.f).push(p.y);
  }
  let sumW = 0;
  let sumWD = 0;
  let ss = 0;
  let nUsed = 0;
  let groups = 0;
  let nT = 0;
  let nF = 0;
  for (const { t, f } of cells.values()) {
    if (t.length === 0 || f.length === 0) continue;
    const mt = mean(t);
    const mf = mean(f);
    const w = (t.length * f.length) / (t.length + f.length);
    sumW += w;
    sumWD += w * (mt - mf);
    for (const y of t) ss += (y - mt) ** 2;
    for (const y of f) ss += (y - mf) ** 2;
    nUsed += t.length + f.length;
    groups += 2;
    nT += t.length;
    nF += f.length;
  }
  const dfRaw = nUsed - groups;
  if (sumW === 0 || dfRaw < 2) return null;
  const diff = sumWD / sumW;
  const s2 = ss / dfRaw;
  const sd = Math.sqrt(s2);
  if (s2 === 0) return diff === 0 ? { estimate: 0, low: 0, high: 0, p: 1, standardized: 0, nT, nF } : null;
  const se = Math.sqrt((s2 / sumW) * inflation);
  const df = Math.max(1, dfRaw / inflation);
  const tc = tCritical(df);
  return {
    estimate: diff,
    low: diff - tc * se,
    high: diff + tc * se,
    p: tTwoSidedP(diff / se, df),
    standardized: diff / sd,
    nT,
    nF,
  };
}

/** Within-stratum difference in rates (0/1 outcomes), pooled like stratifiedDiff. */
export function stratifiedRiskDiff(points: StratPoint[], inflation = 1): TestResult | null {
  const cells = new Map<number, { xt: number; nt: number; xf: number; nf: number }>();
  for (const p of points) {
    let c = cells.get(p.stratum);
    if (!c) cells.set(p.stratum, (c = { xt: 0, nt: 0, xf: 0, nf: 0 }));
    if (p.t) {
      c.nt++;
      c.xt += p.y;
    } else {
      c.nf++;
      c.xf += p.y;
    }
  }
  let sumW = 0;
  let sumWD = 0;
  let varNum = 0;
  let hNum = 0;
  for (const c of cells.values()) {
    if (c.nt === 0 || c.nf === 0) continue;
    const pt = c.xt / c.nt;
    const pf = c.xf / c.nf;
    const w = (c.nt * c.nf) / (c.nt + c.nf);
    sumW += w;
    sumWD += w * (pt - pf);
    // Wald variance with a +½ continuity guard so all-0/all-1 cells aren't zero-variance.
    const ptv = (c.xt + 0.5) / (c.nt + 1);
    const pfv = (c.xf + 0.5) / (c.nf + 1);
    varNum += w * w * ((ptv * (1 - ptv)) / c.nt + (pfv * (1 - pfv)) / c.nf);
    hNum += w * (2 * Math.asin(Math.sqrt(pt)) - 2 * Math.asin(Math.sqrt(pf)));
  }
  if (sumW === 0) return null;
  const diff = sumWD / sumW;
  const se = Math.sqrt((varNum / (sumW * sumW)) * inflation);
  if (!(se > 0)) return null;
  return {
    estimate: diff,
    low: diff - 1.96 * se,
    high: diff + 1.96 * se,
    p: zTwoSidedP(diff / se),
    standardized: hNum / sumW,
  };
}

/** Subtract each stratum's mean (for partial correlations controlling for weekday). */
export function demeanByStratum(values: number[], strata: number[]): number[] {
  const sum = new Map<number, number>();
  const cnt = new Map<number, number>();
  values.forEach((v, i) => {
    sum.set(strata[i], (sum.get(strata[i]) ?? 0) + v);
    cnt.set(strata[i], (cnt.get(strata[i]) ?? 0) + 1);
  });
  return values.map((v, i) => v - sum.get(strata[i])! / cnt.get(strata[i])!);
}
