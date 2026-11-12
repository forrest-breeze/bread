export interface CloudflareDeploymentStatusResult {
  status: "pending" | "deploying" | "connected" | "error";
  domain: string;
  scriptName: string | null;
  deployedAt: string | null;
  lastError: string | null;
  needsDeploy: boolean;
}

export interface CloudflareConnectorStatusResult {
  configured: boolean;
  connected: boolean;
  deployment: CloudflareDeploymentStatusResult | null;
}

export async function getCloudflareConnectorStatus(
  domain: string,
  signal?: AbortSignal,
): Promise<CloudflareConnectorStatusResult | null> {
  try {
    const response = await fetch(
      `/api/cloudflare/integration?domain=${encodeURIComponent(domain)}`,
      { signal },
    );
    if (!response.ok) return null;
    return (await response.json()) as CloudflareConnectorStatusResult;
  } catch {
    return null;
  }
}

export async function deployCloudflarePortal(
  domain: string,
): Promise<
  | { ok: true; deployment: CloudflareDeploymentStatusResult }
  | { ok: false; reconnect: boolean; error: string }
> {
  try {
    const response = await fetch("/api/cloudflare/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      deployment?: CloudflareDeploymentStatusResult;
      error?: string;
    };
    if (!response.ok || !body.deployment) {
      return {
        ok: false,
        reconnect: response.status === 401,
        error: body.error ?? "Cloudflare deployment failed.",
      };
    }
    return { ok: true, deployment: body.deployment };
  } catch {
    return {
      ok: false,
      reconnect: false,
      error: "Couldn't reach the Cloudflare connector.",
    };
  }
}

export function cloudflareConnectUrl(domain: string, returnTo: string): string {
  const query = new URLSearchParams({
    target_domain: domain,
    return_to: returnTo,
  });
  return `/api/cloudflare/oauth/start?${query.toString()}`;
}

