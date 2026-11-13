import assert from "node:assert/strict"
import test from "node:test"
import {
  externalLocation,
  legacyBlogLocation,
  proxyConfig,
  upstreamUrlFor,
  default as worker,
} from "../src/index.js"

const env = {
  EXPECTED_HOST: "customer.com",
  MOUNT_PATH: "/blog",
  BREEZIFY_ORIGIN: "https://app.example.com",
  BREEZIFY_PORTAL_PATH: "/p/acme/blog",
}

test("maps the exact mount and its descendants without swallowing similar paths", () => {
  const config = proxyConfig(env)
  assert.ok(config)
  assert.equal(
    upstreamUrlFor("https://customer.com/blog", config)?.toString(),
    "https://app.example.com/p/acme/blog",
  )
  assert.equal(
    upstreamUrlFor("https://customer.com/blog/post?q=one", config)?.toString(),
    "https://app.example.com/p/acme/blog/post?q=one",
  )
  assert.equal(
    upstreamUrlFor(
      "https://customer.com/blog/_breezify/api/search?q=one",
      config,
    )?.toString(),
    "https://app.example.com/api/public/search?q=one",
  )
  assert.equal(upstreamUrlFor("https://customer.com/blogger", config), null)
  assert.equal(upstreamUrlFor("https://other.com/blog", config), null)
})

test("maps multiple workspace projects from one route bundle", () => {
  const config = proxyConfig({
    EXPECTED_HOST: "portal.northwind.test",
    BREEZIFY_ORIGIN: "https://app.example.com",
    BREEZIFY_ROUTES: JSON.stringify({
      "/manuals": "/p/northwind/developer-guide",
      "/support": "/p/northwind/customer-care",
    }),
  })
  assert.ok(config)
  assert.equal(
    upstreamUrlFor(
      "https://portal.northwind.test/manuals/doc/install",
      config,
    )?.toString(),
    "https://app.example.com/p/northwind/developer-guide/doc/install",
  )
  assert.equal(
    upstreamUrlFor("https://portal.northwind.test/support", config)?.toString(),
    "https://app.example.com/p/northwind/customer-care",
  )
  assert.equal(
    upstreamUrlFor("https://portal.northwind.test/status", config),
    null,
  )
})

test("recovers a legacy blog slug from its trailing UUID", () => {
  const config = proxyConfig(env)
  assert.ok(config)
  assert.equal(
    legacyBlogLocation(
      "https://customer.com/blog/beyond-context-windows-d03c03af-d2a6-406d-b7fc-4e72b7b2ce63?utm_source=old",
      config,
    ),
    "https://customer.com/blog/doc/d03c03af-d2a6-406d-b7fc-4e72b7b2ce63?utm_source=old",
  )
})

test("does not treat current, nested, malformed, or non-blog routes as legacy", () => {
  const config = proxyConfig(env)
  assert.ok(config)
  assert.equal(
    legacyBlogLocation(
      "https://customer.com/blog/doc/d03c03af-d2a6-406d-b7fc-4e72b7b2ce63",
      config,
    ),
    null,
  )
  assert.equal(
    legacyBlogLocation(
      "https://customer.com/blog/guides/launch-d03c03af-d2a6-406d-b7fc-4e72b7b2ce63",
      config,
    ),
    null,
  )
  assert.equal(
    legacyBlogLocation("https://customer.com/blog/launch-not-a-uuid", config),
    null,
  )

  const helpConfig = proxyConfig({ ...env, MOUNT_PATH: "/help" })
  assert.ok(helpConfig)
  assert.equal(
    legacyBlogLocation(
      "https://customer.com/help/launch-d03c03af-d2a6-406d-b7fc-4e72b7b2ce63",
      helpConfig,
    ),
    null,
  )
})

test("301s a legacy blog URL before fetching the portal", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  let fetched = false
  globalThis.fetch = async () => {
    fetched = true
    return new Response("unexpected")
  }

  const response = await worker.fetch(
    new Request(
      "https://customer.com/blog/launch-d03c03af-d2a6-406d-b7fc-4e72b7b2ce63?ref=old",
    ),
    env,
  )

  assert.equal(response.status, 301)
  assert.equal(
    response.headers.get("location"),
    "https://customer.com/blog/doc/d03c03af-d2a6-406d-b7fc-4e72b7b2ce63?ref=old",
  )
  assert.equal(fetched, false)
})

test("rewrites Breezify redirects back to the customer mount", () => {
  const config = proxyConfig(env)
  assert.ok(config)
  assert.equal(
    externalLocation(
      "https://app.example.com/p/acme/blog/doc/launch?ref=search",
      "https://customer.com/blog",
      config,
    ),
    "https://customer.com/blog/doc/launch?ref=search",
  )
  assert.equal(
    externalLocation("https://billing.example.com/checkout", "https://customer.com/blog", config),
    "https://billing.example.com/checkout",
  )
})

test("stops an upstream redirect from bouncing back to the same customer URL", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = async () =>
    new Response(null, {
      status: 307,
      headers: { location: "https://app.example.com/p/acme/blog" },
    })

  const response = await worker.fetch(
    new Request("https://customer.com/blog"),
    env,
  )

  assert.equal(response.status, 502)
  assert.match(await response.text(), /circular redirect/i)
})

test("rewrites portal assets without relying on HTMLRewriter", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = async () =>
    new Response(
      '<link href="/_next/app.css"><script src="/_next/app.js"></script><img src="/breeze-mark.svg">',
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          link: '</_next/font.woff2>; rel=preload',
        },
      },
    )

  const response = await worker.fetch(
    new Request("https://customer.com/blog"),
    env,
  )
  const html = await response.text()

  assert.match(html, /href="https:\/\/app\.example\.com\/_next\/app\.css"/)
  assert.match(html, /src="https:\/\/app\.example\.com\/_next\/app\.js"/)
  assert.match(html, /src="https:\/\/app\.example\.com\/breeze-mark\.svg"/)
  assert.match(response.headers.get("link") ?? "", /https:\/\/app\.example\.com\/_next\/font/)
})

test("rejects an incomplete or root-mount configuration", () => {
  assert.equal(proxyConfig({ ...env, MOUNT_PATH: "/" }), null)
  assert.equal(proxyConfig({ ...env, BREEZIFY_PORTAL_PATH: "/docs" }), null)
  assert.equal(proxyConfig({ ...env, EXPECTED_HOST: "" }), null)
  assert.equal(proxyConfig({ ...env, BREEZIFY_ROUTES: "not json" }), null)
})
