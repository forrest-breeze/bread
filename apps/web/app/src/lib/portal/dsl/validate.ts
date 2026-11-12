import { z } from "zod"
import {
  dslNodeStructuralSchema,
  DSL_MAX_DEPTH,
  DSL_MAX_NODES,
  type DslNode,
} from "@/lib/portal/dsl/node"
import { CORE_PRIMITIVE_MAP } from "@/lib/portal/dsl/registry/defs"
import { compositeNodePropsSchema, type CompositeDef } from "@/lib/portal/dsl/composites"

// ---------------------------------------------------------------------------
// Portal DSL — registry-aware tree validator.
//
// This is the LOCK for the tree model, analogous to `validatePortalLayout` for
// the block model: nothing renders or persists until it passes here. It runs the
// two-stage check described in ./node:
//   1. structural parse (shape + per-level children cap)
//   2. registry walk: resolve each `type` against core primitives + the layout's
//      composites; validate `props` against that type's strict schema; enforce
//      leaf/children rules; enforce global depth, node-count, and id-uniqueness
//      caps.
// Returns the first error (path-prefixed), matching validatePortalLayout's
// `{ ok, error }` contract so callers/agent-tools can surface it uniformly.
// ---------------------------------------------------------------------------

export interface ValidateDslOpts {
  /** Per-layout composites that extend the effective registry. */
  composites?: CompositeDef[]
}

export type DslTreeValidation = { ok: true; data: DslNode } | { ok: false; error: string }

export function validateDslTree(input: unknown, opts: ValidateDslOpts = {}): DslTreeValidation {
  const parsed = dslNodeStructuralSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: formatIssues(parsed.error) }

  // Assemble the effective registry: core primitives + composites. Composites
  // cannot shadow a core type or collide with each other.
  const composites = new Map<string, CompositeDef>()
  for (const c of opts.composites ?? []) {
    if (CORE_PRIMITIVE_MAP.has(c.name)) {
      return { ok: false, error: `composite "${c.name}" shadows a core primitive` }
    }
    if (composites.has(c.name)) {
      return { ok: false, error: `duplicate composite "${c.name}"` }
    }
    composites.set(c.name, c)
  }

  let count = 0
  const ids = new Set<string>()

  function walk(node: DslNode, depth: number, path: string): string | null {
    if (depth > DSL_MAX_DEPTH) return `${path}: exceeds max depth ${DSL_MAX_DEPTH}`
    count += 1
    if (count > DSL_MAX_NODES) return `exceeds max node count ${DSL_MAX_NODES}`
    if (ids.has(node.id)) return `${path}: duplicate node id "${node.id}"`
    ids.add(node.id)

    const prim = CORE_PRIMITIVE_MAP.get(node.type)
    const comp = composites.get(node.type)
    if (!prim && !comp) return `${path}: unknown node type "${node.type}"`

    const propsSchema = prim ? prim.propsSchema : compositeNodePropsSchema(comp as CompositeDef)
    const propsResult = propsSchema.safeParse(node.props ?? {})
    if (!propsResult.success) {
      return `${path} (${node.type}): ${formatIssues(propsResult.error)}`
    }

    const isContainer = prim ? prim.kind === "container" : Boolean(comp?.acceptsChildren)
    const kids = node.children ?? []
    if (kids.length > 0 && !isContainer) {
      return `${path}: "${node.type}" cannot have children`
    }
    for (let i = 0; i < kids.length; i += 1) {
      const err = walk(kids[i], depth + 1, `${path}.children[${i}]`)
      if (err) return err
    }
    return null
  }

  const error = walk(parsed.data, 1, "(root)")
  if (error) return { ok: false, error }
  return { ok: true, data: parsed.data }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
}
