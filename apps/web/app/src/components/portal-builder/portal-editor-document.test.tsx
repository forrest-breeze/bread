// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { buildDefaultHeader, buildPortalTheme } from "@/lib/portal/build-default"
import type { PortalLayout } from "@/lib/portal/schema"
import { PortalEditorDocument } from "./portal-editor-document"

const layout = {
  theme: buildPortalTheme({
    id: "ws-1",
    iconUrl: "",
    websiteUrl: null,
    branding: { name: "Acme", tagline: "", logoUrl: "", accentColor: "#2563eb" },
  } as Parameters<typeof buildPortalTheme>[0]),
  header: buildDefaultHeader(),
  footer: { id: "footer", type: "footer", note: "Acme footer", showPoweredBy: true },
} as PortalLayout

describe("PortalEditorDocument", () => {
  it("keeps the footer and a working outline when a document opens and changes", async () => {
    const props = { layout, appearance: "light" as const, mobile: false, allowPoweredByRemoval: false }
    const { rerender } = render(
      <PortalEditorDocument {...props}><div><h2>Install</h2></div></PortalEditorDocument>,
    )
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Acme footer")
    expect(screen.getByRole("navigation", { name: "On this page" })).toBeInTheDocument()
    const target = screen.getByRole("heading", { name: "Install" })
    const scrollIntoView = vi.fn()
    target.scrollIntoView = scrollIntoView
    fireEvent.click(screen.getByRole("button", { name: "Install" }))
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" })

    rerender(<PortalEditorDocument {...props}><div><h2>Configure</h2></div></PortalEditorDocument>)
    await waitFor(() => expect(screen.getByRole("button", { name: "Configure" })).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull()
  })

  it("reads editable headings without mutating editor-owned DOM", async () => {
    const { container } = render(
      <PortalEditorDocument layout={layout} appearance="light" mobile={false} allowPoweredByRemoval={false}>
        <div contentEditable suppressContentEditableWarning><h2>Editable section</h2></div>
      </PortalEditorDocument>,
    )
    const target = screen.getByRole("heading", { name: "Editable section" })
    expect(target).not.toHaveAttribute("id")
    expect(target).not.toHaveAttribute("style")
    const mutations = vi.fn()
    const observer = new MutationObserver(mutations)
    observer.observe(target, { attributes: true })
    target.textContent = "Renamed section"
    await waitFor(() => expect(screen.getByRole("button", { name: "Renamed section" })).toBeInTheDocument())
    expect(mutations).not.toHaveBeenCalled()
    const scrollIntoView = vi.fn()
    target.scrollIntoView = scrollIntoView
    fireEvent.click(screen.getByRole("button", { name: "Renamed section" }))
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" })
    expect(container.querySelector('[contenteditable="true"] h2')).toBe(target)
    observer.disconnect()
  })

  it("keeps the footer on mobile without squeezing in a reading rail", () => {
    render(
      <PortalEditorDocument layout={layout} appearance="dark" mobile allowPoweredByRemoval={false}>
        <div><h2>Install</h2></div>
      </PortalEditorDocument>,
    )
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Acme footer")
    expect(screen.queryByRole("navigation", { name: "On this page" })).toBeNull()
  })
})
