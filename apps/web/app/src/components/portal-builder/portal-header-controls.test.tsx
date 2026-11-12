// @vitest-environment jsdom

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { PORTAL_SCHEMA_VERSION, type PortalLayout } from "@/lib/portal/schema"

import { PortalHeaderControls } from "./portal-header-controls"

const layout: PortalLayout = {
  schemaVersion: PORTAL_SCHEMA_VERSION,
  theme: {
    brandName: "Acme",
    tagline: "",
    logoUrl: "",
    accentColor: "#334455",
    navLinks: [{ label: "Docs", href: "/docs" }],
    cta: { label: "Contact", href: "/contact" },
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

describe("PortalHeaderControls", () => {
  it("moves the language selector left with the arrow control", async () => {
    const onLayoutChange = vi.fn()
    render(
      <PortalHeaderControls
        layout={layout}
        onLayoutChange={onLayoutChange}
        onSharedLayoutChange={vi.fn()}
        chromeScope="project"
      />,
    )

    await userEvent.click(
      screen.getByRole("button", { name: "Move Language selector left" }),
    )

    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    const next = onLayoutChange.mock.calls[0]?.[0] as PortalLayout
    expect(next.header.itemOrder).toEqual(["links", "language", "cta"])
  })

  it("drags the language selector to the left edge of a shared workspace header", () => {
    const onSharedLayoutChange = vi.fn()
    render(
      <PortalHeaderControls
        layout={layout}
        onLayoutChange={vi.fn()}
        onSharedLayoutChange={onSharedLayoutChange}
        chromeScope="workspace"
      />,
    )

    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: vi.fn(),
      setData: vi.fn(),
    }

    fireEvent.dragStart(
      screen.getByRole("button", { name: "Drag Language selector" }),
      { dataTransfer },
    )
    fireEvent.dragOver(screen.getByTestId("header-order-links"), {
      dataTransfer,
    })
    fireEvent.drop(screen.getByTestId("header-order-links"), { dataTransfer })

    expect(onSharedLayoutChange).toHaveBeenCalledTimes(1)
    const next = onSharedLayoutChange.mock.calls[0]?.[0] as PortalLayout
    expect(next.header.itemOrder).toEqual(["language", "links", "cta"])
  })
})
