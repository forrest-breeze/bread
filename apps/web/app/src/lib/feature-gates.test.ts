import { describe, it, expect, afterEach, vi } from "vitest"

const BREEZIFY_UUID = "d44b116a-99ce-4cbf-ab04-d395266d6a62"
const BEN_UUID = "5e2192ee-4aae-4db4-843d-c047841847e4"

async function loadGates(
  breezifyWorkspaceId: string | undefined,
  nodeEnv: "development" | "production" | "test" = "test",
): Promise<typeof import("./feature-gates")> {
  vi.resetModules()
  vi.stubEnv("NEXT_PUBLIC_BREEZIFY_WORKSPACE_ID", breezifyWorkspaceId ?? "")
  vi.stubEnv("NODE_ENV", nodeEnv)
  return await import("./feature-gates")
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("isBreezifyBrandedPortal", () => {
  it("recognizes official named Breezify portals", async () => {
    const { isBreezifyBrandedPortal } = await loadGates(BREEZIFY_UUID)
    expect(isBreezifyBrandedPortal(BREEZIFY_UUID, "Breezify Docs")).toBe(true)
    expect(isBreezifyBrandedPortal(BREEZIFY_UUID, "Breezify Help Center")).toBe(true)
  })

  it("does not leak Breezify chrome into customer-branded projects", async () => {
    const { isBreezifyBrandedPortal } = await loadGates(BREEZIFY_UUID)
    expect(isBreezifyBrandedPortal(BREEZIFY_UUID, "Acme Help Center")).toBe(false)
    expect(isBreezifyBrandedPortal(BEN_UUID, "Breezify Docs")).toBe(false)
  })
})
