import type { PortalBlock, PortalLayout, PortalTheme } from "@/lib/portal/schema"
import { Hero } from "./hero"
import { CategoryGrid } from "./category-grid"
import { ArticleList } from "./article-list"
import { RichText } from "./rich-text"
import { Callout } from "./callout"
import { DslNodeView } from "./dsl/render"

// Renders the portal BODY (the content region beside the sidebar). The header,
// sidebar, and footer singletons are rendered by the route chrome / page.
//
// Placement convention: `full` blocks stack at the top, full width of the
// content region; remaining `main`/`aside` blocks form a two-column split
// below (main = wide left column, aside = narrow right rail). This is what
// produces the mockup's hero over a [categories | trending] split,
// and gives authored layouts (later phases) a predictable arrangement.

interface BlockContext {
  slug: string
  hrefBase?: string
  font: PortalTheme["font"]
  askAiEnabled: boolean
  variant: "default" | "docs"
}

function renderBlock(block: PortalBlock, ctx: BlockContext): React.ReactElement | null {
  switch (block.type) {
    case "hero":
      return (
        <Hero
          block={block}
          font={ctx.font}
          variant={ctx.variant === "docs" ? "docs" : undefined}
        />
      )
    case "ask-ai-search":
      // Retained in the schema so existing published layouts remain valid.
      // Search is now a single global surface in the portal header.
      return null
    case "category-grid":
      return <CategoryGrid block={block} variant={ctx.variant === "docs" ? "docs" : undefined} />
    case "article-list":
      return <ArticleList block={block} />
    case "rich-text":
      return <RichText block={block} />
    case "callout":
      return <Callout block={block} />
    default: {
      // Compile-time exhaustiveness: a new block type without a case above fails
      // to typecheck here. Unknown types are also rejected by validation first.
      const _exhaustive: never = block
      void _exhaustive
      return null
    }
  }
}

export function PortalRenderer({
  slug,
  hrefBase,
  layout,
  askAiEnabled = false,
  variant = "default",
}: {
  slug: string
  hrefBase?: string
  layout: PortalLayout
  askAiEnabled?: boolean
  variant?: "default" | "docs"
}): React.ReactElement {
  // v2: a layout with a `tree` renders from the open-ended DSL instead of the
  // fixed placement body. DslNodeView is an async server component; returning its
  // element keeps PortalRenderer a plain (sync) RSC — Next awaits the subtree.
  if (layout.tree) {
    const composites = new Map((layout.components ?? []).map((c) => [c.name, c]))
    return (
      <DslNodeView
        node={layout.tree}
        ctx={{
          slug,
          hrefBase,
          composites,
          font: layout.theme.font,
          askAiEnabled,
          variant,
        }}
      />
    )
  }

  const ctx: BlockContext = {
    slug,
    hrefBase,
    font: layout.theme.font,
    askAiEnabled,
    variant,
  }

  const body = layout.body.filter((b) => b.type !== "ask-ai-search")
  const full = body.filter((b) => b.placement === "full")
  const main = body.filter((b) => b.placement === "main")
  const aside = body.filter((b) => b.placement === "aside")
  const hasSplit = main.length > 0 && aside.length > 0

  return (
    <div className="space-y-8">
      {full.length > 0 && (
        <div className="space-y-6">
          {full.map((block) => (
            <div key={block.id}>{renderBlock(block, ctx)}</div>
          ))}
        </div>
      )}

      {hasSplit ? (
        <div className="grid gap-8 xl:grid-cols-[minmax(0,714px)_396px]">
          <div className="space-y-8">
            {main.map((block) => (
              <div key={block.id}>{renderBlock(block, ctx)}</div>
            ))}
          </div>
          <aside className="space-y-6">
            {aside.map((block) => (
              <div key={block.id}>{renderBlock(block, ctx)}</div>
            ))}
          </aside>
        </div>
      ) : (
        (main.length > 0 || aside.length > 0) && (
          <div className="space-y-6">
            {[...main, ...aside].map((block) => (
              <div key={block.id}>{renderBlock(block, ctx)}</div>
            ))}
          </div>
        )
      )}
    </div>
  )
}
