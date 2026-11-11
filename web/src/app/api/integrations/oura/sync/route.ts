import { NextResponse } from "next/server";
import { supabaseServerFromRequest } from "@/lib/supabaseServer";
import { getLocalDateString, getServerTimezone } from "@/lib/dateUtils";
import { getOuraAccessToken, performOuraSync } from "@/lib/oura-sync";

export async function POST(req: Request) {
  const supabase = supabaseServerFromRequest(req);

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { start_date, end_date, data_types } = body as {
    start_date?: string;
    end_date?: string;
    data_types?: string[];
  };

  const { data: integration, error: intError } = await supabase
    .from("integrations")
    .select("*")
    .eq("owner_id", user.id)
    .eq("provider", "oura")
    .single();

  if (intError || !integration) {
    return NextResponse.json({ error: "Oura not connected" }, { status: 400 });
  }

  const token = await getOuraAccessToken(supabase, integration);
  if (!token.ok) {
    const now = new Date().toISOString();
    await supabase.from("integration_sync_log").insert({
      integration_id: integration.id,
      status: "error",
      started_at: now,
      completed_at: now,
      date_range_start: start_date,
      date_range_end: end_date,
      error_message: token.error,
    });
    return NextResponse.json({ error: `${token.error}. Try Reconnect.` }, { status: 401 });
  }
  const accessToken = token.accessToken;

  // Create sync log entry
  const { data: syncLog } = await supabase
    .from("integration_sync_log")
    .insert({ integration_id: integration.id, status: "running", date_range_start: start_date, date_range_end: end_date })
    .select()
    .single();

  const tz = await getServerTimezone();
  const endDate = end_date || getLocalDateString(new Date(), tz);
  const startDateDefault = new Date();
  startDateDefault.setDate(startDateDefault.getDate() - 7);
  const startDate = start_date || getLocalDateString(startDateDefault, tz);

  const syncConfig = integration.sync_config || {};
  const result = await performOuraSync(supabase, {
    userId: user.id,
    accessToken,
    startDate,
    endDate,
    metricMapping: syncConfig.metric_mapping || {},
    overwriteManual: syncConfig.overwrite_manual || false,
    dataTypes: data_types,
  });
  if (token.warning) result.errors.push(token.warning);

  if (syncLog) {
    await supabase
      .from("integration_sync_log")
      .update({
        completed_at: new Date().toISOString(),
        status: result.errors.length > 0 ? "partial" : "success",
        records_synced: result.synced,
        error_message: result.errors.length > 0 ? result.errors.join("; ") : null,
        details: result.details,
      })
      .eq("id", syncLog.id);
  }

  await supabase
    .from("integrations")
    .update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", integration.id);

  return NextResponse.json({
    synced: result.synced,
    errors: result.errors,
    details: result.details,
    date_range: { start: startDate, end: endDate },
  });
}
