// @vitest-environment jsdom

import React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { PORTAL_SCHEMA_VERSION, type PortalLayout } from "@/lib/portal/schema"
import { PortalLanguageControls } from "./portal-language-controls"

const layout: PortalLayout = {
  schemaVersion: PORTAL_SCHEMA_VERSION,
  theme: {
    brandName: "Acme",
    tagline: "",
    logoUrl: "",
    accentColor: "#334455",
    navLinks: [],
    cta: null,
    font: "sans",
    appearance: "light",
  },
  header: {
    id: "header",
    type: "portal-header",
    search: { enabled: true, placeholder: "Search" },
  },
  body: [],
}

describe("PortalLanguageControls", () => {
  it("places the selector to the right of the logo for a project header", async () => {
    const onLayoutChange = vi.fn()
    const onSharedLayoutChange = vi.fn()
    render(
      <PortalLanguageControls
        layout={layout}
        onLayoutChange={onLayoutChange}
        onSharedLayoutChange={onSharedLayoutChange}
        chromeScope="project"
        canUseTranslations={false}
      />,
    )

    expect(screen.getByRole("button", { name: "Far right" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await userEvent.click(screen.getByRole("button", { name: "Right of logo" }))

    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    expect(onSharedLayoutChange).not.toHaveBeenCalled()
    const next = onLayoutChange.mock.calls[0]?.[0] as PortalLayout
    expect(next.header.languagePlacement).toBe("brand")
  })

  it("saves selector placement through the shared workspace header", async () => {
    const onLayoutChange = vi.fn()
    const onSharedLayoutChange = vi.fn()
    render(
      <PortalLanguageControls
        layout={layout}
        onLayoutChange={onLayoutChange}
        onSharedLayoutChange={onSharedLayoutChange}
        chromeScope="workspace"
        canUseTranslations
      />,
    )

    await userEvent.click(screen.getByRole("button", { name: "Right of logo" }))

    expect(onLayoutChange).not.toHaveBeenCalled()
    expect(onSharedLayoutChange).toHaveBeenCalledTimes(1)
    const next = onSharedLayoutChange.mock.calls[0]?.[0] as PortalLayout
    expect(next.header.languagePlacement).toBe("brand")
  })
})
