import {
  validatePortalLayout,
  type FooterBlock,
  type HeaderBlock,
  type PortalChrome,
  type PortalBlock,
  type PortalBlockInput,
  type PortalLayout,
  type PortalLocalization,
  type PortalPage,
  type PortalTheme,
  type SidebarBlock,
} from "@/lib/portal/schema"

// ---------------------------------------------------------------------------
// Portal layout builder ops.
//
// PURE functions over a PortalLayout — no IO. Each op produces a new layout and
// re-validates it through `validatePortalLayout`, throwing on an invalid result.
// This keeps the schema the single source of truth: an op can only ever return
// a layout the renderer (and the public read-side) will accept.
//
// These are the typed editing primitives the agent route exposes as tool calls
// (apps/web/app/src/app/api/portal/agent/route.ts) and the admin editor UI
// drives directly. Block ids follow the schema's existing convention — caller
// provides the id (deterministic), or `addBlock` derives one from the block
// type + the count of same-typed blocks. No Math.random / Date.now here, so the
// same sequence of ops on the same input always yields the same output.
// ---------------------------------------------------------------------------

/** Thrown when an op would produce a layout the schema rejects. */
export class PortalLayoutOpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PortalLayoutOpError"
  }
}

function validated(layout: PortalLayout, context: string): PortalLayout {
  const result = validatePortalLayout(layout)
  if (!result.ok) {
    throw new PortalLayoutOpError(`${context}: ${result.error}`)
  }
  return result.data
}

/**
 * Validate-and-clone an untrusted layout into a known-good PortalLayout. The
 * identity op — used by callers that receive a layout from the client/agent and
 * want the canonical, schema-coerced shape before mutating it.
 */
export function getPortalLayout(input: unknown): PortalLayout {
  const result = validatePortalLayout(input)
  if (!result.ok) {
    throw new PortalLayoutOpError(`getPortalLayout: ${result.error}`)
  }
  return result.data
}

/** Replace the ordered set of project-local portal pages. */
export function setPages(
  layout: PortalLayout,
  pages: PortalPage[],
  homePosition: number = layout.homePosition ?? 0,
): PortalLayout {
  // Home always exists; keep its slot within the pages that remain.
  const position = Math.min(Math.max(0, Math.trunc(homePosition)), pages.length)
  return validated(
    {
      ...layout,
      pages: pages.length > 0 ? pages : undefined,
      homePosition: position > 0 ? position : undefined,
    },
    "setPages",
  )
}

/**
 * Deterministic block id from a type + the first unused suffix among existing
 * body block ids. e.g. the first `callout` is "callout", then "callout-2", etc.
 * Probing for an unused suffix (rather than counting same-typed blocks) means
 * deleting a middle block never produces a colliding id — with
 * [callout, callout-2, callout-3], removing callout-2 then adding yields
 * "callout-2" again, not a duplicate "callout-3". No randomness, so re-applying
 * the same op chain from the same layout reproduces ids.
 */
function deriveBlockId(layout: PortalLayout, type: PortalBlock["type"]): string {
  const taken = new Set(layout.body.map((block) => block.id))
  if (!taken.has(type)) return type
  let n = 2
  while (taken.has(`${type}-${n}`)) n += 1
  return `${type}-${n}`
}

/**
 * Insert a body block. The block id is optional (`PortalBlockInput`): when
 * absent or empty, a deterministic unused id is derived from its type. `index`
 * clamps into `[0, body.length]`; omit to append. The resulting layout is
 * re-validated against the full schema (with the id present).
 */
export function addBlock(
  layout: PortalLayout,
  block: PortalBlockInput,
  index?: number,
): PortalLayout {
  const id = block.id && block.id.length > 0 ? block.id : deriveBlockId(layout, block.type)
  if (layout.body.some((existing) => existing.id === id)) {
    throw new PortalLayoutOpError(`addBlock: duplicate block id "${id}"`)
  }
  const withId = { ...block, id } as PortalBlock
  const body = [...layout.body]
  const at =
    index === undefined ? body.length : Math.max(0, Math.min(index, body.length))
  body.splice(at, 0, withId)
  return validated({ ...layout, body }, "addBlock")
}

/**
 * Shallow-merge `patch` into the body block with `blockId`. The block `type` and
 * `id` are pinned (a patch cannot retype or rename a block — that would be an
 * add/remove). Throws if no block matches.
 */
export function updateBlock(
  layout: PortalLayout,
  blockId: string,
  patch: Record<string, unknown>,
): PortalLayout {
  let found = false
  const body = layout.body.map((block) => {
    if (block.id !== blockId) return block
    found = true
    return { ...block, ...patch, id: block.id, type: block.type } as PortalBlock
  })
  if (!found) {
    throw new PortalLayoutOpError(`updateBlock: no block with id "${blockId}"`)
  }
  return validated({ ...layout, body }, "updateBlock")
}

/** Remove the body block with `blockId`. Throws if no block matches. */
export function removeBlock(layout: PortalLayout, blockId: string): PortalLayout {
  const body = layout.body.filter((block) => block.id !== blockId)
  if (body.length === layout.body.length) {
    throw new PortalLayoutOpError(`removeBlock: no block with id "${blockId}"`)
  }
  return validated({ ...layout, body }, "removeBlock")
}

/**
 * Reorder body blocks to match `orderedIds`. The set of ids must be exactly the
 * current body's ids (a permutation) — no adds, drops, or duplicates — so this
 * op can never lose or invent a block.
 */
