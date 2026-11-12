import { afterEach, describe, expect, it, vi } from "vitest"
import {
  HANDLE_MAX_LENGTH,
  RESERVED_HANDLES,
  handleErrorMessage,
  isReservedHandle,
  normalizeHandle,
  publicKbBaseDomain,
  validateHandle,
} from "./public-kb-handle"

describe("validateHandle", () => {
  it("accepts a simple lowercase handle", () => {
    expect(validateHandle("acme")).toEqual({ handle: "acme", error: null })
  })

  it("lowercases and trims", () => {
    expect(validateHandle("  Acme  ")).toEqual({ handle: "acme", error: null })
  })

  it("accepts internal hyphens and digits", () => {
    expect(validateHandle("acme-corp-2")).toEqual({
      handle: "acme-corp-2",
      error: null,
    })
  })

  it("treats empty / whitespace as a clear (null, no error)", () => {
    expect(validateHandle("")).toEqual({ handle: null, error: null })
    expect(validateHandle("   ")).toEqual({ handle: null, error: null })
    expect(validateHandle(null)).toEqual({ handle: null, error: null })
    expect(validateHandle(undefined)).toEqual({ handle: null, error: null })
  })

  it("rejects too-short handles", () => {
    expect(validateHandle("a").error).toBe("too_short")
  })

  it("rejects handles longer than the DNS label limit", () => {
    expect(validateHandle("a".repeat(HANDLE_MAX_LENGTH + 1)).error).toBe(
      "too_long",
    )
    // Exactly at the limit is allowed.
    expect(validateHandle("a".repeat(HANDLE_MAX_LENGTH)).handle).toHaveLength(
      HANDLE_MAX_LENGTH,
    )
  })

  it("rejects uppercase that survives... (none — it is lowercased) but rejects bad chars", () => {
    expect(validateHandle("acme_corp").error).toBe("invalid_chars")
    expect(validateHandle("acme.corp").error).toBe("invalid_chars")
    expect(validateHandle("acme corp").error).toBe("invalid_chars")
    expect(validateHandle("acmé").error).toBe("invalid_chars")
  })

  it("rejects leading or trailing hyphens", () => {
    expect(validateHandle("-acme").error).toBe("invalid_chars")
    expect(validateHandle("acme-").error).toBe("invalid_chars")
  })

  it("rejects reserved handles (and is case-insensitive about it)", () => {
    expect(validateHandle("app").error).toBe("reserved")
    expect(validateHandle("WWW").error).toBe("reserved")
    expect(validateHandle("api").error).toBe("reserved")
  })

  it("normalizeHandle returns just the handle or null", () => {
    expect(normalizeHandle("Acme")).toBe("acme")
    expect(normalizeHandle("app")).toBeNull()
    expect(normalizeHandle("")).toBeNull()
  })
})

describe("RESERVED_HANDLES / isReservedHandle", () => {
  it("includes the app host label and common infra subdomains", () => {
    for (const r of ["app", "www", "api", "mail", "admin", "docs"]) {
      expect(RESERVED_HANDLES.has(r)).toBe(true)
    }
  })

  it("isReservedHandle is case-insensitive", () => {
    expect(isReservedHandle("App")).toBe(true)
    expect(isReservedHandle("acme")).toBe(false)
  })
})

describe("handleErrorMessage", () => {
  it("maps each reason to non-empty copy", () => {
    for (const r of ["too_short", "too_long", "invalid_chars", "reserved"] as const) {
      expect(handleErrorMessage(r).length).toBeGreaterThan(0)
    }
  })
})

describe("publicKbBaseDomain", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("returns null when the base domain is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN", "")
    expect(publicKbBaseDomain()).toBeNull()
  })

  it("normalizes a configured base domain (scheme/port/path stripped)", () => {
    vi.stubEnv("NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN", "https://Example.com:443/")
    expect(publicKbBaseDomain()).toBe("example.com")
  })
})
