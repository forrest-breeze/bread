import { describe, expect, it } from "vitest"
import { portalProjectUrl } from "./project-url"

const base = {
  origin: "https://app.example.com",
  workspaceSlug: "acme",
  projectSlug: "docs",
  isDefault: false,
}

describe("portalProjectUrl", () => {
  it("builds the built-in Bread project URL", () => {
    expect(portalProjectUrl(base)).toBe("https://app.example.com/p/acme/docs")
  })

  it("uses the workspace custom domain and project suffix", () => {
    expect(
      portalProjectUrl({ ...base, workspaceDomain: "help.acme.com" }),
    ).toBe("https://help.acme.com/docs")
  })

  it("keeps the default project at the workspace custom-domain root", () => {
    expect(
      portalProjectUrl({
        ...base,
        projectSlug: "acme",
        isDefault: true,
        workspaceDomain: "help.acme.com",
      }),
    ).toBe("https://help.acme.com")
  })

  it("uses a project-owned dedicated domain", () => {
    expect(
      portalProjectUrl({
        ...base,
        projectRoute: { domain: "docs.acme.com", pathPrefix: "/" },
      }),
    ).toBe("https://docs.acme.com")
  })

  it("uses a project-owned custom sub-folder", () => {
    expect(
      portalProjectUrl({
        ...base,
        projectRoute: { domain: "acme.com", pathPrefix: "/docs" },
      }),
    ).toBe("https://acme.com/docs")
  })

  it("returns a relative built-in URL before the browser origin is available", () => {
    expect(portalProjectUrl({ ...base, origin: "" })).toBe("/p/acme/docs")
  })
})
