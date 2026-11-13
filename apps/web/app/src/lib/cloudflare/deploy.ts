import "server-only";

import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { listPortalProjects } from "@/lib/portal/experiences-write";
import {
  getKbCustomDomain,
  getPortalAddressMode,
  getPortalAddressScope,
  normalizeCustomDomain,
} from "@/lib/workspace-settings";
import {
  CloudflareApiError,
  deleteCloudflareWorkerDeployment,
  listCloudflareZones,
  selectCloudflareZone,
  syncCloudflareWorkerRoutes,
  uploadCloudflareWorker,
  workerRoutePatterns,
} from "@/lib/cloudflare/api";
import { getCloudflareAccessToken } from "@/lib/cloudflare/oauth";
import type {
  CloudflareConnectionRow,
  CloudflarePortalDeploymentRow,
} from "@breezify/core";

export interface PortalProxyConfig {
  domain: string;
  breezifyOrigin: string;
  workspaceSlug: string;
  routes: Record<string, string>;
}

export interface CloudflareConnectorStatus {
  configured: boolean;
  connected: boolean;
  deployment: {
    status: "pending" | "deploying" | "connected" | "error";
    domain: string;
    scriptName: string | null;
    deployedAt: string | null;
    lastError: string | null;
    needsDeploy: boolean;
  } | null;
}

export class PortalProxyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalProxyConfigurationError";
  }
}

function publicPortalPath(workspaceSlug: string, projectSlug: string): string {
  return projectSlug === workspaceSlug
    ? `/p/${workspaceSlug}`
    : `/p/${workspaceSlug}/${projectSlug}`;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function breezifyOrigin(): string {
  const raw =
    process.env.BREEZIFY_PORTAL_PROXY_ORIGIN?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!raw) {
    throw new PortalProxyConfigurationError(
      "Set BREEZIFY_PORTAL_PROXY_ORIGIN or NEXT_PUBLIC_APP_URL to deploy the portal proxy",
    );
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    // The origin is baked into the deployed Worker as BREEZIFY_ORIGIN. A Worker
    // running on Cloudflare's edge can never reach a loopback address, so a
    // deploy triggered from a dev server (NEXT_PUBLIC_APP_URL=localhost) must
    // set BREEZIFY_PORTAL_PROXY_ORIGIN to the public app, or every request 1003s.
    if (isLoopbackHost(url.hostname)) {
      throw new PortalProxyConfigurationError(
        "Portal proxy origin is a loopback address; set BREEZIFY_PORTAL_PROXY_ORIGIN to the public app URL",
      );
    }
    return url.origin;
  } catch {
    throw new PortalProxyConfigurationError("Breezify's public app URL is invalid");
  }
}

