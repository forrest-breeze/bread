import { beforeEach, describe, expect, it, vi } from "vitest"
import { PORTAL_SCHEMA_VERSION, type PortalLayout } from "./schema"

const hoisted = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: hoisted.createAdminClient,
}))

// Pass-through cache so each call hits the mocked admin client (no cross-test
// memoization). The real unstable_cache keys by args and would mask later cases.
vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(fn: (...args: A) => R) => fn,
}))

import { loadPublishedPortalLayout } from "./experiences"

function validSpec(): PortalLayout {
  return {
    schemaVersion: PORTAL_SCHEMA_VERSION,
    theme: {
      brandName: "Acme",
      tagline: "",
      logoUrl: "",
      accentColor: "#2f5520",
      navLinks: [],
      cta: null,
      font: "sans",
      appearance: "auto",
    },
    header: {
      id: "header",
      type: "portal-header",
      search: { enabled: true, placeholder: "Search or ask AI" },
    },
    body: [{ id: "hero", type: "hero", placement: "full", heading: "Hi" }],
    footer: { id: "footer", type: "footer", showPoweredBy: true },
  }
}

function experiencesQuery(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
  }
  return builder
}

function mockAdmin(result: { data: unknown; error: unknown }) {
  const query = experiencesQuery(result)
  hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => query) })
  return query
}

describe("loadPublishedPortalLayout", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  it("returns null when no published row exists", async () => {
    mockAdmin({ data: null, error: null })
    await expect(loadPublishedPortalLayout("ws-1")).resolves.toBeNull()
  })

  it("returns null on a query error", async () => {
    mockAdmin({ data: null, error: { message: "boom" } })
    await expect(loadPublishedPortalLayout("ws-1")).resolves.toBeNull()
  })

  it("returns the validated layout when a valid spec row exists", async () => {
    mockAdmin({ data: { spec: validSpec() }, error: null })
    const layout = await loadPublishedPortalLayout("ws-1")
    expect(layout).not.toBeNull()
    expect(layout?.schemaVersion).toBe(PORTAL_SCHEMA_VERSION)
    expect(layout?.theme.brandName).toBe("Acme")
  })

  it("scopes the query to published public kb for the workspace", async () => {
    const query = mockAdmin({ data: { spec: validSpec() }, error: null })
    await loadPublishedPortalLayout("ws-42")
    expect(query.eq).toHaveBeenCalledWith("workspace_id", "ws-42")
    expect(query.eq).toHaveBeenCalledWith("kind", "kb")
    expect(query.eq).toHaveBeenCalledWith("audience", "public")
    expect(query.eq).toHaveBeenCalledWith("status", "published")
  })

  it("returns null when the stored spec fails validation", async () => {
    const bad = { ...validSpec(), schemaVersion: 99 }
    mockAdmin({ data: { spec: bad }, error: null })
    await expect(loadPublishedPortalLayout("ws-1")).resolves.toBeNull()
  })
})
