import { NextResponse } from "next/server";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { supabaseServerFromRequest } from "@/lib/supabaseServer";
import { getLocalDateString, addDays, compareDates, getServerTimezone } from "@/lib/dateUtils";

type DateHints = {
  today: string;
  last_log_date: string | null;
  last_required_complete_date: string | null;
  suggested_date: string | null;
  missing_required_days: number;
  required_days_completed: number;
  required_days_possible: number;
};

function isNonEmptyText(v: any): boolean {
  if (v == null) return false;
  return String(v).trim() !== "";
}

export async function GET(req: Request) {
  const supabase = supabaseServerFromRequest(req);

  // Auth
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const tz = await getServerTimezone();
  const today = getLocalDateString(new Date(), tz);

  // 1) last_log_date (fast + uncapped)
  const { data: lastLogRow, error: lastLogErr } = await supabase
    .from("log")
    .select("date")
    .eq("owner_id", user.id)
    .order("date", { ascending: false })
    .limit(1);

  if (lastLogErr) {
    return NextResponse.json({ error: lastLogErr.message }, { status: 500 });
  }

  const last_log_date: string | null = lastLogRow?.[0]?.date ?? null;

  // 2) Load required metrics (include required_since + type for validity rules)
  const { data: reqMetrics, error: reqCfgErr } = await supabase
    .from("config")
    .select("metric_id,type,required,required_since,active")
    .eq("owner_id", user.id)
    .eq("required", true);

  if (reqCfgErr) {
    return NextResponse.json({ error: reqCfgErr.message }, { status: 500 });
  }

  const requiredList =
    (reqMetrics ?? [])
      .filter((m: any) => m.required === true && (m.active ?? true) === true)
      .map((m: any) => ({
        metric_id: String(m.metric_id),
        type: String(m.type),
        // normalize null required_since => treat as "always required"
        required_since: (m.required_since ? String(m.required_since) : null) as string | null,
      }));

  // If nothing required, suggest today and trivial stats
  if (requiredList.length === 0) {
    const out: DateHints = {
      today,
      last_log_date,
      last_required_complete_date: last_log_date, // doesn't really matter when none required
      suggested_date: today,
      missing_required_days: 0,
      required_days_completed: 0,
      required_days_possible: 0,
    };
    return NextResponse.json(out);
  }

  // 3) Determine the earliest date we should consider for required completeness
  // Use min(required_since) among required metrics; if all null, use last_log_date or today.
  let minRequiredSince: string | null = null;
  for (const m of requiredList) {
    if (m.required_since) {
      if (!minRequiredSince || compareDates(m.required_since, minRequiredSince) < 0) {
        minRequiredSince = m.required_since;
      }
    }
  }
  if (!minRequiredSince) {
    // "always required" metrics but no required_since set
    minRequiredSince = last_log_date ?? today;
  }

  // Guard: if minRequiredSince is after today, clamp
  if (compareDates(minRequiredSince, today) > 0) {
    minRequiredSince = today;
  }

  // 4) Fetch ONLY log rows for required metrics in range [minRequiredSince..today]
  // This stays small even with huge datasets.
  const reqMetricIds = requiredList.map((m: { metric_id: string }) => m.metric_id);

  type HintRow = { date: string; metric_id: string; value: number | null; value_text: string | null };
  let rows: HintRow[];
  try {
    rows = await fetchAllRows<HintRow>((withCount) =>
      supabase
        .from("log")
        .select("date,metric_id,value,value_text", withCount ? { count: "exact" } : undefined)
        .eq("owner_id", user.id)
        .gte("date", minRequiredSince)
        .lte("date", today)
        .in("metric_id", reqMetricIds)
        .order("date", { ascending: true })
        .order("metric_id", { ascending: true })
    );
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to load required log rows", details: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }

  // 5) Build map: date -> set(metric_id present & valid)
  // For required completeness, "present" means:
  // - checkbox: any row counts
  // - text: value_text non-empty
  // - others: value is not null
  const typeById = new Map<string, string>();
  const requiredSinceById = new Map<string, string | null>();
  for (const m of requiredList) {
    typeById.set(m.metric_id, m.type);
    requiredSinceById.set(m.metric_id, m.required_since);
  }

  const presentByDate = new Map<string, Set<string>>();
  for (const r of rows) {
    const d = String(r.date);
    const mid = String(r.metric_id);
    const t = typeById.get(mid) ?? "number";

    let ok = false;
    if (t === "checkbox") {
      ok = true; // row/no-row semantics
    } else if (t === "text") {
      ok = isNonEmptyText(r.value_text);
    } else {
      ok = r.value != null;
    }

    if (!ok) continue;

    if (!presentByDate.has(d)) presentByDate.set(d, new Set<string>());
    presentByDate.get(d)!.add(mid);
  }

  // 6) Iterate all days from minRequiredSince..today and compute completeness day-by-day
  // This is O(days * requiredMetrics) which is fine for a few thousand days.
  const possibleDays: string[] = [];
  for (let d = minRequiredSince; compareDates(d, today) <= 0; d = addDays(d, 1)) {
    possibleDays.push(d);
  }

  const required_days_possible = possibleDays.length;
  let required_days_completed = 0;

  let last_required_complete_date: string | null = null;
  let last_incomplete_required_date: string | null = null;

  for (const d of possibleDays) {
    // Determine which metrics are required on this date (required_since <= d, or null => always)
    const needed: string[] = [];
    for (const m of requiredList) {
      const rs = m.required_since;
      if (!rs || compareDates(rs, d) <= 0) needed.push(m.metric_id);
    }

    const present = presentByDate.get(d) ?? new Set<string>();

    const complete = needed.every((mid) => present.has(mid));

    if (complete) {
      required_days_completed++;
      last_required_complete_date = d;
    } else {
      last_incomplete_required_date = d; // keep updating; ends as latest incomplete
    }
  }

  const missing_required_days = required_days_possible - required_days_completed;

  // 7) suggested_date policy per your intention:
  // - If any incomplete required date exists, jump to the most recent incomplete date
  // - Otherwise jump to today
  const suggested_date = last_incomplete_required_date ?? today;

  const out: DateHints = {
    today,
    last_log_date,
    last_required_complete_date,
    suggested_date,
    missing_required_days,
    required_days_completed,
    required_days_possible,
  };

  return NextResponse.json(out);
}
