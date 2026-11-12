import { describe, expect, it } from "vitest"
import {
  portalCanonicalBaseUrl,
  portalCanonicalPageUrl,
} from "./canonical-url"

const base = {
  workspaceSlug: "acme",
  projectSlug: "docs",
  appUrl: "https://app.example.com",
}

describe("portalCanonicalBaseUrl", () => {
  it("prefers a saved project route across all request aliases", () => {
    expect(
      portalCanonicalBaseUrl({
        ...base,
        projectRoute: { domain: "acme.com", pathPrefix: "/manuals" },
        requestPublicBase: "https://app.example.com/p/acme/docs",
        publicKbBaseDomain: "example.app",
      }),
    ).toBe("https://acme.com/manuals")
  })

  it("uses the project slug for workspace sub-folder hosting", () => {
    expect(
      portalCanonicalBaseUrl({
        ...base,
        workspaceDomain: "acme.com",
        workspaceAddressScope: "workspace",
        workspaceAddressMode: "path",
      }),
    ).toBe("https://acme.com/docs")
  })

  it("keeps a default project at a dedicated workspace domain root", () => {
    expect(
      portalCanonicalBaseUrl({
        ...base,
        projectSlug: "acme",
        workspaceDomain: "docs.acme.com",
        workspaceAddressScope: "workspace",
        workspaceAddressMode: "domain",
      }),
    ).toBe("https://docs.acme.com")
  })

  it("uses a trusted public mount before a built-in alias", () => {
    expect(
      portalCanonicalBaseUrl({
        ...base,
        requestPublicBase: "https://customer.com/help",
        publicKbBaseDomain: "example.app",
      }),
    ).toBe("https://customer.com/help")
  })

  it("canonicalizes a direct /p alias to the wildcard public host", () => {
    expect(
      portalCanonicalBaseUrl({
        ...base,
        requestPublicBase: "https://app.example.com/p/acme/docs",
        publicKbBaseDomain: "example.app",
      }),
    ).toBe("https://acme.example.app/docs")
  })

  it("falls back to the always-on app URL", () => {
    expect(portalCanonicalBaseUrl(base)).toBe(
      "https://app.example.com/p/acme/docs",
    )
  })
})

describe("portalCanonicalPageUrl", () => {
  it("builds home, document, folder, and project-page canonicals", () => {
    const root = "https://acme.com/docs/"
    expect(portalCanonicalPageUrl(root, "home")).toBe("https://acme.com/docs")
    expect(portalCanonicalPageUrl(root, "doc", "guides/setup & install")).toBe(
      "https://acme.com/docs/doc/guides/setup%20%26%20install",
    )
    expect(portalCanonicalPageUrl(root, "folder", "folder-id")).toBe(
      "https://acme.com/docs/folder/folder-id",
    )
    expect(portalCanonicalPageUrl(root, "page", "api-reference")).toBe(
      "https://acme.com/docs/page/api-reference",
    )
  })
})
