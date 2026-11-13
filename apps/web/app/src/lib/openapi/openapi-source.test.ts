import { beforeEach, describe, expect, it, vi } from "vitest"

// The folder/index helpers are shared with the GitHub sync and talk to the DB;
// stub them so this test covers the upload logic itself.
const folders = vi.hoisted(() => ({ created: [] as Array<{ name: string; parentId: string | null }> }))
vi.mock("@/lib/github/github-hosted-docs", () => ({
  DOCUMENT_SYNC_CONCURRENCY: 4,
  hostedContentHash: (content: string) => `h${content.length}`,
  hasEquivalentHostedContent: (a: unknown, b: string) => a === b,
  mapWithConcurrency: async <T, R>(items: T[], _n: number, fn: (item: T) => Promise<R>) =>
    Promise.all(items.map(fn)),
  refreshHostedDocumentIndex: vi.fn(async () => {}),
  upsertOpenApiFolder: vi.fn(async (_admin: unknown, input: { name: string; parentId: string | null }) => {
    folders.created.push({ name: input.name, parentId: input.parentId })
    return `folder:${input.name}`
  }),
}))
const update = vi.hoisted(() => ({ fn: vi.fn(async () => ({ applied: true })) }))
vi.mock("@/lib/github/github-hosted-document-update", () => ({
  applyGitHubHostedDocumentUpdate: update.fn,
}))

import {
  OPENAPI_UPLOAD_OPERATION_KIND,
  parseOpenApiUpload,
  sourceFolderName,
  syncOpenApiSource,
} from "./openapi-source"

function spec(paths: Record<string, Record<string, unknown>>, version = "1.0.0"): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Breeze API", version },
    tags: [{ name: "Payments" }, { name: "Refunds" }],
    paths,
  })
}

const BASE = spec({
  "/payments": {
    get: { tags: ["Payments"], summary: "List payments", operationId: "listPayments" },
    post: { tags: ["Payments"], summary: "Create a payment", operationId: "createPayment" },
  },
  "/refunds": { post: { tags: ["Refunds"], summary: "Create a refund", operationId: "createRefund" } },
})

type Row = Record<string, unknown>

function fakeAdmin() {
  const db: Record<string, Row[]> = { documents: [], openapi_sources: [] }
  let id = 0
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    let op: "select" | "insert" | "update" | "upsert" = "select"
    let payload: Row = {}
    const matches = () => db[table]!.filter((r) => filters.every((f) => f(r)))
    const run = () => {
      if (op === "insert") {
        const row = { id: `doc${++id}`, deleted_at: null, ...payload }
        db[table]!.push(row)
        return { data: row, error: null }
      }
      if (op === "update") {
        matches().forEach((r) => Object.assign(r, payload))
        return { data: null, error: null }
      }
      if (op === "upsert") {
        const existing = db[table]!.find(
          (r) => r.workspace_id === payload.workspace_id && r.slug === payload.slug,
        )
        if (existing) Object.assign(existing, payload)
        else db[table]!.push({ ...payload })
        return { data: null, error: null }
      }
      return { data: matches(), error: null }
    }
    const b = {
      select: () => b,
      insert: (row: Row) => ((op = "insert"), (payload = row), b),
      update: (patch: Row) => ((op = "update"), (payload = patch), b),
      upsert: (row: Row) => ((op = "upsert"), (payload = row), Promise.resolve(run())),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      contains: (c: string, v: Row) =>
        (filters.push((r) => Object.entries(v).every(([k, x]) => (r[c] as Row | undefined)?.[k] === x)), b),
      single: async () => run(),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    }
    return b
  }
  return { client: { from } as never, db }
}

const live = (db: Record<string, Row[]>) => db.documents!.filter((d) => d.deleted_at === null)

beforeEach(() => {
  folders.created = []
  vi.clearAllMocks()
})

