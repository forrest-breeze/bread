import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// /api/public/translate — boundary tests. The Claude client and Upstash are
// mocked; the tests pin validation, the key gate, rate limiting, the public
// portal + enabled-language gate, the authenticated preview path, caching, and
// the same-length `{ translations }` contract the portal translator expects.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getAnthropicClient: vi.fn(),
  create: vi.fn(),
  resolvePortalBase: vi.fn(),
  rateLimit: vi.fn(),
  budget: vi.fn(),
  record: vi.fn(),
  headers: vi.fn(),
  buildRedis: vi.fn(),
  createClient: vi.fn(),
  requireRouteUser: vi.fn(),
  getActiveWorkspace: vi.fn(),
  getPortalWorkspaceById: vi.fn(),
}))

vi.mock("@/lib/ai/anthropic", () => ({
  getAnthropicClient: mocks.getAnthropicClient,
  PORTAL_TRANSLATE_MODEL: "claude-haiku-5-5",
}))
vi.mock("@/lib/public-kb-portal-base", () => ({ resolvePortalBase: mocks.resolvePortalBase }))
vi.mock("@/lib/public-kb-ratelimit", () => ({ checkPublicRateLimit: mocks.rateLimit }))
vi.mock("@/lib/public-kb", () => ({ getPortalWorkspaceById: mocks.getPortalWorkspaceById }))
vi.mock("@/lib/ai/usage", () => ({ checkAiBudget: mocks.budget, recordAiUsage: mocks.record }))
vi.mock("@/lib/upstash", () => ({ buildRedis: mocks.buildRedis }))
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }))
vi.mock("@/lib/auth/route-auth", () => ({ requireRouteUser: mocks.requireRouteUser }))
vi.mock("@/lib/db/workspace", () => ({ getActiveWorkspace: mocks.getActiveWorkspace }))
vi.mock("next/headers", () => ({ headers: mocks.headers }))

import { POST } from "./route"

const RESOLVED = {
  workspace: { id: "ws-1", slug: "acme" },
  experienceId: "exp-1",
  scope: null,
  base: "acme",
  layout: { localization: { enabledLanguages: ["es"], defaultLanguage: "en" } },
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/public/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function modelReturns(translations: string[]): void {
  mocks.create.mockResolvedValue({
    model: "claude-haiku-5-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 50, output_tokens: 10 },
    content: [{ type: "text", text: JSON.stringify({ translations }) }],
  })
}

const VALID = { portal: "acme", language: "es", strings: ["Hello", "Search"], preview: false }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.headers.mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" }))
  mocks.getAnthropicClient.mockReturnValue({ messages: { create: mocks.create } })
  mocks.rateLimit.mockResolvedValue(true)
  mocks.resolvePortalBase.mockResolvedValue(RESOLVED)
  mocks.budget.mockResolvedValue({ allowed: true, spentUsd: 0, budgetUsd: 500 })
  mocks.buildRedis.mockReturnValue(null)
  modelReturns(["Hola", "Buscar"])
})

describe("POST /api/public/translate", () => {
  it("rejects invalid bodies with 400", async () => {
    expect((await POST(req({ ...VALID, language: "de" }))).status).toBe(400)
    expect((await POST(req({ ...VALID, strings: [] }))).status).toBe(400)
    expect((await POST(req({ ...VALID, strings: Array(17).fill("a") }))).status).toBe(400)
    expect((await POST(req({ ...VALID, strings: ["a".repeat(7000), "b".repeat(6000)] }))).status).toBe(400)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("returns 503 when ANTHROPIC_API_KEY is not configured", async () => {
    mocks.getAnthropicClient.mockReturnValue(null)
    expect((await POST(req(VALID))).status).toBe(503)
    expect(mocks.resolvePortalBase).not.toHaveBeenCalled()
  })

  it("returns 429 when rate limited", async () => {
    mocks.rateLimit.mockResolvedValue(false)
    expect((await POST(req(VALID))).status).toBe(429)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("returns 404 for an unresolved portal", async () => {
    mocks.resolvePortalBase.mockResolvedValue(null)
    expect((await POST(req(VALID))).status).toBe(404)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("returns 400 for a language the published portal does not offer", async () => {
    expect((await POST(req({ ...VALID, language: "fr" }))).status).toBe(400)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("returns one translation per input string, in order", async () => {
    const res = await POST(req({ ...VALID, strings: ["Hello", "Search", "Hello"] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ translations: ["Hola", "Buscar", "Hola"] })
    // Duplicates are translated once.
    expect(JSON.parse(mocks.create.mock.calls[0][0].messages[0].content)).toEqual(["Hello", "Search"])
    expect(mocks.create.mock.calls[0][0].model).toBe("claude-haiku-5-5")
  })

  it("returns a retryable 502 when the model output has the wrong length", async () => {
    modelReturns(["Hola"])
    expect((await POST(req(VALID))).status).toBe(502)
  })

  it("serves cached translations without calling the model", async () => {
    const set = vi.fn()
    mocks.buildRedis.mockReturnValue({
      mget: vi.fn().mockResolvedValue(["Hola", "Buscar"]),
      pipeline: () => ({ set, exec: vi.fn() }),
    })
    const res = await POST(req(VALID))
    expect(await res.json()).toEqual({ translations: ["Hola", "Buscar"] })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.budget).not.toHaveBeenCalled()
  })

  it("writes fresh translations to the cache", async () => {
    const set = vi.fn()
    mocks.buildRedis.mockReturnValue({
      mget: vi.fn().mockResolvedValue([null, "Buscar"]),
      pipeline: () => ({ set, exec: vi.fn().mockResolvedValue([]) }),
    })
    modelReturns(["Hola"])
    const res = await POST(req(VALID))
    expect(await res.json()).toEqual({ translations: ["Hola", "Buscar"] })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0][0]).toMatch(/^pubkb:tr:v1:claude-haiku-5-5:es:[0-9a-f]{64}$/)
  })

  describe("preview", () => {
    const PREVIEW = { ...VALID, language: "fr", preview: true, projectSlug: "help" }

    beforeEach(() => {
      mocks.createClient.mockResolvedValue({})
      mocks.requireRouteUser.mockResolvedValue({ user: { id: "u-1" }, response: null })
      mocks.getActiveWorkspace.mockResolvedValue({ workspace_id: "ws-1", role: "owner" })
      mocks.getPortalWorkspaceById.mockResolvedValue({ kind: "workspace", workspace: { slug: "acme" } })
    })

    it("translates an unpublished draft for an admin of the portal's workspace", async () => {
      const res = await POST(req(PREVIEW))
      expect(res.status).toBe(200)
      expect(mocks.resolvePortalBase).not.toHaveBeenCalled()
      expect(mocks.budget).toHaveBeenCalledWith("ws-1")
    })

    it("requires a signed-in user", async () => {
      mocks.requireRouteUser.mockResolvedValue({
        user: null,
        response: new Response(null, { status: 401 }),
      })
      expect((await POST(req(PREVIEW))).status).toBe(401)
    })

    it("rejects non-admin members", async () => {
      mocks.getActiveWorkspace.mockResolvedValue({ workspace_id: "ws-1", role: "editor" })
      expect((await POST(req(PREVIEW))).status).toBe(403)
    })

    it("rejects a portal from another workspace", async () => {
      expect((await POST(req({ ...PREVIEW, portal: "other/help" }))).status).toBe(404)
      expect(mocks.create).not.toHaveBeenCalled()
    })
  })
})
