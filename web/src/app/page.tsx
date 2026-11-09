"use client";
import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { getAuthHeaders } from "@/lib/authHeaders";
import { delay } from "@/lib/delay";
import { LoadingScreen } from "@/components/loading/LoadingScreen";
import { DailyTrackerLoader } from "@/components/loading/DailyTrackerLoader";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import React from "react";
import { evaluateCalculatedMetricsV2 } from "@/lib/calc";
import { getLocalDateString, addDays } from "@/lib/dateUtils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SpeechTextarea } from "@/components/ui/speech-textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { TrendBadge } from "@/components/ui/trend-badge";
import { StreakBadge } from "@/components/ui/streak-badge";
import { DatePicker } from "@/components/ui/date-picker";
import { MetricStatsSheet } from "@/components/metric-stats-sheet";
import { QuickAddMetricSheet } from "@/components/QuickAddMetricSheet";
import { MetricHoverTooltip } from "@/components/metric-hover-tooltip";
import { MultiGoalBadge } from "@/components/ui/goal-progress-badge";
import { useMediaQuery } from "@/hooks/use-media-query";
import { TimeOfDayPicker, DurationPicker, NumberWheelPicker } from "@/components/ui/mobile-pickers";
import { useTour } from "@/hooks/useTour";
import { buttonVariants } from "@/components/ui/button";
import { useToast } from "@/components/ui/Toast";
import { CALC_DEBUG_KEY } from "@/lib/devFlags";
import "driver.js/dist/driver.css";

type GoalIndicator = {
  goal_id: string;
  name: string;
  progress_pct: number;
  status: "on_track" | "at_risk" | "met" | "missed" | "not_started";
  current: number;
  target: number;
  frequency: "daily" | "weekly" | "monthly";
};

type ConfigRow = {
  metric_id: string;
  metric_name: string;
  type: "checkbox" | "number" | "score" | "count" | "time" | "hhmm" | "text";
  group?: string | null;
  default_value: number | null;
  min_value: number | null;
  max_value: number | null;
  disallowed_values: string | null;
  required: boolean;
  private: boolean;
  active: boolean;
  show_ma: boolean;
  ma_periods_csv: string | null;
  start_date: string | null;
  metric_order?: number | null;
  group_order?: number | null;
  preset_values_csv?: string | null;
  stt_enabled?: boolean;
  is_calculated: boolean;
  calc_expr: string | null;
  analytics_config?: {
    hide_trend?: boolean;
    hide_streak?: boolean; // deprecated
    show_streak?: boolean; // default: true
    avoid?: boolean; // deprecated, use direction instead
    direction?: "increase" | "decrease" | "neutral"; // increase=positive streaks good, decrease=negative streaks good, neutral=no flame
    trend_period?: number;
    higher_is_better?: boolean;
  } | null;
  notification_config?: {
    streak_alerts?: {
      enabled?: boolean;
      last_notified_threshold?: number | null;
      last_streak_sign?: "positive" | "negative" | "zero" | null;
    };
  } | null;
};

type IndicatorData = {
  trend?: {
    direction: "up" | "down" | "flat";
    change_pct: number;
    period_days: number;
  };
  streak?: {
    yesterday: number;
    logged_today: boolean;
    current: number;
    seed: number;
  };
  goals?: GoalIndicator[];
};

type IndicatorsResponse = {
  metrics: Record<string, IndicatorData>;
};

type UserSettings = {
  main_page: {
    show_indicators: boolean;
    show_trends: boolean;
    show_streaks: boolean;
  };
};

// Inline styles removed - using Tailwind classes instead

type DateHints = {
  today: string;
  last_log_date: string | null;
  last_required_complete_date: string | null;
  suggested_date: string;
  missing_required_days: number;
  required_days_completed: number;
  required_days_possible: number;
};

// function daysBetween(a: string, b: string): number {
//   // a and b are "YYYY-MM-DD"
//   const da = new Date(a + "T00:00:00");
//   const db = new Date(b + "T00:00:00");
//   const ms = db.getTime() - da.getTime();
//   return Math.round(ms / 86400000); // 1000 * 60 * 60 * 24
// }


function sortMetricsForForm(list: ConfigRow[]): ConfigRow[] {
  // Build a group -> group_order map (using the smallest value per group)
  const groupOrderMap = new Map<string, number>();

  for (const m of list) {
    const key = m.group || ""; // Ungrouped becomes ""
    const existing = groupOrderMap.get(key);
    const candidate = m.group_order ?? 0;

    if (existing === undefined || candidate < existing) {
      groupOrderMap.set(key, candidate);
    }
  }

  return [...list].sort((a, b) => {
    const ga = a.group || "";
    const gb = b.group || "";

    const goa = groupOrderMap.get(ga) ?? 0;
    const gob = groupOrderMap.get(gb) ?? 0;

    // 1) group_order at the group level
    if (goa !== gob) return goa - gob;

    // 2) group name as a tie-breaker
    if (ga !== gb) return ga.localeCompare(gb);

    // 3) metric_order within the group
    const oa = a.metric_order ?? 0;
    const ob = b.metric_order ?? 0;
    if (oa !== ob) return oa - ob;

    // 4) stable fallback by ID
    return a.metric_id.localeCompare(b.metric_id);
  });
}

