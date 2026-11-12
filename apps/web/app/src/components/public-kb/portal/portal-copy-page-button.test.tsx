// @vitest-environment jsdom

import { useRef } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PortalCopyPageButton } from "./portal-copy-page-button"

const writeText = vi.fn<(text: string) => Promise<void>>()

function Harness({ heading }: { heading?: string }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div>
      <PortalCopyPageButton targetRef={ref} heading={heading} />
      <div ref={ref}>ignored by jsdom textContent</div>
    </div>
  )
}

/**
 * userEvent.setup() installs its own clipboard stub, so the spy has to replace
 * it afterwards — hence a helper rather than a beforeEach.
 */
function stubClipboard(): void {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  })
}

beforeEach(() => {
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  // jsdom implements no layout, so innerText is absent — the copy path reads it
  // for its block-aware line breaks, which textContent would flatten.
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    get(this: HTMLElement) {
      return this.textContent
    },
    configurable: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("PortalCopyPageButton", () => {
  it("copies the container's text under its heading and confirms", async () => {
    const user = userEvent.setup()
    stubClipboard()
    render(<Harness heading="Quickstart" />)

    await user.click(screen.getByRole("button", { name: "Copy page" }))

    expect(writeText).toHaveBeenCalledWith(
      "Quickstart\n\nignored by jsdom textContent",
    )
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument()
  })

  it("copies the container alone when it already carries the title", async () => {
    const user = userEvent.setup()
    stubClipboard()
    render(<Harness />)

    await user.click(screen.getByRole("button", { name: "Copy page" }))

    expect(writeText).toHaveBeenCalledWith("ignored by jsdom textContent")
  })

  it("stays in its resting state when the clipboard is unavailable", async () => {
    const user = userEvent.setup()
    stubClipboard()
    writeText.mockRejectedValue(new Error("denied"))
    render(<Harness heading="Quickstart" />)

    await user.click(screen.getByRole("button", { name: "Copy page" }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(screen.getByRole("button", { name: "Copy page" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull()
  })
})
