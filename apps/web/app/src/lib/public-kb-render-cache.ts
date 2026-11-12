import "server-only"

import { createHash } from "node:crypto"
import { unstable_cache } from "next/cache"
import { renderPublicHtml } from "@/lib/public-kb-render"
import {
  renderApiReferenceHtml,
  withCodeSampleGroups,
} from "@/lib/portal/api-reference-html"

// ---------------------------------------------------------------------------
// Render-once cache for public document bodies.
//
// renderPublicHtml (jsdom parse + Shiki highlighting + sanitization) is a pure
// function of the stored content, but it is expensive: ~4ms for prose, ~55ms
// for a doc with a handful of code blocks, 600ms+ for a code-heavy reference
// page — and the portal used to pay it on every single view.
//
// Entries are content-addressed (sha256 of the body), so there is nothing to
// invalidate: an edited document simply hashes to a new key. Two layers:
//   1. an in-process LRU for warm function instances (no I/O at all), and
//   2. Next's data cache (shared across instances and requests).
// The save route warms the cache for published documents (see
// public-kb-render-warm.ts), so in the common case the first reader after an edit
// already gets finished HTML: render on publish, not on view.
// ---------------------------------------------------------------------------

// The key includes the deployment so a release that changes the renderer or
// sanitizer never serves HTML produced by older code. Without a deployment id
// (local dev, other hosts) the revalidate window below is the safety net.
const RENDERER_REVISION =
  process.env.VERCEL_DEPLOYMENT_ID ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  "local"
const PERSISTED_SECONDS = 60 * 60 * 24
export const PUBLIC_RENDER_CACHE_TAG = "public-kb-render"

// Bound the in-process layer by total characters, not entry count: one
// code-heavy document renders to several hundred KB of highlighted markup.
const MEMORY_BUDGET_CHARS = 24 * 1024 * 1024
const memory = new Map<string, { value: unknown; size: number }>()
let memoryChars = 0
const inFlight = new Map<string, Promise<unknown>>()

function memoryGet<T>(key: string): T | undefined {
  const hit = memory.get(key)
  if (!hit) return undefined
  // Refresh recency.
  memory.delete(key)
  memory.set(key, hit)
  return hit.value as T
}

function memorySet(key: string, value: unknown, size: number): void {
  if (size > MEMORY_BUDGET_CHARS / 4) return
  const previous = memory.get(key)
  if (previous) {
    memoryChars -= previous.size
    memory.delete(key)
  }
  memory.set(key, { value, size })
  memoryChars += size
  for (const [oldestKey, oldest] of memory) {
    if (memoryChars <= MEMORY_BUDGET_CHARS) break
    memory.delete(oldestKey)
    memoryChars -= oldest.size
  }
}

interface CachedRenderOptions {
  /**
   * Skip the shared data cache and keep the result in process memory only.
   * Used for builder previews, where every autosaved draft is a new body and
   * persisting each one would just fill the cache with throwaway entries.
   */
  memoryOnly?: boolean
}

async function cachedRender<T>(
  kind: string,
  content: string,
  render: (content: string) => T,
  sizeOf: (value: T) => number,
  options: CachedRenderOptions = {},
): Promise<T> {
  const hash = createHash("sha256").update(content).digest("hex")
  const key = `${kind}:${RENDERER_REVISION}:${hash}`

  const warm = memoryGet<T>(key)
  if (warm !== undefined) return warm

  const pending = inFlight.get(key)
  if (pending) return pending as Promise<T>

  const run = (async (): Promise<T> => {
    let value: T
    if (options.memoryOnly) {
      value = render(content)
    } else {
      try {
        value = await unstable_cache(
          async () => render(content),
          ["public-kb-render", kind, RENDERER_REVISION, hash],
          { revalidate: PERSISTED_SECONDS, tags: [PUBLIC_RENDER_CACHE_TAG] },
        )()
      } catch (err) {
        // The data cache is an optimization. Outside a Next request scope, or
        // if the cache backend is unavailable, render directly.
        console.warn("[Bread] public render cache unavailable:", err)
        value = render(content)
      }
    }
    memorySet(key, value, sizeOf(value))
    return value
  })()

  inFlight.set(key, run)
  try {
    return await run
  } finally {
    inFlight.delete(key)
  }
}

/** Cached equivalent of `renderPublicHtml`. Same output, rendered once per body. */
export function renderPublicHtmlCached(
  content: string,
  options?: CachedRenderOptions,
): Promise<string> {
  return cachedRender(
    "html",
    content,
    renderPublicHtml,
    (html) => html.length,
    options,
  )
}

/**
 * Cached `withCodeSampleGroups(renderPublicHtml(content))`: endpoint documents
 * shown through the ordinary doc view get a language picker on their request
 * samples, which is a second jsdom pass over the rendered body.
 */
export function renderPublicHtmlWithCodeGroupsCached(
  content: string,
  options?: CachedRenderOptions,
): Promise<string> {
  return cachedRender(
    "html-code-groups",
    content,
    (body) => withCodeSampleGroups(renderPublicHtml(body)),
    (html) => html.length,
    options,
  )
}

/** Cached equivalent of `renderApiReferenceHtml`. */
export function renderApiReferenceHtmlCached(
  content: string,
  options?: CachedRenderOptions,
): Promise<{ html: string; examplesHtml: string }> {
  return cachedRender(
    "api-reference",
    content,
    renderApiReferenceHtml,
    (value) => value.html.length + value.examplesHtml.length,
    options,
  )
}
