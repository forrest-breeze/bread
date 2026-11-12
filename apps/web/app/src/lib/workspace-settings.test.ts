import { describe, it, expect, afterEach } from "vitest"
import {
  DEFAULT_INGESTION_APPROVAL_MODE,
  DEFAULT_KB_BRAND_ACCENT,
  DEFAULT_PORTAL_CHROME_SCOPE,
  getAllowedDomains,
  getKbBranding,
  getIngestionApprovalMode,
  getPortalAddressMode,
  getPortalAddressScope,
  getPortalChromeScope,
  getLandingPageUrl,
  normalizeKbBrandAccent,
  normalizeKbBrandLogoUrl,
  normalizeLandingPageUrl,
  normalizeWorkspaceSettings,
  validateCustomDomain,
  validatePortalRouteDomain,
  customDomainErrorMessage,
  customDomainDnsRecord,
  portalCnameTarget,
} from "@/lib/workspace-settings"

describe("getIngestionApprovalMode", () => {
  it("returns the default 'smart' when settings are null", () => {
    expect(getIngestionApprovalMode(null)).toBe(DEFAULT_INGESTION_APPROVAL_MODE)
    expect(getIngestionApprovalMode(undefined)).toBe(DEFAULT_INGESTION_APPROVAL_MODE)
  })

  it("returns 'always_review' only when explicitly set", () => {
    expect(getIngestionApprovalMode({ ingestion_approval_mode: "always_review" })).toBe(
      "always_review",
    )
  })

  it("ignores unknown modes and falls back to the default", () => {
    expect(
      getIngestionApprovalMode({ ingestion_approval_mode: "never" as unknown as string }),
    ).toBe("smart")
  })
})

describe("getAllowedDomains", () => {
  it("returns an empty array when allowed_domains is missing or non-array", () => {
    expect(getAllowedDomains(null)).toEqual([])
    expect(getAllowedDomains({})).toEqual([])
    expect(getAllowedDomains({ allowed_domains: "example.com" })).toEqual([])
  })

  it("trims, lowercases, and deduplicates valid domains", () => {
    expect(
      getAllowedDomains({
        allowed_domains: ["Example.com", "example.com", "  ACME.co  "],
      }),
    ).toEqual(["example.com", "acme.co"])
  })

  it("rejects entries without a TLD", () => {
    expect(
      getAllowedDomains({ allowed_domains: ["localhost", "no-tld", "valid.io"] }),
    ).toEqual(["valid.io"])
  })

  it("drops empty strings and non-strings", () => {
    expect(
      getAllowedDomains({
        allowed_domains: ["", "  ", 42, null, "good.com"],
      }),
    ).toEqual(["good.com"])
  })
})

describe("getPortalChromeScope", () => {
  it("defaults to shared workspace header/footer", () => {
    expect(getPortalChromeScope(null)).toBe(DEFAULT_PORTAL_CHROME_SCOPE)
    expect(getPortalChromeScope({})).toBe("workspace")
  })

  it("returns project only when explicitly configured", () => {
    expect(getPortalChromeScope({ portal_chrome_scope: "project" })).toBe("project")
    expect(getPortalChromeScope({ portal_chrome_scope: "workspace" })).toBe("workspace")
  })

  it("ignores unknown values", () => {
    expect(getPortalChromeScope({ portal_chrome_scope: "team" })).toBe("workspace")
  })
})

describe("portal address ownership", () => {
  it("preserves legacy workspace-level URL configuration", () => {
    expect(getPortalAddressScope({ kb_custom_domain: "docs.acme.com" })).toBe(
      "workspace",
    )
    expect(getPortalAddressMode({ kb_custom_domain: "docs.acme.com" })).toBe(
      "domain",
    )
    expect(getPortalAddressScope({})).toBe("workspace")
    expect(getPortalAddressMode({})).toBe("bread")
  })

  it("returns explicit scope and hosting mode values", () => {
    expect(getPortalAddressScope({ portal_address_scope: "workspace" })).toBe(
      "workspace",
    )
    expect(getPortalAddressScope({ portal_address_scope: "project" })).toBe(
      "project",
    )
    expect(getPortalAddressMode({ portal_address_mode: "path" })).toBe("path")
    expect(getPortalAddressMode({ portal_address_mode: "bread" })).toBe(
      "bread",
    )
  })
})

