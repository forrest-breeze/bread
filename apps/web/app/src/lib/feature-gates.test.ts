import { describe, it, expect, afterEach, vi } from "vitest"

const BREAD_UUID = "d44b116a-99ce-4cbf-ab04-d395266d6a62"
const BEN_UUID = "5e2192ee-4aae-4db4-843d-c047841847e4"

async function loadGates(
  breadWorkspaceId: string | undefined,
  nodeEnv: "development" | "production" | "test" = "test",
): Promise<typeof import("./feature-gates")> {
  vi.resetModules()
  vi.stubEnv("NEXT_PUBLIC_BREAD_WORKSPACE_ID", breadWorkspaceId ?? "")
  vi.stubEnv("NODE_ENV", nodeEnv)
  return await import("./feature-gates")
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("isBreadBrandedPortal", () => {
  it("recognizes official named Bread portals", async () => {
    const { isBreadBrandedPortal } = await loadGates(BREAD_UUID)
    expect(isBreadBrandedPortal(BREAD_UUID, "Bread Docs")).toBe(true)
    expect(isBreadBrandedPortal(BREAD_UUID, "Bread Help Center")).toBe(true)
  })

  it("does not leak Bread chrome into customer-branded projects", async () => {
    const { isBreadBrandedPortal } = await loadGates(BREAD_UUID)
    expect(isBreadBrandedPortal(BREAD_UUID, "Acme Help Center")).toBe(false)
    expect(isBreadBrandedPortal(BEN_UUID, "Bread Docs")).toBe(false)
  })
})
