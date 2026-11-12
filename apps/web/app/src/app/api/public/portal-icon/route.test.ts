import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { NextRequest } from "next/server"
import type { ReactElement } from "react"

const mocks = vi.hoisted(() => ({ requirePortal: vi.fn(), render: vi.fn() }))
vi.mock("@/lib/public-kb-route", () => ({ requirePortal: mocks.requirePortal }))
vi.mock("next/og", () => ({
  ImageResponse: class extends Response {
    constructor(element: ReactElement, options: ResponseInit) {
      super("image", options)
      mocks.render(element)
    }
  },
}))
import { GET } from "./route"

const request = () => new NextRequest("https://app.example.com/api/public/portal-icon?workspace=acme&project=docs")
let portal: {
  workspace: { name: string; branding: { logoUrl: string; accentColor: string }; iconUrl: string }
  layout: { theme: Record<string, string> }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://storage.example.com")
  portal = {
    workspace: { name: "Acme", branding: { logoUrl: "", accentColor: "#000000" }, iconUrl: "" },
    layout: { theme: {} },
  }
  mocks.requirePortal.mockResolvedValue(portal)
})
afterEach(() => vi.unstubAllEnvs())

describe("portal favicon", () => {
  it("uses an external workspace logo instead of a letter placeholder", async () => {
    portal.workspace.branding.logoUrl = "https://cdn.example.com/logo.svg"
    const response = await GET(request())
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("https://cdn.example.com/logo.svg")
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it("honors an external favicon override ahead of an uploaded workspace logo", async () => {
    portal.layout.theme.faviconUrl = "https://cdn.example.com/favicon.ico"
    portal.workspace.branding.logoUrl = "https://storage.example.com/storage/v1/object/public/assets/logo.png"
    expect((await GET(request())).headers.get("location")).toBe("https://cdn.example.com/favicon.ico")
  })

  it.each(["logoUrl", "darkLogoUrl"])("falls back to the project %s", async (field) => {
    portal.layout.theme[field] = "https://cdn.example.com/project.png"
    expect((await GET(request())).headers.get("location")).toBe("https://cdn.example.com/project.png")
  })

  it("still renders uploaded logos with the configured crop", async () => {
    const logo = "https://storage.example.com/storage/v1/object/public/assets/logo.png"
    portal.workspace.branding.logoUrl = logo
    portal.layout.theme.faviconShape = "circle"
    await GET(request())
    const element = mocks.render.mock.calls[0][0]
    expect(element.props.children.props.src).toBe(logo)
    expect(element.props.style.borderRadius).toBe("50%")
  })

  it("uses a letter when no usable logo exists", async () => {
    portal.layout.theme.faviconUrl = "javascript:alert(1)"
    portal.workspace.branding.logoUrl = "invalid"
    await GET(request())
    expect(mocks.render.mock.calls[0][0].props.children).toBe("A")
  })

  it("preserves portal access checks", async () => {
    mocks.requirePortal.mockRejectedValue(new Error("not found"))
    await expect(GET(request())).rejects.toThrow("not found")
    expect(mocks.render).not.toHaveBeenCalled()
  })
})