describe("normalizeWorkspaceSettings", () => {
  it("returns a populated object when input is null", () => {
    const normalized = normalizeWorkspaceSettings(null)
    expect(normalized.ingestion_approval_mode).toBe("smart")
    expect(normalized.allowed_domains).toEqual([])
    expect(normalized.portal_chrome_scope).toBe("workspace")
  })

  it("preserves other fields present on the input", () => {
    const normalized = normalizeWorkspaceSettings({
      ingestion_approval_mode: "always_review",
      allowed_domains: ["Example.com"],
      some_other_flag: true,
    })
    expect(normalized.ingestion_approval_mode).toBe("always_review")
    expect(normalized.allowed_domains).toEqual(["example.com"])
    expect((normalized as Record<string, unknown>).some_other_flag).toBe(true)
  })

  it("replaces an invalid allowed_domains with an empty array", () => {
    const normalized = normalizeWorkspaceSettings({ allowed_domains: "oops" })
    expect(normalized.allowed_domains).toEqual([])
  })

  it("normalizes the portal header/footer scope", () => {
    expect(
      normalizeWorkspaceSettings({ portal_chrome_scope: "project" }).portal_chrome_scope,
    ).toBe("project")
    expect(
      normalizeWorkspaceSettings({ portal_chrome_scope: "invalid" }).portal_chrome_scope,
    ).toBe("workspace")
  })

  it("falls back to defaults when input is not an object", () => {
    const normalized = normalizeWorkspaceSettings("not an object")
    expect(normalized.ingestion_approval_mode).toBe("smart")
    expect(normalized.allowed_domains).toEqual([])
  })

  it("normalizes public KB branding fields", () => {
    const normalized = normalizeWorkspaceSettings({
      kb_brand_name: "  Acme Docs  ",
      kb_brand_tagline: "  Engineering   runbooks  ",
      kb_brand_logo_url: "https://cdn.example.com/logo.png",
      kb_brand_accent: "#0F6",
    })

    expect(normalized.kb_brand_name).toBe("Acme Docs")
    expect(normalized.kb_brand_tagline).toBe("Engineering runbooks")
    expect(normalized.kb_brand_logo_url).toBe("https://cdn.example.com/logo.png")
    expect(normalized.kb_brand_accent).toBe("#00ff66")
  })

  it("drops invalid public KB branding values", () => {
    const normalized = normalizeWorkspaceSettings({
      kb_brand_name: " ",
      kb_brand_logo_url: "javascript:alert(1)",
      kb_brand_accent: "green",
    })

    expect(normalized.kb_brand_name).toBeUndefined()
    expect(normalized.kb_brand_logo_url).toBeUndefined()
    expect(normalized.kb_brand_accent).toBeUndefined()
  })
})

describe("public KB branding helpers", () => {
  it("normalizes hex colors", () => {
    expect(normalizeKbBrandAccent("#ABC")).toBe("#aabbcc")
    expect(normalizeKbBrandAccent("#123456")).toBe("#123456")
    expect(normalizeKbBrandAccent("123456")).toBe("")
  })

  it("allows app-relative and http logo URLs only", () => {
    expect(normalizeKbBrandLogoUrl("/logo.svg")).toBe("/logo.svg")
    expect(normalizeKbBrandLogoUrl("https://example.com/logo.svg")).toBe(
      "https://example.com/logo.svg",
    )
    expect(normalizeKbBrandLogoUrl("//example.com/logo.svg")).toBe("")
    expect(normalizeKbBrandLogoUrl("data:image/svg+xml;base64,abc")).toBe("")
  })

  it("falls back to workspace branding defaults", () => {
    expect(getKbBranding({}, "Acme").name).toBe("Acme")
    expect(getKbBranding({}, "Acme").accentColor).toBe(DEFAULT_KB_BRAND_ACCENT)
    expect(getKbBranding({}, "Acme", "/icon.png").logoUrl).toBe("/icon.png")
  })
})

