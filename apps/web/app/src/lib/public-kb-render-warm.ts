import "server-only"

import { after } from "next/server"

/**
 * Render a just-saved published body in the background (after the response is
 * sent) so the next portal view finds finished HTML: render on publish, not on
 * view. The renderer (jsdom + Shiki) is imported lazily inside the callback so
 * the save route's own startup cost is unchanged. Failures only cost the
 * optimization — the view path still renders on demand.
 */
export function warmPublicRender(content: string): void {
  if (!content.trim()) return
  try {
    after(async () => {
      try {
        const { renderPublicHtmlCached } = await import(
          "@/lib/public-kb-render-cache"
        )
        await renderPublicHtmlCached(content)
      } catch (err) {
        console.warn("[Bread] public render warm-up failed:", err)
      }
    })
  } catch {
    // `after` is only available inside a request scope.
  }
}
