import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const resolveCustomDomainRoute = vi.fn()

vi.mock("@/lib/public-kb-domain", () => ({
  resolveCustomDomainRoute: (...args: unknown[]) => resolveCustomDomainRoute(...args),
}))

import {
  hostSharesAuthCookieDomain,
  sanitizePostLoginNext,
  POST_LOGIN_FALLBACK,
} from "./login-next"

describe("hostSharesAuthCookieDomain", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("is false when no cookie domain is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_COOKIE_DOMAIN", "")
    expect(hostSharesAuthCookieDomain("example.com")).toBe(false)
  })

  it("matches the apex and subdomains of the configured domain", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_COOKIE_DOMAIN", ".example.com")
    expect(hostSharesAuthCookieDomain("example.com")).toBe(true)
    expect(hostSharesAuthCookieDomain("app.example.com")).toBe(true)
    expect(hostSharesAuthCookieDomain("docs.acme.com")).toBe(false)
    expect(hostSharesAuthCookieDomain("evilexample.com")).toBe(false)
  })
})

describe("sanitizePostLoginNext", () => {
  beforeEach(() => {
    resolveCustomDomainRoute.mockReset()
    vi.stubEnv("NEXT_PUBLIC_AUTH_COOKIE_DOMAIN", ".example.com")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("passes relative app paths through", async () => {
    expect(await sanitizePostLoginNext("/p/acme/docs?q=x")).toBe("/p/acme/docs?q=x")
    expect(await sanitizePostLoginNext("/dashboard")).toBe("/dashboard")
  })

  it("rejects protocol-relative and malformed paths", async () => {
    expect(await sanitizePostLoginNext("//evil.com")).toBe(POST_LOGIN_FALLBACK)
    expect(await sanitizePostLoginNext("/\\evil.com")).toBe(POST_LOGIN_FALLBACK)
    expect(await sanitizePostLoginNext(null)).toBe(POST_LOGIN_FALLBACK)
    expect(await sanitizePostLoginNext("javascript:alert(1)")).toBe(
      POST_LOGIN_FALLBACK,
    )
  })

  it("allows an absolute URL only when it resolves to a configured portal route", async () => {
    resolveCustomDomainRoute.mockResolvedValueOnce({
      workspaceSlug: "breezify",
      projectSlug: "docs",
      pathPrefix: "/docs",
    })
    expect(await sanitizePostLoginNext("https://example.com/docs?q=x")).toBe(
      "https://example.com/docs?q=x",
    )
    expect(resolveCustomDomainRoute).toHaveBeenCalledWith("example.com", "/docs")
  })

  it("rejects absolute URLs outside the shared auth cookie domain", async () => {
    // Even a real configured customer portal domain can't see the app session,
    // so returning there would loop through /login forever.
    expect(await sanitizePostLoginNext("https://docs.acme.com/help")).toBe(
      POST_LOGIN_FALLBACK,
    )
    expect(resolveCustomDomainRoute).not.toHaveBeenCalled()
  })

  it("rejects absolute URLs entirely when no cookie domain is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_COOKIE_DOMAIN", "")
    expect(await sanitizePostLoginNext("https://example.com/docs")).toBe(
      POST_LOGIN_FALLBACK,
    )
  })

  it("rejects absolute URLs with no matching portal route", async () => {
    resolveCustomDomainRoute.mockResolvedValueOnce(null)
    expect(await sanitizePostLoginNext("https://app.example.com/docs")).toBe(
      POST_LOGIN_FALLBACK,
    )
  })

  it("rejects non-https and credentialed URLs without a route lookup", async () => {
    expect(await sanitizePostLoginNext("http://example.com/docs")).toBe(
      POST_LOGIN_FALLBACK,
    )
    expect(await sanitizePostLoginNext("https://user:pass@example.com/docs")).toBe(
      POST_LOGIN_FALLBACK,
    )
    expect(resolveCustomDomainRoute).not.toHaveBeenCalled()
  })
})
