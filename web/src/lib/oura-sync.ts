import { SupabaseClient } from "@supabase/supabase-js";
import { decrypt, encrypt } from "@/lib/encryption";

export const OURA_API_BASE = "https://api.ouraring.com/v2/usercollection";
const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";

// Sleep durations, RHR, and HRV come from /sleep (actual measured values).
// /daily_sleep and /daily_readiness contributors are 0-100 scores, not real values.
// /sleep can return multiple sessions per day; dedupByDay picks the longest.
export const OURA_DATA_TYPES: Record<string, {
  endpoint: string;
  dedupByDay?: string;
  metrics: Record<string, { field: string; transform: string | null }>;
}> = {
  sleep: {
    endpoint: "/sleep",
    dedupByDay: "total_sleep_duration",
    metrics: {
      sleep_duration: { field: "total_sleep_duration", transform: "seconds_to_minutes" },
      sleep_efficiency: { field: "efficiency", transform: null },
      deep_sleep: { field: "deep_sleep_duration", transform: "seconds_to_minutes" },
      rem_sleep: { field: "rem_sleep_duration", transform: "seconds_to_minutes" },
      light_sleep: { field: "light_sleep_duration", transform: "seconds_to_minutes" },
      resting_heart_rate: { field: "lowest_heart_rate", transform: null },
      hrv_average: { field: "average_hrv", transform: null },
    },
  },
  readiness: {
    endpoint: "/daily_readiness",
    metrics: {
      readiness_score: { field: "score", transform: null },
    },
  },
  activity: {
    endpoint: "/daily_activity",
    metrics: {
      activity_score: { field: "score", transform: null },
      steps: { field: "steps", transform: null },
      calories_active: { field: "active_calories", transform: null },
      calories_total: { field: "total_calories", transform: null },
    },
  },
};

// Refresh this far ahead of expiry so a failed refresh still leaves days of
// a working access token (and daily cron retries) before syncing breaks.
const TOKEN_REFRESH_BUFFER_MS = 3 * 24 * 60 * 60 * 1000;

type OuraIntegrationTokens = {
  id: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
};

type RefreshResult =
  | { ok: true; accessToken: string; warning?: string }
  | { ok: false; error: string };

