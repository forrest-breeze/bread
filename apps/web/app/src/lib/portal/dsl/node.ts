import { z } from "zod"

// ---------------------------------------------------------------------------
// Portal DSL — recursive node tree.
//
// The DSL is the open-ended successor to the closed 6-block body union in
// `@/lib/portal/schema`. A portal layout may carry a `tree` (a single root
// DslNode) instead of / alongside the legacy `body[]`. Where the legacy body is
// a flat list of 6 fixed block types, the tree is an arbitrarily nested
// composition of registry-defined primitives (Box/Stack/Grid/Text/Card/…) plus
// per-workspace composites — "almost any UI" from a finite, trusted vocabulary.
//
// SAFETY MODEL (unchanged from the block system): a tree is pure, serializable
// data. It can only ever resolve to trusted React primitives with token-based
// style props — never raw CSS/HTML/JS, never a className passthrough. Validation
// is two-stage:
//   1. STRUCTURAL (this file): the shape of the tree — ids, string `type`, a
//      props object, a children array — plus hard depth/node caps. Knows nothing
//      about which `type`s exist or whether `props` are valid for a type.
//   2. REGISTRY (./validate): each node's `type` is resolved against the
//      effective registry (core primitives + the layout's composites) and its
//      `props` validated against that entry's schema.
// The split exists because the registry includes per-layout composites that
// aren't known statically, so the tree must be parsed before the registry for a
// given layout is assembled.
// ---------------------------------------------------------------------------

/** Max nesting depth of the tree (root = depth 1). A DoS / runaway-recursion cap. */
export const DSL_MAX_DEPTH = 12
/** Max total node count in a single tree. A DoS / payload-size cap. */
export const DSL_MAX_NODES = 600
/** Max direct children of any one node. */
export const DSL_MAX_CHILDREN = 60

export interface DslNode {
  /** Stable, unique-within-tree id. Drives ops (insert/update/move/remove by id). */
  id: string
  /** Registry key: a core primitive ("Stack", "Card", "Text", …) or a composite name. */
  type: string
  /** Token-based props, validated per-type by the registry. Never raw CSS/classNames. */
  props?: Record<string, unknown>
  /** Child nodes — only meaningful for container primitives / slot-accepting composites. */
  children?: DslNode[]
}

// Structural-only schema. Validates SHAPE, not semantics: `type` is any non-empty
// string here (the registry decides if it's real), `props` is an opaque record
// (the registry validates it per-type). `children` recursion is bounded by
// DSL_MAX_CHILDREN per level; total depth/node count are enforced in ./validate
// (Zod can't express a global node-count cap cleanly).
export const dslNodeStructuralSchema: z.ZodType<DslNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(120),
    type: z.string().min(1).max(80),
    props: z.record(z.string(), z.unknown()).optional(),
    children: z.array(dslNodeStructuralSchema).max(DSL_MAX_CHILDREN).optional(),
  }),
)
