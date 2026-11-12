// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PortalLayout } from "@/lib/portal/schema"
import { PortalAgentPanel } from "./portal-agent-panel"

const { runPortalAgent, saveExchange, truncate, persisted } = vi.hoisted(() => ({
  runPortalAgent: vi.fn(),
  saveExchange: vi.fn(),
  truncate: vi.fn(),
  persisted: { turns: [] as unknown[], ready: true },
}))

vi.mock("@/lib/api/portal", () => ({ runPortalAgent }))

vi.mock("@/hooks/use-portal-builder-chat", () => ({
  usePortalBuilderChat: () => ({
    turns: persisted.turns,
    ready: persisted.ready,
    saveExchange,
    truncate,
  }),
}))

const layout = { theme: { appearance: "light" } } as unknown as PortalLayout
const olderLayout = { theme: { appearance: "dark" } } as unknown as PortalLayout

function renderPanel(
  props: Partial<React.ComponentProps<typeof PortalAgentPanel>> = {},
): { onRestoreCheckpoint: ReturnType<typeof vi.fn> } {
  const onRestoreCheckpoint = vi.fn()
  render(
    <PortalAgentPanel
      layout={layout}
      onLayoutChange={vi.fn()}
      onRestoreCheckpoint={onRestoreCheckpoint}
      projectSlug="docs"
      workspaceId="ws-1"
      {...props}
    />,
  )
  return { onRestoreCheckpoint }
}

function send(text: string): void {
  const box = screen.getByPlaceholderText(/Describe what to build/i)
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: "Enter" })
}

describe("PortalAgentPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persisted.turns = []
    persisted.ready = true
  })

  it("offers a retry that re-runs the failed request without duplicating the turn", async () => {
    runPortalAgent.mockRejectedValueOnce(new Error("The portal agent failed."))
    renderPanel()

    send("change the folder icons")

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("The portal agent failed.")
    expect(screen.getAllByText("change the folder icons")).toHaveLength(1)

    runPortalAgent.mockResolvedValueOnce({
      layout,
      reply: "Updated the icons.",
      toolCalls: [],
    })
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))

    expect(await screen.findByText("Updated the icons.")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getAllByText("change the folder icons")).toHaveLength(1)
    expect(saveExchange).toHaveBeenCalledTimes(1)
  })

  it("dismissing a failure drops its turn and returns the prompt to the composer", async () => {
    runPortalAgent.mockRejectedValueOnce(new Error("nope"))
    renderPanel()

    send("make it blue")
    await screen.findByRole("alert")

    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }))

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
    // The transcript bubble is gone (the textarea still holds the text below).
    expect(screen.queryByText("make it blue", { selector: "p" })).toBeNull()
    expect(screen.getByPlaceholderText(/Describe what to build/i)).toHaveValue(
      "make it blue",
    )
  })

  // A restore UNDOES the turn, so the turn goes with it — leaving an
  // instruction on screen whose effect was just reverted misdescribes the
  // portal. Its prompt moves to the composer to be reworded and sent again.
  it("drops the restored turn and everything after it, and truncates storage", async () => {
    persisted.turns = [
      { id: "m1", role: "user", text: "first ask", checkpoint: olderLayout },
      { id: "m2", role: "agent", text: "first reply" },
      { id: "m3", role: "user", text: "second ask", checkpoint: layout },
      { id: "m4", role: "agent", text: "second reply" },
    ]
    const { onRestoreCheckpoint } = renderPanel()

    fireEvent.click(screen.getAllByRole("button", { name: /Undo this message/ })[1])
    fireEvent.click(screen.getByRole("button", { name: "Undo message" }))

    expect(onRestoreCheckpoint).toHaveBeenCalledWith(layout)
    await waitFor(() =>
      expect(screen.queryByText("second ask", { selector: "p" })).toBeNull(),
    )
    expect(screen.queryByText("second reply")).toBeNull()
    // Turns before the restored one are untouched.
    expect(screen.getByText("first ask")).toBeTruthy()
    expect(screen.getByText("first reply")).toBeTruthy()
    // Two stored rows precede the restored turn.
    expect(truncate).toHaveBeenCalledWith(2)
    // The prompt comes back for reuse rather than being thrown away.
    expect(screen.getByPlaceholderText(/Describe what to build/i)).toHaveValue(
      "second ask",
    )
  })

  it("keeps anything already typed instead of clobbering it", async () => {
    persisted.turns = [
      { id: "m1", role: "user", text: "first ask", checkpoint: olderLayout },
      { id: "m2", role: "agent", text: "first reply" },
    ]
    renderPanel()

    const box = screen.getByPlaceholderText(/Describe what to build/i)
    fireEvent.change(box, { target: { value: "a new idea" } })
    fireEvent.click(screen.getAllByRole("button", { name: /Undo this message/ })[0])
    fireEvent.click(screen.getByRole("button", { name: "Undo message" }))

    await waitFor(() => expect(screen.queryByText("first reply")).toBeNull())
    expect(box).toHaveValue("a new idea")
  })

  it("clears a failed turn's error when an earlier checkpoint is restored", async () => {
    persisted.turns = [
      { id: "m1", role: "user", text: "first ask", checkpoint: olderLayout },
      { id: "m2", role: "agent", text: "first reply" },
    ]
    runPortalAgent.mockRejectedValueOnce(new Error("The portal agent failed."))
    renderPanel()

    send("second ask")
    await screen.findByRole("alert")

    fireEvent.click(screen.getAllByRole("button", { name: /Undo this message/ })[0])
    fireEvent.click(screen.getByRole("button", { name: "Undo message" }))

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
    expect(screen.queryByText("second ask", { selector: "p" })).toBeNull()
    // Restoring the FIRST turn empties the thread; the failed turn was never
    // persisted, so it must not be counted either.
    expect(truncate).toHaveBeenCalledWith(0)
  })
})

