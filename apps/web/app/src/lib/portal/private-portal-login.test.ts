import { describe, expect, it } from "vitest"
import {
  isPrivatePortalLogin,
  privatePortalLoginHref,
  PRIVATE_PORTAL_LOGIN_CONTEXT,
} from "./private-portal-login"

describe("private portal login context", () => {
  it("preserves the portal return path and marks the login context", () => {
    expect(privatePortalLoginHref("/p/acme/help?q=setup", "acme")).toBe(
      "/login?next=%2Fp%2Facme%2Fhelp%3Fq%3Dsetup&context=private-portal",
    )
  })

  it("passes a custom-domain public URL through and targets the app origin", () => {
    // The absolute next is only ever built server-side (portalPublicNextPath)
    // and is re-validated against the domain-routes table on consumption.
    const appOrigin = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "")
    expect(privatePortalLoginHref("https://example.com/docs", "acme")).toBe(
      `${appOrigin}/login?next=https%3A%2F%2Fexample.com%2Fdocs&context=private-portal`,
    )
  })

  it("falls back to the portal root for an unsafe return path", () => {
    expect(privatePortalLoginHref("javascript:alert(1)", "acme")).toBe(
      "/login?next=%2Fp%2Facme&context=private-portal",
    )
    expect(privatePortalLoginHref("http://example.com/docs", "acme")).toBe(
      "/login?next=%2Fp%2Facme&context=private-portal",
    )
  })

  it("requires both the context marker and a portal return path", () => {
    expect(isPrivatePortalLogin(PRIVATE_PORTAL_LOGIN_CONTEXT, "/p/acme")).toBe(true)
    expect(
      isPrivatePortalLogin(PRIVATE_PORTAL_LOGIN_CONTEXT, "https://example.com/docs"),
    ).toBe(true)
    expect(isPrivatePortalLogin(PRIVATE_PORTAL_LOGIN_CONTEXT, "/dashboard")).toBe(false)
    expect(isPrivatePortalLogin(null, "/p/acme")).toBe(false)
  })
})
