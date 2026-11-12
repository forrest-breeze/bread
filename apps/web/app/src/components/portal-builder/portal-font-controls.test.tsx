// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { PortalTheme } from "@/lib/portal/schema"
import { PortalFontControls } from "./portal-font-controls"

function theme(overrides: Partial<PortalTheme> = {}): PortalTheme {
  return {
    brandName: "Acme",
    tagline: "Docs",
    logoUrl: "",
    accentColor: "#2f5520",
    navLinks: [],
    cta: null,
    font: "sans",
    appearance: "auto",
    ...overrides,
  }
}

async function openSelect(name: string): Promise<void> {
  const trigger = screen.getByRole("combobox", { name })
  fireEvent.click(trigger)
  await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument())
}

// Base UI commits a mouse selection only after a pointerdown on the item, as a
// real click produces.
function pick(name: string): void {
  const option = screen.getByRole("option", { name })
  fireEvent.pointerDown(option, { pointerType: "mouse" })
  fireEvent.click(option)
}

describe("PortalFontControls", () => {
  it("shows heading and body dropdowns with the default font", () => {
    render(<PortalFontControls theme={theme()} onChange={vi.fn()} />)

    expect(screen.getByRole("combobox", { name: "Heading font" })).toHaveTextContent(
      "Rethink Sans (default)",
    )
    expect(screen.getByRole("combobox", { name: "Body font" })).toHaveTextContent(
      "Rethink Sans (default)",
    )
    expect(screen.queryByText(/font file/i)).not.toBeInTheDocument()
  })

  it("opens the shared list and applies a font to one slot", async () => {
    const onChange = vi.fn()
    render(<PortalFontControls theme={theme()} onChange={onChange} />)

    await openSelect("Heading font")
    pick("Inter")

    expect(onChange).toHaveBeenCalledWith({ font: "sans", fonts: { heading: "Inter" } })
  })

  it("adds a self-hosted custom font to the shared list and selects it", async () => {
    const onChange = vi.fn()
    render(<PortalFontControls theme={theme()} onChange={onChange} />)

    await openSelect("Body font")
    pick("Add custom font…")
    fireEvent.change(screen.getByLabelText("Font name"), { target: { value: "Brand Sans" } })
    fireEvent.change(screen.getByLabelText("Font file (optional)"), {
      target: { value: "https://cdn.example.com/brand.woff2" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add font" }))

    expect(onChange).toHaveBeenCalledWith({
      font: "sans",
      fonts: {
        body: "Brand Sans",
        bodySource: "https://cdn.example.com/brand.woff2",
        custom: [{ family: "Brand Sans", source: "https://cdn.example.com/brand.woff2" }],
      },
    })
  })

  it("keeps the other slot on Crimson Text when leaving the legacy serif preset", async () => {
    const onChange = vi.fn()
    render(<PortalFontControls theme={theme({ font: "serif" })} onChange={onChange} />)

    expect(screen.getByRole("combobox", { name: "Body font" })).toHaveTextContent("Crimson Text")
    await openSelect("Heading font")
    pick("Rethink Sans (default)")

    expect(onChange).toHaveBeenCalledWith({ font: "sans", fonts: { body: "Crimson Text" } })
  })
})
