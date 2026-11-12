import {
  PortalLayoutOpError,
  getPortalLayout,
} from "@/lib/portal/builder-ops"
import {
  validatePortalLayout,
  PORTAL_SCHEMA_VERSION_V2,
  type PortalLayout,
} from "@/lib/portal/schema"
import type { DslNode } from "@/lib/portal/dsl/node"
import { validateDslTree } from "@/lib/portal/dsl/validate"
import { validateComposite, type CompositeDef } from "@/lib/portal/dsl/composites"
import { bodyToTree } from "@/lib/portal/dsl/body-to-tree"

// ---------------------------------------------------------------------------
// Portal DSL — tree builder ops.
//
// PURE functions over a layout's `tree` (and its `components`) — no IO, no
// Math.random / Date.now, so re-applying an op chain reproduces ids. Each op
// clones, mutates by node id, then RE-VALIDATES the whole result through
// validateDslTree / validatePortalLayout and throws PortalLayoutOpError on an
// invalid result — the same contract as builder-ops, so the schema stays the
// single source of truth. These are the editing primitives the agent route
// exposes as tools.
// ---------------------------------------------------------------------------

function cloneTree(tree: DslNode): DslNode {
  return JSON.parse(JSON.stringify(tree)) as DslNode
}

function validatedTree(
  tree: DslNode,
  composites: CompositeDef[] | undefined,
  context: string,
): DslNode {
  const result = validateDslTree(tree, { composites })
  if (!result.ok) throw new PortalLayoutOpError(`${context}: ${result.error}`)
  return result.data
}

function validatedLayout(layout: PortalLayout, context: string): PortalLayout {
  const result = validatePortalLayout(layout)
  if (!result.ok) throw new PortalLayoutOpError(`${context}: ${result.error}`)
  return result.data
}

function findNodeById(root: DslNode, id: string): DslNode | null {
  if (root.id === id) return root
  for (const child of root.children ?? []) {
    const found = findNodeById(child, id)
    if (found) return found
  }
  return null
}

function detachNode(root: DslNode, id: string): DslNode | null {
  const kids = root.children
  if (kids) {
    for (let i = 0; i < kids.length; i += 1) {
      if (kids[i].id === id) {
        const [removed] = kids.splice(i, 1)
        return removed
      }
      const deeper = detachNode(kids[i], id)
      if (deeper) return deeper
    }
  }
  return null
}

function subtreeContainsId(node: DslNode, id: string): boolean {
  if (node.id === id) return true
  return (node.children ?? []).some((child) => subtreeContainsId(child, id))
}

function collectIds(node: DslNode, into: Set<string>): void {
  into.add(node.id)
  for (const child of node.children ?? []) collectIds(child, into)
}

/**
 * Deterministic unused node id from a type — the first free suffix among the
 * tree's existing ids (e.g. "card", then "card-2"). No randomness, so the same
 * tree + type always yields the same id (mirrors builder-ops.deriveBlockId).
 */
