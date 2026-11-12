import { Fragment } from "react"
import { cn } from "@/lib/utils"
import type {
  ArticleListBlock,
  CalloutBlock,
  CategoryGridBlock,
  HeroBlock,
  PortalTheme,
  RichTextBlock,
} from "@/lib/portal/schema"
import type { DslNode } from "@/lib/portal/dsl/node"
import type { CompositeDef } from "@/lib/portal/dsl/composites"
import {
  resolveColumnsClass,
  resolveContainerClasses,
  resolveRadiusClass,
  resolveTextClasses,
  resolveWidthClass,
} from "@/lib/portal/dsl/style-props"
import { Hero } from "@/components/public-kb/portal/hero"
import { CategoryGrid } from "@/components/public-kb/portal/category-grid"
import { ArticleList } from "@/components/public-kb/portal/article-list"
import { RichText } from "@/components/public-kb/portal/rich-text"
import { Callout } from "@/components/public-kb/portal/callout"
import { DslIcon, type DslIconSize, type DslIconTone } from "./icon"

// ---------------------------------------------------------------------------
// Portal DSL — recursive renderer (the render half of the registry).
//
// Keyed by the same `type` strings as `registry/defs.ts`; a test asserts the
// two stay in sync (every core primitive type has a renderer and vice-versa).
// Adding a primitive = one entry in defs.ts + one entry here. No switch widens.
//
// RSC + testability pattern: a container PRE-RESOLVES its subtree by awaiting
// every child's render, then embeds the resolved elements. This means
// `await DslNodeView({node, ctx})` yields a fully-resolved element tree (no
// pending promises nested inside), so renderToStaticMarkup works in tests and
// the server render path stays a plain RSC.
// ---------------------------------------------------------------------------

export interface DslRenderContext {
  slug: string
  hrefBase?: string
  composites: Map<string, CompositeDef>
  font: PortalTheme["font"]
  askAiEnabled: boolean
  variant?: "default" | "docs"
}

type Renderer = (node: DslNode, ctx: DslRenderContext) => Promise<React.ReactElement | null>