export function reorderBlocks(
  layout: PortalLayout,
  orderedIds: string[],
): PortalLayout {
  const current = layout.body.map((block) => block.id)
  if (orderedIds.length !== current.length) {
    throw new PortalLayoutOpError(
      `reorderBlocks: expected ${current.length} ids, got ${orderedIds.length}`,
    )
  }
  const seen = new Set<string>()
  for (const id of orderedIds) {
    if (seen.has(id)) {
      throw new PortalLayoutOpError(`reorderBlocks: duplicate id "${id}"`)
    }
    seen.add(id)
  }
  const byId = new Map(layout.body.map((block) => [block.id, block]))
  const body: PortalBlock[] = []
  for (const id of orderedIds) {
    const block = byId.get(id)
    if (!block) {
      throw new PortalLayoutOpError(`reorderBlocks: unknown id "${id}"`)
    }
    body.push(block)
  }
  return validated({ ...layout, body }, "reorderBlocks")
}

/** Shallow-merge a partial theme into the layout's theme. */
export function setTheme(
  layout: PortalLayout,
  themePatch: Partial<PortalTheme>,
): PortalLayout {
  const theme = { ...layout.theme, ...themePatch }
  const touchesHeaderChrome = "navLinks" in themePatch || "cta" in themePatch
  return validated(
    {
      ...layout,
      theme,
      ...(touchesHeaderChrome
        ? { chrome: { ...layout.chrome, headerMode: "custom" as const } }
        : {}),
    },
    "setTheme",
  )
}

/** Configure the translated languages exposed by the public portal. */
export function setLocalization(
  layout: PortalLayout,
  localization: PortalLocalization,
): PortalLayout {
  return validated({ ...layout, localization }, "setLocalization")
}

/** Merge a partial patch into the singleton portal header. */
export function setHeader(
  layout: PortalLayout,
  headerPatch: Partial<
    Pick<HeaderBlock, "search" | "itemOrder" | "languagePlacement">
  >,
): PortalLayout {
  const header = { ...layout.header, ...headerPatch }
  return validated(
    { ...layout, header, chrome: { ...layout.chrome, headerMode: "custom" } },
    "setHeader",
  )
}

/** Set whether header/footer chrome inherits workspace defaults or uses project values. */
export function setChromeMode(
  layout: PortalLayout,
  patch: Partial<Pick<PortalChrome, "headerMode" | "footerMode">>,
): PortalLayout {
  return validated(
    { ...layout, chrome: { ...layout.chrome, ...patch } },
    "setChromeMode",
  )
}

/**
 * Merge a partial footer patch into the layout's footer (note / legacy links /
 * multi-column `columns` / `social`). Re-validates through the schema, so an
 * out-of-range column count or unsafe href is rejected before it reaches the
 * buffer. Used by the footer editor and the "import from website" flow.
 */
export function setFooter(
  layout: PortalLayout,
  patch: Partial<
    Pick<FooterBlock, "note" | "links" | "columns" | "social" | "showPoweredBy">
  >,
): PortalLayout {
  const footer = layout.footer ?? {
    id: "footer",
    type: "footer" as const,
    showPoweredBy: true,
  }
  return validated(
    {
      ...layout,
      footer: { ...footer, ...patch },
      chrome: { ...layout.chrome, footerMode: "custom" },
    },
    "setFooter",
  )
}

/** Toggle the global portal footer credit. */
export function setFooterPoweredBy(
  layout: PortalLayout,
  showPoweredBy: boolean,
): PortalLayout {
  const footer = layout.footer ?? {
    id: "footer",
    type: "footer" as const,
    showPoweredBy: true,
  }
  return validated(
    { ...layout, footer: { ...footer, showPoweredBy } },
    "setFooterPoweredBy",
  )
}

/**
 * Override a folder's icon and/or label, keyed by folder id (a sidebar group's
 * id == its folder id). Folder-driven surfaces — the nav rail AND the home
 * page's generated category cards — are regenerated from the folder tree on
 * render, so this persisted override is what makes such a change stick; it is
 * re-applied during normalize. Passing a patch that clears both fields removes
 * the override for that folder.
 */
export function setSidebarOverride(
  layout: PortalLayout,
  groupId: string,
  patch: { icon?: string; label?: string },
): PortalLayout {
  const overrides = { ...(layout.sidebarOverrides ?? {}) }
  const next = { ...(overrides[groupId] ?? {}), ...patch }
  if (next.icon === undefined && next.label === undefined) {
    delete overrides[groupId]
  } else {
    overrides[groupId] = next
  }
  return validated({ ...layout, sidebarOverrides: overrides }, "setSidebarOverride")
}

/**
 * Toggle whether root sidebar groups render their icons. The docs template
 * hides them by default; this explicit flag wins in both directions and, like
 * sidebarOverrides, persists through the folder-driven sidebar regeneration.
 * A layout with no stored sidebar gets an empty placeholder block — only the
 * flag needs to persist; groups are rebuilt on render.
 */
export function setSidebarIconsVisible(
  layout: PortalLayout,
  visible: boolean,
): PortalLayout {
  const sidebar: SidebarBlock = {
    ...(layout.sidebar ?? { id: "sidebar", type: "sidebar-nav" as const, groups: [] }),
    showIcons: visible,
  }
  return validated({ ...layout, sidebar }, "setSidebarIconsVisible")
}

/**
 * Replace the sidebar nav. Pass `null` to remove the sidebar entirely. The
 * passed block's `type`/`id` are normalized to the sidebar singleton shape.
 */
export function setNav(
  layout: PortalLayout,
  nav: SidebarBlock | null,
): PortalLayout {
  if (nav === null) {
    const next = { ...layout }
    delete next.sidebar
    return validated(next, "setNav")
  }
  const sidebar: SidebarBlock = { ...nav, id: nav.id || "sidebar", type: "sidebar-nav" }
  return validated({ ...layout, sidebar }, "setNav")
}