function canonicalRoutes(entries: Array<[string, string]>): Record<string, string> {
  return Object.fromEntries(
    entries
      .map(([mount, portal]) => [
        `/${mount.replace(/^\/+|\/+$/g, "")}`,
        `/${portal.replace(/^\/+|\/+$/g, "")}`,
      ])
      .filter(([mount]) => mount !== "/")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function buildWorkspacePortalRoutes(
  workspaceSlug: string,
  projectSlugs: string[],
): Record<string, string> {
  return canonicalRoutes(
    projectSlugs.map((projectSlug) => [
      `/${projectSlug}`,
      publicPortalPath(workspaceSlug, projectSlug),
    ]),
  );
}

export function buildProjectPortalRoutes(
  workspaceSlug: string,
  rows: Array<{ projectSlug: string; pathPrefix: string }>,
): Record<string, string> {
  return canonicalRoutes(
    rows.map((row) => [
      row.pathPrefix,
      publicPortalPath(workspaceSlug, row.projectSlug),
    ]),
  );
}

export async function loadPortalProxyConfig(
  workspaceId: string,
  requestedDomain: string,
): Promise<PortalProxyConfig> {
  const domain = normalizeCustomDomain(requestedDomain);
  if (!domain) {
    throw new PortalProxyConfigurationError("Enter and save a valid domain first");
  }
  const admin = createAdminClient();
  const { data: workspace, error } = await admin
    .from("workspaces")
    .select("slug, settings")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error || !workspace) {
    throw new PortalProxyConfigurationError("Workspace not found");
  }
  const workspaceSlug = workspace.slug as string;
  const settings =
    workspace.settings && typeof workspace.settings === "object"
      ? (workspace.settings as Record<string, unknown>)
      : {};
  const scope = getPortalAddressScope(settings);
  let routes: Record<string, string>;

  if (scope === "workspace") {
    if (
      getPortalAddressMode(settings) !== "path" ||
      getKbCustomDomain(settings) !== domain
    ) {
      throw new PortalProxyConfigurationError(
        "This domain is not the workspace's saved custom sub-folder domain",
      );
    }
    const projects = await listPortalProjects(workspaceId);
    routes = buildWorkspacePortalRoutes(
      workspaceSlug,
      projects.map((project) => project.slug),
    );
  } else {
    const { data: rows, error: routeError } = await admin
      .from("portal_domain_routes")
      .select("project_slug, path_prefix")
      .eq("workspace_id", workspaceId)
      .eq("domain", domain)
      .neq("path_prefix", "/");
    if (routeError) {
      throw new PortalProxyConfigurationError("Failed to load project routes");
    }
    routes = buildProjectPortalRoutes(
      workspaceSlug,
      (rows ?? []).map((row) => ({
        projectSlug: row.project_slug as string,
        pathPrefix: row.path_prefix as string,
      })),
    );
  }

  if (Object.keys(routes).length === 0) {
    throw new PortalProxyConfigurationError(
      "No project sub-folder routes are saved for this domain",
    );
  }
  return {
    domain,
    workspaceSlug,
    breezifyOrigin: breezifyOrigin(),
    routes,
  };
}

export function cloudflareScriptName(workspaceId: string, domain: string): string {
  const digest = createHash("sha256")
    .update(`${workspaceId}:${domain}`)
    .digest("hex")
    .slice(0, 20);
  return `breezify-portal-${digest}`;
}

function sameRoutes(a: unknown, b: Record<string, string>): boolean {
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  const left = Object.entries(a as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([x], [y]) => x.localeCompare(y));
  const right = Object.entries(b).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(left) === JSON.stringify(right);
}

async function recordDeploymentError(
  workspaceId: string,
  domain: string,
  routes: Record<string, string>,
  error: unknown,
): Promise<void> {
  const message =
    error instanceof Error ? error.message.slice(0, 1000) : "Cloudflare deployment failed";
  await createAdminClient().from("cloudflare_portal_deployments").upsert(
    {
      workspace_id: workspaceId,
      domain,
      routes,
      status: "error",
      last_error: message,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,domain" },
  );
}

export async function deployWorkspacePortalToCloudflare(
  workspaceId: string,
  requestedDomain: string,
): Promise<CloudflarePortalDeploymentRow> {
  const config = await loadPortalProxyConfig(workspaceId, requestedDomain);
  const accessToken = await getCloudflareAccessToken(workspaceId);
  if (!accessToken) {
    throw new CloudflareApiError("Reconnect Cloudflare to continue", 401);
  }
  const admin = createAdminClient();
  await admin.from("cloudflare_portal_deployments").upsert(
    {
      workspace_id: workspaceId,
      domain: config.domain,
      routes: config.routes,
      status: "deploying",
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,domain" },
  );

  try {
    const zones = await listCloudflareZones(accessToken);
    const zone = selectCloudflareZone(config.domain, zones);
    if (!zone) {
      throw new PortalProxyConfigurationError(
        `Cloudflare did not grant access to the zone for ${config.domain}`,
      );
    }
    const scriptName = cloudflareScriptName(workspaceId, config.domain);
    await uploadCloudflareWorker({
      accessToken,
      accountId: zone.account.id,
      scriptName,
      domain: config.domain,
      breezifyOrigin: config.breezifyOrigin,
      routes: config.routes,
    });
    await syncCloudflareWorkerRoutes({
      accessToken,
      zoneId: zone.id,
      scriptName,
      patterns: workerRoutePatterns(config.domain, config.routes),
    });

    const now = new Date().toISOString();
    const { data, error } = await admin
      .from("cloudflare_portal_deployments")
      .upsert(
        {
          workspace_id: workspaceId,
          domain: config.domain,
          account_id: zone.account.id,
          zone_id: zone.id,
          zone_name: zone.name,
          script_name: scriptName,
          routes: config.routes,
          status: "connected",
          last_error: null,
          deployed_at: now,
          updated_at: now,
        },
        { onConflict: "workspace_id,domain" },
      )
      .select("*")
      .single();
    if (error || !data) {
      throw new Error(`Failed to save the Cloudflare deployment: ${error?.message ?? "unknown error"}`);
    }
    return data as CloudflarePortalDeploymentRow;
  } catch (error) {
    await recordDeploymentError(workspaceId, config.domain, config.routes, error);
    throw error;
  }
}

export async function getCloudflareConnectorStatus(
  workspaceId: string,
  requestedDomain: string | null,
): Promise<CloudflareConnectorStatus> {
  const admin = createAdminClient();
  const [{ data: connection }, deploymentResult] = await Promise.all([
    admin
      .from("cloudflare_connections")
      .select("workspace_id")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    requestedDomain
      ? admin
          .from("cloudflare_portal_deployments")
          .select("*")
          .eq("workspace_id", workspaceId)
          .eq("domain", normalizeCustomDomain(requestedDomain))
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const deployment = deploymentResult.data as CloudflarePortalDeploymentRow | null;
  let desired: PortalProxyConfig | null = null;
  if (requestedDomain) {
    try {
      desired = await loadPortalProxyConfig(workspaceId, requestedDomain);
    } catch {
      desired = null;
    }
  }
  return {
    configured: Boolean(loadCloudflareOAuthConfigSafe()),
    connected: Boolean(connection),
    deployment: deployment
      ? {
          status: deployment.status,
          domain: deployment.domain,
          scriptName: deployment.script_name,
          deployedAt: deployment.deployed_at,
          lastError: deployment.last_error,
          needsDeploy: !desired || !sameRoutes(deployment.routes, desired.routes),
        }
      : null,
  };
}

function loadCloudflareOAuthConfigSafe(): boolean {
  return Boolean(
    process.env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim() &&
      process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET?.trim() &&
      process.env.NEXT_PUBLIC_APP_URL?.trim(),
  );
}

export async function removeCloudflareWorkspaceConnection(
  workspaceId: string,
): Promise<string | null> {
  const admin = createAdminClient();
  const { data: connection, error: connectionError } = await admin
    .from("cloudflare_connections")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (connectionError) {
    throw new Error(`Failed to load the Cloudflare connection: ${connectionError.message}`);
  }
  if (!connection) return null;
  const accessToken = await getCloudflareAccessToken(workspaceId);
  if (!accessToken) {
    throw new Error("Reconnect Cloudflare before disconnecting managed Workers");
  }
  const { data, error } = await admin
    .from("cloudflare_portal_deployments")
    .select("*")
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`Failed to load Cloudflare deployments: ${error.message}`);
  for (const deployment of (data ?? []) as CloudflarePortalDeploymentRow[]) {
    if (!deployment.account_id || !deployment.zone_id || !deployment.script_name) continue;
    await deleteCloudflareWorkerDeployment({
      accessToken,
      accountId: deployment.account_id,
      zoneId: deployment.zone_id,
      scriptName: deployment.script_name,
    });
  }
  return accessToken;
}
