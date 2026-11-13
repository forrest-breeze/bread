import "server-only";

import { createHash } from "node:crypto";

const API_BASE = "https://api.cloudflare.com/client/v4";
// Raw URL of the portal proxy Worker script (see
// templates/cloudflare-portal-subfolder-proxy) and its expected SHA-256. Both
// must be set to deploy the proxy; there is no default source.
const WORKER_SOURCE_URL = process.env.BREEZIFY_PORTAL_WORKER_SOURCE_URL?.trim() ?? "";
const WORKER_SOURCE_SHA256 =
  process.env.BREEZIFY_PORTAL_WORKER_SOURCE_SHA256?.trim().toLowerCase() ?? "";
const COMPATIBILITY_DATE = "2026-07-15";

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: {
    page?: number;
    total_pages?: number;
  };
}

export interface CloudflareZone {
  id: string;
  name: string;
  account: { id: string; name?: string };
}

interface CloudflareWorkerRoute {
  id: string;
  pattern: string;
  script?: string;
}

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

async function cloudflareApi<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<CloudflareEnvelope<T>> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let body: CloudflareEnvelope<T> | null = null;
  try {
    body = JSON.parse(raw) as CloudflareEnvelope<T>;
  } catch {
    // Handled by the common failure below.
  }
  if (!response.ok || !body?.success) {
    const first = body?.errors?.[0];
    throw new CloudflareApiError(
      first?.message?.slice(0, 500) || `Cloudflare API request failed with HTTP ${response.status}`,
      response.status,
      first?.code,
    );
  }
  return body;
}

export async function listCloudflareZones(
  accessToken: string,
): Promise<CloudflareZone[]> {
  const zones: CloudflareZone[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await cloudflareApi<CloudflareZone[]>(
      accessToken,
      `/zones?per_page=50&page=${page}`,
    );
    zones.push(...(response.result ?? []));
    const totalPages = response.result_info?.total_pages ?? page;
    if (page >= totalPages || (response.result ?? []).length === 0) break;
  }
  return zones;
}

export function selectCloudflareZone(
  domain: string,
  zones: CloudflareZone[],
): CloudflareZone | null {
  const host = domain.toLowerCase();
  return (
    zones
      .filter((zone) => host === zone.name || host.endsWith(`.${zone.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0] ?? null
  );
}

let cachedWorkerSource: string | null = null;

export async function loadCloudflareWorkerSource(): Promise<string> {
  if (cachedWorkerSource) return cachedWorkerSource;
  if (!WORKER_SOURCE_URL || !WORKER_SOURCE_SHA256) {
    throw new Error(
      "Set BREEZIFY_PORTAL_WORKER_SOURCE_URL and BREEZIFY_PORTAL_WORKER_SOURCE_SHA256 to deploy the portal proxy Worker",
    );
  }
  const response = await fetch(WORKER_SOURCE_URL, {
    cache: "force-cache",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to load the Breezify Worker template (HTTP ${response.status})`);
  }
  const source = await response.text();
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest !== WORKER_SOURCE_SHA256) {
    throw new Error("The Breezify Worker template failed its integrity check");
  }
  cachedWorkerSource = source;
  return source;
}

export async function uploadCloudflareWorker(input: {
  accessToken: string;
  accountId: string;
  scriptName: string;
  domain: string;
  breezifyOrigin: string;
  routes: Record<string, string>;
  source?: string;
}): Promise<void> {
  const source = input.source ?? (await loadCloudflareWorkerSource());
  const metadata = {
    main_module: "worker.js",
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      { type: "plain_text", name: "EXPECTED_HOST", text: input.domain },
      { type: "plain_text", name: "BREEZIFY_ORIGIN", text: input.breezifyOrigin },
      {
        type: "plain_text",
        name: "BREEZIFY_ROUTES",
        text: JSON.stringify(input.routes),
      },
    ],
    annotations: {
      "workers/message": "Deployed automatically by Breezify",
      "workers/tag": "breezify-portal-proxy",
    },
  };
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  form.append(
    "worker.js",
    new Blob([source], { type: "application/javascript+module" }),
    "worker.js",
  );
  await cloudflareApi<unknown>(
    input.accessToken,
    `/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${encodeURIComponent(input.scriptName)}`,
    { method: "PUT", body: form },
  );
}

export function workerRoutePatterns(
  domain: string,
  routes: Record<string, string>,
): string[] {
  return Object.keys(routes)
    .sort()
    .flatMap((mountPath) => [
      `${domain}${mountPath}`,
      `${domain}${mountPath}/*`,
    ]);
}

export async function syncCloudflareWorkerRoutes(input: {
  accessToken: string;
  zoneId: string;
  scriptName: string;
  patterns: string[];
}): Promise<void> {
  const response = await cloudflareApi<CloudflareWorkerRoute[]>(
    input.accessToken,
    `/zones/${encodeURIComponent(input.zoneId)}/workers/routes`,
  );
  const current = response.result ?? [];
  const desired = new Set(input.patterns);

  // Only remove routes already owned by this Breezify-managed Worker. A route
  // attached to any other Worker is left untouched and Cloudflare will return
  // a conflict when we try to create it.
  for (const route of current) {
    if (route.script === input.scriptName && !desired.has(route.pattern)) {
      await cloudflareApi<unknown>(
        input.accessToken,
        `/zones/${encodeURIComponent(input.zoneId)}/workers/routes/${encodeURIComponent(route.id)}`,
        { method: "DELETE" },
      );
    }
  }

  const existing = new Set(
    current
      .filter((route) => route.script === input.scriptName)
      .map((route) => route.pattern),
  );
  for (const pattern of input.patterns) {
    if (existing.has(pattern)) continue;
    await cloudflareApi<unknown>(
      input.accessToken,
      `/zones/${encodeURIComponent(input.zoneId)}/workers/routes`,
      {
        method: "POST",
        body: JSON.stringify({ pattern, script: input.scriptName }),
      },
    );
  }
}

export async function deleteCloudflareWorkerDeployment(input: {
  accessToken: string;
  accountId: string;
  zoneId: string;
  scriptName: string;
}): Promise<void> {
  const routes = await cloudflareApi<CloudflareWorkerRoute[]>(
    input.accessToken,
    `/zones/${encodeURIComponent(input.zoneId)}/workers/routes`,
  );
  for (const route of routes.result ?? []) {
    if (route.script !== input.scriptName) continue;
    await cloudflareApi<unknown>(
      input.accessToken,
      `/zones/${encodeURIComponent(input.zoneId)}/workers/routes/${encodeURIComponent(route.id)}`,
      { method: "DELETE" },
    );
  }
  await cloudflareApi<unknown>(
    input.accessToken,
    `/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${encodeURIComponent(input.scriptName)}`,
    { method: "DELETE" },
  );
}

