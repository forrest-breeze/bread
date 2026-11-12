import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  BREEZE_WORKSPACE_SLUG,
  ensureBreezeWorkspaceMember,
} from "./breeze-workspace"

type Row = Record<string, unknown>

/** Minimal in-memory stand-in for the supabase-js query builder. */
function fakeAdmin(seed: Record<string, Row[]> = {}) {
  const db: Record<string, Row[]> = {
    workspaces: [],
    workspace_members: [],
    subscriptions: [],
    profiles: [],
    ...seed,
  }
  let seq = 0
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)).toISOString()

  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    let op: "select" | "insert" | "update" | "delete" = "select"
    let payload: Row = {}
    let head = false
    let order: { col: string; asc: boolean } | null = null
    let limit: number | null = null

    const rows = () => {
      let out = db[table]!.filter((r) => filters.every((f) => f(r)))
      if (order) {
        const { col, asc } = order
        out = [...out].sort((a, b) =>
          String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : asc ? 1 : -1,
        )
      }
      return limit === null ? out : out.slice(0, limit)
    }

    const run = () => {
      if (op === "insert") {
        const row: Row = { id: `${table}_${seq}`, created_at: clock(), ...payload }
        if (
          table === "workspace_members" &&
          db[table]!.some((r) => r.workspace_id === row.workspace_id && r.user_id === row.user_id)
        ) {
          return { data: null, error: { code: "23505", message: "duplicate" } }
        }
        db[table]!.push(row)
        return { data: row, error: null }
      }
      if (op === "update") {
        for (const r of rows()) Object.assign(r, payload)
        return { data: null, error: null }
      }
      if (op === "delete") {
        const doomed = new Set(rows())
        db[table] = db[table]!.filter((r) => !doomed.has(r))
        return { data: null, error: null }
      }
      const out = rows()
      return head ? { count: out.length, data: null, error: null } : { data: out, error: null }
    }

    const builder = {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (opts?.head) head = true
        return builder
      },
      insert: (row: Row) => ((op = "insert"), (payload = row), builder),
      update: (patch: Row) => ((op = "update"), (payload = patch), builder),
      delete: () => ((op = "delete"), builder),
      eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), builder),
      is: (col: string, val: unknown) =>
        (filters.push((r) => (r[col] ?? null) === val), builder),
      order: (col: string, o: { ascending: boolean }) =>
        ((order = { col, asc: o.ascending }), builder),
      limit: (n: number) => ((limit = n), builder),
      single: async () => run(),
      maybeSingle: async () => {
        const res = run() as { data: Row[] | Row | null; error: unknown }
        return { data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data, error: res.error }
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    }
    return builder
  }

  return { client: { from: query } as never, db }
}

describe("ensureBreezeWorkspaceMember", () => {
  it("creates the Breeze workspace for the first user and makes them owner", async () => {
    const { client, db } = fakeAdmin({ profiles: [{ user_id: "u1", onboarding_completed_at: null }] })

    const result = await ensureBreezeWorkspaceMember(client, "u1")

    expect(result.joined).toBe(true)
    expect(db.workspaces).toHaveLength(1)
    expect(db.workspaces![0]).toMatchObject({ slug: BREEZE_WORKSPACE_SLUG, name: "Breeze" })
    expect(db.workspace_members).toEqual([
      expect.objectContaining({ user_id: "u1", role: "owner", status: "active" }),
    ])
    expect(db.subscriptions).toHaveLength(1)
    expect(db.profiles![0]!.onboarding_completed_at).toEqual(expect.any(String))
  })

  it("adds later users to the same workspace as editors", async () => {
    const { client, db } = fakeAdmin()
    await ensureBreezeWorkspaceMember(client, "u1")
    await ensureBreezeWorkspaceMember(client, "u2")

    expect(db.workspaces).toHaveLength(1)
    expect(db.workspace_members!.map((m) => [m.user_id, m.role])).toEqual([
      ["u1", "owner"],
      ["u2", "editor"],
    ])
  })

  it("is a no-op for an existing active member", async () => {
    const { client, db } = fakeAdmin()
    await ensureBreezeWorkspaceMember(client, "u1")
    const again = await ensureBreezeWorkspaceMember(client, "u1")

    expect(again.joined).toBe(false)
    expect(db.workspace_members).toHaveLength(1)
  })

  it("reactivates an existing non-active membership instead of duplicating it", async () => {
    const { client, db } = fakeAdmin({
      workspaces: [{ id: "ws", slug: BREEZE_WORKSPACE_SLUG, created_at: "2026-01-01T00:00:00Z" }],
      workspace_members: [{ id: "m", workspace_id: "ws", user_id: "u1", role: "viewer", status: "invited" }],
    })

    await ensureBreezeWorkspaceMember(client, "u1")

    expect(db.workspace_members).toEqual([
      expect.objectContaining({ id: "m", status: "active", role: "viewer" }),
    ])
  })
})
