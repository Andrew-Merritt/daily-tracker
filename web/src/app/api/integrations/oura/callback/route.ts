import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { encrypt } from "@/lib/encryption";

const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.redirect(new URL("/integrations?error=not_authenticated", req.url));
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/integrations?error=${encodeURIComponent(error)}`, req.url)
    );
  }

  if (!code) {
    return NextResponse.redirect(new URL("/integrations?error=no_code", req.url));
  }

  // Verify state
  if (state) {
    try {
      const stateData = JSON.parse(Buffer.from(state, "base64url").toString());
      if (stateData.user_id !== user.id) {
        return NextResponse.redirect(new URL("/integrations?error=invalid_state", req.url));
      }
      // Check timestamp is within 10 minutes
      if (Date.now() - stateData.timestamp > 10 * 60 * 1000) {
        return NextResponse.redirect(new URL("/integrations?error=state_expired", req.url));
      }
    } catch {
      return NextResponse.redirect(new URL("/integrations?error=invalid_state", req.url));
    }
  }

  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  const redirectUri = process.env.OURA_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(new URL("/integrations?error=not_configured", req.url));
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(OURA_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const errorText = await tokenRes.text();
      console.error("Oura token exchange failed:", errorText);
      return NextResponse.redirect(new URL("/integrations?error=token_exchange_failed", req.url));
    }

    const tokens = await tokenRes.json();

    // Calculate token expiry
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + (tokens.expires_in || 86400));

    // Encrypt tokens before storing
    const encryptedAccessToken = encrypt(tokens.access_token);
    const encryptedRefreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;

    // On reconnect, only replace tokens — keep the existing metric mapping and settings.
    const { data: existing } = await supabase
      .from("integrations")
      .select("id")
      .eq("owner_id", user.id)
      .eq("provider", "oura")
      .maybeSingle();

    const tokenFields = {
      access_token: encryptedAccessToken,
      refresh_token: encryptedRefreshToken,
      token_expires_at: expiresAt.toISOString(),
      scopes: tokens.scope?.split(" ") || [],
      updated_at: new Date().toISOString(),
    };

    const { error: saveError } = existing
      ? await supabase.from("integrations").update(tokenFields).eq("id", existing.id)
      : await supabase.from("integrations").insert({
          owner_id: user.id,
          provider: "oura",
          ...tokenFields,
          sync_config: {
            auto_sync: false,
            overwrite_manual: false,
            metric_mapping: {},
          },
        });

    console.log(`[oura] ${existing ? "Reconnected" : "Connected"} Oura for user ${user.id}; token expires ${expiresAt.toISOString()}`);

    if (saveError) {
      console.error("Failed to save integration:", saveError);
      return NextResponse.redirect(new URL("/integrations?error=save_failed", req.url));
    }

    return NextResponse.redirect(
      new URL(`/integrations/oura?${existing ? "reconnected" : "connected"}=1`, req.url)
    );
  } catch (e) {
    console.error("Oura callback error:", e);
    return NextResponse.redirect(new URL("/integrations?error=callback_failed", req.url));
  }
}
