// @vitest-environment happy-dom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PortalDocumentScrollReset } from "./portal-document-scroll-reset"

describe("PortalDocumentScrollReset", () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("scrolls to the top when the rendered document changes", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {})
    const { rerender } = render(<PortalDocumentScrollReset documentId="first" />)

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" })

    scrollTo.mockClear()
    rerender(<PortalDocumentScrollReset documentId="first" />)
    expect(scrollTo).not.toHaveBeenCalled()

    rerender(<PortalDocumentScrollReset documentId="second" />)
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" })
  })
})
