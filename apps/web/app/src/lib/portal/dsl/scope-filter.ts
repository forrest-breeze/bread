import type { PortalLayout } from "@/lib/portal/schema"
import type { DslNode } from "@/lib/portal/dsl/node"
import type { CompositeDef } from "@/lib/portal/dsl/composites"
import { CORE_PRIMITIVE_MAP } from "@/lib/portal/dsl/registry/defs"

// ---------------------------------------------------------------------------
// Portal DSL — recursive content-link scope filter.
//
// Workspace-scoping is a hard rule: a portal may only link the docs/folders in
// its project's content catalog. The agent is told this, but the server still
// enforces it as a safety net (it can never trust the model). This module is the
// shared enforcement for BOTH the legacy block body and the DSL tree.
//
// For the tree it walks every node and, using each primitive's declared
// hrefProps / nestedHrefProps:
//   - a leaf whose REQUIRED top-level href (Link/Button/...) points at an
//     out-of-scope knowledge href is DROPPED (blanking a required href would
//     just produce an invalid tree),
//   - out-of-scope items inside an array prop (CategoryGrid/ArticleList items)
//     are filtered out,
//   - out-of-scope hrefs embedded in the legacy RichText/Callout HTML leaves are
//     stripped from the markup.
// Non-knowledge hrefs (external URLs, image src, in-page anchors) are left as-is.
// ---------------------------------------------------------------------------

