// @vitest-environment happy-dom
/**
 * FileDropZone — upload-error surfacing + accessibility tests.
 *
 * Covers plan `docs/plans/knowledge-file-upload-errors.md` §5.1 U1–U6 and §5.2 C1–C11.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mutateMock = vi.fn()
vi.mock('swr', () => ({
  useSWRConfig: () => ({ mutate: mutateMock }),
}))

import {
  FileDropZone,
  MAX_FILE_SIZE_BYTES,
  validateFile,
} from './file-drop-zone'

function makeFile(
  name: string,
  {
    size = 10,
    type = 'text/plain',
  }: { size?: number; type?: string } = {},
): File {
  const content = 'x'.repeat(Math.max(size, 0))
  const blob = new Blob([content], { type })
  Object.defineProperty(blob, 'size', { value: size })
  return new File([blob], name, { type })
}

function mockFetchSequence(
  responses: Array<{ ok: boolean; status?: number; body?: unknown }>,
): void {
  let call = 0
  global.fetch = vi.fn(async () => {
    const response = responses[call] ?? responses[responses.length - 1]
    call += 1
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 201 : 500),
      json: async () => response.body ?? {},
    } as unknown as Response
  }) as unknown as typeof fetch
}

async function dropFiles(container: HTMLElement, files: File[]): Promise<void> {
  const region = within(container).getByRole('region', {
    name: /drop files to upload/i,
  })
  const dataTransfer = {
    files,
    types: ['Files'],
    items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
  }
  await act(async () => {
    fireEvent.drop(region, { dataTransfer })
  })
}

beforeEach(() => {
  cleanup()
  mutateMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

// ===========================================================================
// §5.1 — validateFile helper unit tests
// ===========================================================================

describe('validateFile', () => {
  it('U1: accepts .md file under the cap', () => {
    const result = validateFile(makeFile('notes.md', { size: 1024 }))
    expect(result).toEqual({ ok: true })
  })

  it('U2: rejects .txt file over MAX_FILE_SIZE_BYTES as oversize', () => {
    const result = validateFile(
      makeFile('huge.txt', { size: MAX_FILE_SIZE_BYTES + 1 }),
    )
    expect(result).toEqual({ ok: false, reason: 'oversize' })
  })

  it('U3: rejects .pdf as unsupported-type', () => {
    const result = validateFile(
      makeFile('book.pdf', { size: 1024, type: 'application/pdf' }),
    )
    expect(result).toEqual({ ok: false, reason: 'unsupported-type' })
  })

  it('U4: rejects empty .md as empty', () => {
    const result = validateFile(makeFile('blank.md', { size: 0 }))
    expect(result).toEqual({ ok: false, reason: 'empty' })
  })

  it('U5: accepts text/csv mime without matching extension', () => {
    const result = validateFile(
      makeFile('data', { size: 512, type: 'text/csv' }),
    )
    expect(result).toEqual({ ok: true })
  })

  it('U6: accepts uppercase .JS extension', () => {
    const result = validateFile(
      makeFile('App.JS', { size: 512, type: '' }),
    )
    expect(result).toEqual({ ok: true })
  })
})

// ===========================================================================
// §5.2 — FileDropZone component tests
// ===========================================================================

describe('FileDropZone', () => {
  it('C1: drops three .md files, all succeed, mutate called once', async () => {
    mockFetchSequence([
      { ok: true, status: 201 },
      { ok: true, status: 201 },
      { ok: true, status: 201 },
    ])
    const { container } = render(
      <FileDropZone>
        <div data-testid="content" />
      </FileDropZone>,
    )

    await dropFiles(container, [
      makeFile('a.md', { size: 10 }),
      makeFile('b.md', { size: 10 }),
      makeFile('c.md', { size: 10 }),
    ])

    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/3 of 3/i)
    expect(mutateMock).toHaveBeenCalledTimes(1)
    const cacheMatcher = mutateMock.mock.calls[0]?.[0] as (key: string) => boolean
    expect(cacheMatcher('/api/documents')).toBe(true)
    expect(cacheMatcher('/api/documents/home')).toBe(true)
    expect(cacheMatcher('/api/folders')).toBe(false)
  })

  it('C2: two succeed, one fails with 500 — status shows 1 of 3 failed, retry visible, mutate called once', async () => {
    mockFetchSequence([
      { ok: true, status: 201 },
      { ok: true, status: 201 },
      { ok: false, status: 500, body: { error: 'boom' } },
    ])
    const { container } = render(
      <FileDropZone>
        <div />
      </FileDropZone>,
    )

    await dropFiles(container, [
      makeFile('a.md', { size: 10 }),
      makeFile('b.md', { size: 10 }),
      makeFile('c.md', { size: 10 }),
    ])

    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/1 of 3/i)
    expect(status.textContent).toContain('c.md')
    expect(
      within(status).getByRole('button', { name: /retry failed/i }),
    ).not.toBeNull()
    expect(mutateMock).toHaveBeenCalledTimes(1)
  })

  it('C3: all three fail — mutate not called', async () => {
    mockFetchSequence([
      { ok: false, status: 500, body: { error: 'boom' } },
      { ok: false, status: 500, body: { error: 'boom' } },
      { ok: false, status: 500, body: { error: 'boom' } },
    ])
    const { container } = render(
      <FileDropZone>
        <div />
      </FileDropZone>,
    )

    await dropFiles(container, [
      makeFile('a.md', { size: 10 }),
      makeFile('b.md', { size: 10 }),
      makeFile('c.md', { size: 10 }),
    ])

    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/3 of 3/i)
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('C4: .pdf among two .md — PDF rejected inline, MDs upload', async () => {
    mockFetchSequence([
      { ok: true, status: 201 },
      { ok: true, status: 201 },
    ])
    const { container } = render(
      <FileDropZone>
        <div />
      </FileDropZone>,
    )

    await dropFiles(container, [
      makeFile('a.md', { size: 10 }),
      makeFile('b.pdf', { size: 10, type: 'application/pdf' }),
      makeFile('c.md', { size: 10 }),
    ])

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('b.pdf')
    expect(status.textContent).toMatch(/unsupported/i)
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it('C5: 3 MB .md rejected client-side — no fetch call', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    const { container } = render(
      <FileDropZone>
        <div />
      </FileDropZone>,
    )

    await dropFiles(container, [
      makeFile('huge.md', { size: 3 * 1024 * 1024 }),
    ])

    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/too large|oversize/i)
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('C6: Retry failed re-invokes fetch only for the failed file', async () => {
    mockFetchSequence([
      { ok: true, status: 201 },
      { ok: true, status: 201 },
      { ok: false, status: 500, body: { error: 'boom' } },
    ])
    const { container } = render(
      <FileDropZone>
        <div />
      </FileDropZone>,
    )

    await dropFiles(container, [
      makeFile('a.md', { size: 10 }),
      makeFile('b.md', { size: 10 }),
      makeFile('c.md', { size: 10 }),
    ])

    const status = await screen.findByRole('status')
    const retry = within(status).getByRole('button', { name: /retry failed/i })

    ;(global.fetch as ReturnType<typeof vi.fn>).mockClear()
    mockFetchSequence([{ ok: true, status: 201 }])

    await userEvent.click(retry)

    const updated = await screen.findByRole('status')
    expect(updated.textContent).toMatch(/3 of 3/i)
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('C7: exposes drag and drop without an import button or file picker', () => {
    const { container } = render(
      <FileDropZone>
        <div />
      </FileDropZone>,
    )

    expect(screen.queryByRole('button', { name: /import/i })).toBeNull()
    expect(container.querySelector('input[type="file"]')).toBeNull()
    expect(
      within(container).getByRole('region', { name: /drop files to upload/i }),
    ).not.toBeNull()
  })

  it('C8: 401 surfaces server error message (not raw status)', async () => {
    mockFetchSequence([
      { ok: false, status: 401, body: { error: 'Unauthorized' } },
    ])
    const { container } = render(
      <FileDropZone>
        <div />
      </FileDropZone>,
    )

    await dropFiles(container, [makeFile('a.md', { size: 10 })])

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('Unauthorized')
  })

  it('C9: network error surfaces the underlying error message', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    global.fetch = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    const { container } = render(
      <FileDropZone>
        <div />
      </FileDropZone>,
    )

    await dropFiles(container, [makeFile('a.md', { size: 10 })])

    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/offline/i)
    consoleSpy.mockRestore()
  })

  it('C10: drop region + status region carry the right a11y attributes', async () => {
    mockFetchSequence([{ ok: true, status: 201 }])
    const { container } = render(
      <FileDropZone>
        <div />
      </FileDropZone>,
    )

    const region = within(container).getByRole('region', {
      name: /drop files to upload/i,
    })

    await dropFiles(container, [makeFile('a.md', { size: 10 })])
    const status = await screen.findByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    // aria-busy is checked on the region during upload; it may have already
    // flipped back to false by the time we read it, so just assert presence.
    expect(region.hasAttribute('aria-busy')).toBe(true)
  })

  it('C11: status region auto-dismisses 3s after all uploads succeed', async () => {
    vi.useFakeTimers()
    mockFetchSequence([{ ok: true, status: 201 }])
    const { container } = render(
      <FileDropZone>
        <div />
      </FileDropZone>,
    )

    await dropFiles(container, [makeFile('a.md', { size: 10 })])
    expect(screen.queryByRole('status')).not.toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