export default function Home() {
  const { toast, confirm } = useToast();
  const [authChecked, setAuthChecked] = useState(false);
  const todayISO = getLocalDateString();
  const [date, setDate] = useState<string>(() => getLocalDateString());
  const [initialDateLoaded, setInitialDateLoaded] = useState(false);
  const [metrics, setMetrics] = useState<ConfigRow[]>([]);
  const [metricsLoaded, setMetricsLoaded] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  // Track which metrics have default values auto-populated (not from saved data)
  const [defaultPopulated, setDefaultPopulated] = useState<Set<string>>(new Set());
  // Track which metrics have been "touched" (focused or edited)
  const [touchedMetrics, setTouchedMetrics] = useState<Set<string>>(new Set());

  const [dateHints, setDateHints] = useState<DateHints | null>(null);
  const [dateInitializedFromHints, setDateInitializedFromHints] = useState(false);

  const hasRequired = metrics.some((m) => m.required);

  const [showCalcDebug, setShowCalcDebug] = useState(false);
  // Calc debug is a developer aid toggled from Settings (stored per device).
  useEffect(() => {
    setShowCalcDebug(localStorage.getItem(CALC_DEBUG_KEY) === "1");
  }, []);
  const [hasShownHeadsUp, setHasShownHeadsUp] = useState(false);

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // Show private metrics toggle (persists through date changes)
  const [showPrivate, setShowPrivate] = useState(true);

  // Indicators state
  const [indicators, setIndicators] = useState<IndicatorsResponse | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);

  // Track original saved numeric values for goal indicator live updates
  const [savedNumericVals, setSavedNumericVals] = useState<Record<string, number | null>>({});

  // Available years for date picker (years with log data)
  const [availableYears, setAvailableYears] = useState<number[]>([]);

  // Stats sheet state
  const [statsMetric, setStatsMetric] = useState<ConfigRow | null>(null);

  // Quick-add metric FAB state
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  // Mobile detection for picker UI
  const isMobile = useMediaQuery("(max-width: 639px)");

  // Derived groups for quick-add sheet datalist
  const existingGroups = useMemo(
    () => [...new Set(metrics.filter((c) => c.group).map((c) => c.group!))].sort(),
    [metrics]
  );

  const { status: tourStatus, loading: tourLoading, seed: tourSeed, cleanup: tourCleanup, devReset: tourDevReset } = useTour();

  // A ref flag set when we want the tour to start as soon as metrics are in the DOM
  const pendingTourLaunch = useRef(false);

  const reloadMetrics = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch("/api/config", { headers });
      const data = await res.json();
      if (!res.ok) return;
      const rows = data as any[];
      const normalized: ConfigRow[] = rows.map((r) => ({
        metric_id: r.metric_id,
        metric_name: (r.metric_name ?? r.metric_id).replace(/\s*\[[0-9a-f]{8}\]$/, ""),
        type: r.type,
        group: r.group ?? null,
        private: !!r.private,
        active: r.active ?? true,
        show_ma: !!r.show_ma,
        ma_periods_csv: r.ma_periods_csv ?? "",
        start_date: r.start_date ?? null,
        required: !!r.required,
        default_value: r.default_value ?? null,
        min_value: r.min_value ?? null,
        max_value: r.max_value ?? null,
        disallowed_values: r.disallowed_values ?? null,
        metric_order: typeof r.metric_order === "number" ? r.metric_order : null,
        group_order: typeof r.group_order === "number" ? r.group_order : null,
        preset_values_csv: r.preset_values_csv ?? null,
        is_calculated: !!r.is_calculated,
        calc_expr: r.calc_expr ?? null,
        analytics_config: r.analytics_config ?? null,
        notification_config: r.notification_config ?? null,
      }));
      const active = normalized.filter((r) => r.active);
      setMetrics(sortMetricsForForm(active));
    } catch (e) {
      console.warn("Metrics reload failed:", e);
    }
  }, []);

  const launchDriverTour = useCallback(() => {
    import("driver.js").then(({ driver }) => {
      const driverObj = driver({
        animate: true,
        showProgress: true,
        allowClose: true,
        steps: [
          {
            popover: {
              title: "Welcome to Daily Tracker",
              description:
                "This quick tour shows you how to log your day. We've added some demo metrics so you can see everything in action. Takes about 1 minute.",
              nextBtnText: "Let's go →",
            },
          },
          {
            element: '[data-tour="date-picker"]',
            popover: {
              title: "Date Navigation",
              description:
                "The app auto-jumps to the next date that needs data. You can navigate to any past date to log or review your entries.",
              side: "bottom",
              align: "start",
            },
          },
          {
            element: '[data-tour="metric-group"]',
            popover: {
              title: "Metric Groups",
              description:
                "Metrics are organized into collapsible groups. Click any group header to expand or collapse it — handy for keeping things tidy.",
              side: "bottom",
              align: "start",
            },
          },
          {
            element: '[data-tour="metric-row"]',
            popover: {
              title: "Logging Your Data",
              description:
                "Each row is one metric. You'll see different input types: checkboxes, numbers, scores, time values, and free text. Badges show your trend (↑↓), streak (🔥), and goal progress (%).",
              side: "bottom",
              align: "start",
            },
          },
          {
            element: '[data-tour="metric-label"]',
            popover: {
              title: "Detailed Stats",
              description:
                "Click any metric name to open its full history: a chart, heatmap, streaks, and more. Great for spotting long-term patterns.",
              side: "right",
              align: "start",
            },
          },
          {
            element: '[data-tour="save-button"]',
            popover: {
              title: "Save Your Day",
              description:
                "Hit Save Day (or Ctrl+Enter) to save all your entries. Ready to set up your own metrics?",
              side: "bottom",
              align: "end",
              nextBtnText: "Go to Metrics →",
              onNextClick: () => {
                driverObj.destroy();
                window.location.href = "/metrics";
              },
            },
          },
        ],
      });
      driverObj.drive();
    });
  }, [tourCleanup]);

  // When metrics load (or reload) and a tour launch is pending, start the tour.
  // Using a small timeout to let React commit the DOM after state update.
  useEffect(() => {
    if (!pendingTourLaunch.current) return;
    if (metrics.length === 0) return;
    pendingTourLaunch.current = false;
    setTimeout(launchDriverTour, 300);
  }, [metrics, launchDriverTour]);

  // Auto-resume on page reload when status is 'seeded' (abandoned prior session)
  const tourAutoResumed = useRef(false);
  useEffect(() => {
    if (tourStatus !== "seeded") return;
    if (metrics.length === 0) return;
    if (tourAutoResumed.current) return;
    tourAutoResumed.current = true;
    setTimeout(launchDriverTour, 500);
  }, [tourStatus, metrics, launchDriverTour]);

  function toggleGroup(name: string) {
    setCollapsedGroups((prev) => ({
      ...prev,
      [name]: !prev[name],
    }));
  }

  // Warn user about unsaved changes when trying to close or refresh the page
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        // Standard way to trigger the browser's native confirmation dialog
        e.preventDefault();
        // For older browsers (Chrome < 119)
        e.returnValue = "";
        return "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);


  const groupedMetrics = React.useMemo<
    { groupName: string; items: ConfigRow[] }[]
  >(() => {
    if (!metrics || metrics.length === 0) return [];

    const map = new Map<string, ConfigRow[]>();

    for (const m of metrics) {
      // Skip private metrics if showPrivate is disabled
      if (!showPrivate && m.private) continue;

      const groupName = m.group || "Other";
      if (!map.has(groupName)) map.set(groupName, []);
      map.get(groupName)!.push(m);
    }

    return Array.from(map.entries()).map(([groupName, items]) => ({
      groupName,
      items,
    }));
  }, [metrics, showPrivate]);

  const daysBetween = (d1: string, d2: string) => {
    const t1 = Date.parse(d1);
    const t2 = Date.parse(d2);
    if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0;
    // difference in whole days
    return Math.floor((t2 - t1) / 86400000);
  };

  const gapMessage = (() => {
    if (metrics.length === 0) return null;
    if (!dateHints) return null;

    const anchor =
      dateHints.last_log_date || dateHints.last_required_complete_date;
    if (!anchor) return null;

    if (date <= anchor) return null;

    const diffDays = daysBetween(anchor, date);
    const missingWholeDays = diffDays - 1;

    if (missingWholeDays <= 0) return null;

    return `There ${missingWholeDays === 1 ? "is" : "are"} ${missingWholeDays} missing day${
      missingWholeDays === 1 ? "" : "s"
    } between your last recorded day (${anchor}) and this date.`;
  })();





  
  // Ref to hold current save function for keyboard shortcut
  const saveRef = useRef<() => void>(() => {});

  // auth check effect
  useEffect(() => {
    (async () => {
      const { data, error } = await supabaseBrowser.auth.getSession();
      if (!data.session) {
        // not logged in → go to login
        window.location.href = "/login";
        return;
      }
      // logged in
      setAuthChecked(true);
    })();
  }, []);

  // Ctrl+Enter keyboard shortcut to save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (!saving && metrics.length > 0) {
          saveRef.current();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [saving, metrics.length]);

  // Combined initial load: fires once after auth, fetches config/dateHints/settings/availableYears in parallel
  useEffect(() => {
    if (!authChecked) return;
    (async () => {
      const loadStart = Date.now();
      try {
        const headers = await getAuthHeaders();

        const [configRes, hintsRes, settingsRes, logsRes] = await Promise.all([
          fetch("/api/config", { headers }),
          fetch("/api/date_hints", { headers }),
          fetch("/api/settings", { headers }),
          fetch("/api/log?years=1", { headers }),
        ]);

        // Config
        if (configRes.ok) {
          const data = await configRes.json();
          const rows = data as any[];
          const normalized: ConfigRow[] = rows.map((r) => ({
            metric_id: r.metric_id,
            metric_name: (r.metric_name ?? r.metric_id).replace(/\s*\[[0-9a-f]{8}\]$/, ""),
            type: r.type,
            group: r.group ?? null,
            private: !!r.private,
            active: r.active ?? true,
            show_ma: !!r.show_ma,
            ma_periods_csv: r.ma_periods_csv ?? "",
            start_date: r.start_date ?? null,
            required: !!r.required,
            default_value: r.default_value ?? null,
            min_value: r.min_value ?? null,
            max_value: r.max_value ?? null,
            disallowed_values: r.disallowed_values ?? null,
            metric_order: typeof r.metric_order === "number" ? r.metric_order : null,
            group_order: typeof r.group_order === "number" ? r.group_order : null,
            preset_values_csv: r.preset_values_csv ?? null,
            stt_enabled: !!r.stt_enabled,
            is_calculated: !!r.is_calculated,
            calc_expr: r.calc_expr ?? null,
            analytics_config: r.analytics_config ?? null,
            notification_config: r.notification_config ?? null,
          }));
          setMetrics(sortMetricsForForm(normalized.filter((r) => r.active)));
          const elapsed = Date.now() - loadStart;
          if (elapsed < 1000) await delay(1000 - elapsed);
          setMetricsLoaded(true);
        } else {
          const err = await configRes.json().catch(() => null);
          setError(err?.error || "Failed to load config");
        }

        // Date hints
        const hintsCt = hintsRes.headers.get("content-type") || "";
        if (hintsRes.ok && hintsCt.includes("application/json")) {
          const j = await hintsRes.json();
          if (!j?.error) setDateHints(j as DateHints);
        }

        // Settings
        if (settingsRes.ok) {
          setUserSettings(await settingsRes.json());
        }

        // Available years (server returns newest-first, current year included)
        if (logsRes.ok) {
          setAvailableYears((await logsRes.json()) as number[]);
        } else {
          const currentYear = new Date().getFullYear();
          setAvailableYears(Array.from({ length: 5 }, (_, i) => currentYear - i));
        }
      } catch (e: any) {
        setError(String(e?.message || e));
        const currentYear = new Date().getFullYear();
        setAvailableYears(Array.from({ length: 5 }, (_, i) => currentYear - i));
      }
    })();
  }, [authChecked]);

  // Fetch indicators when date changes
  useEffect(() => {
    if (!authChecked) return;
    if (!date) return;
    // Validate date format before fetching
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    // Wait for settings to load before deciding
    if (userSettings === null) return;
    // If settings loaded but indicators are disabled, clear them
    if (!userSettings.main_page?.show_indicators) {
      setIndicators(null);
      return;
    }
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`/api/indicators?date=${encodeURIComponent(date)}`, { headers });
        if (res.ok) {
          const data = await res.json();
          setIndicators(data);
        } else {
          // Log as warning to avoid triggering Next.js error overlay for transient network issues
          console.warn("Indicators API error:", res.status, await res.text());
        }
      } catch (e) {
        console.warn("Failed to load indicators:", e);
      }
    })();
  }, [authChecked, date, userSettings]);

  useEffect(() => {
    if (!authChecked) return;
    if (!dateHints) return;
    if (dateInitializedFromHints) return;

    // A deep link (/?date=YYYY-MM-DD, e.g. "Edit this day" from the heatmap)
    // wins over the suggested date. Strip it afterwards so a refresh or the
    // back button behaves normally.
    const linked = new URLSearchParams(window.location.search).get("date");
    const linkedOk = !!linked && /^\d{4}-\d{2}-\d{2}$/.test(linked) && linked <= dateHints.today;
    if (linked) window.history.replaceState(null, "", window.location.pathname);

    const nextDate = linkedOk ? linked : dateHints.suggested_date || dateHints.today;
    if (nextDate) setDate(nextDate);

    // Decide Heads Up exactly once, at initial auto-jump
    // if (!hasShownHeadsUp && dateHints.missing_required_days > 0) {
    //   setShowHeadsUp(true);
    //   setHasShownHeadsUp(true);
    // } else {
    //   setShowHeadsUp(false);
    //   setHasShownHeadsUp(true); // lock it off so it never reappears this page load
    // }

    setDateInitializedFromHints(true);
  }, [authChecked, dateHints, dateInitializedFromHints, hasShownHeadsUp]);

  // Initial load of the date's data
  useEffect(() => {
    if (!authChecked) return;
    if (!date) return;
    if (metrics.length === 0) return;
    // Validate date is complete YYYY-MM-DD format (typing fires onChange on each keystroke)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

    loadDayValues(date);
  }, [authChecked, date, metrics]);

  
  const setVal = (id: string, v: string) => {
    setVals(s => ({ ...s, [id]: v }));
    setDirty(true);
  };

  // Mark a metric as "touched" (user interacted with it)
  const markAsTouched = (id: string) => {
    setTouchedMetrics(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const [prevByN, setPrevByN] = useState<Record<number, Record<string, number | null>>>({});

  const metricsById = React.useMemo<Record<string, ConfigRow>>(() => {
    const m: Record<string, ConfigRow> = {};
    for (const metric of metrics) {
      m[metric.metric_id] = metric;
    }
    return m;
  }, [metrics]);

  type SaveEntry = {
    metric_id: string;
    value: number | null;
    value_text?: string | null;
  };

  function getMaxPrevDays(metrics: ConfigRow[]): number {
    let maxN = 1;
    const re = /prev\(\s*[a-zA-Z0-9_]+\s*(?:,\s*(\d+)\s*)?\)/g;

    for (const m of metrics) {
      if (!m.is_calculated || !m.calc_expr) continue;
      let match: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((match = re.exec(m.calc_expr)) !== null) {
        const n = match[1] ? Number(match[1]) : 1;
        if (Number.isFinite(n) && n > maxN) maxN = n;
      }
    }

    return Math.max(1, Math.min(365, Math.floor(maxN))); // clamp to keep sane
  }


  function buildEntries(): SaveEntry[] {
    const entries: SaveEntry[] = [];

    for (const m of metrics) {
      // Skip untouched default-populated fields (don't save them)
      if (defaultPopulated.has(m.metric_id) && !touchedMetrics.has(m.metric_id)) {
        continue;
      }

      // Calculated metrics → use calculatedValues
      if (m.is_calculated) {
        const v = calculatedValues[m.metric_id];
        const num = v != null && Number.isFinite(v) ? (v as number) : null;

        // If it's a checkbox metric, enforce row/no-row semantics
        const coerced =
          m.type === "checkbox"
            ? (num != null && num >= 0.5 ? 1 : null)
            : num;

        entries.push({ metric_id: m.metric_id, value: coerced });
        continue;
      }

      // console.log("calc sample", {
      //   date,
      //   total_sleep: calculatedValues["total_sleep"],
      //   fasting_window: calculatedValues["fasting_window"],
      // });

      // Non-calculated metrics → use user input
      const raw = vals[m.metric_id];
      const trimmed = raw?.trim() ?? "";

      let value: number | null = null;

      if (m.type === "text") {
        // raw multi-line allowed; blank => delete row
        const t = raw ?? "";
        entries.push({
          metric_id: m.metric_id,
          value: null,
          value_text: t.trim() === "" ? null : t, // keep raw text, only trim to decide empty vs not
        });
        continue;
      }

      if (m.type === "checkbox") {
        // checkbox: checked => 1, unchecked => null (delete row)
        value = trimmed ? 1 : null;
      } else if (m.type === "hhmm") {
        if (trimmed !== "") {
          const mins = parseHHMM(trimmed);
          value = mins != null ? mins : null;
        } else {
          value = null; // delete row
        }
      } else if (m.type === "time") {
        // time: accepts both minutes and h:mm format
        if (trimmed !== "") {
          value = parseTimeInput(trimmed);
        } else {
          value = null;
        }
      } else {
        // number
        if (trimmed !== "") {
          const num = Number(trimmed);
          value = Number.isFinite(num) ? num : null;
        } else {
          value = null;
        }
      }

      entries.push({
        metric_id: m.metric_id,
        value,
      });
    }

    return entries;
  }



  function parseHHMM(raw: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // Try HH:MM or H:MM format first
    const colonMatch = /^(\d{1,2}):([0-5]\d)$/.exec(trimmed);
    if (colonMatch) {
      const hours = Number(colonMatch[1]);
      const minutes = Number(colonMatch[2]);
      if (hours < 0 || hours > 23) return null;
      return hours * 60 + minutes;
    }

    // Try flexible numeric formats (desktop-friendly):
    // 3 digits: 705 → 7:05, 130 → 1:30
    // 4 digits: 1930 → 19:30, 0705 → 7:05
    const numMatch = /^(\d{3,4})$/.exec(trimmed);
    if (numMatch) {
      const num = trimmed;
      let hours: number;
      let minutes: number;

      if (num.length === 3) {
        // 705 → 7:05
        hours = Number(num.slice(0, 1));
        minutes = Number(num.slice(1));
      } else {
        // 1930 → 19:30
        hours = Number(num.slice(0, 2));
        minutes = Number(num.slice(2));
      }

      if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
      return hours * 60 + minutes;
    }

    return null;
  }

  function formatHHMM(totalMinutes: number | null): string {
    if (totalMinutes == null || !Number.isFinite(totalMinutes)) return "";
    const minutes = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function formatDurationHHMM(totalMinutes: number | null): string {
    if (totalMinutes == null || !Number.isFinite(totalMinutes)) return "";
    const minutes = Math.max(0, Math.round(totalMinutes));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
  }

  // Parse time input - accepts both raw minutes (e.g., "420") and h:mm format (e.g., "7:00")
  function parseTimeInput(raw: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // Try h:mm or hh:mm format first
    const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (match) {
      const h = Number(match[1]);
      const m = Number(match[2]);
      if (h >= 0 && m >= 0 && m < 60) {
        return h * 60 + m;
      }
    }

    // Try raw minutes
    const num = Number(trimmed);
    if (Number.isFinite(num) && num >= 0) {
      return num;
    }

    return null;
  }


  function validateField(m: ConfigRow, raw: string): string | null {
    // Checkboxes: no numeric validation
    if (m.type === "checkbox") return null;
    
    // Text: always valid here (required-on-past-days handled elsewhere)
    if (m.type === "text") return null;

    // Empty → treat as delete, no error
    if (raw === "" || raw == null) return null;

    // HH:MM type (also accepts flexible numeric formats like 705 → 7:05, 1930 → 19:30)
    if (m.type === "hhmm") {
      const minutes = parseHHMM(raw);
      if (minutes == null) {
        return `${m.metric_name}: use HH:MM or numeric (705, 1930)`;
      }
      // If you later want min/max for hhmm, you can reuse the numeric block below
      return null;
    }

    // TIME type: accept both minutes and h:mm
    if (m.type === "time") {
      const mins = parseTimeInput(raw);
      if (mins == null) {
        return `${m.metric_name}: enter minutes (e.g., 90) or h:mm (e.g., 1:30)`;
      }
      // Range checks
      if (m.min_value != null && mins < m.min_value) {
        return `${m.metric_name}: must be ≥ ${m.min_value} minutes`;
      }
      if (m.max_value != null && mins > m.max_value) {
        return `${m.metric_name}: must be ≤ ${m.max_value} minutes`;
      }
      return null;
    }

    // NUMBER: parse
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      return `${m.metric_name}: not a valid number`;
    }

    // Range checks
    if (m.min_value != null && num < m.min_value) {
      return `${m.metric_name}: must be ≥ ${m.min_value}`;
    }
    if (m.max_value != null && num > m.max_value) {
      return `${m.metric_name}: must be ≤ ${m.max_value}`;
    }

    // Disallowed values (comma-separated in config)
    if (m.disallowed_values) {
      const banned = m.disallowed_values
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isFinite(n));

      if (banned.includes(num)) {
        return `${m.metric_name}: ${num} is not an allowed value`;
      }
    }

    return null;
  }

  function getNumericValue(m: ConfigRow, vals: Record<string, string>): number | null {
    const raw = vals[m.metric_id];
    if (raw == null || raw.trim() === "") return null;

    switch (m.type) {
      case "number": {
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      }
      case "checkbox": {
        // checkbox stored as "on" or "" in vals
        return raw === "on" || raw === "1" ? 1 : 0;
      }
      case "time": {
        // time = duration in minutes; accepts plain minutes ("960") or
        // h:mm ("16:00"), matching validateField's parseTimeInput and how
        // default_value/saved values are displayed (formatDurationHHMM).
        return parseTimeInput(raw);
      }

      case "hhmm": {
        // hhmm = clock time "HH:MM" -> minutes since midnight
        const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return null;

        const hours = Number(match[1]);
        const minutes = Number(match[2]);

        if (
          !Number.isFinite(hours) ||
          !Number.isFinite(minutes) ||
          hours < 0 ||
          hours > 23 ||
          minutes < 0 ||
          minutes > 59
        ) {
          return null;
        }

        return hours * 60 + minutes;
      }

      default:
        return null;
    }
  }

  type NumericContext = {
    [metricId: string]: number | null;
  };

  function buildNumericContext(metrics: ConfigRow[], vals: Record<string, string>): NumericContext {
    const ctx: NumericContext = {};
    for (const m of metrics) {
      ctx[m.metric_id] = getNumericValue(m, vals);
    }
    return ctx;
  }

  function buildNumericContextFromLogRows(
    metrics: ConfigRow[],
    rows: { metric_id: string; value: any }[]
  ): Record<string, number | null> {
    const map = new Map(rows.map((r) => [r.metric_id, r.value]));
    const ctx: Record<string, number | null> = {};

    for (const m of metrics) {
      const v = map.get(m.metric_id);

      if (v == null) {
        ctx[m.metric_id] = null;
        continue;
      }

      if (m.type === "checkbox") {
        const num = typeof v === "number" ? v : Number(v);
        ctx[m.metric_id] = Number.isFinite(num) && num >= 0.5 ? 1 : 0;
      } else {
        const num = typeof v === "number" ? v : Number(v);
        ctx[m.metric_id] = Number.isFinite(num) ? num : null;
      }
    }
    return ctx;
  }


  useEffect(() => {
    if (!authChecked) return;
    if (!date) return;
    if (metrics.length === 0) return;
    // Validate date is complete YYYY-MM-DD format before creating Date objects
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

    const maxN = getMaxPrevDays(metrics);

    // If no calculated metrics use prev(), keep empty
    const needsPrev = metrics.some(
      (m) => m.is_calculated && (m.calc_expr ?? "").includes("prev(")
    );
    if (!needsPrev) {
      setPrevByN({});
      return;
    }

    (async () => {
      try {
        // Build [start, end] = [date - maxN, date - 1]
        const end = addDays(date, -1);
        const start = addDays(date, -maxN);

        const headers = await getAuthHeaders();
        const res = await fetch(
          `/api/log?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
          { headers }
        );

        const rows = (await res.json()) as { date: string; metric_id: string; value: any }[];
        if (!res.ok) {
          setPrevByN({});
          return;
        }

        // Group rows by date
        const rowsByDate = new Map<string, { metric_id: string; value: any }[]>();
        for (const r of rows) {
          if (!rowsByDate.has(r.date)) rowsByDate.set(r.date, []);
          rowsByDate.get(r.date)!.push({ metric_id: r.metric_id, value: r.value });
        }

        // Build prevByN contexts for 1..maxN
        const out: Record<number, Record<string, number | null>> = {};

        for (let n = 1; n <= maxN; n++) {
          const d = addDays(date, -n);
          const dayRows = rowsByDate.get(d) ?? [];
          out[n] = buildNumericContextFromLogRows(metrics, dayRows);
        }

        setPrevByN(out);
      } catch {
        setPrevByN({});
      }
    })();
  }, [authChecked, date, metrics]);


  // type Token =
  //   | { kind: "number"; value: number }
  //   | { kind: "ident"; name: string }
  //   | { kind: "op"; op: "+" | "-" | "*" | "/" }
  //   | { kind: "paren"; value: "(" | ")" };

  // function tokenizeExpr(expr: string): Token[] | null {
  //   const tokens: Token[] = [];
  //   let i = 0;

  //   while (i < expr.length) {
  //     const ch = expr[i];

  //     if (ch === " " || ch === "\t") {
  //       i++;
  //       continue;
  //     }

  //     if (/[0-9.]/.test(ch)) {
  //       let j = i;
  //       while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
  //       const numStr = expr.slice(i, j);
  //       const n = Number(numStr);
  //       if (!Number.isFinite(n)) return null;
  //       tokens.push({ kind: "number", value: n });
  //       i = j;
  //       continue;
  //     }

  //     if (/[a-zA-Z_]/.test(ch)) {
  //       let j = i;
  //       while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j++;
  //       const name = expr.slice(i, j);
  //       tokens.push({ kind: "ident", name });
  //       i = j;
  //       continue;
  //     }

  //     if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
  //       tokens.push({ kind: "op", op: ch });
  //       i++;
  //       continue;
  //     }

  //     if (ch === "(" || ch === ")") {
  //       tokens.push({ kind: "paren", value: ch });
  //       i++;
  //       continue;
  //     }

  //     // unsupported character
  //     return null;
  //   }

  //   return tokens;
  // }

  // function toRpn(tokens: Token[]): (Token & { kind: "number" | "ident" | "op" })[] | null {
  //   const output: (Token & { kind: "number" | "ident" | "op" })[] = [];
  //   const ops: ("+" | "-" | "*" | "/" | "(")[] = [];

  //   const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };

  //   for (const t of tokens) {
  //     if (t.kind === "number" || t.kind === "ident") {
  //       output.push(t as any);
  //     } else if (t.kind === "op") {
  //       while (ops.length > 0) {
  //         const top = ops[ops.length - 1];
  //         if (top === "(") break;
  //         if (precedence[top] >= precedence[t.op]) {
  //           output.push({ kind: "op", op: ops.pop()! } as any);
  //         } else break;
  //       }
  //       ops.push(t.op);
  //     } else if (t.kind === "paren" && t.value === "(") {
  //       ops.push("(");
  //     } else if (t.kind === "paren" && t.value === ")") {
  //       let found = false;
  //       while (ops.length > 0) {
  //         const top = ops.pop()!;
  //         if (top === "(") {
  //           found = true;
  //           break;
  //         }
  //         output.push({ kind: "op", op: top } as any);
  //       }
  //       if (!found) return null; // mismatched parens
  //     }
  //   }

  //   while (ops.length > 0) {
  //     const top = ops.pop()!;
  //     if (top === "(") return null;
  //     output.push({ kind: "op", op: top } as any);
  //   }

  //   return output;
  // }

  // function evalRpn(
  //   rpn: (Token & { kind: "number" | "ident" | "op" })[],
  //   ctx: NumericContext
  // ): number | null {
  //   const stack: number[] = [];

  //   for (const t of rpn) {
  //     if (t.kind === "number") {
  //       stack.push(t.value);
  //     } else if (t.kind === "ident") {
  //       const metric = metricsById[t.name]; // ConfigRow | undefined
  //       const v = ctx[t.name];

  //       // Treat missing checkbox as 0 for arithmetic
  //       if (metric?.type === "checkbox") {
  //         stack.push(v ?? 0);
  //         continue;
  //       }

  //       // For all other types, missing propagates to null
  //       if (v == null) return null;
  //       stack.push(v);
  //     } else if (t.kind === "op") {
  //       if (stack.length < 2) return null;
  //       const b = stack.pop()!;
  //       const a = stack.pop()!;
  //       if (a == null || b == null) return null;
  //       let res: number;
  //       switch (t.op) {
  //         case "+":
  //           res = a + b;
  //           break;
  //         case "-":
  //           res = a - b;
  //           break;
  //         case "*":
  //           res = a * b;
  //           break;
  //         case "/":
  //           if (b === 0) return null;
  //           res = a / b;
  //           break;
  //         default:
  //           return null;
  //       }
  //       if (!Number.isFinite(res)) return null;
  //       stack.push(res);
  //     }
  //   }


  //   if (stack.length !== 1) return null;
  //   return stack[0];
  // }

  // function evalCalcExpr(
  //   expr: string,
  //   ctx: Record<string, number | null>,
  //   metricsById: Record<string, ConfigRow>
  // ): number | null{
  //   const trimmed = expr.trim();
  //   if (!trimmed) return null;

  //   const tokens = tokenizeExpr(trimmed);
  //   if (!tokens) return null;

  //   const rpn = toRpn(tokens);
  //   if (!rpn) return null;

  //   return evalRpn(rpn, ctx);
  // }

  // function splitTopLevelArgs(s: string): string[] {
  //   // splits "a, b, prev(x)" at commas, respecting parentheses depth
  //   const out: string[] = [];
  //   let depth = 0;
  //   let start = 0;
  //   for (let i = 0; i < s.length; i++) {
  //     const ch = s[i];
  //     if (ch === "(") depth++;
  //     else if (ch === ")") depth--;
  //     else if (ch === "," && depth === 0) {
  //       out.push(s.slice(start, i).trim());
  //       start = i + 1;
  //     }
  //   }
  //   out.push(s.slice(start).trim());
  //   return out.filter(Boolean);
  // }

  // function diffMinutes(a: number, b: number): number {
  //   // wraparound: minutes from b to a
  //   const d = a - b;
  //   return d >= 0 ? d : d + 1440;
  // }

  // function evalCalcExprV1(
  //   expr: string,
  //   ctxToday: Record<string, number | null>,
  //   ctxPrev: Record<string, number | null>
  // ): number | null {
  //   const s = expr.trim();
  //   if (!s) return null;

  //   // prev(x)
  //   const prevMatch = /^prev\(\s*([a-zA-Z0-9_]+)\s*\)$/.exec(s);
  //   if (prevMatch) {
  //     const id = prevMatch[1];
  //     return ctxPrev[id] ?? null;
  //   }

  //   // or(a,b,c...)
  //   const orMatch = /^or\((.*)\)$/.exec(s);
  //   if (orMatch) {
  //     const args = splitTopLevelArgs(orMatch[1]);
  //     for (const a of args) {
  //       const v = evalCalcExprV1(a, ctxToday, ctxPrev);
  //       // treat null as 0 for OR (your preference)
  //       if ((v ?? 0) !== 0) return 1;
  //     }
  //     return 0;
  //   }

  //   // diff(a,b)
  //   const diffMatch = /^diff\((.*)\)$/.exec(s);
  //   if (diffMatch) {
  //     const args = splitTopLevelArgs(diffMatch[1]);
  //     if (args.length !== 2) return null;
  //     const a = evalCalcExprV1(args[0], ctxToday, ctxPrev);
  //     const b = evalCalcExprV1(args[1], ctxToday, ctxPrev);
  //     if (a == null || b == null) return null;
  //     return diffMinutes(a, b);
  //   }

  //   // identifier
  //   if (/^[a-zA-Z0-9_]+$/.test(s)) {
  //     return ctxToday[s] ?? null;
  //   }

  //   // fallback: arithmetic via your existing RPN path
  //   return evalCalcExpr(s, ctxToday, metricsById);
  // }


  const numericContext = React.useMemo(
    () => buildNumericContext(metrics, vals),
    [metrics, vals]
  );

  const { values: calculatedValues, errors: calcErrors, missing: calcMissing } = React.useMemo(() => {
    return evaluateCalculatedMetricsV2(
      metrics.map((m) => ({
        metric_id: m.metric_id,
        type: m.type,
        is_calculated: m.is_calculated,
        calc_expr: m.calc_expr,
      })),
      numericContext,
      prevByN
    );
  }, [metrics, numericContext, prevByN]);


  // Optional: debugging (remove later)
  useEffect(() => {
    const anyErr = Object.entries(calcErrors).filter(([, v]) => v);
    if (anyErr.length) console.warn("Calc errors:", anyErr);
  }, [calcErrors]);

  // Compute adjusted goal indicators based on current (unsaved) values
  const adjustedIndicators = React.useMemo((): IndicatorsResponse | null => {
    if (!indicators) return null;

    const adjusted: IndicatorsResponse = {
      metrics: { ...indicators.metrics },
    };

    // For each metric with goals, adjust based on value changes
    for (const [metricId, indicatorData] of Object.entries(indicators.metrics)) {
      if (!indicatorData.goals || indicatorData.goals.length === 0) continue;

      const currentNumeric = numericContext[metricId];
      const savedNumeric = savedNumericVals[metricId];

      // Skip if no change or both are null
      if (currentNumeric === savedNumeric) continue;
      if (currentNumeric == null && savedNumeric == null) continue;

      // Calculate delta
      const oldVal = savedNumeric ?? 0;
      const newVal = currentNumeric ?? 0;
      const delta = newVal - oldVal;

      // Adjust each goal
      const adjustedGoals = indicatorData.goals.map((goal) => {
        let adjustedCurrent = goal.current;

        // For daily goals, current is just today's value
        if (goal.frequency === "daily") {
          adjustedCurrent = newVal;
        } else {
          // For weekly/monthly, adjust by delta
          adjustedCurrent = goal.current + delta;
        }

        // Recalculate progress_pct
        const progress_pct = goal.target > 0
          ? Math.round((adjustedCurrent / goal.target) * 1000) / 10
          : 0;

        // Recalculate status
        let status = goal.status;
        const is_met = adjustedCurrent >= goal.target;

        if (is_met) {
          status = "met";
        } else if (progress_pct >= 80) {
          status = "on_track";
        } else if (progress_pct >= 50) {
          status = "at_risk";
        } else if (goal.status === "met") {
          // Was met but now isn't
          status = "at_risk";
        }

        return {
          ...goal,
          current: adjustedCurrent,
          progress_pct,
          status,
        };
      });

      adjusted.metrics[metricId] = {
        ...indicatorData,
        goals: adjustedGoals,
      };
    }

    return adjusted;
  }, [indicators, numericContext, savedNumericVals]);


  type PresetValue = { raw: string; display: string };

  function parsePresets(metric: ConfigRow): PresetValue[] {
    const csv = metric.preset_values_csv;
    if (!csv) return [];

    const values = csv
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (metric.type === "text") {
      // Text type: pass through as-is
      return values.map((v) => ({ raw: v, display: v }));
    }

    if (metric.type === "hhmm") {
      // HH:MM format - validate and pass through
      return values
        .map((s) => {
          // Accept HH:MM format
          const match = s.match(/^(\d{1,2}):(\d{2})$/);
          if (!match) return null;
          const h = parseInt(match[1], 10);
          const m = parseInt(match[2], 10);
          if (h < 0 || h > 23 || m < 0 || m > 59) return null;
          // Normalize display to HH:MM
          const display = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
          return { raw: display, display };
        })
        .filter((v): v is PresetValue => v !== null);
    }

    if (metric.type === "time") {
      // Time in minutes - can be entered as minutes or HH:MM
      return values
        .map((s) => {
          // Try HH:MM format first
          const match = s.match(/^(\d{1,2}):(\d{2})$/);
          if (match) {
            const h = parseInt(match[1], 10);
            const m = parseInt(match[2], 10);
            const totalMinutes = h * 60 + m;
            return { raw: String(totalMinutes), display: `${h}:${String(m).padStart(2, "0")}` };
          }
          // Otherwise treat as minutes
          const n = Number(s);
          if (!Number.isFinite(n) || n < 0) return null;
          const hours = Math.floor(n / 60);
          const mins = n % 60;
          return { raw: String(n), display: hours > 0 ? `${hours}:${String(mins).padStart(2, "0")}` : `${mins}m` };
        })
        .filter((v): v is PresetValue => v !== null);
    }

    // Numeric types (number): parse as numbers, filter invalid
    return values
      .map((s) => {
        const n = Number(s);
        if (!Number.isFinite(n)) return null;
        return { raw: String(n), display: String(n) };
      })
      .filter((v): v is PresetValue => v !== null);
  }

  function applyPresetValue(metric: ConfigRow, preset: PresetValue) {
    markAsTouched(metric.metric_id);

    // reuse existing validation
    const msg = validateField(metric, preset.raw);

    setVals((prev) => ({
      ...prev,
      [metric.metric_id]: preset.raw,
    }));

    setFieldErrors((prev) => ({
      ...prev,
      [metric.metric_id]: msg,
    }));

    setDirty(true);
  }



  async function reloadDateHints() {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch("/api/date_hints", { headers });

      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        // non-JSON, bail quietly
        return;
      }

      const j = await res.json();
      if (!res.ok || j?.error) {
        console.error("date-hints error:", j?.error || j);
        return;
      }

      setDateHints(j as DateHints);
    } catch (e) {
      console.error("date-hints fetch failed:", e);
    }
  }

  async function reloadIndicators() {
    if (!userSettings?.main_page?.show_indicators) return;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/indicators?date=${encodeURIComponent(date)}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setIndicators(data);
      }
    } catch (e) {
      console.warn("Failed to reload indicators:", e);
    }
  }



  async function save() {
    setSaving(true);
    setError(null);

    try {
      // -----------------------------
      // 1) Numeric / format validation
      // -----------------------------
      const newErrors: Record<string, string | null> = {};
      let hasAnyError = false;

      for (const m of metrics) {
        const raw = vals[m.metric_id] ?? "";

        // No validation for checkboxes or calculated metrics
        if (m.type === "checkbox" || m.is_calculated) {
          newErrors[m.metric_id] = null;
          continue;
        }

        const msg = validateField(m, raw);
        if (msg) {
          hasAnyError = true;
          newErrors[m.metric_id] = msg;
        } else {
          newErrors[m.metric_id] = null;
        }
      }

      if (hasAnyError) {
        setFieldErrors((prev) => ({ ...prev, ...newErrors }));
        setError("Please fix the highlighted fields before saving.");
        setSaving(false);
        const firstErrorId = metrics.find((m) => newErrors[m.metric_id])?.metric_id;
        if (firstErrorId) {
          setTimeout(() => {
            document.getElementById(`metric-field-${firstErrorId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, 0);
        }
        return;
      }

      // -----------------------------------------
      // 2) Required guard ONLY for past dates (< today)
      // -----------------------------------------
      if (date < todayISO) {
        const missingLabels: string[] = [];
        const requiredErrors: Record<string, string | null> = {};

        for (const m of metrics) {
          // Skip non-required OR calculated metrics
          if (!m.required || m.is_calculated) continue;

          const raw = vals[m.metric_id];

          let missing = false;


          if (m.type === "checkbox") {
            // For checkboxes:
            //   - undefined  => user hasn't touched it => treat as missing
            //   - "on" or "" => explicitly logged (true/false) => OK
            if (raw === undefined) {
              missing = true;
            }
          } else {
            // For numeric / time / hhmm:
            //   - undefined or "" => missing
            //   - anything else   => logged (we already validated format above)
            if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
              missing = true;
            }
          }

          if (missing) {
            const label = m.metric_name || m.metric_id;
            missingLabels.push(label);
            requiredErrors[m.metric_id] = `${label} is required for this date`;
          } else {
            requiredErrors[m.metric_id] = null;
          }
        }

        if (missingLabels.length > 0) {
          setFieldErrors((prev) => ({ ...prev, ...requiredErrors }));
          setError(
            `Please fill these required metrics before saving this past day: ${missingLabels.join(
              ", "
            )}.`
          );
          setSaving(false);
          const firstMissingId = metrics.find((m) => requiredErrors[m.metric_id])?.metric_id;
          if (firstMissingId) {
            setTimeout(() => {
              document.getElementById(`metric-field-${firstMissingId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
            }, 0);
          }
          return;
        }
      }

      // -----------------------------
      // -----------------------------
      // 3) Build entries + POST
      // -----------------------------
      const entries = buildEntries();

      const headers = await getAuthHeaders();

      const res = await fetch("/api/save-log", {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ date, entries }),
      });


      if (!res.ok) {
        const text = await res.text();
        console.error("save-log failed:", res.status, text);
        toast(`Save failed (${res.status}).`, "error");
        return;
      }

      setDirty(false);
      // Reload the saved day so the form reflects server state, but don't hold
      // the Save button on the heavier date-hint / streak-indicator refreshes —
      // those update in the background.
      void reloadDateHints();
      void reloadIndicators();
      await loadDayValues(date);
      toast("Saved", "success");
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  // Update ref so keyboard shortcut always has current save function
  saveRef.current = save;

  async function loadDayValues(d: string) {
    setError(null);
    // Reset touched state when loading a new day
    setTouchedMetrics(new Set());

    const headers = await getAuthHeaders();
    const res = await fetch(`/api/log?date=${encodeURIComponent(d)}`, {
      headers,
    });

    const rows: { metric_id: string; value: number | null; value_text?: string | null }[] = await res.json();
    if (!res.ok) {
      setError((rows as any)?.error || "Failed to load day");
      return;
    }

    const valueMap = new Map<string, number | null>();
    const textMap = new Map<string, string | null>();

    for (const r of rows) {
      valueMap.set(r.metric_id, r.value);
      textMap.set(r.metric_id, r.value_text ?? null);
    }

    // Store original numeric values for goal indicator live updates
    const numericVals: Record<string, number | null> = {};
    valueMap.forEach((value, metricId) => {
      numericVals[metricId] = value;
    });
    setSavedNumericVals(numericVals);

    const next: Record<string, string> = {};
    const newDefaultPopulated = new Set<string>();

    for (const def of metrics) {
      const existing = valueMap.get(def.metric_id);
      const hasExistingValue = existing != null;
      const hasExistingText = textMap.get(def.metric_id) != null;

      if (def.type === "checkbox") {
        if (hasExistingValue) {
          next[def.metric_id] = existing >= 0.5 ? "on" : "";
        } else if (def.default_value != null) {
          next[def.metric_id] = def.default_value >= 0.5 ? "on" : "";
          newDefaultPopulated.add(def.metric_id);
        } else {
          next[def.metric_id] = "";
        }
      } else if (def.type === "text") {
        const existingText = textMap.get(def.metric_id);
        next[def.metric_id] = existingText ?? "";
        // Text type doesn't use default_value
      } else if (def.type === "hhmm") {
        if (hasExistingValue) {
          next[def.metric_id] = formatHHMM(existing);
        } else if (def.default_value != null) {
          next[def.metric_id] = formatHHMM(def.default_value);
          newDefaultPopulated.add(def.metric_id);
        } else {
          next[def.metric_id] = "";
        }
      } else if (def.type === "time") {
        // time: format as h:mm
        if (hasExistingValue) {
          next[def.metric_id] = formatDurationHHMM(existing);
        } else if (def.default_value != null) {
          next[def.metric_id] = formatDurationHHMM(def.default_value);
          newDefaultPopulated.add(def.metric_id);
        } else {
          next[def.metric_id] = "";
        }
      } else {
        // number
        if (hasExistingValue) {
          next[def.metric_id] = String(existing);
        } else if (def.default_value != null) {
          next[def.metric_id] = String(def.default_value);
          newDefaultPopulated.add(def.metric_id);
        } else {
          next[def.metric_id] = "";
        }
      }
    }

    setVals(next);
    setDefaultPopulated(newDefaultPopulated);
    setFieldErrors({}); // clear per-field errors
    setDirty(false);
  }


  // Handle date change from custom date picker
  const handleDateChange = useCallback(async (newDate: string) => {
    if (dirty) {
      const ok = await confirm({ message: "You have unsaved changes.\nDiscard them and switch date?", confirmLabel: "Discard", destructive: true });
      if (!ok) return;
    }
    setDate(newDate);
  }, [dirty, confirm]);  

  if (!authChecked || !metricsLoaded) {
    return (
      <main className="p-6">
        <LoadingScreen><DailyTrackerLoader /></LoadingScreen>
      </main>
    );
  }

  const untouchedDefaultCount = defaultPopulated.size > 0
    ? Array.from(defaultPopulated).filter(id => !touchedMetrics.has(id)).length
    : 0;

  const acceptDefaultsBtn = untouchedDefaultCount > 0 ? (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        setTouchedMetrics(prev => {
          const next = new Set(prev);
          defaultPopulated.forEach(id => next.add(id));
          return next;
        });
      }}
    >
      Accept Defaults ({untouchedDefaultCount})
    </Button>
  ) : null;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Sticky Header with Date & Save */}
      <header className="sticky top-[41px] z-40 bg-background border-b shadow-sm">
        <div className="max-w-3xl mx-auto px-3 sm:px-6 py-2 sm:py-3">
          {/* Row 1: DatePicker + Today + (desktop: Private, Unsaved, Days) + Save */}
          <div className="flex items-center justify-between gap-2 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-3">
              <div data-tour="date-picker">
                <DatePicker
                  value={date}
                  onChange={handleDateChange}
                  maxDate={todayISO}
                  availableYears={availableYears}
                />
              </div>
              {/* Today button */}
              {date !== todayISO && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDateChange(todayISO)}
                  className="h-8 px-2 text-xs"
                >
                  Today
                </Button>
              )}
              {/* Desktop-only: Private toggle */}
              <label className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={showPrivate}
                  onChange={(e) => setShowPrivate(e.target.checked)}
                  className="h-3.5 w-3.5 rounded"
                />
                Private
              </label>
              {/* Desktop-only: Unsaved changes */}
              {dirty && (
                <span className="hidden sm:inline text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 px-2 py-1 rounded border border-amber-200 dark:border-amber-700">
                  Unsaved changes
                </span>
              )}
              {/* Days counter - hidden on mobile */}
              {dateHints && dateHints.required_days_possible > 0 && (
                <span className="hidden sm:inline text-xs text-gray-500">
                  {dateHints.required_days_completed}/{dateHints.required_days_possible} days
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Desktop-only: Accept Defaults */}
              <div className="hidden sm:block">
                {acceptDefaultsBtn}
              </div>
              {/* Tour replay button — shown only after tour was completed */}
              {tourStatus === "completed" && (
                <Button
                  variant="ghost"
                  size="sm"
                  title="Replay the tour"
                  onClick={async () => {
                    pendingTourLaunch.current = true;
                    tourAutoResumed.current = true; // prevent double-launch
                    const ok = await tourSeed();
                    if (ok) { await reloadMetrics(); await reloadIndicators(); }
                    else pendingTourLaunch.current = false;
                  }}
                  disabled={tourLoading}
                  className="h-8 w-8 p-0 text-muted-foreground"
                >
                  ?
                </Button>
              )}
              <Button
                data-tour="save-button"
                onClick={save}
                disabled={saving || metrics.length === 0 || !dirty}
                variant={dirty ? "default" : "outline"}
              >
                {saving ? "Saving..." : "Save Day"}
              </Button>
              <span className="hidden sm:inline text-xs text-muted-foreground">Ctrl+Enter</span>
            </div>
          </div>

          {/* Row 2: Mobile-only — Private + Accept Defaults + Unsaved */}
          <div className="flex sm:hidden items-center gap-3 mt-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={showPrivate}
                onChange={(e) => setShowPrivate(e.target.checked)}
                className="h-3.5 w-3.5 rounded"
              />
              Private
            </label>
            {acceptDefaultsBtn}
            {dirty && (
              <span className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 px-2 py-1 rounded border border-amber-200 dark:border-amber-700">
                Unsaved changes
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 p-6 max-w-3xl mx-auto w-full space-y-6">
        {gapMessage && (
          <div className="inline-block text-xs px-2 py-1 rounded border text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700">
            {gapMessage}
          </div>
        )}
    {/*
      {dateHints &&
        dateHints.missing_required_days > 0 &&
        showHeadsUp && (
          <div
            style={{
              marginTop: 8,
              padding: "6px 8px",
              fontSize: "0.8rem",
              borderRadius: 4,
              backgroundColor: "#FEF9C3",
              border: "1px solid #FACC15",
              color: "#78350F",
              maxWidth: 520,
            }}
          >
            <strong>Heads up</strong>
            <div style={{ marginTop: 2 }}>
              Required metrics were last fully completed on{" "}
              {dateHints.last_required_complete_date}. There may be{" "}
              {dateHints.missing_required_days} missing day
              {dateHints.missing_required_days === 1 ? "" : "s"} between then and
              today. We’ve jumped you to {dateHints.suggested_date}.
            </div> 
          </div>
        )}*/}

      {metrics.length === 0 ? (
        <div className="mt-8 text-center">
          {error ? (
            <p className="text-red-600">Error: {error}</p>
          ) : !metricsLoaded ? (
            <p className="text-muted-foreground">Loading metrics…</p>
          ) : tourStatus === "idle" ? (
            /* New user welcome banner */
            <div className="max-w-sm mx-auto space-y-4 p-6 border rounded-xl shadow-sm bg-card">
              <p className="text-2xl font-semibold">Welcome!</p>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Daily Tracker helps you log and understand your habits. Take a
                quick tour to see how it works, or jump straight to setting up
                your metrics.
              </p>
              <div className="flex flex-col sm:flex-row gap-2 justify-center">
                <Button
                  onClick={async () => {
                    pendingTourLaunch.current = true;
                    tourAutoResumed.current = true; // prevent double-launch
                    const ok = await tourSeed();
                    if (ok) { await reloadMetrics(); await reloadIndicators(); }
                    else pendingTourLaunch.current = false;
                  }}
                  disabled={tourLoading}
                  className="gap-2"
                >
                  {tourLoading ? "Setting up…" : "Take the Tour"}
                </Button>
                <a href="/metrics" className={buttonVariants({ variant: "outline" })}>
                  Set Up Metrics →
                </a>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-lg font-medium">Welcome!</p>
              <p className="text-muted-foreground text-sm">
                Go ahead and create your first metric on the{" "}
                <a href="/metrics" className="underline text-foreground hover:text-primary">
                  Metrics page
                </a>
                .
              </p>
            </div>
          )}
        </div>
      ) : (
        <div>
          {groupedMetrics.map((group, groupIndex) => {
            const isCollapsed = collapsedGroups[group.groupName] ?? false;

            return (
              <Card
                key={group.groupName}
                className="mt-4 max-w-md overflow-hidden"
                {...(groupIndex === 0 ? { "data-tour": "metric-group" } : {})}
              >
                {/* Group header bar */}
                <CardHeader
                  className="bg-muted py-2 px-3 cursor-pointer border-b"
                  onClick={() => toggleGroup(group.groupName)}
                >
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-semibold">
                      {group.groupName}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        {group.items.length}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {isCollapsed ? "▸" : "▾"}
                      </span>
                    </div>
                  </div>
                </CardHeader>

                {/* Group body */}
                {!isCollapsed && (
                  <CardContent className="p-4">
                    {group.items.map((m, itemIndex) => {
                      const isFirstItem = groupIndex === 0 && itemIndex === 0;
                      const isCalculated = m.is_calculated;

                      const calcValue = isCalculated ? calculatedValues[m.metric_id] : null;

                      // current raw value + error for this metric
                      const raw = vals[m.metric_id] ?? "";
                      const err = fieldErrors[m.metric_id] ?? null;

                      let calcDisplay: string | null = null;
                      if (isCalculated) {
                        if (calcValue == null) {
                          calcDisplay = "—";
                        } else if (m.type === "hhmm" || m.type === "time") {
                          // Format both hhmm and time as h:mm duration
                          calcDisplay = formatDurationHHMM(calcValue);
                        // } else if (m.type === "checkbox") {
                        //   calcDisplay = calcValue >= 0.5 ? "✓" : "";
                        } else {
                          // Truncate to 2 decimal places for calculated metrics
                          calcDisplay = String(Math.round(calcValue * 100) / 100);
                        }
                      }

                      return (
                        <div
                          key={m.metric_id}
                          id={`metric-field-${m.metric_id}`}
                          className="mb-3"
                          {...(isFirstItem ? { "data-tour": "metric-row" } : {})}
                        >
                          {/* LABEL */}
                          <label
                            className="flex items-center gap-2 font-medium mb-1 relative"
                            {...(isFirstItem ? { "data-tour": "metric-label" } : {})}
                          >
                            <MetricHoverTooltip
                              metricId={m.metric_id}
                              metricName={m.metric_name}
                              metricType={m.type}
                              onClick={() => { if (tourStatus !== "seeded") setStatsMetric(m); }}
                              hoverDelay={tourStatus === "seeded" ? Infinity : 300}
                            />
                            {(() => {
                              const alerts = m.notification_config?.streak_alerts;
                              if (!alerts?.enabled || alerts.last_notified_threshold == null) return null;
                              const sign = alerts.last_streak_sign;
                              const decrease = m.analytics_config?.direction === "decrease";
                              const goodSign = decrease ? "negative" : "positive";
                              const badSign  = decrease ? "positive" : "negative";
                              if (sign === goodSign) {
                                return (
                                  <span
                                    title={`Milestone reached: ${Math.abs(alerts.last_notified_threshold)}-day streak`}
                                    className="text-amber-400 text-sm leading-none select-none"
                                    aria-label="Streak milestone"
                                  >★</span>
                                );
                              }
                              if (sign === badSign) {
                                return (
                                  <span
                                    title={`Streak alert: ${Math.abs(alerts.last_notified_threshold)} days without logging`}
                                    className="text-orange-500 text-xs font-bold leading-none select-none"
                                    aria-label="Streak alert"
                                  >!</span>
                                );
                              }
                              return null;
                            })()}
                            {m.required && !isCalculated && (
                              <Badge variant="destructive" className="text-[10px] px-1.5 py-0" title="This metric must be filled in before saving">
                                required
                              </Badge>
                            )}
                            {isCalculated && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0" title="Calculated automatically from other metrics — read only">
                                calc
                              </Badge>
                            )}
                            {/* Trend indicator for numeric types (not calculated, not count) */}
                            {userSettings?.main_page?.show_indicators &&
                              userSettings?.main_page?.show_trends &&
                              !m.is_calculated &&
                              ["number", "score", "time", "hhmm"].includes(m.type) &&
                              !m.analytics_config?.hide_trend &&
                              indicators?.metrics[m.metric_id]?.trend && (
                                <TrendBadge
                                  direction={indicators.metrics[m.metric_id].trend!.direction}
                                  changePct={indicators.metrics[m.metric_id].trend!.change_pct}
                                  periodDays={indicators.metrics[m.metric_id].trend!.period_days}
                                  higherIsBetter={m.analytics_config?.higher_is_better !== false}
                                />
                              )}
                            {/* Streak indicator for all non-text, non-calculated types */}
                            {userSettings?.main_page?.show_indicators &&
                              userSettings?.main_page?.show_streaks &&
                              !m.is_calculated &&
                              m.type !== "text" &&
                              indicators?.metrics[m.metric_id]?.streak && (() => {
                                // Check if streaks are enabled (backwards compat with hide_streak)
                                const showStreak = m.analytics_config?.show_streak ??
                                  (m.analytics_config?.hide_streak === true ? false : true);
                                if (!showStreak) return null;

                                const streak = indicators.metrics[m.metric_id].streak!;

                                // Determine if form has a value
                                const rawVal = vals[m.metric_id];
                                let formHasValue = false;
                                if (m.type === "checkbox") {
                                  formHasValue = rawVal === "on";
                                } else if (m.type === "count") {
                                  // For count type, only non-zero values count (like checkbox)
                                  const numVal = Number(rawVal);
                                  formHasValue = !isNaN(numVal) && numVal !== 0;
                                } else {
                                  formHasValue = rawVal != null && rawVal.trim() !== "";
                                }

                                // Handle backward compat: avoid=true maps to direction="decrease"
                                const direction = m.analytics_config?.direction ??
                                  (m.analytics_config?.avoid ? "decrease" : "increase");

                                return (
                                  <StreakBadge
                                    yesterdayStreak={streak.yesterday}
                                    loggedTodayInDb={streak.logged_today}
                                    formHasValue={formHasValue}
                                    direction={direction}
                                    seed={streak.seed ?? 0}
                                  />
                                );
                              })()}
                            {/* Goal progress indicator */}
                            {userSettings?.main_page?.show_indicators &&
                              adjustedIndicators?.metrics[m.metric_id]?.goals &&
                              adjustedIndicators.metrics[m.metric_id].goals!.length > 0 && (
                                <MultiGoalBadge
                                  goals={adjustedIndicators.metrics[m.metric_id].goals!}
                                />
                              )}
                          </label>

                          {isCalculated ? (
                            m.type === "checkbox" ? (
                              <div className="mt-0.5">
                                <div className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={(calcValue ?? 0) >= 0.5}
                                    disabled
                                    className="h-5 w-5 opacity-60 cursor-not-allowed"
                                  />
                                  <span className="text-xs text-muted-foreground">
                                    (calculated)
                                  </span>
                                </div>

                                {showCalcDebug && (
                                  <div className="mt-1 text-xs text-muted-foreground w-full max-w-72">
                                    <div className="font-mono whitespace-pre-wrap">
                                      {m.calc_expr || "(no expr)"}
                                    </div>
                                    {calcErrors?.[m.metric_id] ? (
                                      <div className="mt-0.5 text-destructive">⚠️ {calcErrors[m.metric_id]}</div>
                                    ) : (
                                      <div className="mt-0.5">
                                        {calcValue == null ? "Value is null" : "Value computed"}
                                        {calcMissing?.[m.metric_id]?.length ? (
                                          <div className="mt-0.5">
                                            Missing: {calcMissing[m.metric_id].join(", ")}
                                          </div>
                                        ) : null}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div>
                                <div className="mt-0.5 border border-input bg-zinc-100 dark:bg-zinc-700 text-foreground min-h-[22px] w-full max-w-72 px-2 py-1 flex items-center rounded-md text-sm">
                                  {calcDisplay}
                                </div>

                                {showCalcDebug && (
                                  <div className="mt-1 text-xs text-muted-foreground w-full max-w-72">
                                    <div className="font-mono whitespace-pre-wrap">
                                      {m.calc_expr || "(no expr)"}
                                    </div>
                                    {calcErrors?.[m.metric_id] ? (
                                      <div className="mt-0.5 text-destructive">⚠️ {calcErrors[m.metric_id]}</div>
                                    ) : (
                                      <div className="mt-0.5">
                                        {calcValue == null ? "Value is null" : "Value computed"}
                                      </div>
                                    )}
                                    {calcMissing?.[m.metric_id]?.length ? (
                                      <div className="mt-0.5">
                                        Missing: {calcMissing[m.metric_id].join(", ")}
                                      </div>
                                    ) : null}
                                  </div>
                                )}
                              </div>
                            )

                          ) : m.type === "checkbox" ? (
                            <>
                              <div className="flex items-center gap-2">
                                {/* For unacknowledged defaults: show unchecked but highlighted */}
                                {defaultPopulated.has(m.metric_id) && !touchedMetrics.has(m.metric_id) ? (
                                  <input
                                    type="checkbox"
                                    checked={false}
                                    onChange={() => {
                                      // Clicking acknowledges the default - mark as touched and it will show as checked
                                      markAsTouched(m.metric_id);
                                      setDirty(true);
                                    }}
                                    className="h-5 w-5 rounded border-amber-500 dark:border-amber-400 ring-2 ring-amber-300 dark:ring-amber-600 ring-offset-1"
                                  />
                                ) : (
                                  <input
                                    type="checkbox"
                                    checked={raw === "on"}
                                    onChange={(e) => {
                                      markAsTouched(m.metric_id);
                                      const v = e.target.checked ? "on" : "";
                                      setVal(m.metric_id, v);
                                      setDirty(true);
                                      setFieldErrors((prev) => ({
                                        ...prev,
                                        [m.metric_id]: null,
                                      }));
                                    }}
                                    className="h-5 w-5 rounded border-gray-300"
                                  />
                                )}
                                {defaultPopulated.has(m.metric_id) && !touchedMetrics.has(m.metric_id) && (
                                  <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30">
                                    default
                                  </Badge>
                                )}
                              </div>
                              {err && <p className="text-xs text-destructive mt-1">{err}</p>}
                            </>
                          ) : m.type === "text" ? (
                            <div>
                              {m.stt_enabled ? (
                                <div className="w-full max-w-72">
                                  <SpeechTextarea
                                    value={raw ?? ""}
                                    rows={4}
                                    onFocus={() => markAsTouched(m.metric_id)}
                                    onChange={(e) => {
                                      markAsTouched(m.metric_id);
                                      const v = e.target.value;
                                      setVal(m.metric_id, v);
                                      setDirty(true);
                                      setFieldErrors((prev) => ({ ...prev, [m.metric_id]: null }));
                                    }}
                                    className={cn(err && "border-destructive bg-destructive/10")}
                                  />
                                </div>
                              ) : (
                                <Textarea
                                  value={raw}
                                  rows={4}
                                  onFocus={() => markAsTouched(m.metric_id)}
                                  onChange={(e) => {
                                    markAsTouched(m.metric_id);
                                    const v = e.target.value;
                                    setVal(m.metric_id, v);
                                    setDirty(true);
                                    setFieldErrors((prev) => ({ ...prev, [m.metric_id]: null }));
                                  }}
                                  className={cn(
                                    "w-full max-w-72",
                                    err && "border-destructive bg-destructive/10"
                                  )}
                                />
                              )}

                              {parsePresets(m).length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {parsePresets(m).map((p) => (
                                    <Button
                                      key={p.raw}
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => applyPresetValue(m, p)}
                                      title={p.display}
                                      className={cn(
                                        "h-7 px-2 text-xs max-w-[150px] truncate",
                                        p.raw === raw && "bg-amber-100 dark:bg-amber-800/50 border-amber-300 dark:border-amber-600"
                                      )}
                                    >
                                      {p.display}
                                    </Button>
                                  ))}
                                </div>
                              )}

                              {err && <p className="text-xs text-destructive mt-1 px-1">{err}</p>}
                            </div>
                          ) : isMobile && m.type === "hhmm" ? (
                            /* Mobile: Time-of-day clock picker for hhmm */
                            <div className="max-w-72">
                              {defaultPopulated.has(m.metric_id) && !touchedMetrics.has(m.metric_id) && (
                                <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30 mb-1">
                                  default
                                </Badge>
                              )}
                              <TimeOfDayPicker
                                value={raw ? parseHHMM(raw) : null}
                                onChange={(mins) => {
                                  markAsTouched(m.metric_id);
                                  const formatted = formatHHMM(mins);
                                  setVal(m.metric_id, formatted);
                                  setDirty(true);
                                  setFieldErrors((prev) => ({ ...prev, [m.metric_id]: null }));
                                }}
                              />
                              {parsePresets(m).length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {parsePresets(m).map((p) => (
                                    <Button
                                      key={p.raw}
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => applyPresetValue(m, p)}
                                      title={p.display}
                                      className={cn(
                                        "h-7 px-2 text-xs max-w-[100px] truncate",
                                        p.raw === raw && "bg-amber-100 dark:bg-amber-800/50 border-amber-300 dark:border-amber-600"
                                      )}
                                    >
                                      {p.display}
                                    </Button>
                                  ))}
                                </div>
                              )}
                              {err && <p className="text-xs text-destructive mt-1 px-1">{err}</p>}
                            </div>
                          ) : isMobile && m.type === "time" ? (
                            /* Mobile: Duration wheel picker for time */
                            <div className="max-w-72">
                              {defaultPopulated.has(m.metric_id) && !touchedMetrics.has(m.metric_id) && (
                                <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30 mb-1">
                                  default
                                </Badge>
                              )}
                              <DurationPicker
                                value={raw ? parseTimeInput(raw) : null}
                                onChange={(mins) => {
                                  markAsTouched(m.metric_id);
                                  const formatted = formatDurationHHMM(mins);
                                  setVal(m.metric_id, formatted);
                                  setDirty(true);
                                  setFieldErrors((prev) => ({ ...prev, [m.metric_id]: null }));
                                }}
                              />
                              {parsePresets(m).length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {parsePresets(m).map((p) => (
                                    <Button
                                      key={p.raw}
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => applyPresetValue(m, p)}
                                      title={p.display}
                                      className={cn(
                                        "h-7 px-2 text-xs max-w-[100px] truncate",
                                        p.raw === raw && "bg-amber-100 dark:bg-amber-800/50 border-amber-300 dark:border-amber-600"
                                      )}
                                    >
                                      {p.display}
                                    </Button>
                                  ))}
                                </div>
                              )}
                              {err && <p className="text-xs text-destructive mt-1 px-1">{err}</p>}
                            </div>
                          ) : isMobile && ((m.type === "number" || m.type === "score") && m.min_value != null && m.max_value != null || m.type === "count") ? (
                            /* Mobile: Number wheel picker (count defaults to 0-99, number/score require explicit bounds) */
                            <div className="max-w-72">
                              {defaultPopulated.has(m.metric_id) && !touchedMetrics.has(m.metric_id) && (
                                <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30 mb-1">
                                  default
                                </Badge>
                              )}
                              <NumberWheelPicker
                                value={raw ? Number(raw) : null}
                                onChange={(num) => {
                                  markAsTouched(m.metric_id);
                                  setVal(m.metric_id, String(num));
                                  setDirty(true);
                                  setFieldErrors((prev) => ({ ...prev, [m.metric_id]: null }));
                                }}
                                min={m.min_value ?? 0}
                                max={m.max_value ?? 99}
                                disallowedValues={m.disallowed_values}
                              />
                              {parsePresets(m).length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {parsePresets(m).map((p) => (
                                    <Button
                                      key={p.raw}
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => applyPresetValue(m, p)}
                                      title={p.display}
                                      className={cn(
                                        "h-7 px-2 text-xs max-w-[100px] truncate",
                                        p.raw === raw && "bg-amber-100 dark:bg-amber-800/50 border-amber-300 dark:border-amber-600"
                                      )}
                                    >
                                      {p.display}
                                    </Button>
                                  ))}
                                </div>
                              )}
                              {err && <p className="text-xs text-destructive mt-1 px-1">{err}</p>}
                            </div>
                          ) : (
                            /* Desktop or fallback: text input */
                            <div>
                              {defaultPopulated.has(m.metric_id) && !touchedMetrics.has(m.metric_id) && (
                                <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30 mb-1" title="Pre-filled with a default value — adjust as needed">
                                  default
                                </Badge>
                              )}
                              <Input
                                inputMode={m.type === "number" ? "decimal" : m.type === "score" || m.type === "count" ? "numeric" : undefined}
                                placeholder={m.type === "hhmm" ? "e.g. 22:30" : m.type === "time" ? "e.g. 90 or 1:30" : m.type === "score" ? "1–10" : m.type === "count" ? "0, 1, 2…" : undefined}
                                value={raw}
                                onFocus={() => markAsTouched(m.metric_id)}
                                onChange={(e) => {
                                  markAsTouched(m.metric_id);
                                  const v = e.target.value;
                                  setVal(m.metric_id, v);
                                  setDirty(true);
                                  const msg = validateField(m, v);
                                  setFieldErrors((prev) => ({
                                    ...prev,
                                    [m.metric_id]: msg,
                                  }));
                                }}
                                onBlur={(e) => {
                                  const v = e.target.value;
                                  const msg = validateField(m, v);
                                  setFieldErrors((prev) => ({
                                    ...prev,
                                    [m.metric_id]: msg,
                                  }));
                                  // For time type, format as h:mm after blur
                                  if (m.type === "time" && v.trim() !== "" && !msg) {
                                    const mins = parseTimeInput(v);
                                    if (mins != null) {
                                      setVals(prev => ({
                                        ...prev,
                                        [m.metric_id]: formatDurationHHMM(mins),
                                      }));
                                    }
                                  }
                                  // For hhmm type, format as HH:MM after blur (normalizes 705 → 07:05)
                                  if (m.type === "hhmm" && v.trim() !== "" && !msg) {
                                    const mins = parseHHMM(v);
                                    if (mins != null) {
                                      setVals(prev => ({
                                        ...prev,
                                        [m.metric_id]: formatHHMM(mins),
                                      }));
                                    }
                                  }
                                }}
                                className={cn(
                                  "w-full max-w-72",
                                  err && "border-destructive bg-destructive/10",
                                  defaultPopulated.has(m.metric_id) && !touchedMetrics.has(m.metric_id) && "border-amber-500 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30"
                                )}
                              />

                              {parsePresets(m).length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {parsePresets(m).map((p) => (
                                    <Button
                                      key={p.raw}
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => applyPresetValue(m, p)}
                                      title={p.display}
                                      className={cn(
                                        "h-7 px-2 text-xs max-w-[100px] truncate",
                                        p.raw === raw && "bg-amber-100 dark:bg-amber-800/50 border-amber-300 dark:border-amber-600"
                                      )}
                                    >
                                      {p.display}
                                    </Button>
                                  ))}
                                </div>
                              )}

                              {err && <p className="text-xs text-destructive mt-1 px-1">{err}</p>}
                            </div>
                          )}

                        </div>
                      );
                    })}
                  </CardContent>
                )}
              </Card>
            );
          })}

        </div>
      )}


      
      {error && <div className="text-red-600 text-sm">Error: {error}</div>}


      {/* Metric stats sheet */}
      <MetricStatsSheet
        metricId={statsMetric?.metric_id ?? null}
        metricName={statsMetric?.metric_name ?? null}
        metricType={statsMetric?.type ?? null}
        open={statsMetric !== null}
        onOpenChange={(open) => !open && setStatsMetric(null)}
      />

      {/* Quick-add metric FAB */}
      <button
        onClick={() => setQuickAddOpen(true)}
        className="fixed bottom-6 right-6 z-40 h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors flex items-center justify-center text-2xl"
        aria-label="Add metric"
      >
        +
      </button>

      <QuickAddMetricSheet
        open={quickAddOpen}
        onOpenChange={setQuickAddOpen}
        existingGroups={existingGroups}
        onCreated={reloadMetrics}
      />

      {/* Dev-only tour reset button */}
      {process.env.NODE_ENV === "development" && (
        <div className="fixed bottom-4 right-4 z-50">
          <Button
            variant="outline"
            size="sm"
            className="text-xs opacity-60 hover:opacity-100 bg-background"
            title={`Tour: ${tourStatus}`}
            onClick={async () => {
              await tourDevReset();
              window.location.reload();
            }}
          >
            Reset Tour ({tourStatus})
          </Button>
        </div>
      )}
      </main>
    </div>
  );
}
