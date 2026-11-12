/**
 * Internal tool: billing is removed, so every workspace gate returns full
 * access, and reading a subscription never writes (no self-healing insert).
 */
import { describe, expect, it, vi } from "vitest"

const { mockCreateAdminClient } = vi.hoisted(() => ({
  mockCreateAdminClient: vi.fn(),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}))

import {
  getPortalEntitlementsForWorkspace,
  getWorkspaceSubscription,
  isAgentEnabledForWorkspace,
  isAutoIngestEnabledForWorkspace,
  isBusinessTierForWorkspace,
  isPortalEditorEnabledForWorkspace,
  isPortalReportingEnabledForWorkspace,
  isWorkspaceOnPaidTier,
} from "@/lib/db/subscription"

function mockRead(result: { data: unknown; error: { message: string } | null }) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
  }
  mockCreateAdminClient.mockReturnValue({ from: vi.fn(() => chain) })
  return chain
}

describe("workspace gates", () => {
  it("grant full access to every workspace", async () => {
    expect(await isWorkspaceOnPaidTier("ws")).toBe(true)
    expect(await isBusinessTierForWorkspace("ws")).toBe(true)
    expect(await isAgentEnabledForWorkspace("ws")).toBe(true)
    expect(await isAutoIngestEnabledForWorkspace("ws")).toBe(true)
    expect(await isPortalEditorEnabledForWorkspace("ws")).toBe(true)
    expect(await isPortalReportingEnabledForWorkspace("ws")).toBe(true)
    expect((await getPortalEntitlementsForWorkspace("ws")).planId).toBe("enterprise")
  })
})

describe("getWorkspaceSubscription", () => {
  it("returns the row when present", async () => {
    mockRead({ data: { workspace_id: "ws", plan_id: "free" }, error: null })
    expect(await getWorkspaceSubscription("ws")).toMatchObject({ workspace_id: "ws" })
  })

  it("returns null and does not insert when the row is missing", async () => {
    const chain = mockRead({ data: null, error: null })
    expect(await getWorkspaceSubscription("ws")).toBeNull()
    expect(chain.insert).not.toHaveBeenCalled()
  })

  it("returns null on read error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockRead({ data: null, error: { message: "boom" } })
    expect(await getWorkspaceSubscription("ws")).toBeNull()
  })
})
