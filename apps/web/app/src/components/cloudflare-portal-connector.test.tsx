// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  deployCloudflarePortal,
  getCloudflareConnectorStatus,
} from "@/lib/api/cloudflare"

vi.mock("@/lib/api/cloudflare", () => ({
  getCloudflareConnectorStatus: vi.fn(),
  deployCloudflarePortal: vi.fn(),
  cloudflareConnectUrl: vi.fn(() => "/api/cloudflare/oauth/start"),
}))

import { CloudflarePortalConnector } from "./cloudflare-portal-connector"

const deployment = {
  status: "connected" as const,
  domain: "customer.com",
  scriptName: "breezify-portal-123",
  deployedAt: "2026-08-21T18:31:13.970Z",
  lastError: null,
  needsDeploy: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCloudflareConnectorStatus).mockResolvedValue({
    configured: true,
    connected: true,
    deployment: { ...deployment, needsDeploy: true },
  })
  vi.mocked(deployCloudflarePortal).mockResolvedValue({
    ok: true,
    deployment,
  })
})

describe("CloudflarePortalConnector route activation", () => {
  it("shows an activating state until the public route verifies", async () => {
    let finishVerification: ((active: boolean) => void) | undefined
    const verifyActivation = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishVerification = resolve
        }),
    )
    const onConnected = vi.fn()

    render(
      <CloudflarePortalConnector
        domain="customer.com"
        verifyActivation={verifyActivation}
        onConnected={onConnected}
      />,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Update Worker" }))

    expect(
      await screen.findByRole("button", { name: "Activating routes…" }),
    ).toBeDisabled()
    expect(
      screen.getByText("Worker deployed · activating routes"),
    ).toBeInTheDocument()
    expect(onConnected).not.toHaveBeenCalled()

    finishVerification?.(true)

    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce())
    expect(screen.getByText("Worker connected")).toBeInTheDocument()
  })
})
