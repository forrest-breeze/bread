// @vitest-environment happy-dom

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PortalReverseProxyInstructions } from "./portal-reverse-proxy-instructions"
import { getCloudflareConnectorStatus } from "@/lib/api/cloudflare"

vi.mock("@/lib/api/cloudflare", () => ({
  getCloudflareConnectorStatus: vi.fn().mockResolvedValue({
    configured: true,
    connected: false,
    deployment: null,
  }),
  deployCloudflarePortal: vi.fn(),
  cloudflareConnectUrl: vi.fn(() => "/api/cloudflare/oauth/start"),
}))

describe("PortalReverseProxyInstructions", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com"))
  afterEach(() => vi.unstubAllEnvs())

  it("offers the configured Cloudflare flow and exposes the exact route bundle", () => {
    render(
      <PortalReverseProxyInstructions
        domain="customer.com"
        mountPath="/blog"
        portalPath="/p/acme/blog"
      />,
    )

    expect(screen.getByText("No DNS changes.")).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: "Copy Cloudflare setup for customer.com/blog and customer.com/blog/*",
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Checking/i })).toBeInTheDocument()
  })

  it("waits until the automatically saved domain is ready", () => {
    render(
      <PortalReverseProxyInstructions
        domain="customer.com"
        mountPath="docs"
        portalPath="/p/acme/docs"
        connectorReady={false}
      />,
    )

    expect(screen.getByRole("button", { name: /Checking/i })).toBeDisabled()
    expect(screen.getByText(/connector becomes available/i)).toBeInTheDocument()
  })

  it("bundles all workspace project paths into one Worker setup", () => {
    render(
      <PortalReverseProxyInstructions
        domain="portal.northwind.test"
        mountPath="manuals"
        portalPath="/p/northwind/developer-guide"
        routeMappings={[
          { mountPath: "/manuals", portalPath: "/p/northwind/developer-guide" },
          { mountPath: "/support", portalPath: "/p/northwind/customer-care" },
        ]}
      />,
    )

    expect(
      screen.getByRole("button", {
        name: "Copy Cloudflare setup for portal.northwind.test/manuals and portal.northwind.test/manuals/* and portal.northwind.test/support and portal.northwind.test/support/*",
      }),
    ).toBeInTheDocument()
  })

  it("reveals the manual proxy instructions", async () => {
    const user = userEvent.setup()
    render(
      <PortalReverseProxyInstructions
        domain="customer.com"
        mountPath="docs"
        portalPath="/p/acme/docs"
      />,
    )

    await user.click(screen.getByRole("button", { name: /Other reverse proxy/i }))

    expect(screen.getByText(/location = \/docs/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy Nginx configuration" })).toBeInTheDocument()
  })

  it("rechecks the portal after finding an active Worker deployment", async () => {
    vi.mocked(getCloudflareConnectorStatus).mockResolvedValueOnce({
      configured: true,
      connected: true,
      deployment: {
        status: "connected",
        domain: "customer.com",
        scriptName: "breezify-portal-123",
        deployedAt: "2026-07-28T01:00:00.000Z",
        lastError: null,
        needsDeploy: false,
      },
    })
    const onWorkerConnected = vi.fn()

    render(
      <PortalReverseProxyInstructions
        domain="customer.com"
        mountPath="/docs"
        portalPath="/p/acme/docs"
        onWorkerConnected={onWorkerConnected}
      />,
    )

    await waitFor(() => expect(onWorkerConnected).toHaveBeenCalledTimes(1))
  })

  it("shows a connected Worker separately from an out-of-date route bundle", async () => {
    vi.mocked(getCloudflareConnectorStatus).mockResolvedValueOnce({
      configured: true,
      connected: true,
      deployment: {
        status: "connected",
        domain: "customer.com",
        scriptName: "breezify-portal-123",
        deployedAt: "2026-07-28T01:00:00.000Z",
        lastError: null,
        needsDeploy: true,
      },
    })

    render(
      <PortalReverseProxyInstructions
        domain="customer.com"
        mountPath="/docs"
        portalPath="/p/acme/docs"
      />,
    )

    expect(
      await screen.findByText("Worker connected · update required"),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Update Worker" }),
    ).toBeInTheDocument()
    expect(screen.queryByText("Cloudflare authorized")).not.toBeInTheDocument()
  })
})
