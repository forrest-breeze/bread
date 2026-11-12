// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { AppTooltip, InfoHint, TooltipProvider } from "@/components/ui/tooltip"

afterEach(cleanup)

describe("AppTooltip", () => {
  it("shows a label, supporting copy, and keyboard hint on hover", async () => {
    const user = userEvent.setup()

    render(
      <TooltipProvider delay={0}>
        <AppTooltip
          label="Document outline"
          description="Jump between pages and headings."
          shortcut="⌘⇧O"
        >
          <button type="button">Outline</button>
        </AppTooltip>
      </TooltipProvider>,
    )

    await user.hover(screen.getByRole("button", { name: "Outline" }))

    expect(await screen.findByText("Document outline")).toBeVisible()
    expect(screen.getByText("Jump between pages and headings.")).toBeVisible()
    expect(screen.getByText("⌘⇧O")).toBeVisible()
  })
})

describe("InfoHint", () => {
  it("keeps help copy out of the layout until the glyph is hovered", async () => {
    const user = userEvent.setup()

    render(
      <TooltipProvider delay={0}>
        <InfoHint>Folders you include are served on this portal.</InfoHint>
      </TooltipProvider>,
    )

    const copy = "Folders you include are served on this portal."
    expect(screen.queryByText(copy)).toBeNull()

    await user.hover(screen.getByRole("button", { name: "More information" }))

    expect(await screen.findByText(copy)).toBeVisible()
  })
})
