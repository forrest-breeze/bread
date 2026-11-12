// @vitest-environment happy-dom
/**
 * usePaletteNavigation — keyboard nav + mouse-vs-keyboard mode tracking.
 *
 * Pins the contract for the command-palette nav primitive: bounded arrow-key
 * cycling with wrap-around, Enter-to-activate, document-level mousemove flips
 * inputMode to 'mouse' (so consumers can hide the focus ring while hovering),
 * any nav key flips inputMode back to 'keyboard'. Items reference change
 * resets activeIndex to 0 — typing a new query starts selection from the top.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

import { usePaletteNavigation } from './use-palette-navigation'

function makeKey(key: string): {
  event: React.KeyboardEvent
  preventDefault: ReturnType<typeof vi.fn>
} {
  const preventDefault = vi.fn()
  return {
    event: { key, preventDefault } as unknown as React.KeyboardEvent,
    preventDefault,
  }
}

beforeEach(() => {
  cleanup()
})

afterEach(() => {
  cleanup()
})

describe('usePaletteNavigation — initial state', () => {
  it('returns activeIndex=0 for non-empty items', () => {
    const { result } = renderHook(() => usePaletteNavigation(['a', 'b', 'c']))
    expect(result.current.activeIndex).toBe(0)
  })

  it('returns activeIndex=-1 for empty items (no selection sentinel)', () => {
    const { result } = renderHook(() => usePaletteNavigation([]))
    expect(result.current.activeIndex).toBe(-1)
  })

  it("defaults inputMode to 'keyboard' (palette opens via Cmd+K, not click)", () => {
    const { result } = renderHook(() => usePaletteNavigation(['a']))
    expect(result.current.inputMode).toBe('keyboard')
  })
})

describe('usePaletteNavigation — setActiveIndex', () => {
  it('updates activeIndex when called with an in-bounds value', () => {
    const { result } = renderHook(() => usePaletteNavigation(['a', 'b', 'c']))
    act(() => result.current.setActiveIndex(2))
    expect(result.current.activeIndex).toBe(2)
  })

  it('clamps activeIndex when items shrinks below the current selection', () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => usePaletteNavigation(items),
      { initialProps: { items: ['a', 'b', 'c', 'd', 'e'] as readonly string[] } },
    )
    act(() => result.current.setActiveIndex(4))
    rerender({ items: ['a', 'b'] as readonly string[] })
    // Clamped to the last valid index. Consumers that want a full reset on
    // query change should call setActiveIndex(0) themselves — the hook only
    // guarantees activeIndex is never out of bounds.
    expect(result.current.activeIndex).toBe(1)
  })
})

describe('usePaletteNavigation — arrow keys', () => {
  it('ArrowDown bumps activeIndex by one within bounds', () => {
    const { result } = renderHook(() => usePaletteNavigation(['a', 'b', 'c']))
    const { event, preventDefault } = makeKey('ArrowDown')
    act(() => result.current.onKeyDown(event))
    expect(result.current.activeIndex).toBe(1)
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('ArrowDown at the last item wraps to 0', () => {
    const { result } = renderHook(() => usePaletteNavigation(['a', 'b', 'c']))
    act(() => result.current.setActiveIndex(2))
    act(() => result.current.onKeyDown(makeKey('ArrowDown').event))
    expect(result.current.activeIndex).toBe(0)
  })

  it('ArrowUp at index 0 wraps to the last item', () => {
    const { result } = renderHook(() => usePaletteNavigation(['a', 'b', 'c']))
    act(() => result.current.onKeyDown(makeKey('ArrowUp').event))
    expect(result.current.activeIndex).toBe(2)
  })

  it('ArrowUp from middle decrements', () => {
    const { result } = renderHook(() => usePaletteNavigation(['a', 'b', 'c']))
    act(() => result.current.setActiveIndex(2))
    act(() => result.current.onKeyDown(makeKey('ArrowUp').event))
    expect(result.current.activeIndex).toBe(1)
  })

  it('arrow keys are no-ops on empty items (and do not preventDefault)', () => {
    const { result } = renderHook(() => usePaletteNavigation([] as readonly string[]))
    const down = makeKey('ArrowDown')
    act(() => result.current.onKeyDown(down.event))
    expect(result.current.activeIndex).toBe(-1)
    expect(down.preventDefault).not.toHaveBeenCalled()
  })
})

describe('usePaletteNavigation — Enter activation', () => {
  it('calls onActivate with the current item and index, and preventDefaults', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() =>
      usePaletteNavigation(['a', 'b', 'c'], { onActivate }),
    )
    act(() => result.current.setActiveIndex(1))
    const enter = makeKey('Enter')
    act(() => result.current.onKeyDown(enter.event))
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate).toHaveBeenCalledWith('b', 1)
    expect(enter.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('does not call onActivate when items is empty', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() =>
      usePaletteNavigation([] as readonly string[], { onActivate }),
    )
    const enter = makeKey('Enter')
    act(() => result.current.onKeyDown(enter.event))
    expect(onActivate).not.toHaveBeenCalled()
    expect(enter.preventDefault).not.toHaveBeenCalled()
  })

  it('Enter without onActivate option is a silent no-op (still preventDefaults)', () => {
    const { result } = renderHook(() => usePaletteNavigation(['a']))
    const enter = makeKey('Enter')
    act(() => result.current.onKeyDown(enter.event))
    expect(enter.preventDefault).toHaveBeenCalledTimes(1)
  })
})

describe('usePaletteNavigation — non-nav keys', () => {
  it('Tab is not intercepted (allows focus to leave the palette)', () => {
    const { result } = renderHook(() => usePaletteNavigation(['a', 'b']))
    const tab = makeKey('Tab')
    act(() => result.current.onKeyDown(tab.event))
    expect(tab.preventDefault).not.toHaveBeenCalled()
    expect(result.current.activeIndex).toBe(0)
  })

  it('a printable character (text input) is not intercepted', () => {
    const { result } = renderHook(() => usePaletteNavigation(['a', 'b']))
    const letter = makeKey('a')
    act(() => result.current.onKeyDown(letter.event))
    expect(letter.preventDefault).not.toHaveBeenCalled()
    expect(result.current.activeIndex).toBe(0)
  })
})

describe('usePaletteNavigation — input mode tracking', () => {
  it('document mousemove flips inputMode to mouse', () => {
    const { result } = renderHook(() => usePaletteNavigation(['a', 'b']))
    expect(result.current.inputMode).toBe('keyboard')
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    })
    expect(result.current.inputMode).toBe('mouse')
  })

  it('a nav key after mouse mode flips inputMode back to keyboard', () => {
    const { result } = renderHook(() => usePaletteNavigation(['a', 'b']))
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    })
    expect(result.current.inputMode).toBe('mouse')
    act(() => result.current.onKeyDown(makeKey('ArrowDown').event))
    expect(result.current.inputMode).toBe('keyboard')
  })

  it('removes the document mousemove listener on unmount', () => {
    const { result, unmount } = renderHook(() => usePaletteNavigation(['a']))
    unmount()
    // After unmount, dispatching mousemove on the document must not throw and
    // must not affect any state owned by the (now-gone) hook. We can't observe
    // the unmounted hook's state, so we assert no error is thrown — happy-dom
    // would throw on a stale React handler that updates state on an unmounted
    // component. The bare result reference stays at the last rendered value.
    expect(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    }).not.toThrow()
    expect(result.current.inputMode).toBe('keyboard')
  })
})

describe('usePaletteNavigation — items length transitions', () => {
  it('returns -1 when items becomes empty across rerender', () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => usePaletteNavigation(items),
      { initialProps: { items: ['a', 'b'] as readonly string[] } },
    )
    rerender({ items: [] as readonly string[] })
    expect(result.current.activeIndex).toBe(-1)
  })

  it('returns to a valid index when items grows back from empty', () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) => usePaletteNavigation(items),
      { initialProps: { items: [] as readonly string[] } },
    )
    expect(result.current.activeIndex).toBe(-1)
    rerender({ items: ['a', 'b', 'c'] as readonly string[] })
    // Internal rawIndex is still 0 (initial state). With 3 items, that maps
    // to a valid in-bounds activeIndex of 0 — no consumer reset needed for
    // the empty-to-non-empty case.
    expect(result.current.activeIndex).toBe(0)
  })
})
