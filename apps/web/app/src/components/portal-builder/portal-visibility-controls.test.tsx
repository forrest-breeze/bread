// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkspaceWithRole } from "@/hooks/swr"
import { PortalVisibilityControls } from "./portal-visibility-controls"

const workspace = {
  user_role: "owner",
} as WorkspaceWithRole

function renderControls(hasPublishableChanges: boolean): void {
  render(
    <PortalVisibilityControls
      workspace={workspace}
      projectSlug="docs"
      visibility="public"
      brandName="Breezify"
      isPublished
      hasPublishableChanges={hasPublishableChanges}
      canDiscard={false}
      publishing={false}
      discarding={false}
      dirty={false}
      saving={false}
      onPublish={vi.fn(async () => true)}
      onDiscard={vi.fn()}
    />,
  )
}

afterEach(cleanup)

describe("PortalVisibilityControls publishing", () => {
  it("does not offer portal publishing when the portal has no changes", () => {
    renderControls(false)

    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument()
    expect(screen.getByText("Live and up to date.")).toBeInTheDocument()
  })

  it("offers portal publishing when the portal has unpublished changes", () => {
    renderControls(true)

    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument()
    expect(screen.getByText("Live, with unpublished changes.")).toBeInTheDocument()
  })
})