describe("parseOpenApiUpload", () => {
  it("rejects names that are not URL-safe", () => {
    expect(parseOpenApiUpload("Payments API", BASE).spec).toBeNull()
    expect(parseOpenApiUpload("../x", BASE).spec).toBeNull()
  })

  it("gives upload pages their own openapi- slug prefix", () => {
    const { spec: parsed } = parseOpenApiUpload("payments-api", BASE)
    expect(parsed?.operations).toHaveLength(3)
    expect(parsed?.operations.every((o) => o.publicSlug.startsWith("openapi-"))).toBe(true)
  })

  it("reports invalid specs instead of throwing", () => {
    expect(parseOpenApiUpload("x", "not json").issues[0]?.message).toMatch(/JSON or YAML object/)
    expect(parseOpenApiUpload("x", "{ broken").issues[0]?.message).toMatch(/valid JSON or YAML/)
    expect(parseOpenApiUpload("x", JSON.stringify({ openapi: "3.1.0", paths: {} })).spec).toBeNull()
  })
})

describe("syncOpenApiSource", () => {
  it("creates one page per operation under a spec folder and a folder per tag", async () => {
    const { client, db } = fakeAdmin()
    const out = await syncOpenApiSource(client, { workspaceId: "ws", slug: "payments-api", raw: BASE, syncedBy: "api" })

    expect(out).toMatchObject({ ok: true, result: { operationCount: 3, created: 3, updated: 0, removed: 0 } })
    expect(live(db)).toHaveLength(3)
    expect(live(db)[0]).toMatchObject({
      author: "OpenAPI",
      status: "Published",
      source_metadata: expect.objectContaining({
        kind: OPENAPI_UPLOAD_OPERATION_KIND,
        openapi_source_slug: "payments-api",
      }),
    })
    expect(folders.created[0]).toEqual({ name: sourceFolderName("payments-api"), parentId: null })
    expect(new Set(folders.created.slice(1).map((f) => f.parentId))).toEqual(
      new Set([`folder:${sourceFolderName("payments-api")}`]),
    )
    expect(db.openapi_sources).toEqual([
      expect.objectContaining({ slug: "payments-api", title: "Breeze API", operation_count: 3, last_synced_by: "api" }),
    ])
  })

  it("on re-upload updates changed pages, adds new ones and removes deleted ones", async () => {
    const { client, db } = fakeAdmin()
    await syncOpenApiSource(client, { workspaceId: "ws", slug: "payments-api", raw: BASE, syncedBy: "api" })

    const next = spec(
      {
        "/payments": {
          get: { tags: ["Payments"], summary: "List payments", operationId: "listPayments" },
          post: { tags: ["Payments"], summary: "Create a payment (v2)", operationId: "createPayment" },
        },
        "/payouts": { post: { tags: ["Payments"], summary: "Create a payout", operationId: "createPayout" } },
      },
      "1.1.0",
    )
    const out = await syncOpenApiSource(client, { workspaceId: "ws", slug: "payments-api", raw: next, syncedBy: "api" })

    expect(out).toMatchObject({ ok: true, result: { created: 1, updated: 1, removed: 1 } })
    expect(update.fn).toHaveBeenCalledTimes(1)
    expect(live(db).map((d) => d.title).sort()).toEqual(["Create a payment", "Create a payout", "List payments"])
    expect(db.openapi_sources![0]).toMatchObject({ version: "1.1.0", operation_count: 3 })
  })

  it("never touches another source's pages", async () => {
    const { client, db } = fakeAdmin()
    await syncOpenApiSource(client, { workspaceId: "ws", slug: "api", raw: BASE, syncedBy: "api" })
    await syncOpenApiSource(client, { workspaceId: "ws", slug: "api-v2", raw: BASE, syncedBy: "api" })
    const onlyOne = spec({ "/payments": { get: { tags: ["Payments"], summary: "List payments" } } })
    await syncOpenApiSource(client, { workspaceId: "ws", slug: "api", raw: onlyOne, syncedBy: "api" })

    const bySlug = (slug: string) =>
      live(db).filter((d) => (d.source_metadata as Row).openapi_source_slug === slug)
    expect(bySlug("api")).toHaveLength(1)
    expect(bySlug("api-v2")).toHaveLength(3)
  })

  it("writes nothing for an invalid spec", async () => {
    const { client, db } = fakeAdmin()
    const out = await syncOpenApiSource(client, { workspaceId: "ws", slug: "x", raw: "{}", syncedBy: "api" })
    expect(out.ok).toBe(false)
    expect(db.documents).toHaveLength(0)
    expect(folders.created).toHaveLength(0)
  })
})
