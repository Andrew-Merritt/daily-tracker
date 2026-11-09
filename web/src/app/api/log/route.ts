import { NextResponse } from "next/server";
import { supabaseServerFromRequest } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/fetchAllRows";

export async function GET(req: Request) {
  const supabase = supabaseServerFromRequest(req);

  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const year = searchParams.get("year"); // Optional year filter for heatmap
  const metricId = searchParams.get("metric_id"); // Optional single-metric filter
  const yearsOnly = searchParams.get("years") === "1"; // Just list years that have data

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Years with data: one indexed lookup of the earliest log date instead of
  // shipping the whole history to the client. Returns newest-first, always
  // including the current year.
  if (yearsOnly) {
    const { data, error } = await supabase
      .from("log")
      .select("date")
      .eq("owner_id", user.id)
      .order("date", { ascending: true })
      .limit(1);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const currentYear = new Date().getFullYear();
    const firstYear = data?.[0]?.date ? parseInt(String(data[0].date).slice(0, 4), 10) : currentYear;
    const start = Number.isFinite(firstYear) ? Math.min(firstYear, currentYear) : currentYear;
    const years: number[] = [];
    for (let y = currentYear; y >= start; y--) years.push(y);
    return NextResponse.json(years);
  }

  // Single date query - no pagination needed
  if (date) {
    const { data, error } = await supabase
      .from("log")
      .select("date,metric_id,value,value_text")
      .eq("owner_id", user.id)
      .eq("date", date)
      .order("date", { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json(data ?? []);
  }

  // For range queries or full data fetch, page past Supabase's 1000-row limit
  // (pages fetched in parallel; metric_id tiebreaker keeps paging stable).
  let rows: unknown[];
  try {
    rows = await fetchAllRows<unknown>((withCount) => {
      let q = supabase
        .from("log")
        .select("date,metric_id,value,value_text", withCount ? { count: "exact" } : undefined)
        .eq("owner_id", user.id)
        .order("date", { ascending: true })
        .order("metric_id", { ascending: true });

      if (start) q = q.gte("date", start);
      if (end) q = q.lte("date", end);
      if (year) {
        q = q.gte("date", `${year}-01-01`).lte("date", `${year}-12-31`);
      }
      if (metricId) q = q.eq("metric_id", metricId);
      return q;
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  return NextResponse.json(rows);
}
