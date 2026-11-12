// @vitest-environment jsdom

import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import PublicKbLoading from "./loading"

describe("PublicKbLoading", () => {
  it("ships distinct rail-less changelog feed and entry scaffolds", () => {
    const { container } = render(<PublicKbLoading />)
    const styles = container.querySelector("style")?.textContent ?? ""
    const feed = container.querySelector(".portal-changelog-feed-loading")
    const entry = container.querySelector(".portal-changelog-entry-loading")

    expect(styles).toContain('[data-portal-surface="changelog-feed"]')
    expect(styles).toContain('[data-portal-surface="changelog-entry"]')
    expect(feed).toBeInTheDocument()
    expect(entry).toBeInTheDocument()
    expect(feed?.querySelector("aside")).not.toBeInTheDocument()
    expect(entry?.querySelector("aside")).not.toBeInTheDocument()
    expect(entry?.querySelector("article")).toBeInTheDocument()
  })
})