// Portal bases are one segment (`/p/<ws>/…`) or two (`/p/<ws>/<project>/…`).
// `doc`/`folder` are reserved project slugs, so the optional second segment can
// never itself be the structural `doc/`/`folder/` marker — the lookahead keeps
// `/p/<ws>/folder/<id>` parsing as a one-segment base.
const PORTAL_CONTENT_HREF_RE =
  /^\/p\/[^/]+(?:\/(?!(?:doc|folder)\/)[^/]+)?\/(doc|folder)\/([^?#]+)/
const LEGACY_KB_CONTENT_HREF_RE = /^\/kb\/(doc|folder)\/([^?#]+)/

/** A doc/folder reference extracted from a portal content href, base ignored. */
export interface PortalContentRef {
  kind: "doc" | "folder"
  /** Folder id, or doc public slug / id (hierarchical slugs keep their `/`s). */
  ref: string
}

/**
 * Parse a portal knowledge-content href (`/p/<base>/doc|folder/<ref>`, legacy
 * `/kb/doc|folder/<ref>`) into its content ref, regardless of which base the
 * href was baked with. Layouts accumulate hrefs from several producers (agent
 * route, draft route, scripts) that historically used different bases, so any
 * base-sensitive check fails open on stale links — ref-based checks don't.
 */
export function parsePortalContentHref(href: string): PortalContentRef | null {
  const match = PORTAL_CONTENT_HREF_RE.exec(href) ?? LEGACY_KB_CONTENT_HREF_RE.exec(href)
  if (!match) return null
  return { kind: match[1] as "doc" | "folder", ref: match[2] }
}

/** A link into workspace knowledge content (doc/folder) — the scoped surface. */
export function isKnowledgeContentHref(href: string): boolean {
  return (
    PORTAL_CONTENT_HREF_RE.test(href) ||
    LEGACY_KB_CONTENT_HREF_RE.test(href) ||
    /^\/knowledge\/(?:folder\/)?[^/?#]+/.test(href)
  )
}

/**
 * Decides what happens to a knowledge-content href: `null` drops/strips it,
 * a string keeps it (possibly rewritten, e.g. rehomed onto the current portal
 * base). Non-knowledge hrefs never reach the resolver.
 */
export type KnowledgeHrefResolver = (href: string) => string | null

function allowedResolver(allowedHrefs: Set<string>): KnowledgeHrefResolver {
  return (href) => (allowedHrefs.has(href) ? href : null)
}

/** Rewrite/strip knowledge-content `href="…"` attributes in an HTML string. */
export function transformKnowledgeHtmlLinks(
  html: string,
  resolve: KnowledgeHrefResolver,
): string {
  return html.replace(
    /\s+href=(["'])([^"']+)\1/g,
    (match, quote: string, href: string) => {
      if (!isKnowledgeContentHref(href)) return match
      const resolved = resolve(href)
      if (resolved === null) return ""
      return resolved === href ? match : ` href=${quote}${resolved}${quote}`
    },
  )
}

/** Strip `href="…"` attributes pointing at out-of-scope knowledge content from HTML. */
export function stripOutOfScopeHtmlLinks(html: string, allowedHrefs: Set<string>): string {
  return transformKnowledgeHtmlLinks(html, allowedResolver(allowedHrefs))
}

function linkAllowed(href: string, allowedHrefs: Set<string>): boolean {
  return !isKnowledgeContentHref(href) || allowedHrefs.has(href)
}

/**
 * Recursively transform every knowledge-content href in a DSL tree through
 * `resolve`. Pure: returns a transformed clone. A resolved `null` drops the
 * leaf (required top-level href), filters the item (nested arrays), or strips
 * the link (HTML leaves); a rewritten string replaces the href in place.
 */
export function transformTreeContentLinks(
  tree: DslNode,
  resolve: KnowledgeHrefResolver,
  composites: readonly CompositeDef[] = [],
): DslNode {
  const resolveHref = (href: string): string | null =>
    isKnowledgeContentHref(href) ? resolve(href) : href
  const compositeMap = new Map(composites.map((composite) => [composite.name, composite]))

  function filterNode(node: DslNode): DslNode | null {
    const prim = CORE_PRIMITIVE_MAP.get(node.type)
    const composite = compositeMap.get(node.type)
    const props: Record<string, unknown> = { ...(node.props ?? {}) }

    if (prim) {
      // A required top-level href that is out of scope ⇒ drop the whole leaf
      // (blanking a required href would just produce an invalid tree).
      for (const hp of prim.hrefProps ?? []) {
        const value = props[hp]
        if (typeof value === "string") {
          const resolved = resolveHref(value)
          if (resolved === null) return null
          props[hp] = resolved
        }
      }
      // Filter out-of-scope items from nested item arrays (CategoryGrid/ArticleList).
      for (const nested of prim.nestedHrefProps ?? []) {
        const arr = props[nested.prop]
        if (Array.isArray(arr)) {
          props[nested.prop] = arr.flatMap((item) => {
            const record = item as Record<string, unknown> | null
            const href = record?.[nested.href]
            if (typeof href !== "string") return [item]
            const resolved = resolveHref(href)
            if (resolved === null) return []
            return [resolved === href ? item : { ...record, [nested.href]: resolved }]
          })
        }
      }
      // Legacy HTML leaves: strip/rewrite links in the markup.
      if (node.type === "RichText" && typeof props.html === "string") {
        props.html = transformKnowledgeHtmlLinks(props.html, resolve)
      }
      if (node.type === "Callout" && typeof props.body === "string") {
        props.body = transformKnowledgeHtmlLinks(props.body, resolve)
      }
    } else if (composite) {
      // Composite instances can expose href-typed parameters that are
      // substituted into Link/Button/etc. inside the component definition.
      // Resolve those parameters before expansion so composites cannot bypass
      // the same content-scope enforcement applied to core primitives.
      for (const param of composite.params) {
        if (param.type !== "href") continue
        const value = props[param.name]
        if (typeof value !== "string") continue
        const resolved = resolveHref(value)
        if (resolved === null) return null
        props[param.name] = resolved
      }
    }

    const next: DslNode = { id: node.id, type: node.type, props }
    if (node.children) {
      next.children = node.children
        .map(filterNode)
        .filter((child): child is DslNode => child !== null)
    }
    return next
  }

  // A Link/Button is a valid DSL root. If that root is out of scope, returning
  // the original tree would fail open. Preserve the root id but replace it with
  // a valid empty container so the filtered tree remains renderable and safe.
  return filterNode(tree) ?? { id: tree.id, type: "Stack", props: {}, children: [] }
}

/** Recursively scope-filter a DSL tree against an exact allowed-href set. */
export function enforceScopedContentLinksTree(
  tree: DslNode,
  allowedHrefs: Set<string>,
): DslNode {
  return transformTreeContentLinks(tree, allowedResolver(allowedHrefs))
}

/**
 * Scope-filter the legacy block body + sidebar (the back-compat path used for
 * generate mode and v1 layouts). Mirrors the original route helper, kept here so
 * the body and tree paths share one implementation.
 */
export function enforceScopedContentLinksBody(
  layout: PortalLayout,
  allowedHrefs: Set<string>,
): PortalLayout {
  const allowed = (href: string): boolean => linkAllowed(href, allowedHrefs)

  const body = layout.body
    .map((block) => {
      if (block.type === "category-grid") {
        return { ...block, items: block.items.filter((item) => allowed(item.href)) }
      }
      if (block.type === "article-list") {
        return { ...block, items: block.items.filter((item) => allowed(item.href)) }
      }
      if (block.type === "rich-text") {
        return { ...block, html: stripOutOfScopeHtmlLinks(block.html, allowedHrefs) }
      }
      if (block.type === "callout") {
        return { ...block, body: stripOutOfScopeHtmlLinks(block.body, allowedHrefs) }
      }
      return block
    })
    .filter((block) => {
      if (block.type === "category-grid" || block.type === "article-list") {
        return block.items.length > 0
      }
      return true
    })

  const sidebarGroups = layout.sidebar?.groups
    .map((group) => ({
      ...group,
      href: group.href && allowed(group.href) ? group.href : undefined,
      items: group.items.filter((item) => allowed(item.href)),
    }))
    .filter((group) => group.href || group.items.length > 0)

  return {
    ...layout,
    sidebar:
      sidebarGroups && sidebarGroups.length > 0
        ? { ...layout.sidebar!, groups: sidebarGroups }
        : undefined,
    body,
  }
}

/**
 * Scope-filter whichever representation the layout uses: the `tree` when present
 * (v2) and always the legacy `body`/sidebar (back-compat). One call the route
 * can apply after every op and before persist.
 */
export function enforceScopedContentLinks(
  layout: PortalLayout,
  allowedHrefs: Set<string>,
): PortalLayout {
  const scoped = enforceScopedContentLinksBody(layout, allowedHrefs)
  const resolve = allowedResolver(allowedHrefs)
  const components = scoped.components?.map((component) => ({
    ...component,
    tree: transformTreeContentLinks(component.tree, resolve),
  }))
  if (scoped.tree) {
    return {
      ...scoped,
      ...(components ? { components } : {}),
      tree: transformTreeContentLinks(scoped.tree, resolve, components),
    }
  }
  return components ? { ...scoped, components } : scoped
}
