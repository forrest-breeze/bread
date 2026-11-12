// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/cloudflare-portal-connector", () => ({
  CloudflarePortalConnector: ({
    domain,
    onConnected,
  }: {
    domain: string
    onConnected: () => void
  }) => (
    <button type="button" onClick={onConnected}>
      Update Worker for {domain}
    </button>
  ),
}))

import { CloudflareWorkerUpdateDialog } from "./cloudflare-worker-update-dialog"

describe("CloudflareWorkerUpdateDialog", () => {
  it("explains the missing route and closes after the Worker updates", () => {
    const onOpenChange = vi.fn()
    const onUpdated = vi.fn()

    render(
      <CloudflareWorkerUpdateDialog
        open
        domain="example.com"
        pathPrefix="/onboarding"
        projectSlug="onboarding"
        onOpenChange={onOpenChange}
        onUpdated={onUpdated}
      />,
    )

    expect(
      screen.getByRole("heading", { name: "Update the Cloudflare Worker?" }),
    ).toBeInTheDocument()
    expect(screen.getByText("/onboarding")).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole("button", { name: "Update Worker for example.com" }),
    )
    expect(onUpdated).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole("button", { name: "Not now" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
