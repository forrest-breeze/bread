import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  absoluteOAuthReturnUrl,
  appendOAuthResult,
  sanitizeOAuthReturnPath,
} from "./oauth-return"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("sanitizeOAuthReturnPath", () => {
  it("allows settings and portal-builder paths, and no longer /onboarding", () => {
    expect(sanitizeOAuthReturnPath("/onboarding?step=integration", "/fallback")).toBe(
      "/fallback",
    )
    expect(sanitizeOAuthReturnPath("/settings/integrations/slack", "/fallback")).toBe(
      "/settings/integrations/slack",
    )
    expect(sanitizeOAuthReturnPath("/settings?tab=workspace", "/fallback")).toBe(
      "/settings?tab=workspace",
    )
    expect(sanitizeOAuthReturnPath("/kb?project=docs", "/fallback")).toBe(
      "/kb?project=docs",
    )
  })

  it("rejects external, protocol-relative, and unrelated paths", () => {
    expect(sanitizeOAuthReturnPath("https://evil.example/onboarding", "/fallback")).toBe(
      "/fallback",
    )
    expect(sanitizeOAuthReturnPath("//evil.example/onboarding", "/fallback")).toBe(
      "/fallback",
    )
    expect(sanitizeOAuthReturnPath("/admin", "/fallback")).toBe("/fallback")
  })
})

describe("appendOAuthResult", () => {
  it("preserves existing query params and appends the result", () => {
    expect(
      appendOAuthResult("/settings/integrations?step=integration&integration=slack", {
        connected: "1",
      }),
    ).toBe("/settings/integrations?step=integration&integration=slack&connected=1")
  })
})

describe("absoluteOAuthReturnUrl", () => {
  it("uses NEXT_PUBLIC_APP_URL outside development", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.dev")
    vi.stubEnv("NODE_ENV", "production")

    expect(
      absoluteOAuthReturnUrl(
        new NextRequest("http://localhost:3001/api/oauth/callback"),
        "/settings",
      ),
    ).toBe("https://app.example.dev/settings")
  })

  it("uses the request origin in development", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.dev")
    vi.stubEnv("NODE_ENV", "development")

    expect(
      absoluteOAuthReturnUrl(
        new NextRequest("http://localhost:3001/api/oauth/callback"),
        "/onboarding",
      ),
    ).toBe("http://localhost:3001/onboarding")
  })
})