describe("PortalAgentPanel edit and resubmit", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persisted.turns = []
    persisted.ready = true
    runPortalAgent.mockResolvedValue({
      layout,
      reply: "edited reply",
      toolCalls: [],
    })
  })

  function openEditor(index = 0): HTMLElement {
    fireEvent.click(screen.getAllByRole("button", { name: /Edit and resubmit/ })[index])
    return screen.getByLabelText("Edit message")
  }

  it("prefills the editor with the message and can cancel back", () => {
    persisted.turns = [
      { id: "m1", role: "user", text: "first ask", checkpoint: olderLayout },
      { id: "m2", role: "agent", text: "first reply" },
    ]
    renderPanel()

    expect(openEditor()).toHaveValue("first ask")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByLabelText("Edit message")).toBeNull()
    expect(screen.getByText("first ask")).toBeTruthy()
  })

  // The edited turn REPLACES the original, so the old wording and the reply it
  // produced both go — otherwise the transcript shows an instruction that no
  // longer describes the portal.
  it("replaces the edited turn and everything after it", async () => {
    persisted.turns = [
      { id: "m1", role: "user", text: "first ask", checkpoint: olderLayout },
      { id: "m2", role: "agent", text: "first reply" },
      { id: "m3", role: "user", text: "second ask", checkpoint: layout },
      { id: "m4", role: "agent", text: "second reply" },
    ]
    renderPanel()

    const box = openEditor(1)
    fireEvent.change(box, { target: { value: "second ask, but clearer" } })
    fireEvent.click(screen.getByRole("button", { name: "Resubmit" }))

    await screen.findByText("edited reply")
    expect(screen.queryByText("second ask")).toBeNull()
    expect(screen.queryByText("second reply")).toBeNull()
    expect(screen.getByText("second ask, but clearer")).toBeTruthy()
    // Turns before the edited one survive untouched.
    expect(screen.getByText("first ask")).toBeTruthy()
    // Storage is cut to the two turns that preceded the edited one.
    expect(truncate).toHaveBeenCalledWith(2)
  })

  // Replaying against the turn's own checkpoint is what stops an edit from
  // compounding on the edit it supersedes.
  it("replays against the edited turn's checkpoint, not the live layout", async () => {
    persisted.turns = [
      { id: "m1", role: "user", text: "first ask", checkpoint: olderLayout },
      { id: "m2", role: "agent", text: "first reply" },
    ]
    renderPanel()

    const box = openEditor()
    fireEvent.change(box, { target: { value: "reworded" } })
    fireEvent.click(screen.getByRole("button", { name: "Resubmit" }))

    await screen.findByText("edited reply")
    expect(runPortalAgent).toHaveBeenCalledWith(
      "reworded",
      olderLayout,
      "docs",
      [],
    )
  })
})

