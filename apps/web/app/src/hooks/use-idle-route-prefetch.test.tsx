// @vitest-environment happy-dom
import { render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const prefetch = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch }),
}))

import {
  BULK_PRELOAD_LIMIT,
  resetBulkRoutePrefetch,
  useBulkRoutePrefetch,
} from "./use-idle-route-prefetch"

function Probe({ hrefs, listKey }: { hrefs: string[]; listKey: string }) {
  useBulkRoutePrefetch(hrefs, listKey)
  return null
}

const hrefsOf = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `/p/acme/doc/page-${i}`)

describe("useBulkRoutePrefetch", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    prefetch.mockClear()
    resetBulkRoutePrefetch()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("waits for the page to settle, then prefetches the list in order", () => {
    render(<Probe hrefs={hrefsOf(10)} listKey="a" />)
    expect(prefetch).not.toHaveBeenCalled()

    vi.runAllTimers()

    expect(prefetch.mock.calls.map((call) => call[0])).toEqual(hrefsOf(10))
    expect(prefetch.mock.calls[0][1]).toEqual({ kind: "full" })
  })

  it("caps a pass so a very large portal cannot flood the server", () => {
    render(<Probe hrefs={hrefsOf(BULK_PRELOAD_LIMIT + 40)} listKey="a" />)
    vi.runAllTimers()

    expect(prefetch).toHaveBeenCalledTimes(BULK_PRELOAD_LIMIT)
  })

  it("does not repeat a fresh pass when the reader navigates", () => {
    const first = render(<Probe hrefs={hrefsOf(6)} listKey="a" />)
    vi.runAllTimers()
    first.unmount()
    prefetch.mockClear()

    // Same list, re-ordered around the new page.
    render(<Probe hrefs={hrefsOf(6).reverse()} listKey="a" />)
    vi.runAllTimers()

    expect(prefetch).not.toHaveBeenCalled()
  })

  it("stops when the reader leaves mid-pass and resumes on the next page", () => {
    const first = render(<Probe hrefs={hrefsOf(12)} listKey="a" />)
    // Start delay (1500ms) plus the idle fallback (200ms): one batch has gone.
    vi.advanceTimersByTime(1800)
    const sent = prefetch.mock.calls.length
    expect(sent).toBeGreaterThan(0)
    expect(sent).toBeLessThan(12)
    first.unmount()
    vi.runAllTimers()
    expect(prefetch).toHaveBeenCalledTimes(sent)

    render(<Probe hrefs={hrefsOf(12)} listKey="a" />)
    vi.runAllTimers()
    expect(prefetch.mock.calls.length).toBe(sent + 12)
  })
})
