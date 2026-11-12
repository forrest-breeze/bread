import type { PortalBlock } from "@/lib/portal/schema"
import type { DslNode } from "@/lib/portal/dsl/node"

// ---------------------------------------------------------------------------
// Portal DSL — upgrade a legacy `body[]` into a DSL `tree`.
//
// Each block becomes a leaf node of its matching legacy primitive (see
// registry/defs LEGACY_LEAF_PRIMITIVES), and the placement layout is mirrored so
// an upgraded layout renders the same arrangement PortalRenderer produced from
// body: `full` blocks stack at the top; `main`/`aside` form a 2-column Grid when
// both exist, else stack. Node ids are DETERMINISTIC (derived from block ids via
// a probe-for-unused-suffix), so re-running the upgrade reproduces the tree.
// ---------------------------------------------------------------------------

const BLOCK_TYPE_TO_PRIMITIVE: Record<PortalBlock["type"], string> = {
  hero: "Hero",
  "ask-ai-search": "AskAiSearch",
  "category-grid": "CategoryGrid",
  "article-list": "ArticleList",
  "rich-text": "RichText",
  callout: "Callout",
}

function deriveUniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (used.has(`${base}-${n}`)) n += 1
  const id = `${base}-${n}`
  used.add(id)
  return id
}

/** Block fields that become the leaf node's props (everything but id/type/placement). */
function blockProps(block: PortalBlock): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...block }
  delete clone.id
  delete clone.type
  delete clone.placement
  return clone
}

export function bodyToTree(body: PortalBlock[]): DslNode {
  const used = new Set<string>([
    "body-root",
    "body-split",
    "body-main",
    "body-aside",
  ])

  const toNode = (block: PortalBlock): DslNode => ({
    id: deriveUniqueId(`n-${block.id}`, used),
    type: BLOCK_TYPE_TO_PRIMITIVE[block.type],
    props: blockProps(block),
  })

  const full = body.filter((b) => b.placement === "full").map(toNode)
  const main = body.filter((b) => b.placement === "main").map(toNode)
  const aside = body.filter((b) => b.placement === "aside").map(toNode)

  const children: DslNode[] = [...full]
  if (main.length > 0 && aside.length > 0) {
    children.push({
      id: "body-split",
      type: "Grid",
      props: { columns: 2, gap: "lg" },
      children: [
        { id: "body-main", type: "Stack", props: { gap: "lg" }, children: main },
        { id: "body-aside", type: "Stack", props: { gap: "md" }, children: aside },
      ],
    })
  } else {
    children.push(...main, ...aside)
  }

  return { id: "body-root", type: "Stack", props: { gap: "lg" }, children }
}
