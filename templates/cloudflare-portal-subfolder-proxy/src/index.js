const CONFIG_ERROR =
  "This Bread proxy is not configured. Check EXPECTED_HOST, BREAD_ORIGIN, and BREAD_ROUTES (or the legacy MOUNT_PATH and BREAD_PORTAL_PATH)."

function normalizedPath(value, { allowRoot = false } = {}) {
  const raw = String(value ?? "").trim()
  if (!raw) return allowRoot ? "/" : ""
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`
  const normalized = withSlash.replace(/\/{2,}/g, "/").replace(/\/+$/, "")
  return normalized || "/"
}

function normalizedOrigin(value) {
  try {
    const url = new URL(String(value ?? "").trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    url.pathname = "/"
    url.search = ""
    url.hash = ""
    return url
  } catch {
    return null
  }
}

function normalizedRoute(mountValue, portalValue) {
  const mountPath = normalizedPath(mountValue)
  const portalPath = normalizedPath(portalValue)
  if (
    !mountPath ||
    mountPath === "/" ||
    !portalPath ||
    !portalPath.startsWith("/p/")
  ) {
    return null
  }
  return { mountPath, portalPath }
}

function normalizedRouteMap(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return []
    const routes = []
    const seen = new Set()
    for (const [mountValue, portalValue] of Object.entries(parsed)) {
      const route = normalizedRoute(mountValue, portalValue)
      if (!route || seen.has(route.mountPath)) return []
      seen.add(route.mountPath)
      routes.push(route)
    }
    return routes.sort((a, b) => b.mountPath.length - a.mountPath.length)
  } catch {
    return []
  }
}

export function proxyConfig(env) {
  const expectedHost = String(env.EXPECTED_HOST ?? "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
  const breadOrigin = normalizedOrigin(env.BREAD_ORIGIN)
  const routeMap = normalizedRouteMap(env.BREAD_ROUTES)
  const legacyRoute = normalizedRoute(env.MOUNT_PATH, env.BREAD_PORTAL_PATH)
  const routes = routeMap ?? (legacyRoute ? [legacyRoute] : [])

  if (
    !expectedHost ||
    expectedHost.includes("/") ||
    !breadOrigin ||
    routes.length === 0
  ) {
    return null
  }

  return {
    expectedHost,
    breadOrigin,
    routes,
    mountPath: routes[0].mountPath,
    portalPath: routes[0].portalPath,
  }
}

function activeRoute(requestUrl, config) {
  const incoming = new URL(requestUrl)
  if (incoming.hostname.toLowerCase() !== config.expectedHost) return null
  const routes = config.routes ?? [
    { mountPath: config.mountPath, portalPath: config.portalPath },
  ]
  return (
    routes.find(
      (route) =>
        incoming.pathname === route.mountPath ||
        incoming.pathname.startsWith(`${route.mountPath}/`),
    ) ?? null
  )
}

const LEGACY_BLOG_UUID_RE =
  /^\/[^/]+-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i

/**
 * Recover the pre-portal blog route (`/blog/<title>-<uuid>`) without a lookup.
 * This is deliberately scoped to the exact /blog mount and a single path
 * segment so current `/blog/doc/...` URLs and customer mounts are untouched.
 */
export function legacyBlogLocation(requestUrl, config) {
  const route = activeRoute(requestUrl, config)
  if (!route || route.mountPath !== "/blog") return null

  const incoming = new URL(requestUrl)
  const suffix = incoming.pathname.slice(route.mountPath.length)
  const uuid = suffix.match(LEGACY_BLOG_UUID_RE)?.[1]
  if (!uuid) return null

  incoming.pathname = `${route.mountPath}/doc/${uuid.toLowerCase()}`
  return incoming.toString()
}

export function upstreamUrlFor(requestUrl, config) {
  const incoming = new URL(requestUrl)
  const route = activeRoute(requestUrl, config)
  if (!route) return null

  const upstream = new URL(config.breadOrigin)
  const suffix = incoming.pathname.slice(route.mountPath.length)
  const apiPrefix = "/_bread/api/"

  // Address the stable portal route directly. Going through the public mount
  // on app.example.com can hit the project's canonical-address redirect first:
  // customer.example/manuals -> app.example.com/p/project/<id> -> the public mount.
  // Using /p/<workspace>/<project> removes that redirect hop entirely while
  // the forwarding headers keep all rendered links rooted at the public mount.
  upstream.pathname = suffix.startsWith(apiPrefix)
    ? `/api/public/${suffix.slice(apiPrefix.length)}`
    : `${route.portalPath}${suffix}`
  upstream.search = incoming.search
  return upstream
}

export function externalLocation(location, requestUrl, config) {
  if (!location) return null
  const route = activeRoute(requestUrl, config)
  if (!route) return location
  const target = new URL(location, config.breadOrigin)
  if (target.origin !== config.breadOrigin.origin) return location
  if (
    target.pathname !== route.portalPath &&
    !target.pathname.startsWith(`${route.portalPath}/`)
  ) {
    return location
  }

  const incoming = new URL(requestUrl)
  const suffix = target.pathname.slice(route.portalPath.length)
  target.protocol = incoming.protocol
  target.host = incoming.host
  target.pathname = `${route.mountPath}${suffix}`
  return target.toString()
}

function proxyRequest(request, upstream, config) {
  const headers = new Headers(request.headers)
  headers.set("x-forwarded-host", config.expectedHost)
  headers.set("x-bread-base-path", config.mountPath)
  headers.set("x-bread-proxy", "cloudflare-worker-v1")
  headers.delete("cf-connecting-ip")

  return new Request(upstream, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "manual",
  })
}

async function rewriteHtml(response, config) {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("text/html")) return response

  const assetOrigin = config.breadOrigin.origin
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")

  const link = headers.get("link")
  if (link) {
    headers.set(
      "link",
      link
        .replaceAll("</_next/", `<${assetOrigin}/_next/`)
        .replaceAll("</breeze-mark.svg>", `<${assetOrigin}/breeze-mark.svg>`),
    )
  }

  const html = (await response.text())
    .replace(/(["'])\/_next\//g, `$1${assetOrigin}/_next/`)
    .replace(/(["'])\/breeze-mark\.svg(?=["'])/g, `$1${assetOrigin}/breeze-mark.svg`)

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function isSelfRedirect(location, requestUrl) {
  try {
    const target = new URL(location)
    const current = new URL(requestUrl)
    target.hash = ""
    current.hash = ""
    return target.toString() === current.toString()
  } catch {
    return false
  }
}

export default {
  async fetch(request, env) {
    const config = proxyConfig(env)
    if (!config) return new Response(CONFIG_ERROR, { status: 500 })

    const route = activeRoute(request.url, config)
    if (!route) {
      return new Response("This Worker only serves the configured Bread path.", {
        status: 404,
      })
    }
    const activeConfig = { ...config, ...route, routes: [route] }
    if (request.method === "GET" || request.method === "HEAD") {
      const legacyLocation = legacyBlogLocation(request.url, activeConfig)
      if (legacyLocation) {
        return new Response(null, {
          status: 301,
          headers: {
            location: legacyLocation,
            "x-bread-proxy": "cloudflare-worker-v1",
          },
        })
      }
    }
    const upstream = upstreamUrlFor(request.url, activeConfig)

    const upstreamResponse = await fetch(
      proxyRequest(request, upstream, activeConfig),
    )
    const response = new Response(upstreamResponse.body, upstreamResponse)
    const location = externalLocation(
      response.headers.get("location"),
      request.url,
      activeConfig,
    )
    if (location && isSelfRedirect(location, request.url)) {
      return new Response(
        "Bread returned a circular redirect. Check BREAD_ROUTES and redeploy this Worker.",
        {
          status: 502,
          headers: { "x-bread-proxy": "cloudflare-worker-v1" },
        },
      )
    }
    if (location) response.headers.set("location", location)
    response.headers.set("x-bread-proxy", "cloudflare-worker-v1")
    return rewriteHtml(response, activeConfig)
  },
}
