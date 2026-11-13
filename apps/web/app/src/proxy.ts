import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";
import {
  customDomainCanonicalPath,
  customDomainRewritePath,
  resolveCustomDomainRoute,
  resolveCustomDomainProjectRoute,
  resolveSubdomainSlug,
} from "@/lib/public-kb-domain";
import { RESERVED_HANDLES } from "@/lib/public-kb-handle";
import {
  parsePortalLlmsPath,
  portalLlmsApiSearch,
  PORTAL_LLMS_API_PATH,
} from "@/lib/portal/llms-txt-request";

// ---------------------------------------------------------------------------
// Public Knowledge Base subdomain routing (opt-in via env).
//
// When NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN is set (e.g. "example.com"), requests to
// "<handle>.<base>" are resolved (handle -> owning workspace) and rewritten to
// the internal "/p/<slug>" tree so a published workspace KB is reachable at its
// own subdomain. The clean URL "https://<app-host>/p/<slug>" always works
// regardless; this only adds the subdomain entry point. No-op when unset.
//
// The base domain may be the bare apex (example.com), a sibling of the app host
// (app.example.com), so reserved labels (app, www, api, ...) and the app host
// itself are excluded before any handle lookup — otherwise the app would be
// hijacked to /p/app. Reserved labels are also barred from being claimed as a
// handle (see src/lib/public-kb-handle.ts), so the two lists stay in sync.
//
// Separately, custom-domain routes can mount a project at a whole host or at a
// host path. Legacy workspace-wide custom domains still resolve as before — see
// publicKbCustomDomainRewrite.
// ---------------------------------------------------------------------------
const PUBLIC_KB_BASE_DOMAIN = process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN;
const APP_HOST = (process.env.NEXT_PUBLIC_APP_URL ?? "")
  .replace(/^https?:\/\//, "")
  .split("/")[0]
  .split(":")[0]
  .toLowerCase();
const REVERSE_PROXY_MARKERS = new Set([
  "cloudflare-worker-v1",
  "reverse-proxy-v1",
]);
const PORTAL_PROXY_API_ENDPOINTS = new Set([
  "ask",
  "search",
  "track",
  "translate",
]);
const REVERSE_PROXY_MOUNT_RE =
  /^\/(?:[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)$/;

function reverseProxyHost(request: NextRequest, actualHost: string): string | null {
  const marker = request.headers.get("x-breezify-proxy") ?? "";
  if (!REVERSE_PROXY_MARKERS.has(marker)) return null;
  // Only accept forwarding metadata at Breezify's own origin. A request that
  // already arrived on a customer host must be resolved from its real Host.
  if (APP_HOST && actualHost !== APP_HOST) return null;
  const forwarded = (request.headers.get("x-forwarded-host") ?? "")
    .split(",")[0]
    ?.trim()
    .split(":")[0]
    .toLowerCase();
  if (!forwarded || !forwarded.includes(".") || forwarded.includes("/")) {
    return null;
  }
  return forwarded;
}

function reverseProxyMountPath(
  request: NextRequest,
  pathname: string,
  fallback: string,
): string {
  const raw = (request.headers.get("x-breezify-base-path") ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (
    REVERSE_PROXY_MOUNT_RE.test(raw) &&
    (pathname === raw || pathname.startsWith(`${raw}/`))
  ) {
    return raw;
  }
  return fallback;
}

// A portal's machine-readable files (llms.txt / llms-full.txt) have to answer on
// the portal's own mount — help.acme.com/llms.txt, acme.com/help/llms.txt,
// app.example.com/p/acme/help/llms.txt. The catch-all portal route is a page and
// can only return HTML, so every one of those resolves to the internal
// /p/<workspace>[/<project>]/llms.txt path here and is rewritten onto the public
// API route that renders text/plain. Returns false when the path isn't one.
function applyPortalLlmsTarget(url: URL, internalPath: string): boolean {
  const target = parsePortalLlmsPath(internalPath);
  if (!target) return false;
  url.pathname = PORTAL_LLMS_API_PATH;
  url.search = portalLlmsApiSearch(target);
  return true;
}

async function publicKbRewrite(
  request: NextRequest,
): Promise<NextResponse | null> {
  if (!PUBLIC_KB_BASE_DOMAIN) return null;

  const host = (request.headers.get("host") ?? "").split(":")[0].toLowerCase();
  const base = PUBLIC_KB_BASE_DOMAIN.split(":")[0].toLowerCase();

  // Only act on a single-label subdomain of the configured base domain, and
  // never on the app host or a reserved infra label (app, www, api, ...).
  if (host === base || !host.endsWith(`.${base}`)) return null;
  if (host === APP_HOST) return null;
  const sub = host.slice(0, host.length - base.length - 1);
  if (!sub || sub.includes(".") || RESERVED_HANDLES.has(sub)) return null;

  const { pathname } = request.nextUrl;
  // Leave API and already-internal /p paths untouched so links and data routes
  // are not double-prefixed.
  if (pathname.startsWith("/api") || pathname === "/p" || pathname.startsWith("/p/")) {
    return null;
  }

  // The subdomain label is a workspace slug; resolve it (verifying the workspace
  // is published) so the portal stays slug-keyed. Only published workspaces
  // resolve, so an unknown/unpublished slug falls through (no content exposed).
  const slug = await resolveSubdomainSlug(sub);
  if (!slug) return null;

  const url = request.nextUrl.clone();
  const internalPath = `/p/${slug}${pathname === "/" ? "" : pathname}`;
  const isLlms = applyPortalLlmsTarget(url, internalPath);
  if (!isLlms) url.pathname = internalPath;
  // A subdomain portal owns its whole host. Stamp that public mount on every
  // portal request so metadata and llms.txt both emit clean host-root URLs
  // instead of leaking the internal /p/<slug> rewrite target.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-breezify-portal-mount-path", "/");
  const rewrite = NextResponse.rewrite(url, {
    request: { headers: requestHeaders },
  });
  // Marker the connection-verify endpoint reads to confirm a host resolves to
  // this exact workspace (see /api/workspace/kb-domain/verify).
  rewrite.headers.set("x-breezify-portal", slug);
  return rewrite;
}

// Hosts that should never trigger a custom-domain DB lookup: the app's own
// host, localhost, and any subdomain of the configured base domain (already
// handled by publicKbRewrite). Everything else is a candidate custom domain.
function isOwnOrInfraHost(host: string): boolean {
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (APP_HOST && host === APP_HOST) return true;
  if (PUBLIC_KB_BASE_DOMAIN) {
    const base = PUBLIC_KB_BASE_DOMAIN.split(":")[0].toLowerCase();
    // The apex itself may intentionally expose path-mounted portals through a
    // reverse proxy (e.g. example.com/docs). Built-in subdomains remain reserved.
    if (host !== base && host.endsWith(`.${base}`)) return true;
  }
  return false;
}

async function publicKbCustomDomainRewrite(
  request: NextRequest,
): Promise<NextResponse | null> {
  const actualHost = (request.headers.get("host") ?? "")
    .split(":")[0]
    .toLowerCase();
  const proxiedHost = reverseProxyHost(request, actualHost);
  const host = proxiedHost ?? actualHost;
  if (!proxiedHost && isOwnOrInfraHost(host)) return null;

  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api") || pathname === "/p") {
    return null;
  }

  // Portal components still emit their stable internal `/p/...` hrefs. On a
  // custom host, canonicalize those back to the configured clean domain/path
  // mount. This keeps navigation on customer.com/docs (or docs.customer.com)
  // while avoiding a cross-cutting rewrite of every portal component.
  //
  // Never canonicalize a trusted reverse-proxy fetch: the Cloudflare Worker
  // template deliberately addresses /p/<ws>/<project> as its origin request
  // (skipping the public-mount redirect hop), so bouncing it back to the clean
  // path turns every proxied portal page into a circular redirect.
  if (pathname.startsWith("/p/")) {
    if (proxiedHost) return null;
    const parts = pathname.split("/").filter(Boolean);
    const workspaceSlug = parts[1];
    if (!workspaceSlug) return null;
    const third = parts[2];
    const projectSlug =
      third && third !== "doc" && third !== "folder" ? third : null;
    const route = await resolveCustomDomainProjectRoute(
      host,
      workspaceSlug,
      projectSlug,
    );
    if (!route) return null;
    const canonicalPath = customDomainCanonicalPath(route, pathname);
    if (!canonicalPath) return null;
    const url = request.nextUrl.clone();
    url.pathname = canonicalPath;
    return NextResponse.redirect(url, 307);
  }

  const route = await resolveCustomDomainRoute(host, pathname);
  if (!route) return null;
  const mountPath = proxiedHost
    ? reverseProxyMountPath(request, pathname, route.pathPrefix)
    : route.pathPrefix;

  if (proxiedHost) {
    const apiPrefix =
      mountPath === "/"
        ? "/_breezify/api/"
        : `${mountPath}/_breezify/api/`;
    if (pathname.startsWith(apiPrefix)) {
      const endpoint = pathname.slice(apiPrefix.length);
      if (!PORTAL_PROXY_API_ENDPOINTS.has(endpoint)) return null;
      const url = request.nextUrl.clone();
      url.pathname = `/api/public/${endpoint}`;
      return NextResponse.rewrite(url);
    }
  }

  const rewrittenPath = route.projectSlug
    ? customDomainRewritePath(route, pathname)
    : `/p/${route.workspaceSlug}${pathname === "/" ? "" : pathname}`;
  if (!rewrittenPath) return null;

  const url = request.nextUrl.clone();
  if (!applyPortalLlmsTarget(url, rewrittenPath)) url.pathname = rewrittenPath;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-breezify-portal-host", host);
  requestHeaders.set("x-breezify-portal-mount-path", mountPath);
  if (proxiedHost) {
    requestHeaders.set("x-breezify-base-path", mountPath);
  }
  if (route.projectSlug) {
    requestHeaders.set("x-breezify-portal-project", route.projectSlug);
  }
  const rewrite = NextResponse.rewrite(url, {
    request: { headers: requestHeaders },
  });
  rewrite.headers.set("x-breezify-portal", route.workspaceSlug);
  rewrite.headers.set("x-breezify-portal-mount-path", mountPath);
  return rewrite;
}

// A trusted reverse proxy (Cloudflare Worker / customer reverse proxy) maps
// its mount path straight onto the internal /p/<slug> tree, and /p/* skips the
// rewrite pipeline above — so the x-breezify-portal marker the kb-domain
// verifier reads would never be stamped for worker-proxied mounts. Recover the
// slug from the requested path when the proxy metadata is trustworthy.
function reverseProxyPortalSlug(request: NextRequest): string | null {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/p/")) return null;
  const marker = request.headers.get("x-breezify-proxy") ?? "";
  if (!REVERSE_PROXY_MARKERS.has(marker)) return null;
  return pathname.split("/").filter(Boolean)[1] ?? null;
}

/** Carry the session-refresh cookies onto a rewrite response. */
function withSessionCookies(target: NextResponse, session: NextResponse): NextResponse {
  session.cookies.getAll().forEach((cookie) => target.cookies.set(cookie.name, cookie.value, cookie));
  return target;
}

export default async function proxy(request: NextRequest) {
  // Portal hosts (subdomain / custom domain) rewrite onto /p/* or /api/public/*,
  // which skip the Breeze-session requirement and gate on the portal's own
  // visibility setting (public → anyone, private → signed-in members). Run the
  // session pass only to refresh cookies; never let it redirect a portal host
  // to the app's login page.
  const portalRewrite =
    (await publicKbRewrite(request)) ??
    (await publicKbCustomDomainRewrite(request));
  if (portalRewrite) {
    return withSessionCookies(portalRewrite, await updateSession(request));
  }

  // Everything else: authenticate FIRST. updateSession verifies the session,
  // refreshes it, and returns a redirect to /login (pages) or a 401 (APIs)
  // unless the user is a Breeze account or the path is on the anonymous
  // allowlist (lib/auth/anonymous-paths.ts — which includes /p/* and
  // /api/public/*, so path-addressed portals are reachable too).
  const session = await updateSession(request);
  if (session.status !== 200 || session.headers.has("location")) return session;

  // A /p/... path reaches here two ways: addressed directly on the app host, or
  // forwarded by the Worker proxy (which addresses /p/<ws>/<project> and so skips
  // the rewrites above). Both need the llms.txt files mapped to the text route;
  // the Worker's own x-breezify-base-path header still supplies the public mount.
  const llmsUrl = request.nextUrl.clone();
  if (applyPortalLlmsTarget(llmsUrl, request.nextUrl.pathname)) {
    return withSessionCookies(NextResponse.rewrite(llmsUrl, { request }), session);
  }

  const proxiedSlug = reverseProxyPortalSlug(request);
  if (proxiedSlug) session.headers.set("x-breezify-portal", proxiedSlug);
  return session;
}

export const config = {
  matcher: [
    /*
     * Run on EVERY request except Next's build assets and the few real files
     * in /public. Matching by extension (the old `.*\\.(png|svg|…)$` rule)
     * let any route whose URL ends in ".png" skip authentication.
     */
    "/((?!_next/static|_next/image|breeze-mark\\.png|breeze-icon\\.png|icon\\.png).*)",
  ],
};
