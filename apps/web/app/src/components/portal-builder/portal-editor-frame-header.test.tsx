// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildDefaultHeader, buildPortalTheme } from "@/lib/portal/build-default"
import type { PortalLayout } from "@/lib/portal/schema"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/knowledge/doc-1",
}))

import {
  navigateFromFrame,
  PortalEditorFrameHeader,
} from "./portal-editor-frame-header"

afterEach(() => {
  vi.restoreAllMocks()
})

function nav() {
  return { onOpenDocument: vi.fn(), onOpenPage: vi.fn() }
}

describe("navigateFromFrame", () => {
  it("opens docs in the editor and pages or home in the preview", () => {
    const handlers = nav()
    navigateFromFrame("/p/acme/doc/install?ref=search", handlers)
    expect(handlers.onOpenDocument).toHaveBeenCalledWith("install")

    navigateFromFrame("/p/acme/page/api", handlers)
    expect(handlers.onOpenPage).toHaveBeenLastCalledWith("api")

    navigateFromFrame("/portal-preview?slug=acme&page=changelog", handlers)
    expect(handlers.onOpenPage).toHaveBeenLastCalledWith("changelog")

    navigateFromFrame("/p/acme", handlers)
    expect(handlers.onOpenPage).toHaveBeenLastCalledWith(null)
  })

  it("opens off-site links in a new tab instead of leaving the builder", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    const handlers = nav()
    navigateFromFrame("https://example.com/pricing", handlers)
    expect(open).toHaveBeenCalledWith(
      "https://example.com/pricing",
      "_blank",
      "noopener,noreferrer",
    )
    expect(handlers.onOpenDocument).not.toHaveBeenCalled()
    expect(handlers.onOpenPage).not.toHaveBeenCalled()
  })
})

describe("PortalEditorFrameHeader", () => {
  it("keeps header items clickable and routes them inside the builder", () => {
    const handlers = nav()
    const onAppearanceChange = vi.fn()
    const theme = buildPortalTheme({
      id: "ws-1",
      iconUrl: "",
      websiteUrl: null,
      branding: { name: "Acme", tagline: "", logoUrl: "", accentColor: "#2563eb" },
    } as unknown as Parameters<typeof buildPortalTheme>[0])
    const layout = {
      theme,
      header: buildDefaultHeader(),
      pages: [],
    } as unknown as PortalLayout

    render(
      <PortalEditorFrameHeader
        layout={layout}
        previewSlug="acme"
        appearance="light"
        onAppearanceChange={onAppearanceChange}
        {...handlers}
      />,
    )

    const frame = screen.getByTestId("portal-editor-frame-header")
    expect(frame.className).not.toContain("pointer-events-none")

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }))
    expect(onAppearanceChange).toHaveBeenCalledWith("dark")

    const brand = frame.querySelector("a[href]")
    expect(brand).not.toBeNull()
    fireEvent.click(brand!)
    expect(handlers.onOpenPage).toHaveBeenCalled()
  })
})
