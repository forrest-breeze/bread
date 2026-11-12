// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PortalSearch } from "./portal-search"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

describe("PortalSearch", () => {
  it("opens the compact header trigger as a themed modal", () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      () =>
        ({
          matches: true,
          media: "(max-width: 1279px)",
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList,
    )
    const { container } = render(
      <div data-portal-root className="dark">
        <PortalSearch
          slug="acme"
          placeholder="Search Acme"
          askAiEnabled={false}
        />
      </div>,
    )

    fireEvent.click(screen.getByRole("button", { name: "Search the knowledge base" }))

    const portalRoot = container.querySelector<HTMLElement>("[data-portal-root]")
    const dialog = screen.getByRole("dialog", { name: "Search the knowledge base" })
    expect(dialog.closest("[data-portal-root]")).toBe(portalRoot)
    matchMedia.mockRestore()
  })

  it("keeps the command palette inside the themed portal root", () => {
    const { container } = render(
      <div data-portal-root className="dark" style={{ "--portal-accent": "#123456" } as React.CSSProperties}>
        <PortalSearch
          slug="acme"
          placeholder="Search Acme"
          askAiEnabled={false}
          globalShortcut
        />
      </div>,
    )

    fireEvent.keyDown(document, { key: "k", metaKey: true })

    const portalRoot = container.querySelector<HTMLElement>("[data-portal-root]")
    const dialog = screen.getByRole("dialog", { name: "Search the knowledge base" })

    expect(portalRoot).not.toBeNull()
    expect(dialog.closest("[data-portal-root]")).toBe(portalRoot)
  })
})