function props(node: DslNode): Record<string, unknown> {
  return node.props ?? {}
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function clampLevel(value: unknown): 1 | 2 | 3 | 4 {
  const n = typeof value === "number" ? Math.round(value) : 2
  if (n <= 1) return 1
  if (n >= 4) return 4
  return n as 2 | 3
}

async function renderChildren(node: DslNode, ctx: DslRenderContext): Promise<React.ReactNode> {
  const children = node.children ?? []
  const rendered = await Promise.all(children.map((child) => DslNodeView({ node: child, ctx })))
  return rendered.map((el, i) => <Fragment key={children[i].id}>{el}</Fragment>)
}

function badgeToneClass(tone: unknown): string {
  switch (tone) {
    case "accent":
      return "bg-[var(--portal-accent)] text-white"
    case "muted":
      return "bg-muted text-muted-foreground"
    case "success":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    case "warn":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    case "danger":
      return "bg-red-500/15 text-red-700 dark:text-red-300"
    default:
      return "bg-foreground/10 text-foreground"
  }
}

function buttonVariantClass(variant: unknown): string {
  switch (variant) {
    case "secondary":
      return "border border-border bg-card text-foreground hover:bg-muted"
    case "ghost":
      return "text-foreground hover:bg-muted"
    default:
      return "bg-[var(--portal-accent)] text-white hover:opacity-90"
  }
}

interface ChecklistItem {
  id: string
  label: string
  description?: string
  href?: string
}

// type → renderer. Step 2 adds the 6 legacy-block leaves here (one entry each).
const CORE_RENDERERS: Record<string, Renderer> = {
  Box: async (node, ctx) => (
    <div className={cn("flex flex-col", resolveContainerClasses(props(node)))}>
      {await renderChildren(node, ctx)}
    </div>
  ),
  Stack: async (node, ctx) => (
    <div className={cn("flex flex-col", resolveContainerClasses(props(node)))}>
      {await renderChildren(node, ctx)}
    </div>
  ),
  Row: async (node, ctx) => (
    <div
      className={cn(
        "flex flex-row",
        props(node).wrap ? "flex-wrap" : undefined,
        resolveContainerClasses(props(node)),
      )}
    >
      {await renderChildren(node, ctx)}
    </div>
  ),
  Grid: async (node, ctx) => (
    <div
      className={cn(
        "grid",
        resolveColumnsClass(props(node).columns),
        resolveContainerClasses(props(node)),
      )}
    >
      {await renderChildren(node, ctx)}
    </div>
  ),
  Section: async (node, ctx) => {
    const title = str(props(node).title)
    return (
      <section className={cn("flex flex-col", resolveContainerClasses(props(node)))}>
        {title && <h2 className="text-xl font-semibold text-foreground">{title}</h2>}
        {await renderChildren(node, ctx)}
      </section>
    )
  },
  Card: async (node, ctx) => (
    <div className={cn("rounded-lg border bg-card", resolveContainerClasses(props(node)))}>
      {await renderChildren(node, ctx)}
    </div>
  ),

  Divider: async () => <hr className="border-border" />,
  Text: async (node) => (
    <p className={resolveTextClasses(props(node))}>{str(props(node).text)}</p>
  ),
  Heading: async (node) => {
    const level = clampLevel(props(node).level)
    const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4"
    return (
      <Tag className={cn("font-semibold text-foreground", resolveTextClasses(props(node)))}>
        {str(props(node).text)}
      </Tag>
    )
  },
  Image: async (node) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={str(props(node).src)}
      alt={str(props(node).alt)}
      loading="lazy"
      decoding="async"
      className={cn(
        "h-auto max-w-full",
        resolveRadiusClass(props(node).radius),
        // `width` is part of the Image prop schema; without this it validated
        // but never reached the DOM.
        resolveWidthClass(props(node).width),
      )}
    />
  ),
  Icon: async (node) =>
    DslIcon({
      name: str(props(node).name),
      size: props(node).size as DslIconSize | undefined,
      tone: props(node).tone as DslIconTone | undefined,
    }),
  Button: async (node) => (
    <a
      href={str(props(node).href)}
      className={cn(
        "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors",
        buttonVariantClass(props(node).variant),
      )}
    >
      {str(props(node).label)}
    </a>
  ),
  Link: async (node) => (
    <a
      href={str(props(node).href)}
      className="text-[var(--portal-accent)] underline-offset-2 hover:underline"
    >
      {str(props(node).label)}
    </a>
  ),
  Badge: async (node) => (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        badgeToneClass(props(node).tone),
      )}
    >
      {str(props(node).text)}
    </span>
  ),

  // ----- legacy block leaves (reuse the existing block components) -----------
  Hero: async (node, ctx) => {
    const block: HeroBlock = {
      id: node.id,
      type: "hero",
      placement: "full",
      eyebrow: optStr(props(node).eyebrow),
      heading: str(props(node).heading),
      subtitle: optStr(props(node).subtitle),
    }
    return (
      <Hero
        block={block}
        font={ctx.font}
        variant={ctx.variant === "docs" ? "docs" : undefined}
      />
    )
  },
  // Kept in the registry for backwards compatibility with stored DSL trees.
  // The portal header is the only search surface now.
  AskAiSearch: async () => null,
  CategoryGrid: async (node, ctx) => {
    const block: CategoryGridBlock = {
      id: node.id,
      type: "category-grid",
      placement: "full",
      items: (props(node).items as CategoryGridBlock["items"] | undefined) ?? [],
    }
    return (
      <CategoryGrid
        block={block}
        variant={ctx.variant === "docs" ? "docs" : undefined}
      />
    )
  },
  ArticleList: async (node) => {
    const block: ArticleListBlock = {
      id: node.id,
      type: "article-list",
      placement: "full",
      title: optStr(props(node).title),
      variant: props(node).variant === "changelog" ? "changelog" : undefined,
      items: (props(node).items as ArticleListBlock["items"] | undefined) ?? [],
    }
    return <ArticleList block={block} />
  },
  RichText: async (node) => {
    const block: RichTextBlock = {
      id: node.id,
      type: "rich-text",
      placement: "full",
      html: str(props(node).html),
    }
    return <RichText block={block} />
  },
  Callout: async (node) => {
    const block: CalloutBlock = {
      id: node.id,
      type: "callout",
      placement: "full",
      tone: (props(node).tone as CalloutBlock["tone"] | undefined) ?? "info",
      title: optStr(props(node).title),
      body: str(props(node).body, " "),
    }
    return <Callout block={block} />
  },
  Checklist: async (node) => {
    const items = (props(node).items as ChecklistItem[] | undefined) ?? []
    const title = optStr(props(node).title)
    const description = optStr(props(node).description)
    return (
      <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
        {title ? <h2 className="text-xl font-semibold text-foreground">{title}</h2> : null}
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
        <ul className={cn("space-y-2.5", title || description ? "mt-5" : undefined)}>
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-3 rounded-lg border border-border/70 bg-background p-3"
            >
              <input
                type="checkbox"
                aria-label={item.label}
                className="mt-0.5 size-4 shrink-0 accent-[var(--portal-accent)]"
              />
              <div className="min-w-0 flex-1">
                {item.href ? (
                  <a
                    href={item.href}
                    className="font-medium text-foreground underline-offset-2 hover:text-[var(--portal-accent)] hover:underline"
                  >
                    {item.label}
                  </a>
                ) : (
                  <span className="font-medium text-foreground">{item.label}</span>
                )}
                {item.description ? (
                  <p className="mt-0.5 text-sm text-muted-foreground">{item.description}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
    )
  },
}

/** Register a renderer for a type (used by Step 2 to add legacy-block leaves). */
export function registerDslRenderer(type: string, renderer: Renderer): void {
  CORE_RENDERERS[type] = renderer
}

/** Every type that has a renderer (for the isomorphism test vs. the registry). */
export function dslRendererTypes(): string[] {
  return Object.keys(CORE_RENDERERS)
}

/**
 * Expand a composite instance node into its parameterized subtree: substitute
 * `{{param}}` placeholders in every string prop with the instance's prop value
 * (falling back to the param default, then ""), and append the instance's
 * children to the expanded root when the composite accepts a children slot.
 * Phase-1 composites reference only core primitives (one level, no nesting).
 */
export function expandComposite(def: CompositeDef, node: DslNode): DslNode {
  const values = node.props ?? {}
  const defaults = new Map(def.params.map((p) => [p.name, p.default]))

  const substitute = (value: string): string =>
    value.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const resolved = values[key] ?? defaults.get(key) ?? ""
      return String(resolved)
    })

  const clone = (n: DslNode): DslNode => {
    const nextProps: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(n.props ?? {})) {
      nextProps[key] = typeof value === "string" ? substitute(value) : value
    }
    const out: DslNode = { id: n.id, type: n.type, props: nextProps }
    if (n.children) out.children = n.children.map(clone)
    return out
  }

  const expanded = clone(def.tree)
  if (def.acceptsChildren && node.children && node.children.length > 0) {
    expanded.children = [...(expanded.children ?? []), ...node.children]
  }
  return expanded
}

/** Render a single DSL node (and, recursively, its subtree) to an element. */
export async function DslNodeView({
  node,
  ctx,
}: {
  node: DslNode
  ctx: DslRenderContext
}): Promise<React.ReactElement | null> {
  const composite = ctx.composites.get(node.type)
  if (composite) {
    return DslNodeView({ node: expandComposite(composite, node), ctx })
  }
  const renderer = CORE_RENDERERS[node.type]
  // Unknown type: validation already rejected it; render nothing defensively.
  if (!renderer) return null
  return renderer(node, ctx)
}