// Opening a project that HAS history used to flash the "no messages yet" empty
// state while the thread loaded — a reading that is always wrong for a thread
// with messages in it.
describe("PortalAgentPanel loading state", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persisted.turns = []
    persisted.ready = true
  })

  it("shows a skeleton instead of the empty state while the thread loads", () => {
    persisted.ready = false
    renderPanel()

    expect(screen.getByText("Loading conversation")).toBeTruthy()
    expect(screen.queryByAltText("Breeze")).toBeNull()
  })

  it("falls through to the empty state once a genuinely empty thread loads", () => {
    persisted.ready = true
    renderPanel()

    expect(screen.queryByText("Loading conversation")).toBeNull()
    expect(screen.getByAltText("Breeze")).toBeTruthy()
  })

  it("shows the transcript, not the skeleton, once turns arrive", () => {
    persisted.turns = [
      { id: "m1", role: "user", text: "first ask", checkpoint: olderLayout },
    ]
    renderPanel()

    expect(screen.queryByText("Loading conversation")).toBeNull()
    expect(screen.getByText("first ask")).toBeTruthy()
  })
})

// Undo reverts the portal AND truncates the stored transcript, both autosaved.
// It sits on a hover-revealed icon next to Edit, so a stray click was able to
// throw work away — hence the confirmation.
describe("PortalAgentPanel undo confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persisted.turns = [
      { id: "m1", role: "user", text: "first ask", checkpoint: olderLayout },
      { id: "m2", role: "agent", text: "first reply" },
      { id: "m3", role: "user", text: "second ask", checkpoint: layout },
      { id: "m4", role: "agent", text: "second reply" },
    ]
    persisted.ready = true
  })

  function clickUndo(index: number): void {
    fireEvent.click(
      screen.getAllByRole("button", { name: /Undo this message/ })[index],
    )
  }

  it("does not touch anything until the dialog is confirmed", () => {
    const { onRestoreCheckpoint } = renderPanel()

    clickUndo(0)

    expect(screen.getByRole("alertdialog")).toBeTruthy()
    expect(onRestoreCheckpoint).not.toHaveBeenCalled()
    expect(truncate).not.toHaveBeenCalled()
    expect(screen.getByText("second ask")).toBeTruthy()
  })

  it("cancelling leaves the transcript and the portal alone", async () => {
    const { onRestoreCheckpoint } = renderPanel()

    clickUndo(0)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(onRestoreCheckpoint).not.toHaveBeenCalled()
    expect(truncate).not.toHaveBeenCalled()
    expect(screen.getByText("first ask")).toBeTruthy()
    expect(screen.getByText("second ask")).toBeTruthy()
  })

  // The count is the point of the dialog — it tells you what the click costs.
  it("names how many later turns go with it", () => {
    renderPanel()

    clickUndo(0)
    expect(
      screen.getByText(/This message and the 3 messages after it/),
    ).toBeTruthy()
  })

  it("uses singular wording when only one turn follows", () => {
    renderPanel()

    clickUndo(1)
    expect(
      screen.getByText(/This message and the 1 message after it/),
    ).toBeTruthy()
  })
})
