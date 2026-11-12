"use client"

import { useMemo, useState } from "react"
import {
  Check,
  ChevronDown,
  Cloud,
  Copy,
  Server,
} from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { InfoHint } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { CloudflarePortalConnector } from "@/components/cloudflare-portal-connector"
import type { CloudflareConnectorStatusResult } from "@/lib/api/cloudflare"

function normalizeMountPath(value: string): string {
  const withSlash = value.trim().startsWith("/") ? value.trim() : `/${value.trim()}`
  return withSlash.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/"
}

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

// Host of the app origin, or "" when NEXT_PUBLIC_APP_URL is unset/invalid.
function originHost(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return ""
  }
}

export function PortalReverseProxyInstructions({
  domain,
  mountPath,
  portalPath,
  routeMappings,
  breadOrigin = process.env.NEXT_PUBLIC_APP_URL ?? "",
  connectorReady = true,
  verifyWorkerActivation,
  onWorkerConnected,
  onWorkerStatusChange,
  className,
}: {
  domain: string
  mountPath: string
  portalPath: string
  routeMappings?: Array<{ mountPath: string; portalPath: string }>
  breadOrigin?: string
  connectorReady?: boolean
  verifyWorkerActivation?: () => Promise<boolean>
  onWorkerConnected?: () => void
  onWorkerStatusChange?: (status: CloudflareConnectorStatusResult | null) => void
  className?: string
}): React.ReactElement {
  const [copied, setCopied] = useState<string | null>(null)
  const [showOther, setShowOther] = useState(false)
  const normalizedOrigin = normalizeOrigin(breadOrigin)
  const normalizedRoutes = useMemo(() => {
    const candidates = routeMappings?.length
      ? routeMappings
      : [{ mountPath, portalPath }]
    const deduped = new Map<string, string>()
    for (const route of candidates) {
      const normalizedMount = normalizeMountPath(route.mountPath)
      if (normalizedMount === "/" || !route.portalPath.startsWith("/p/")) continue
      deduped.set(normalizedMount, normalizeMountPath(route.portalPath))
    }
    if (deduped.size === 0) {
      deduped.set(normalizeMountPath(mountPath), normalizeMountPath(portalPath))
    }
    return Array.from(deduped, ([normalizedMount, normalizedPortal]) => ({
      mountPath: normalizedMount,
      portalPath: normalizedPortal,
    }))
  }, [mountPath, portalPath, routeMappings])
  const workerRoutes = normalizedRoutes.flatMap((route) => [
    `${domain}${route.mountPath}`,
    `${domain}${route.mountPath}/*`,
  ])
  const routeBundle = Object.fromEntries(
    normalizedRoutes.map((route) => [route.mountPath, route.portalPath]),
  )
  const cloudflareSetup = useMemo(
    () => `EXPECTED_HOST=${domain}
BREAD_ORIGIN=${normalizedOrigin}
BREAD_ROUTES=${JSON.stringify(routeBundle)}
${workerRoutes.map((route, index) => `WORKER_ROUTE_${index + 1}=${route}`).join("\n")}`,
    [domain, normalizedOrigin, routeBundle, workerRoutes],
  )

  const nginxConfig = useMemo(
    () => normalizedRoutes.map((route) => `# ${domain}${route.mountPath}
location = ${route.mountPath} {
    proxy_pass ${normalizedOrigin}${route.portalPath};
    proxy_ssl_server_name on;
    proxy_set_header Host ${originHost(normalizedOrigin)};
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Bread-Base-Path ${route.mountPath};
    proxy_set_header X-Bread-Proxy reverse-proxy-v1;
}

location ^~ ${route.mountPath}/ {
    proxy_pass ${normalizedOrigin}${route.portalPath}/;
    proxy_ssl_server_name on;
    proxy_set_header Host ${originHost(normalizedOrigin)};
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Bread-Base-Path ${route.mountPath};
    proxy_set_header X-Bread-Proxy reverse-proxy-v1;
}`).join("\n\n"),
    [domain, normalizedOrigin, normalizedRoutes],
  )

  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(value)
      setTimeout(
        () => setCopied((current) => (current === value ? null : current)),
        1500,
      )
    } catch {
      // Clipboard unavailable in insecure contexts.
    }
  }

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">No DNS changes.</span>{" "}
        Your homepage stays on its current site. Only{" "}
        {normalizedRoutes.length === 1 ? "the project path" : "these project paths"}{" "}
        <span className="font-mono text-foreground">
          {normalizedRoutes.map((route) => route.mountPath).join(", ")}
        </span>{" "}
        {normalizedRoutes.length === 1 ? "is" : "are"} sent to Bread.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex min-h-40 flex-col rounded-xl border border-orange-500/30 bg-orange-500/[0.04] p-3">
          <div className="flex items-start gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-orange-500/10">
              <Cloud className="size-4 text-orange-500" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                Cloudflare one-click
                <InfoHint side="top">
                  Authorize Bread once. The connector finds this domain&apos;s
                  Cloudflare zone, deploys the Worker with the generated
                  variables, and mounts every listed project path.
                </InfoHint>
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                Deploy one Worker for the configured project paths.
              </span>
            </span>
          </div>
          <div className="mt-auto flex flex-wrap items-start gap-2 pt-4">
            <CloudflarePortalConnector
              domain={domain}
              ready={connectorReady}
              verifyActivation={verifyWorkerActivation}
              onConnected={onWorkerConnected}
              onStatusChange={onWorkerStatusChange}
            />
            <button
              type="button"
              aria-label={`Copy Cloudflare setup for ${workerRoutes.join(" and ")}`}
              onClick={() => void copy(cloudflareSetup)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {copied === cloudflareSetup ? (
                <Check className="mr-1 size-3.5 text-primary" />
              ) : (
                <Copy className="mr-1 size-3.5" />
              )}
              {copied === cloudflareSetup ? "Copied" : "Copy setup"}
            </button>
          </div>
        </div>

        <button
          type="button"
          aria-expanded={showOther}
          onClick={() => setShowOther((visible) => !visible)}
          className="group flex min-h-40 w-full items-start gap-2.5 rounded-xl border border-input bg-background p-3 text-left hover:bg-muted/30"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Server className="size-4 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">
              Other reverse proxy
            </span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              Nginx or any host that can forward a path and preserve headers.
            </span>
            <span className="mt-4 block text-[11px] font-medium text-foreground">
              {showOther ? "Hide instructions" : "View instructions"}
            </span>
          </span>
          <ChevronDown
            className={`mt-1 size-3.5 text-muted-foreground transition-transform ${
              showOther ? "rotate-180" : ""
            }`}
          />
        </button>

        {showOther ? (
          <div className="space-y-2 rounded-xl border border-input bg-background p-3 sm:col-span-2">
            <p className="text-[10px] text-muted-foreground">
              Add these location blocks to the existing server for{" "}
              <span className="font-mono">{domain}</span>. They preserve the
              method, body, query string, and remaining path.
            </p>
            <div className="relative">
              <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2.5 pr-9 text-[10px] leading-relaxed text-foreground">
                <code>{nginxConfig}</code>
              </pre>
              <button
                type="button"
                aria-label="Copy Nginx configuration"
                onClick={() => void copy(nginxConfig)}
                className="absolute right-1.5 top-1.5 rounded p-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              >
                {copied === nginxConfig ? (
                  <Check className="size-3.5 text-primary" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
