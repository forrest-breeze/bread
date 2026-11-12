// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PORTAL_SCHEMA_VERSION, type PortalLayout } from "@/lib/portal/schema"
import { PortalThemeControls } from "./portal-theme-controls"

function layout(): PortalLayout {
  return {
    schemaVersion: PORTAL_SCHEMA_VERSION,
    theme: {
      brandName: "Acme",
      tagline: "Docs",
      logoUrl: "",
      accentColor: "#2f5520",
      navLinks: [],
      cta: null,
      font: "sans",
      appearance: "auto",
    },
    header: {
      id: "header",
      type: "portal-header",
      search: { enabled: true, placeholder: "Search or ask AI" },
    },
    body: [],
    footer: { id: "footer", type: "footer", showPoweredBy: true },
  }
}

describe("PortalThemeControls", () => {
  it("shows separate light and dark logo controls plus favicon branding", () => {
    render(
      <PortalThemeControls layout={layout()} onLayoutChange={vi.fn()} />,
    )

    expect(screen.getByLabelText("Light mode logo upload")).toBeInTheDocument()
    expect(screen.getByLabelText("Dark mode logo upload")).toBeInTheDocument()
    expect(screen.getByLabelText("Favicon upload")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Circular Logo" })).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: "Circular Favicon" }),
    ).toBeInTheDocument()
  })

  it("updates the visible logo text and keeps the internal portal name aligned", () => {
    const onLayoutChange = vi.fn()
    render(
      <PortalThemeControls layout={layout()} onLayoutChange={onLayoutChange} />,
    )

    const input = screen.getByLabelText("Logo Text")
    fireEvent.change(input, { target: { value: "" } })

    expect(input).toHaveValue("")
    expect(onLayoutChange).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: "Beta" } })
    fireEvent.blur(input)

    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    expect(onLayoutChange.mock.calls[0]?.[0].theme.brandName).toBe("Beta")
    expect(onLayoutChange.mock.calls[0]?.[0].theme.logoText).toBe("Beta")
  })

  it("allows empty logo text to hide the copy without clearing the portal name", () => {
    const onLayoutChange = vi.fn()
    render(
      <PortalThemeControls layout={layout()} onLayoutChange={onLayoutChange} />,
    )

    const input = screen.getByLabelText("Logo Text")
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.blur(input)

    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    expect(onLayoutChange.mock.calls[0]?.[0].theme.logoText).toBe("")
    expect(onLayoutChange.mock.calls[0]?.[0].theme.brandName).toBe("Acme")
  })

  it("persists the circular logo option", () => {
    const onLayoutChange = vi.fn()
    render(
      <PortalThemeControls layout={layout()} onLayoutChange={onLayoutChange} />,
    )

    fireEvent.click(screen.getByRole("switch", { name: "Circular Logo" }))

    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    expect(onLayoutChange.mock.calls[0]?.[0].theme.circularLogo).toBe(true)
  })

  it("uses the workspace logo as the default rounded favicon and can make it circular", () => {
    const onLayoutChange = vi.fn()
    render(
      <PortalThemeControls
        layout={layout()}
        onLayoutChange={onLayoutChange}
        workspaceLogoUrl="/workspace-logo.svg"
      />,
    )

    const faviconDropzone = screen.getByRole("button", {
      name: "Favicon. Click to upload.",
    })
    const inheritedFavicon = faviconDropzone.querySelector(
      'img[src="/workspace-logo.svg"]',
    )
    expect(inheritedFavicon?.parentElement).toHaveClass("rounded-xl")

    fireEvent.click(screen.getByRole("switch", { name: "Circular Favicon" }))

    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    expect(onLayoutChange.mock.calls[0]?.[0].theme.faviconShape).toBe("circle")
  })
})
