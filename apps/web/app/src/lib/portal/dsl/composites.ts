import { z } from "zod"
import { isSafeHref } from "@/lib/portal/href"
import { dslNodeStructuralSchema, type DslNode } from "@/lib/portal/dsl/node"
import { CORE_PRIMITIVE_MAP } from "@/lib/portal/dsl/registry/defs"

// ---------------------------------------------------------------------------
// Portal DSL — composites ("user-authored components").
//
// A composite is a NAMED, PARAMETERIZED subtree built from core primitives —
// the mechanism by which a workspace (or the agent, in chat) extends the
// vocabulary without anyone writing code. e.g.
//
//   { name: "KpiTile", params: [{name:"label",type:"string"},
//                               {name:"value",type:"string"}],
//     tree: { type:"Card", children:[
//       { type:"Text", props:{ text:"{{label}}", tone:"muted" } },
//       { type:"Heading", props:{ text:"{{value}}" } } ] } }
//
// Once defined (stored in `layout.components`), `{ type:"KpiTile", props:{...} }`
// becomes a usable node. Composites are pure DATA over trusted primitives — no
// code execution — so they inherit the exact safety posture of the primitives.
//
// Phase-1 constraints (keep expansion trivially safe & acyclic):
//   - a composite's tree may only reference CORE primitives, never other
//     composites (no composite-of-composites yet → no cycle graph to reason
//     about, no expansion-depth blowup)
//   - param placeholders are "{{paramName}}" substituted into string props at
//     render; missing optional params fall back to "" / their default
// ---------------------------------------------------------------------------

export const COMPOSITE_PARAM_TYPES = ["string", "number", "boolean", "icon", "href", "color"] as const
export type CompositeParamType = (typeof COMPOSITE_PARAM_TYPES)[number]

export interface CompositeParam {
  name: string
  type: CompositeParamType
  required?: boolean
  default?: string | number | boolean
}

export interface CompositeDef {
  /** PascalCase; must not collide with a core primitive type. */
  name: string
  params: CompositeParam[]
  /** Whether the composite renders a `{{children}}` slot. */
  acceptsChildren?: boolean
  /** Subtree of CORE primitives with `{{param}}` placeholders in string props. */
  tree: DslNode
}

export const compositeDefSchema: z.ZodType<CompositeDef> = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z0-9]{1,40}$/, "composite name must be PascalCase"),
  params: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][A-Za-z0-9]*$/, "param name must be camelCase").max(40),
        type: z.enum(COMPOSITE_PARAM_TYPES),
        required: z.boolean().optional(),
        default: z.union([z.string(), z.number(), z.boolean()]).optional(),
      }),
    )
    .max(20),
  acceptsChildren: z.boolean().optional(),
  tree: dslNodeStructuralSchema,
})

/**
 * The props schema for a NODE that instantiates a composite: one field per
 * declared param, typed by the param's `type`, required/optional per `required`.
 * Strict — a composite node can't set props the composite didn't declare.
 */
export function compositeNodePropsSchema(def: CompositeDef): z.ZodType {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const p of def.params) {
    let base: z.ZodTypeAny
    switch (p.type) {
      case "number":
        base = z.number()
        break
      case "boolean":
        base = z.boolean()
        break
      case "href":
        base = z.string().min(1).max(2048).refine(isSafeHref, "href must be a same-origin path or http(s) URL")
        break
      case "color":
        base = z.string().max(64)
        break
      case "icon":
        base = z.string().min(1).max(60)
        break
      default:
        base = z.string().max(4000)
    }
    shape[p.name] = p.required ? base : base.optional()
  }
  return z.object(shape).strict()
}

export type CompositeValidation = { ok: true; data: CompositeDef } | { ok: false; error: string }

/**
 * Validate a composite DEFINITION: structural shape, then that its `tree`
 * references only core primitives (Phase-1 rule) and respects leaf/container
 * children rules. Called by `defineComponent` before a composite is stored.
 */
export function validateComposite(input: unknown): CompositeValidation {
  const parsed = compositeDefSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: formatIssues(parsed.error) }
  }
  const def = parsed.data
  if (CORE_PRIMITIVE_MAP.has(def.name)) {
    return { ok: false, error: `composite "${def.name}" shadows a core primitive` }
  }

  // Walk the composite's tree: only core primitives allowed, leaf/children rules
  // enforced. (Param-placeholder substitution is checked lazily at render.)
  const seenIds = new Set<string>()
  function walk(node: DslNode, path: string): string | null {
    if (seenIds.has(node.id)) return `${path}: duplicate node id "${node.id}"`
    seenIds.add(node.id)
    const prim = CORE_PRIMITIVE_MAP.get(node.type)
    if (!prim) {
      return `${path}: composite tree may only use core primitives, got "${node.type}"`
    }
    const kids = node.children ?? []
    if (kids.length > 0 && prim.kind !== "container") {
      return `${path}: "${node.type}" cannot have children`
    }
    for (let i = 0; i < kids.length; i++) {
      const err = walk(kids[i], `${path}.children[${i}]`)
      if (err) return err
    }
    return null
  }
  const treeErr = walk(def.tree, "tree")
  if (treeErr) return { ok: false, error: treeErr }
  return { ok: true, data: def }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
}
