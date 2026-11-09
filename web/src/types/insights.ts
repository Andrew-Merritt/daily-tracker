export type InsightType =
  | "trend"
  | "day_of_week"
  | "numeric_numeric"
  | "checkbox_numeric"
  | "checkbox_checkbox"
  | "time_lagged"
  | "histogram"
  | "cumulative"
  | "year_over_year"
  | "streak_timeline"
  | "candlestick";

export type Evidence = "strong" | "moderate" | "suggestive";

/**
 * Significance info attached to relationship / trend insights.
 * effect, low, high: estimate and 95% interval in natural units — a difference
 * of averages, a difference of rates (0–1), or a correlation r.
 * q: p-value after the Benjamini–Hochberg correction across everything tested.
 */
export type InsightEvidence = {
  effect: number;
  low: number;
  high: number;
  p: number;
  q: number;
  evidence: Evidence;
  score: number;
};

export type Metric = {
  metric_id: string;
  metric_name: string | null;
  type: string;
  private: boolean | null;
  is_calculated: boolean | null;
  calc_expr: string | null;
  analytics_config: {
    higher_is_better?: boolean;
    direction?: "increase" | "decrease" | "neutral";
  } | null;
  start_date?: string | null;
  required?: boolean | null;
};

export type LogRow = {
  metric_id: string;
  date: string;
  value: number | null;
};

export type CorrelationInsight = {
  type: "checkbox_numeric";
  id: string;
  checkboxMetricId: string;
  checkboxMetricName: string;
  numericMetricId: string;
  numericMetricName: string;
  avgWhenTrue: number;
  avgWhenFalse: number;
  percentDiff: number;
  daysTrue: number;
  daysFalse: number;
  direction: "higher" | "lower";
  involvesPrivate: boolean;
  numericHigherIsBetter: boolean;
  numericMetricType: string;
  stats: InsightEvidence;
};

export type CheckboxCheckboxInsight = {
  type: "checkbox_checkbox";
  id: string;
  metricAId: string;
  metricAName: string;
  metricBId: string;
  metricBName: string;
  rateWhenATrue: number;
  rateWhenAFalse: number;
  percentDiff: number;
  daysATrue: number;
  daysAFalse: number;
  involvesPrivate: boolean;
  stats: InsightEvidence;
};

export type NumericNumericInsight = {
  type: "numeric_numeric";
  id: string;
  metricAId: string;
  metricAName: string;
  metricBId: string;
  metricBName: string;
  correlation: number;
  direction: "positive" | "negative";
  daysOverlap: number;
  involvesPrivate: boolean;
  metricAHigherIsBetter: boolean;
  metricBHigherIsBetter: boolean;
  /** 0 = same day; 1 = A today vs B the next day. */
  lag: 0 | 1;
  metricAType: string;
  metricBType: string;
  stats: InsightEvidence;
};

export type TimeLaggedInsight = {
  type: "time_lagged";
  id: string;
  triggerMetricId: string;
  triggerMetricName: string;
  outcomeMetricId: string;
  outcomeMetricName: string;
  avgNextDayWhenTrue: number;
  avgNextDayWhenFalse: number;
  percentDiff: number;
  direction: "higher" | "lower";
  daysTrue: number;
  daysFalse: number;
  involvesPrivate: boolean;
  outcomeHigherIsBetter: boolean;
  /** Days between the checkbox and the outcome (1 = next day). */
  lag: 1 | 2;
  outcomeMetricType: string;
  stats: InsightEvidence;
};

export type DayOfWeekInsight = {
  type: "day_of_week";
  id: string;
  metricId: string;
  metricName: string;
  metricType: string;
  bestDay: string;
  worstDay: string;
  bestAvg: number;
  worstAvg: number;
  overallAvg: number;
  dayAverages: { day: string; avg: number }[];
  involvesPrivate: boolean;
  higherIsBetter: boolean;
  q: number;
  evidence: Evidence;
  score: number;
};

export type TrendInsight = {
  type: "trend";
  id: string;
  metricId: string;
  metricName: string;
  metricType: string;
  recentAvg: number;
  priorAvg: number;
  percentChange: number;
  direction: "up" | "down";
  recentDays: number;
  priorDays: number;
  involvesPrivate: boolean;
  higherIsBetter: boolean;
  stats: InsightEvidence;
};

export type HistogramInsight = {
  type: "histogram";
  id: string;
  metricId: string;
  metricName: string;
  metricType: string;
  mean: number;
  stdDev: number;
  count: number;
  involvesPrivate: boolean;
  higherIsBetter: boolean;
};

export type CumulativeInsight = {
  type: "cumulative";
  id: string;
  metricId: string;
  metricName: string;
  metricType: string;
  currentTotal: number;
  dailyRate: number;
  projectedYearEnd: number;
  involvesPrivate: boolean;
  higherIsBetter: boolean;
};

export type YearOverYearInsight = {
  type: "year_over_year";
  id: string;
  metricId: string;
  metricName: string;
  metricType: string;
  yearRange: string;
  currentYearAvg: number;
  priorYearAvg: number;
  percentChange: number;
  involvesPrivate: boolean;
  higherIsBetter: boolean;
};

export type StreakTimelineInsight = {
  type: "streak_timeline";
  id: string;
  metricId: string;
  metricName: string;
  metricType: string;
  currentStreak: number;
  longestStreak: number;
  averageStreak: number;
  isCheckbox: boolean;
  involvesPrivate: boolean;
  higherIsBetter: boolean;
};

export type CandlestickInsight = {
  type: "candlestick";
  id: string;
  metricId: string;
  metricName: string;
  metricType: string;
  recentRange: number;
  recentClose: number;
  volatility: number;
  involvesPrivate: boolean;
  higherIsBetter: boolean;
};

export type InsightsResponse = {
  checkboxNumeric: CorrelationInsight[];
  checkboxCheckbox: CheckboxCheckboxInsight[];
  numericNumeric: NumericNumericInsight[];
  timeLagged: TimeLaggedInsight[];
  dayOfWeek: DayOfWeekInsight[];
  trends: TrendInsight[];
  histograms: HistogramInsight[];
  cumulative: CumulativeInsight[];
  yearOverYear: YearOverYearInsight[];
  streakTimelines: StreakTimelineInsight[];
  candlesticks: CandlestickInsight[];
  totalDays: number;
  dateRange: { first: string; last: string } | null;
  /** How many relationships were tested (for the "N pairs tested" note). */
  testedPairs?: number;
};

export type CustomInsightConfig = {
  id: string;
  metricId: string;
  metricName: string;
  chartType: InsightType;
  label?: string;
  options?: {
    period?: "weekly" | "monthly";
    threshold?: number;
    bins?: number;
    dateRange?: { start?: string; end?: string };
  };
  createdAt: number;
};
