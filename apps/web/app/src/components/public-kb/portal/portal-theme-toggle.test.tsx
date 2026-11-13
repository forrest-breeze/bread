// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPortalPreviewThemeMessage } from "@/lib/portal/preview-theme-message"
import { PortalThemeToggle } from "./portal-theme-toggle"

describe("PortalThemeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("persists the public preference and replaces the explicit root mode", () => {
    const { container } = render(
      <div data-portal-root className="light">
        <PortalThemeToggle appearance="light" />
      </div>,
    )

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }))

    expect(container.firstElementChild).toHaveClass("dark")
    expect(container.firstElementChild).not.toHaveClass("light")
    expect(window.localStorage.getItem("breezify-public-portal-theme")).toBe("dark")
  })

  it("keeps preview mode isolated from the public preference", () => {
    window.localStorage.setItem("breezify-public-portal-theme", "dark")
    const postMessage = vi.spyOn(window.parent, "postMessage")
    const { container } = render(
      <div data-portal-root className="light">
        <PortalThemeToggle appearance="dark" previewMode="light" />
      </div>,
    )

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }))

    expect(container.firstElementChild).toHaveClass("dark")
    expect(container.firstElementChild).not.toHaveClass("light")
    expect(window.localStorage.getItem("breezify-public-portal-theme")).toBe("dark")
    expect(postMessage).toHaveBeenCalledWith(
      createPortalPreviewThemeMessage("dark"),
      window.location.origin,
    )
  })

  it("follows same-origin theme changes from the editor toolbar", () => {
    const { container } = render(
      <div data-portal-root className="light">
        <PortalThemeToggle appearance="auto" previewMode="light" />
      </div>,
    )

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: createPortalPreviewThemeMessage("dark"),
          origin: window.location.origin,
          source: window.parent,
        }),
      )
    })

    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass("dark")
    expect(container.firstElementChild).not.toHaveClass("light")
  })
})
