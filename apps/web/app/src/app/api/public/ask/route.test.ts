import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// /api/public/ask — boundary tests for the public "Ask AI" route. The Claude
// client is mocked; retrieval helpers are mocked so the tests pin the guard
// order (validation → key → rate limit → portal gate → scope re-check) and the
// response contract the portal assistant reads.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getAnthropicClient: vi.fn(),
  create: vi.fn(),
  resolvePortalBase: vi.fn(),
  rateLimit: vi.fn(),
  search: vi.fn(),
  getDoc: vi.fn(),
  inScope: vi.fn(),
  budget: vi.fn(),
  record: vi.fn(),
  headers: vi.fn(),
}))

vi.mock("@/lib/ai/anthropic", () => ({
  getAnthropicClient: mocks.getAnthropicClient,
  PORTAL_ASK_MODEL: "claude-opus-5-5",
}))
vi.mock("@/lib/public-kb", () => ({
  searchPublicForQuestion: mocks.search,
  getPublicDocument: mocks.getDoc,
  isDocInScope: mocks.inScope,
}))
vi.mock("@/lib/public-kb-portal-base", () => ({ resolvePortalBase: mocks.resolvePortalBase }))
vi.mock("@/lib/public-kb-ratelimit", () => ({ checkPublicRateLimit: mocks.rateLimit }))
vi.mock("@/lib/public-kb-render", () => ({
  renderPublicHtml: (md: string) => `<p>${md}</p>`,
}))
vi.mock("@/lib/ai/usage", () => ({ checkAiBudget: mocks.budget, recordAiUsage: mocks.record }))
vi.mock("next/headers", () => ({ headers: mocks.headers }))

import { POST } from "./route"

const RESOLVED = {
  workspace: { id: "ws-1", name: "Acme", slug: "acme", branding: { name: "Acme Help" } },
  experienceId: null,
  scope: ["folder-1"],
  base: "acme",
  layout: null,
}

const DOC = {
  id: "doc-1",
  slug: "install",
  title: "Install",
  content: "Run the installer.",
  source: null,
  author: null,
  updated_at: "2026-01-01T00:00:00Z",
  folder_id: "folder-1",
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/public/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

const VALID = { portal: "acme", question: "How do I install?", history: [] }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.headers.mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" }))
  mocks.getAnthropicClient.mockReturnValue({ beta: { messages: { create: mocks.create } } })
  mocks.rateLimit.mockResolvedValue(true)
  mocks.resolvePortalBase.mockResolvedValue(RESOLVED)
  mocks.budget.mockResolvedValue({ allowed: true, spentUsd: 0, budgetUsd: 500 })
  mocks.search.mockResolvedValue([{ id: "doc-1", slug: "install", title: "Install", source: null, snippet: "" }])
  mocks.getDoc.mockResolvedValue(DOC)
  mocks.inScope.mockResolvedValue(true)
  mocks.create.mockResolvedValue({
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20 },
    content: [{ type: "text", text: "See [Install](/p/acme/doc/install)." }],
  })
})

describe("POST /api/public/ask", () => {
  it("rejects invalid bodies with 400", async () => {
    expect((await POST(req({ portal: "acme" }))).status).toBe(400)
    expect((await POST(req({ ...VALID, question: "x" }))).status).toBe(400)
    const tooMuchHistory = Array.from({ length: 13 }, () => ({ role: "user", content: "hi" }))
    expect((await POST(req({ ...VALID, history: tooMuchHistory }))).status).toBe(400)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("returns 503 when ANTHROPIC_API_KEY is not configured", async () => {
    mocks.getAnthropicClient.mockReturnValue(null)
    const res = await POST(req(VALID))
    expect(res.status).toBe(503)
    expect(mocks.resolvePortalBase).not.toHaveBeenCalled()
  })

  it("returns 429 when rate limited", async () => {
    mocks.rateLimit.mockResolvedValue(false)
    const res = await POST(req(VALID))
    expect(res.status).toBe(429)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("returns 404 for an unresolved (private or missing) portal", async () => {
    mocks.resolvePortalBase.mockResolvedValue(null)
    const res = await POST(req(VALID))
    expect(res.status).toBe(404)
    expect(mocks.search).not.toHaveBeenCalled()
  })

  it("returns 404 when the published layout turned the assistant off", async () => {
    mocks.resolvePortalBase.mockResolvedValue({
      ...RESOLVED,
      layout: { theme: { assistant: { enabled: false } } },
    })
    expect((await POST(req(VALID))).status).toBe(404)
  })

  it("answers with sanitized HTML and citations for linked docs only", async () => {
    const res = await POST(req(VALID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      answer: "See [Install](/p/acme/doc/install).",
      answerHtml: "<p>See [Install](/p/acme/doc/install).</p>",
      citations: [{ title: "Install", docId: "doc-1", href: "/p/acme/doc/install" }],
    })
    expect(mocks.search).toHaveBeenCalledWith("ws-1", "How do I install?", 5, ["folder-1"])
    const params = mocks.create.mock.calls[0][0]
    expect(params.model).toBe("claude-opus-5-5")
    expect(params.messages.at(-1).content).toContain('<document title="Install" href="/p/acme/doc/install">')
    expect(mocks.record).toHaveBeenCalled()
  })

  it("never reads a document outside the resolved scope into the prompt", async () => {
    mocks.inScope.mockResolvedValue(false)
    const res = await POST(req(VALID))
    const body = await res.json()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(body.citations).toEqual([])
  })

  it("drops leading assistant turns so the conversation starts with a user turn", async () => {
    await POST(
      req({
        ...VALID,
        history: [
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
        ],
      }),
    )
    const messages = mocks.create.mock.calls[0][0].messages
    expect(messages[0]).toEqual({ role: "user", content: "Earlier question" })
    expect(messages).toHaveLength(3)
  })

  it("returns 503 when the workspace AI budget is exhausted", async () => {
    mocks.budget.mockResolvedValue({ allowed: false, spentUsd: 500, budgetUsd: 500 })
    expect((await POST(req(VALID))).status).toBe(503)
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