describe("normalizeLandingPageUrl", () => {
  it("assumes https for a bare host and strips a trailing slash", () => {
    expect(normalizeLandingPageUrl("acme.com")).toBe("https://acme.com")
    expect(normalizeLandingPageUrl("https://acme.com/")).toBe("https://acme.com")
  })

  it("keeps an explicit scheme and path", () => {
    expect(normalizeLandingPageUrl("http://acme.com/welcome")).toBe(
      "http://acme.com/welcome",
    )
  })

  it("rejects non-http(s) schemes, bare words, and empty input", () => {
    expect(normalizeLandingPageUrl("javascript:alert(1)")).toBe("")
    expect(normalizeLandingPageUrl("localhost")).toBe("")
    expect(normalizeLandingPageUrl("not a url")).toBe("")
    expect(normalizeLandingPageUrl("   ")).toBe("")
    expect(normalizeLandingPageUrl(undefined)).toBe("")
  })

  it("round-trips through normalizeWorkspaceSettings, dropping invalid input", () => {
    expect(
      normalizeWorkspaceSettings({ landing_page_url: "acme.com" }).landing_page_url,
    ).toBe("https://acme.com")
    expect(
      normalizeWorkspaceSettings({ landing_page_url: "nope" }).landing_page_url,
    ).toBeUndefined()
    expect(getLandingPageUrl({ landing_page_url: "https://acme.com" })).toBe(
      "https://acme.com",
    )
  })
})

describe("validateCustomDomain", () => {
  const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL
  const ORIGINAL_BASE = process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL
    process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN = ORIGINAL_BASE
  })

  it("treats empty / whitespace / non-string as 'clear the domain'", () => {
    expect(validateCustomDomain("")).toEqual({ domain: "", error: null })
    expect(validateCustomDomain("   ")).toEqual({ domain: "", error: null })
    expect(validateCustomDomain(undefined)).toEqual({ domain: "", error: null })
    expect(validateCustomDomain(null)).toEqual({ domain: "", error: null })
  })

  it("accepts and normalizes a valid bare host", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com"
    process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN = "example.com"
    expect(validateCustomDomain("DOCS.Acme.com")).toEqual({
      domain: "docs.acme.com",
      error: null,
    })
    // Tolerates a pasted URL with scheme + path + trailing dot.
    expect(validateCustomDomain("https://docs.acme.com./guide")).toEqual({
      domain: "docs.acme.com",
      error: null,
    })
  })

  it("rejects malformed input as invalid_format", () => {
    expect(validateCustomDomain("not a domain").error).toBe("invalid_format")
    expect(validateCustomDomain("*.acme.com").error).toBe("invalid_format")
    expect(validateCustomDomain("acme").error).toBe("invalid_format")
    expect(validateCustomDomain("-acme.com").error).toBe("invalid_format")
  })

  it("strips a pasted scheme + port rather than rejecting (URL tolerance)", () => {
    // normalizeCustomDomain peels scheme/port/path off a pasted URL, so the
    // bare host that survives is accepted — matching the input the proxy sees.
    expect(validateCustomDomain("http://acme.com:8080/path")).toEqual({
      domain: "acme.com",
      error: null,
    })
  })

  it("rejects the app's own host and its subdomains", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com"
    delete process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN
    expect(validateCustomDomain("app.example.com").error).toBe("own_host")
    expect(validateCustomDomain("api.app.example.com").error).toBe("own_host")
  })

  it("rejects the public-KB base domain and its subdomains", () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN = "example.com"
    expect(validateCustomDomain("example.com").error).toBe("reserved_base")
    expect(validateCustomDomain("acme.example.com").error).toBe("reserved_base")
  })

  it("rejects obvious infra / placeholder hosts", () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN
    expect(validateCustomDomain("example.com").error).toBe("infra_host")
    expect(validateCustomDomain("myapp.vercel.app").error).toBe("infra_host")
    expect(validateCustomDomain("kb.supabase.co").error).toBe("infra_host")
  })

  it("grandfathers the workspace's already-saved domain past policy checks", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com"
    process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN = "example.com"
    // The dogfood workspace holds the KB apex itself — re-validating its own
    // saved domain must not flag it as reserved.
    expect(validateCustomDomain("example.com", "example.com")).toEqual({
      domain: "example.com",
      error: null,
    })
    // Normalization applies to both sides.
    expect(validateCustomDomain("https://Example.com/", "example.com")).toEqual({
      domain: "example.com",
      error: null,
    })
    // A *different* reserved domain is still rejected.
    expect(validateCustomDomain("acme.example.com", "example.com").error).toBe(
      "reserved_base",
    )
    // Grandfathering never rescues malformed input.
    expect(validateCustomDomain("not a domain", "example.com").error).toBe(
      "invalid_format",
    )
  })

  it("has user-facing copy for every error reason", () => {
    for (const reason of [
      "invalid_format",
      "own_host",
      "reserved_base",
      "infra_host",
    ] as const) {
      expect(customDomainErrorMessage(reason).length).toBeGreaterThan(0)
    }
  })
})