export async function refreshOuraToken(
  supabase: SupabaseClient,
  integration: OuraIntegrationTokens
): Promise<RefreshResult> {
  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, error: "OURA_CLIENT_ID / OURA_CLIENT_SECRET not configured" };
  }
  if (!integration.refresh_token) {
    return { ok: false, error: "No refresh token stored — reconnect Oura" };
  }

  try {
    const res = await fetch(OURA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: decrypt(integration.refresh_token),
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[oura] Token refresh failed for integration ${integration.id}: ${res.status} ${body}`);

      // Oura refresh tokens are single-use. If a concurrent sync already
      // refreshed, our copy is stale — use the token it saved instead.
      const { data: current } = await supabase
        .from("integrations")
        .select("access_token, refresh_token, token_expires_at")
        .eq("id", integration.id)
        .single();
      if (
        current &&
        current.refresh_token !== integration.refresh_token &&
        current.token_expires_at &&
        new Date(current.token_expires_at) > new Date()
      ) {
        console.log(`[oura] Integration ${integration.id} was refreshed concurrently; using stored token (expires ${current.token_expires_at})`);
        return { ok: true, accessToken: decrypt(current.access_token) };
      }

      return { ok: false, error: `Oura token refresh failed (${res.status}): ${body.slice(0, 200)}` };
    }

    const tokens = await res.json();

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + (tokens.expires_in || 86400));
    console.log(`[oura] Refreshed token for integration ${integration.id}; new expiry ${expiresAt.toISOString()}, rotated refresh token: ${Boolean(tokens.refresh_token)}`);

    const { error: saveError } = await supabase
      .from("integrations")
      .update({
        access_token: encrypt(tokens.access_token),
        refresh_token: tokens.refresh_token
          ? encrypt(tokens.refresh_token)
          : integration.refresh_token,
        token_expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", integration.id);

    if (saveError) {
      // The old refresh token is already spent, so the next refresh will fail.
      // This sync can still proceed with the new access token.
      console.error(`[oura] Refreshed token could not be saved for integration ${integration.id}:`, saveError);
      return {
        ok: true,
        accessToken: tokens.access_token,
        warning: `Refreshed Oura token could not be saved (${saveError.message}) — reconnect Oura before ${expiresAt.toISOString().slice(0, 10)}`,
      };
    }

    return { ok: true, accessToken: tokens.access_token };
  } catch (e) {
    console.error(`[oura] Token refresh threw for integration ${integration.id}:`, e);
    return { ok: false, error: `Oura token refresh error: ${e instanceof Error ? e.message : "Unknown error"}` };
  }
}

/**
 * Returns a usable access token, refreshing early when within
 * TOKEN_REFRESH_BUFFER_MS of expiry. If an early refresh fails but the
 * current token is still valid, syncs continue with a warning.
 */
export async function getOuraAccessToken(
  supabase: SupabaseClient,
  integration: OuraIntegrationTokens
): Promise<RefreshResult> {
  const expiresAt = integration.token_expires_at ? new Date(integration.token_expires_at) : null;
  const now = Date.now();

  if (!expiresAt || expiresAt.getTime() - now > TOKEN_REFRESH_BUFFER_MS) {
    return { ok: true, accessToken: decrypt(integration.access_token) };
  }

  const stillValid = expiresAt.getTime() > now;
  console.log(`[oura] Token for integration ${integration.id} expires ${expiresAt.toISOString()} (${stillValid ? "within refresh window" : "expired"}); refreshing`);

  const refreshed = await refreshOuraToken(supabase, integration);
  if (refreshed.ok || !stillValid) return refreshed;

  return {
    ok: true,
    accessToken: decrypt(integration.access_token),
    warning: `${refreshed.error}. Current token still works until ${expiresAt.toISOString().slice(0, 10)}; will retry next sync`,
  };
}

export type SyncResult = {
  synced: number;
  errors: string[];
  details: Record<string, unknown>;
};

export async function performOuraSync(
  supabase: SupabaseClient,
  params: {
    userId: string;
    accessToken: string;
    startDate: string;
    endDate: string;
    metricMapping: Record<string, { enabled: boolean; metric_id: string }>;
    overwriteManual: boolean;
    dataTypes?: string[];
  }
): Promise<SyncResult> {
  const { userId, accessToken, startDate, endDate, metricMapping, overwriteManual, dataTypes } = params;
  const typesToSync = dataTypes || Object.keys(OURA_DATA_TYPES);

  let totalSynced = 0;
  const errors: string[] = [];
  const details: Record<string, unknown> = {};

  for (const dataType of typesToSync) {
    const config = OURA_DATA_TYPES[dataType];
    if (!config) continue;

    try {
      const url = `${OURA_API_BASE}${config.endpoint}?start_date=${startDate}&end_date=${endDate}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        errors.push(`${dataType}: API error ${res.status}`);
        continue;
      }

      const data = await res.json();
      let items: Record<string, unknown>[] = data.data || [];

      details[dataType] = { fetched: items.length };

      // For endpoints with multiple records per day, keep only the longest session.
      if (config.dedupByDay) {
        const field = config.dedupByDay;
        const byDay = new Map<string, Record<string, unknown>>();
        for (const item of items) {
          const day = item.day as string;
          const existing = byDay.get(day);
          if (!existing || ((item[field] as number) ?? 0) > ((existing[field] as number) ?? 0)) {
            byDay.set(day, item);
          }
        }
        items = Array.from(byDay.values());
      }

      for (const item of items) {
        const date = item.day as string;

        for (const [metricKey, metricConfig] of Object.entries(config.metrics)) {
          const mapping = metricMapping[metricKey];
          if (!mapping?.enabled) continue;

          const targetMetricId = mapping.metric_id;
          if (!targetMetricId) continue;

          let value: unknown = item;
          for (const key of metricConfig.field.split(".")) {
            value = (value as Record<string, unknown>)?.[key];
          }
          if (value == null) continue;

          let numValue = value as number;
          if (metricConfig.transform === "seconds_to_minutes") {
            numValue = Math.round(numValue / 60);
          } else if (metricConfig.transform === "seconds_to_hours") {
            numValue = Math.round((numValue / 3600) * 10) / 10;
          }

          if (!overwriteManual) {
            const { data: existing } = await supabase
              .from("log")
              .select("value")
              .eq("owner_id", userId)
              .eq("date", date)
              .eq("metric_id", targetMetricId)
              .single();
            if (existing?.value != null) continue;
          }

          const { error: upsertError } = await supabase
            .from("log")
            .upsert(
              { owner_id: userId, date, metric_id: targetMetricId, value: numValue },
              { onConflict: "owner_id,date,metric_id" }
            );

          if (!upsertError) totalSynced++;
        }
      }
    } catch (e) {
      errors.push(`${dataType}: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  }

  return { synced: totalSynced, errors, details };
}
