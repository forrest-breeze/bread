// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PortalVersionMenu, formatEditDate } from "./portal-version-menu"
import type { PortalVersionSummary } from "@/lib/api/portal"

afterEach(cleanup)
const versions: PortalVersionSummary[] = [{
  version: 3, status: "archived", publishedBy: "Ada",
  createdAt: "2026-08-01T10:00:00.000Z", updatedAt: "2026-08-01T10:00:00.000Z",
}]
function props() {
  return { versions, loading: false, selectedVersion: null, restoring: false,
    lastEditedAt: new Date().toISOString(), onSelect: vi.fn(), onRestore: vi.fn() }
}

describe("PortalVersionMenu", () => {
  it("replaces Saved with the edit time when confirmation ends", () => {
    const input = props()
    const { rerender } = render(<PortalVersionMenu {...input} savedStatusVisible />)
    expect(screen.getByRole("button", { name: /version history/i })).toHaveTextContent("Saved")
    rerender(<PortalVersionMenu {...input} savedStatusVisible={false} />)
    expect(screen.getByRole("button", { name: /version history/i })).toHaveTextContent("Edited just now")
  })
  it("shows Editing and editor/date entries without publication labels or numbers", async () => {
    const user = userEvent.setup()
    const input = props()
    render(<PortalVersionMenu {...input} />)
    await user.click(screen.getByRole("button", { name: /version history/i }))
    expect(await screen.findByText("Editing")).toBeInTheDocument()
    expect(screen.getByText("Ada")).toBeInTheDocument()
    expect(screen.getByText(formatEditDate(versions[0].createdAt))).toBeInTheDocument()
    expect(screen.queryByText(/Working copy|matches v|Live|v3/)).not.toBeInTheDocument()
    await user.click(screen.getByText("Ada"))
    expect(input.onSelect).toHaveBeenCalledWith(3)
  })
  it("restores a saved edit with an explicit publish-later explanation", async () => {
    const user = userEvent.setup()
    const input = props()
    render(<PortalVersionMenu {...input} />)
    await user.click(screen.getByRole("button", { name: /version history/i }))
    await user.click(await screen.findByRole("button", { name: "Restore" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Publish when you want these changes to go live")
    await user.click(within(dialog).getByRole("button", { name: "Restore" }))
    expect(input.onRestore).toHaveBeenCalledWith(3)
  })
  it("shows an empty saved-edit history", async () => {
    render(<PortalVersionMenu {...props()} versions={[]} />)
    await userEvent.click(screen.getByRole("button", { name: /version history/i }))
    expect(await screen.findByText("No saved edits yet.")).toBeInTheDocument()
  })
})

describe("formatEditDate", () => {
  it("shows only time on the same local day", () => {
    const saved = new Date(2026, 10, 11, 9, 25)
    expect(formatEditDate(saved.toISOString(), new Date(2026, 10, 11, 18)))
      .toBe(saved.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))
  })
  it("shows only date across a local midnight", () => {
    const saved = new Date(2026, 10, 10, 23, 59)
    expect(formatEditDate(saved.toISOString(), new Date(2026, 10, 11, 0, 1)))
      .toBe(saved.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))
  })
})
