// @vitest-environment happy-dom
/**
 * usePortalBuilderChat — checkpoint-restore truncation.
 *
 * The portal builder's "Restore checkpoint" rolls the transcript back to the
 * restored turn. That cut has to hold in three places or the removed messages
 * come back: the panel's own list, this hook's list (which the panel re-adopts
 * whenever it rehydrates), and storage.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, act, cleanup, waitFor } from "@testing-library/react"
import { usePortalBuilderChat } from "./use-portal-builder-chat"

const CONVERSATION_ID = "conversation-1"

function storedMessage(id: string, role: "user" | "assistant", text: string) {
  return { id, role, content: text, parts: [{ type: "text", text }] }
}

// Four messages: two exchanges. Restoring the first user turn keeps one.
const STORED = [
  storedMessage("m1", "user", "first ask"),
  storedMessage("m2", "assistant", "first reply"),
  storedMessage("m3", "user", "second ask"),
  storedMessage("m4", "assistant", "second reply"),
]

let deleteCalls: string[] = []
// When `holdDetailLoad` is set, the transcript GET parks until released, so a
// truncate can be made to land while the initial load is still in flight.
// `detailParked` resolves once the handler has actually parked — the release
// function does not exist before then.
let holdDetailLoad = false
let releaseDetailLoad: (() => void) | null = null
let detailParked: Promise<void> = Promise.resolve()
let markDetailParked: () => void = () => {}

function mockFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "DELETE") {
        deleteCalls.push(url)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url.includes("/api/conversations?")) {
        return new Response(JSON.stringify([{ id: CONVERSATION_ID }]), {
          status: 200,
        })
      }
      if (url.includes(`/api/conversations/${CONVERSATION_ID}`)) {
        if (holdDetailLoad) {
          await new Promise<void>((resolve) => {
            releaseDetailLoad = resolve
            markDetailParked()
          })
        }
        return new Response(JSON.stringify({ messages: STORED }), { status: 200 })
      }
      return new Response("{}", { status: 200 })
    }),
  )
}

type Hook = ReturnType<typeof usePortalBuilderChat>

function renderHookUnderTest(): {
  current: () => Hook
  unmount: () => void
} {
  let latest: Hook | null = null
  function Harness(): null {
    latest = usePortalBuilderChat("help", "ws1")
    return null
  }
  const view = render(<Harness />)
  return {
    current: () => {
      if (!latest) throw new Error("hook did not render")
      return latest
    },
    unmount: view.unmount,
  }
}

describe("usePortalBuilderChat truncate", () => {
  beforeEach(() => {
    deleteCalls = []
    holdDetailLoad = false
    releaseDetailLoad = null
    detailParked = new Promise<void>((resolve) => {
      markDetailParked = resolve
    })
    mockFetch()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("loads the persisted transcript", async () => {
    const hook = renderHookUnderTest()
    await waitFor(() => expect(hook.current().ready).toBe(true))
    expect(hook.current().turns.map((turn) => turn.text)).toEqual([
      "first ask",
      "first reply",
      "second ask",
      "second reply",
    ])
  })

  // Without this the panel's next rehydration (a project switch and back)
  // re-adopts the hook's stale list and the restored-away text reappears.
  it("drops its own turns past the cut, not just storage's", async () => {
    const hook = renderHookUnderTest()
    await waitFor(() => expect(hook.current().ready).toBe(true))

    await act(async () => {
      await hook.current().truncate(1)
    })

    expect(hook.current().turns.map((turn) => turn.text)).toEqual(["first ask"])
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0]).toContain("keep=1")
  })

  // A transcript GET that was already in flight when the cut happened returns
  // the PRE-cut rows. Adopting that response wholesale would put the
  // restored-away turns straight back on screen.
  it("clamps a load still in flight when the cut lands", async () => {
    holdDetailLoad = true
    const hook = renderHookUnderTest()
    // Park mid-load: the transcript GET has been issued but not answered.
    await act(async () => {
      await detailParked
    })
    expect(hook.current().turns).toHaveLength(0)
    expect(hook.current().ready).toBe(false)

    await act(async () => {
      await hook.current().truncate(1)
    })

    // Release the stale load — it resolves with all four stored messages.
    // waitFor does its own act wrapping; nesting it inside one deadlocks.
    releaseDetailLoad?.()
    await waitFor(() => expect(hook.current().ready).toBe(true))

    expect(hook.current().turns.map((turn) => turn.text)).toEqual(["first ask"])
  })

  it("never lets a truncate widen an earlier, deeper cut", async () => {
    const hook = renderHookUnderTest()
    await waitFor(() => expect(hook.current().ready).toBe(true))

    await act(async () => {
      await hook.current().truncate(1)
    })
    await act(async () => {
      await hook.current().truncate(3)
    })

    expect(hook.current().turns.map((turn) => turn.text)).toEqual(["first ask"])
  })
})

// ---------------------------------------------------------------------------
// Remount survival.
//
// A checkpoint restore also saves the restored layout, and that save briefly
// swaps the builder to its skeleton — unmounting the panel and this hook while
// the truncate DELETE is still in flight. Component state and refs die with it,
// so without a cut that outlives the remount the fresh instance re-reads the
// pre-cut rows and the removed messages come straight back on screen. This is
// the path that survived the first two fixes.
// ---------------------------------------------------------------------------
describe("usePortalBuilderChat cut survives a remount", () => {
  beforeEach(() => {
    deleteCalls = []
    holdDetailLoad = false
    releaseDetailLoad = null
    detailParked = new Promise<void>((resolve) => {
      markDetailParked = resolve
    })
    mockFetch()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("does not resurrect dropped turns when remounted mid-DELETE", async () => {
    const first = renderHookUnderTest()
    await waitFor(() => expect(first.current().ready).toBe(true))
    expect(first.current().turns).toHaveLength(4)

    // Restore: cut to one turn, then the save unmounts the panel before the
    // DELETE has landed. `void` mirrors the panel's fire-and-forget call.
    const cutting = first.current().truncate(1)
    first.unmount()

    // The remounted panel loads the thread again. Storage may still hold all
    // four rows, but the user must not see the restored-away turns return.
    const second = renderHookUnderTest()
    await waitFor(() => expect(second.current().ready).toBe(true))
    expect(second.current().turns.map((turn) => turn.text)).toEqual(["first ask"])

    await cutting
  })

  it("lets the thread grow again once the cut has landed", async () => {
    const first = renderHookUnderTest()
    await waitFor(() => expect(first.current().ready).toBe(true))
    await act(async () => {
      await first.current().truncate(1)
    })
    first.unmount()

    // The cut is settled, so a later mount reflects storage as-is rather than
    // clamping forever — new messages have to be able to extend the thread.
    const second = renderHookUnderTest()
    await waitFor(() => expect(second.current().ready).toBe(true))
    expect(second.current().turns).toHaveLength(4)
  })
})