describe("validatePortalRouteDomain", () => {
  const ORIGINAL_BASE = process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN

  afterEach(() => {
    process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN = ORIGINAL_BASE
  })

  it("allows the public-KB apex for a path-mounted project", () => {
    process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN = "example.com"
    expect(validatePortalRouteDomain("example.com", true)).toEqual({
      domain: "example.com",
      error: null,
    })
  })

  it("keeps the public-KB apex reserved for a dedicated project domain", () => {
    process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN = "example.com"
    expect(validatePortalRouteDomain("example.com", false).error).toBe(
      "reserved_base",
    )
  })

  it("does not allow a built-in subdomain in either mode", () => {
    process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN = "example.com"
    expect(validatePortalRouteDomain("docs.example.com", true).error).toBe(
      "reserved_base",
    )
  })

  it("grandfathers the route's already-saved domain in either mode", () => {
    process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN = "example.com"
    expect(
      validatePortalRouteDomain("example.com", false, "example.com"),
    ).toEqual({ domain: "example.com", error: null })
    // A different reserved host is still rejected even with a saved domain.
    expect(
      validatePortalRouteDomain("docs.example.com", true, "example.com").error,
    ).toBe("reserved_base")
  })
})

describe("customDomainDnsRecord / portalCnameTarget", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_PORTAL_CNAME_TARGET
  })

  it("derives the subdomain label as the record host", () => {
    process.env.NEXT_PUBLIC_PORTAL_CNAME_TARGET = "app.example.com"
    const record = customDomainDnsRecord("help.acme.com")
    expect(record).toEqual({
      type: "CNAME",
      host: "help",
      target: "app.example.com",
      isApex: false,
    })
  })

  it("keeps multi-label subdomains intact", () => {
    expect(customDomainDnsRecord("docs.support.acme.com")?.host).toBe(
      "docs.support",
    )
  })

  it("marks a bare apex with host '@' and isApex", () => {
    const record = customDomainDnsRecord("acme.com")
    expect(record?.host).toBe("@")
    expect(record?.isApex).toBe(true)
  })

  it("tolerates pasted URLs and trailing dots", () => {
    expect(customDomainDnsRecord("https://help.acme.com/")?.host).toBe("help")
  })

  it("returns null for an invalid domain", () => {
    expect(customDomainDnsRecord("")).toBeNull()
    expect(customDomainDnsRecord("notadomain")).toBeNull()
  })

  it("uses the configured CNAME target when set", () => {
    process.env.NEXT_PUBLIC_PORTAL_CNAME_TARGET = "cname.example.com"
    expect(portalCnameTarget()).toBe("cname.example.com")
    expect(customDomainDnsRecord("help.acme.com")?.target).toBe("cname.example.com")
  })

  it("is empty when unset (no fallback host)", () => {
    delete process.env.NEXT_PUBLIC_PORTAL_CNAME_TARGET
    expect(portalCnameTarget()).toBe("")
  })
})
