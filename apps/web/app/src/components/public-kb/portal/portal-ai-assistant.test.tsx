// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PortalAiAssistant } from "./portal-ai-assistant"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("PortalAiAssistant", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("opens the assistant drawer", () => {
    render(<PortalAiAssistant slug="acme" label="Ask Acme" />)

    const trigger = screen.getByRole("button", { name: "Ask Acme" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("dialog", { name: "Ask Acme" })).toBeInTheDocument()
    expect(screen.getByLabelText("Question for AI assistant")).toBeInTheDocument()
  })

  it("closes the drawer and returns focus to its floating trigger", async () => {
    render(<PortalAiAssistant slug="acme" label="Help bot" />)

    fireEvent.click(screen.getByRole("button", { name: "Help bot" }))

    expect(screen.getByRole("dialog", { name: "Help bot" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Close AI assistant" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Help bot" })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole("button", { name: "Help bot" })).toHaveFocus())
  })

  it("holds a multi-turn chat and sends prior turns as history", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          answer: "Alpha does things [1].",
          citations: [{ title: "Alpha doc", docId: "doc-a", href: "/p/acme/doc/doc-a" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ answer: "Set it up in settings.", citations: [] }))
    vi.stubGlobal("fetch", fetchMock)

    render(<PortalAiAssistant slug="acme" label="Ask Acme" />)
    fireEvent.click(screen.getByRole("button", { name: "Ask Acme" }))

    const input = screen.getByLabelText("Question for AI assistant")
    fireEvent.change(input, { target: { value: "what is alpha" } })
    fireEvent.submit(input.closest("form")!)

    // First turn renders the question bubble and then the cited answer.
    expect(screen.getByText("what is alpha")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByText("Alpha does things [1].")).toBeInTheDocument(),
    )
    expect(screen.getByRole("link", { name: "Alpha doc" })).toHaveAttribute(
      "href",
      "/p/acme/doc/doc-a",
    )

    // The input stays available for a follow-up — no reset step required.
    fireEvent.change(input, { target: { value: "how do I set it up" } })
    fireEvent.submit(input.closest("form")!)
    await waitFor(() =>
      expect(screen.getByText("Set it up in settings.")).toBeInTheDocument(),
    )
    // Earlier turns stay in the thread.
    expect(screen.getByText("what is alpha")).toBeInTheDocument()

    // The follow-up request carries the first exchange as history.
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as { question: string; history: Array<{ role: string; content: string }> }
    expect(secondBody.question).toBe("how do I set it up")
    expect(secondBody.history).toEqual([
      { role: "user", content: "what is alpha" },
      { role: "assistant", content: "Alpha does things [1]." },
    ])
  })

  it("renders the server-sanitized answer HTML when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        answer: "Use **PAT** tokens.",
        answerHtml: "<p>Use <strong>PAT</strong> tokens.</p>",
        citations: [],
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    render(<PortalAiAssistant slug="acme" label="Ask Acme" />)
    fireEvent.click(screen.getByRole("button", { name: "Ask Acme" }))

    const input = screen.getByLabelText("Question for AI assistant")
    fireEvent.change(input, { target: { value: "how do I authenticate" } })
    fireEvent.submit(input.closest("form")!)

    // The markdown is rendered (a real <strong>), not shown as literal `**`.
    const bold = await screen.findByText("PAT")
    expect(bold.tagName).toBe("STRONG")
    expect(screen.queryByText("Use **PAT** tokens.")).not.toBeInTheDocument()
  })

  it("shows an error turn and lets the visitor retry", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "nope" }, 429))
    vi.stubGlobal("fetch", fetchMock)

    render(<PortalAiAssistant slug="acme" label="Ask Acme" />)
    fireEvent.click(screen.getByRole("button", { name: "Ask Acme" }))

    const input = screen.getByLabelText("Question for AI assistant")
    fireEvent.change(input, { target: { value: "what is alpha" } })
    fireEvent.submit(input.closest("form")!)

    await waitFor(() =>
      expect(
        screen.getByText("Too many questions. Please wait a moment and try again."),
      ).toBeInTheDocument(),
    )
    expect(screen.getByLabelText("Question for AI assistant")).not.toBeDisabled()
  })
})