export function deriveNodeId(tree: DslNode, type: string): string {
  const used = new Set<string>()
  collectIds(tree, used)
  const base = type.charAt(0).toLowerCase() + type.slice(1)
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/** Insert `node` as a child of `parentId` at `index` (append when omitted). */
export function insertNode(
  tree: DslNode,
  parentId: string,
  node: DslNode,
  index?: number,
  composites?: CompositeDef[],
): DslNode {
  const next = cloneTree(tree)
  const parent = findNodeById(next, parentId)
  if (!parent) throw new PortalLayoutOpError(`insertNode: no node with id "${parentId}"`)
  parent.children = parent.children ?? []
  const at =
    index === undefined
      ? parent.children.length
      : Math.max(0, Math.min(index, parent.children.length))
  parent.children.splice(at, 0, node)
  return validatedTree(next, composites, "insertNode")
}

/** Shallow-merge `propsPatch` into the node with `nodeId` (id/type are pinned). */
export function updateNode(
  tree: DslNode,
  nodeId: string,
  propsPatch: Record<string, unknown>,
  composites?: CompositeDef[],
): DslNode {
  const next = cloneTree(tree)
  const node = findNodeById(next, nodeId)
  if (!node) throw new PortalLayoutOpError(`updateNode: no node with id "${nodeId}"`)
  node.props = { ...(node.props ?? {}), ...propsPatch }
  return validatedTree(next, composites, "updateNode")
}

/** Move the node with `nodeId` under `newParentId` at `index`. */
export function moveNode(
  tree: DslNode,
  nodeId: string,
  newParentId: string,
  index: number,
  composites?: CompositeDef[],
): DslNode {
  if (tree.id === nodeId) throw new PortalLayoutOpError("moveNode: cannot move the root node")
  const next = cloneTree(tree)
  const target = findNodeById(next, nodeId)
  if (!target) throw new PortalLayoutOpError(`moveNode: no node with id "${nodeId}"`)
  const newParent = findNodeById(next, newParentId)
  if (!newParent) throw new PortalLayoutOpError(`moveNode: no node with id "${newParentId}"`)
  if (subtreeContainsId(target, newParentId)) {
    throw new PortalLayoutOpError("moveNode: cannot move a node into its own subtree")
  }
  const detached = detachNode(next, nodeId)
  if (!detached) throw new PortalLayoutOpError(`moveNode: no node with id "${nodeId}"`)
  newParent.children = newParent.children ?? []
  const at = Math.max(0, Math.min(index, newParent.children.length))
  newParent.children.splice(at, 0, detached)
  return validatedTree(next, composites, "moveNode")
}

/** Remove the node with `nodeId` (the root cannot be removed). */
export function removeNode(
  tree: DslNode,
  nodeId: string,
  composites?: CompositeDef[],
): DslNode {
  if (tree.id === nodeId) throw new PortalLayoutOpError("removeNode: cannot remove the root node")
  const next = cloneTree(tree)
  const removed = detachNode(next, nodeId)
  if (!removed) throw new PortalLayoutOpError(`removeNode: no node with id "${nodeId}"`)
  return validatedTree(next, composites, "removeNode")
}

/** Append a composite definition to the layout (rejects name collisions). */
export function defineComponent(layout: PortalLayout, composite: unknown): PortalLayout {
  const validation = validateComposite(composite)
  if (!validation.ok) throw new PortalLayoutOpError(`defineComponent: ${validation.error}`)
  const def = validation.data
  const existing = layout.components ?? []
  if (existing.some((c) => c.name === def.name)) {
    throw new PortalLayoutOpError(`defineComponent: component "${def.name}" already defined`)
  }
  return validatedLayout({ ...layout, components: [...existing, def] }, "defineComponent")
}

/** Remove a composite by name. Throws (via re-validation) if the tree still uses it. */
export function removeComponent(layout: PortalLayout, name: string): PortalLayout {
  const existing = layout.components ?? []
  if (!existing.some((c) => c.name === name)) {
    throw new PortalLayoutOpError(`removeComponent: no component "${name}"`)
  }
  return validatedLayout(
    { ...layout, components: existing.filter((c) => c.name !== name) },
    "removeComponent",
  )
}

/**
 * Upgrade a legacy `body[]` layout to a v2 `tree` layout on first edit. If a
 * tree already exists, the layout is returned (validated) unchanged. The body is
 * cleared (the tree becomes the render source) and the schema bumps to v2.
 */
export function ensureTree(layout: PortalLayout): PortalLayout {
  const canonical = getPortalLayout(layout)
  if (canonical.tree) return canonical
  const tree = bodyToTree(canonical.body)
  return validatedLayout(
    { ...canonical, schemaVersion: PORTAL_SCHEMA_VERSION_V2, tree, body: [] },
    "ensureTree",
  )
}
