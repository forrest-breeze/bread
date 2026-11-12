// @vitest-environment happy-dom
/**
 * Route-segment error boundary — contract tests.
 *
 * Next.js app-router recovery story (see
 * https://nextjs.org/docs/app/building-your-application/routing/error-handling):
 *   - `global-error.tsx` catches errors in the root layout itself (~1% case).
 *   - `error.tsx` catches errors in every route segment below the root
 *     layout (~99% case of real-world React component errors).
 *
 * Without this file, route-segment errors bubble up to `global-error.tsx`
 * and render the Next.js default error page — functional, but not branded
 * and visually surprising. These tests pin the two load-bearing behaviours
 * of the custom boundary:
 *
 *   1. Fallback UI renders (user sees a real page, not the Next default).
 *   2. "Try again" refreshes server data (`router.refresh()`) *before*
 *      resetting the boundary (`reset()`). `reset()` alone re-renders the
 *      segment against the same cached server output, so a deterministic
 *      error recurs and the page appears frozen — the refresh is what
 *      actually clears data-driven failures.
 *   3. "Reload page" is an always-works hard-reload escape hatch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}))

import ErrorBoundary from './error'

beforeEach(() => {
  cleanup()
  refresh.mockClear()
})

function makeError(): Error & { digest?: string } {
  const err = new Error('boom') as Error & { digest?: string }
  err.digest = 'abc123'
  return err
}

describe('route-segment error boundary', () => {
  it('renders the fallback heading and a recovery button so the user sees a real page', () => {
    render(<ErrorBoundary error={makeError()} reset={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('refreshes server data and resets the boundary when the user clicks "Try again"', () => {
    const reset = vi.fn()
    render(<ErrorBoundary error={makeError()} reset={reset} />)
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('hard-reloads the page when the user clicks "Reload page"', () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    })
    render(<ErrorBoundary error={makeError()} reset={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /reload page/i }))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
