import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const mocks = vi.hoisted(() => ({
  authenticateBearer: vi.fn(),
  syncOpenApiSource: vi.fn(),
  deleteOpenApiSource: vi.fn(),
  writeToRepository: vi.fn(),
  removeFromRepository: vi.fn(),
  repositoryPath: vi.fn(),
}))
vi.mock("@/lib/github/readme/readme-service", () => ({
  writeOpenApiSourceToLinkedRepository: mocks.writeToRepository,
  removeOpenApiSourceFromLinkedRepository: mocks.removeFromRepository,
  openApiSourceRepositoryPath: mocks.repositoryPath,
}))
vi.mock("@/lib/api/authenticate-bearer", () => ({ authenticateBearer: mocks.authenticateBearer }))
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }))
vi.mock("@/lib/openapi/openapi-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openapi/openapi-source")>()),
  syncOpenApiSource: mocks.syncOpenApiSource,
  deleteOpenApiSource: mocks.deleteOpenApiSource,
}))

import { DELETE, PUT } from "./route"

const params = (slug: string) => ({ params: Promise.resolve({ slug }) })
const put = (body = "{}", headers: Record<string, string> = {}) =>
  new NextRequest("https://app.test/api/v1/openapi/payments-api", {
    method: "PUT",
    body,
    headers: { authorization: "Bearer breezify_sk_x", "x-breezify-workspace": "breeze", ...headers },
  })

function apiKey(scopes: string[], role: string) {
  mocks.authenticateBearer.mockResolvedValue({
    data: { kind: "api_key", workspaceId: "ws", scopes, role },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // No ReadMe-format repository linked unless a test says otherwise.
  mocks.writeToRepository.mockResolvedValue(null)
  mocks.removeFromRepository.mockResolvedValue(null)
  mocks.repositoryPath.mockResolvedValue(null)
  mocks.syncOpenApiSource.mockResolvedValue({
    ok: true,
    result: { slug: "payments-api", title: "Breeze API", version: "1.0.0", operationCount: 60, created: 60, updated: 0, removed: 0 },
  })
})

describe("PUT /api/v1/openapi/[slug]", () => {
  it("publishes with an admin-scoped editor key", async () => {
    apiKey(["read", "admin"], "editor")
    const res = await PUT(put('{"openapi":"3.1.0"}'), params("payments-api"))
    expect(res.status).toBe(200)
    expect(mocks.syncOpenApiSource).toHaveBeenCalledWith(
      {},
      { workspaceId: "ws", slug: "payments-api", raw: '{"openapi":"3.1.0"}', syncedBy: "api" },
    )
  })

  it("writes the definition to a linked ReadMe-format repository and reports it", async () => {
    apiKey(["admin"], "admin")
    mocks.writeToRepository.mockResolvedValue({
      committed: true,
      path: "reference/payments-api.json",
      commit_sha: "abc123",
    })
    const res = await PUT(put('{"openapi":"3.1.0"}'), params("payments-api"))
    expect(res.status).toBe(200)
    expect(mocks.writeToRepository).toHaveBeenCalledWith({}, "ws", "payments-api")
    expect(await res.json()).toMatchObject({
      slug: "payments-api",
      github: { committed: true, path: "reference/payments-api.json", commit_sha: "abc123" },
    })
  })

  it("does not touch GitHub when the definition is rejected", async () => {
    apiKey(["admin"], "admin")
    mocks.syncOpenApiSource.mockResolvedValue({ ok: false, issues: [{ path: "x", message: "bad" }] })
    expect((await PUT(put("{}"), params("payments-api"))).status).toBe(422)
    expect(mocks.writeToRepository).not.toHaveBeenCalled()
  })

  it("passes through authentication failures", async () => {
    mocks.authenticateBearer.mockResolvedValue({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    })
    expect((await PUT(put(), params("payments-api"))).status).toBe(401)
    expect(mocks.syncOpenApiSource).not.toHaveBeenCalled()
  })

  it.each([
    ["a read-only key", () => apiKey(["read"], "editor")],
    ["a viewer key", () => apiKey(["read", "admin"], "viewer")],
    [
      "a browser session token",
      () => mocks.authenticateBearer.mockResolvedValue({ data: { kind: "supabase", userId: "u", workspaceId: "ws" } }),
    ],
  ])("refuses %s", async (_label, setup) => {
    setup()
    expect((await PUT(put(), params("payments-api"))).status).toBe(403)
    expect(mocks.syncOpenApiSource).not.toHaveBeenCalled()
  })

  it("rejects unsafe names before authenticating", async () => {
    expect((await PUT(put(), params("Payments API"))).status).toBe(400)
    expect(mocks.authenticateBearer).not.toHaveBeenCalled()
  })

  it("rejects oversized uploads by Content-Length", async () => {
    apiKey(["read", "admin"], "editor")
    const res = await PUT(put("{}", { "content-length": String(3 * 1024 * 1024) }), params("payments-api"))
    expect(res.status).toBe(413)
  })

  it("returns 422 with the parser's issues for an invalid spec", async () => {
    apiKey(["read", "admin"], "admin")
    mocks.syncOpenApiSource.mockResolvedValue({ ok: false, issues: [{ path: "x", message: "must be valid JSON" }] })
    const res = await PUT(put("nope"), params("payments-api"))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ issues: [{ message: "must be valid JSON" }] })
  })
})

describe("DELETE /api/v1/openapi/[slug]", () => {
  it("removes a source with an admin-scoped key", async () => {
    apiKey(["read", "admin"], "admin")
    mocks.deleteOpenApiSource.mockResolvedValue({ removed: 60 })
    const res = await DELETE(put(), params("payments-api"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ removed: 60 })
  })

  it("deletes the definition's file from a linked ReadMe-format repository", async () => {
    apiKey(["admin"], "admin")
    mocks.deleteOpenApiSource.mockResolvedValue({ removed: 3 })
    mocks.repositoryPath.mockResolvedValue("reference/payments-api.yaml")
    mocks.removeFromRepository.mockResolvedValue({
      committed: true,
      path: "reference/payments-api.yaml",
      commit_sha: "def456",
    })
    const res = await DELETE(put(), params("payments-api"))
    // The path is read before the source row is gone.
    expect(mocks.repositoryPath.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteOpenApiSource.mock.invocationCallOrder[0]!,
    )
    expect(mocks.removeFromRepository).toHaveBeenCalledWith({}, "ws", {
      slug: "payments-api",
      repoPath: "reference/payments-api.yaml",
    })
    expect(await res.json()).toEqual({
      removed: 3,
      github: { committed: true, path: "reference/payments-api.yaml", commit_sha: "def456" },
    })
  })
})
