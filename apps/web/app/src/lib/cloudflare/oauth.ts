import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  decryptCloudflareToken,
  encryptCloudflareToken,
} from "@/lib/cloudflare/token-crypto";
import type { CloudflareConnectionRow } from "@breezify/core";

const AUTHORIZE_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const REVOKE_ENDPOINT = "https://dash.cloudflare.com/oauth2/revoke";
const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

export interface CloudflareOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface CloudflareOAuthState {
  workspaceId: string;
  userId: string;
  targetDomain: string;
  returnPath: string;
}

export interface CloudflareTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string | string[];
}

function normalizedAppUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuredScopes(value: string | undefined): string[] {
  return Array.from(
    new Set(
      (value ?? "")
        .split(/[\s,]+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  );
}

export function loadCloudflareOAuthConfig(): CloudflareOAuthConfig | null {
  const clientId = process.env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET?.trim();
  const appUrl = normalizedAppUrl(process.env.NEXT_PUBLIC_APP_URL);
  if (!clientId || !clientSecret || !appUrl) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: `${appUrl}/api/cloudflare/oauth/callback`,
    scopes: configuredScopes(process.env.CLOUDFLARE_OAUTH_SCOPES),
  };
}

export function buildCloudflareAuthorizeUrl(
  config: CloudflareOAuthConfig,
  state: string,
): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  // Cloudflare defaults to the scopes configured on the client. This optional
  // override is useful if the client later gains unrelated permissions.
  if (config.scopes.length > 0) {
    url.searchParams.set("scope", config.scopes.join(" "));
  }
  return url.toString();
}

function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export async function issueCloudflareOAuthState(
  input: CloudflareOAuthState,
): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const admin = createAdminClient();
  // Opportunistic cleanup keeps the short-lived table bounded without cron.
  await admin
    .from("cloudflare_oauth_states")
    .delete()
    .lt("expires_at", new Date().toISOString());

  const { error } = await admin.from("cloudflare_oauth_states").insert({
    state_hash: stateHash(state),
    workspace_id: input.workspaceId,
    user_id: input.userId,
    target_domain: input.targetDomain,
    return_path: input.returnPath,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`Cloudflare OAuth state insert failed: ${error.message}`);
  return state;
}

export async function consumeCloudflareOAuthState(
  state: string,
): Promise<CloudflareOAuthState | null> {
  if (!state || state.length > 2048) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("cloudflare_oauth_states")
    .delete()
    .eq("state_hash", stateHash(state))
    .gt("expires_at", new Date().toISOString())
    .select("workspace_id, user_id, target_domain, return_path")
    .maybeSingle();
  if (error) {
    console.error("[Breezify] Cloudflare OAuth state consume:", error.message);
    return null;
  }
  if (!data) return null;
  return {
    workspaceId: data.workspace_id as string,
    userId: data.user_id as string,
    targetDomain: data.target_domain as string,
    returnPath: data.return_path as string,
  };
}

async function tokenRequest(
  config: CloudflareOAuthConfig,
  params: Record<string, string>,
): Promise<CloudflareTokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...params,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (
    !response.ok ||
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { access_token?: unknown }).access_token !== "string"
  ) {
    const description =
      parsed && typeof parsed === "object"
        ? String(
            (parsed as { error_description?: unknown; error?: unknown })
              .error_description ??
              (parsed as { error?: unknown }).error ??
              "unknown_error",
          )
        : `HTTP ${response.status}`;
    throw new Error(`Cloudflare token exchange failed: ${description.slice(0, 300)}`);
  }
  return parsed as CloudflareTokenResponse;
}

export function exchangeCloudflareCode(
  config: CloudflareOAuthConfig,
  code: string,
): Promise<CloudflareTokenResponse> {
  return tokenRequest(config, {
    code,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });
}

export function refreshCloudflareToken(
  config: CloudflareOAuthConfig,
  refreshToken: string,
): Promise<CloudflareTokenResponse> {
  return tokenRequest(config, {
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}

export function tokenScopes(tokens: CloudflareTokenResponse): string[] {
  if (Array.isArray(tokens.scope)) return tokens.scope.filter(Boolean);
  return (tokens.scope ?? "").split(/[\s,]+/).filter(Boolean);
}

export function tokenExpiry(tokens: CloudflareTokenResponse): string | null {
  return typeof tokens.expires_in === "number" && tokens.expires_in > 0
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;
}

export async function storeCloudflareConnection(input: {
  workspaceId: string;
  userId: string;
  tokens: CloudflareTokenResponse;
}): Promise<void> {
  const access = encryptCloudflareToken(input.tokens.access_token);
  const refresh = input.tokens.refresh_token
    ? encryptCloudflareToken(input.tokens.refresh_token)
    : null;
  if (!access || (input.tokens.refresh_token && !refresh)) {
    throw new Error("Cloudflare token encryption is unavailable");
  }
  const admin = createAdminClient();
  const { error } = await admin.from("cloudflare_connections").upsert(
    {
      workspace_id: input.workspaceId,
      access_token_encrypted: access,
      refresh_token_encrypted: refresh,
      access_token_expires_at: tokenExpiry(input.tokens),
      scopes: tokenScopes(input.tokens),
      connected_by: input.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(`Cloudflare connection upsert failed: ${error.message}`);
}

export async function getCloudflareAccessToken(
  workspaceId: string,
): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("cloudflare_connections")
    .select("*")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as CloudflareConnectionRow;
  const access = decryptCloudflareToken(row.access_token_encrypted);
  if (!access) return null;
  const expiresAt = row.access_token_expires_at
    ? new Date(row.access_token_expires_at).getTime()
    : Number.POSITIVE_INFINITY;
  if (expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS) return access;

  if (!row.refresh_token_encrypted) return null;
  const refresh = decryptCloudflareToken(row.refresh_token_encrypted);
  const config = loadCloudflareOAuthConfig();
  if (!refresh || !config) return null;
  try {
    const tokens = await refreshCloudflareToken(config, refresh);
    const nextAccess = encryptCloudflareToken(tokens.access_token);
    const nextRefresh = tokens.refresh_token
      ? encryptCloudflareToken(tokens.refresh_token)
      : row.refresh_token_encrypted;
    if (!nextAccess || !nextRefresh) return null;
    const { error: updateError } = await admin
      .from("cloudflare_connections")
      .update({
        access_token_encrypted: nextAccess,
        refresh_token_encrypted: nextRefresh,
        access_token_expires_at: tokenExpiry(tokens),
        scopes: tokenScopes(tokens).length > 0 ? tokenScopes(tokens) : row.scopes,
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", workspaceId);
    if (updateError) return null;
    return tokens.access_token;
  } catch (error) {
    console.error("[Breezify] Cloudflare token refresh:", error);
    return null;
  }
}

export async function revokeCloudflareToken(
  config: CloudflareOAuthConfig,
  token: string,
): Promise<void> {
  const response = await fetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare token revocation failed with HTTP ${response.status}`);
  }
}

