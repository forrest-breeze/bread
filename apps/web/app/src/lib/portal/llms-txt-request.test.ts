import { describe, expect, it } from "vitest"
import {
  normalizePortalMountPath,
  parsePortalLlmsPath,
  portalLlmsApiSearch,
  portalLlmsFilename,
  resolvePortalPublicUrl,
} from "./llms-txt-request"

// ---------------------------------------------------------------------------
// The portal llms.txt files are addressed at the visitor's mount and served by
// an API route. Two things must hold:
//   • path parsing never steals a real document path (a doc slugged
//     "llms.txt" still renders as a document),
//   • the emitted links use the PUBLIC mount, not the internal /p/ address —
//     a custom-domain portal that advertised /p/<slug> links would be broken.
// ---------------------------------------------------------------------------

function headers(values: Record<string, string>): { get(n: string): string | null } {
  const lower = new Map(
    Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return { get: (name) => lower.get(name.toLowerCase()) ?? null }
}

describe("parsePortalLlmsPath", () => {
  it("parses the workspace-root form", () => {
    expect(parsePortalLlmsPath("/p/acme/llms.txt")).toEqual({
      base: "acme",
      variant: "index",
    })
  })

  it("parses the named-project form", () => {
    expect(parsePortalLlmsPath("/p/acme/help/llms.txt")).toEqual({
      base: "acme/help",
      variant: "index",
    })
  })

  it("parses the full variant", () => {
    expect(parsePortalLlmsPath("/p/acme/help/llms-full.txt")).toEqual({
      base: "acme/help",
      variant: "full",
    })
  })

  it("is case-insensitive on the filename", () => {
    expect(parsePortalLlmsPath("/p/acme/LLMS.TXT")?.variant).toBe("index")
  })

  it.each([
    "/p/acme/doc/llms.txt",
    "/p/acme/help/doc/llms.txt",
    "/p/acme/folder/llms.txt",
  ])("never claims the document/folder path %s", (path) => {
    expect(parsePortalLlmsPath(path)).toBeNull()
  })

  it.each([
    "/llms.txt",
    "/p/llms.txt",
    "/p/acme/help/extra/llms.txt",
    "/p/acme/help",
    "/p/acme/robots.txt",
  ])("returns null for %s", (path) => {
    expect(parsePortalLlmsPath(path)).toBeNull()
  })
})

describe("portalLlmsApiSearch", () => {
  it("passes the base through as the portal param", () => {
    expect(portalLlmsApiSearch({ base: "acme/help", variant: "index" })).toBe(
      "portal=acme%2Fhelp",
    )
  })

  it("marks the full variant explicitly", () => {
    expect(portalLlmsApiSearch({ base: "acme", variant: "full" })).toBe(
      "portal=acme&variant=full",
    )
  })
})

describe("portalLlmsFilename", () => {
  it("round-trips both variants through the parser", () => {
    for (const variant of ["index", "full"] as const) {
      expect(
        parsePortalLlmsPath(`/p/acme/${portalLlmsFilename(variant)}`)?.variant,
      ).toBe(variant)
    }
  })
})

describe("normalizePortalMountPath", () => {
  it.each([
    ["/help/", "/help"],
    ["//help//guides//", "/help/guides"],
    ["/", "/"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizePortalMountPath(input)).toBe(expected)
  })

  it.each(["", "help", undefined, null, "/p/acme/help"])(
    "rejects %s as a public mount",
    (input) => {
      expect(normalizePortalMountPath(input)).toBeNull()
    },
  )
})

describe("resolvePortalPublicUrl", () => {
  it("uses the internal /p path when there is no mount metadata", () => {
    expect(
      resolvePortalPublicUrl(headers({ host: "app.example.com" }), "acme/help"),
    ).toBe("https://app.example.com/p/acme/help")
  })

  it("treats a host-root mount as the bare origin", () => {
    expect(
      resolvePortalPublicUrl(
        headers({
          host: "help.acme.com",
          "x-breezify-portal-host": "help.acme.com",
          "x-breezify-portal-mount-path": "/",
        }),
        "acme/help",
      ),
    ).toBe("https://help.acme.com")
  })

  it("uses the Worker's forwarded host and mount path", () => {
    expect(
      resolvePortalPublicUrl(
        headers({
          host: "app.example.com",
          "x-breezify-proxy": "cloudflare-worker-v1",
          "x-forwarded-host": "acme.com",
          "x-breezify-base-path": "/help",
        }),
        "acme/help",
      ),
    ).toBe("https://acme.com/help")
  })

  it("ignores a forwarded host that arrives without a trusted proxy marker", () => {
    expect(
      resolvePortalPublicUrl(
        headers({ host: "app.example.com", "x-forwarded-host": "evil.example" }),
        "acme",
      ),
    ).toBe("https://app.example.com/p/acme")
  })

  it("keeps the port and http scheme on localhost", () => {
    expect(
      resolvePortalPublicUrl(headers({ host: "localhost:3001" }), "acme"),
    ).toBe("http://localhost:3001/p/acme")
  })

  it("honors x-forwarded-proto", () => {
    expect(
      resolvePortalPublicUrl(
        headers({ host: "help.acme.com", "x-forwarded-proto": "http, https" }),
        "acme",
      ),
    ).toBe("http://help.acme.com/p/acme")
  })
})
