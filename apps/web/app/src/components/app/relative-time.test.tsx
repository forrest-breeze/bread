// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"
import { RelativeTime } from "./relative-time"

describe("RelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("renders a deterministic server fallback across minute boundaries", () => {
    const isoDate = "2026-04-20T11:52:00.000Z"

    vi.setSystemTime(new Date("2026-04-20T11:59:59.000Z"))
    const serverHtml = renderToString(<RelativeTime isoDate={isoDate} />)

    vi.setSystemTime(new Date("2026-04-20T12:00:01.000Z"))
    const nextServerHtml = renderToString(<RelativeTime isoDate={isoDate} />)

    expect(nextServerHtml).toBe(serverHtml)
    expect(serverHtml).toContain("2026-04-20")
    expect(serverHtml).not.toContain("7m ago")
    expect(serverHtml).not.toContain("8m ago")
  })

  it("renders the live relative label after client hydration", () => {
    vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"))

    render(<RelativeTime isoDate="2026-04-20T11:52:00.000Z" />)

    expect(screen.getByText("8m ago")).toBeInTheDocument()
  })
})
