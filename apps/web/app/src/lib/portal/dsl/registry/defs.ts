import { z } from "zod"
import { isSafeHref } from "@/lib/portal/href"
import {
  containerStyleProps,
  textStyleProps,
  MAX_COLUMNS,
  MIN_COLUMNS,
} from "@/lib/portal/dsl/style-props"

// ---------------------------------------------------------------------------
// Portal DSL — primitive registry (definitions).
//
// This is the ISOMORPHIC half of the registry: pure data (no React), safe to
// import from the API route (validation), the agent (vocabulary), and the
// scope-filter. The render half (type → React component) lives in ./render and
// is keyed by the same `type` strings; a test asserts the two stay in sync.
//
// Each entry declares:
//   - kind: "container" (may have children) | "leaf" (must not)
//   - propsSchema: a STRICT Zod object — unknown props are rejected, so the
//     model/editor can only ever set props we vetted (the schema is the lock,
//     exactly as for the closed block union it generalizes)
//   - hrefProps: which top-level string props carry hrefs, so the recursive
//     scope-filter and same-origin check know where to look
//
// Adding a primitive = adding one entry here + one renderer in ./render. No
// switch to extend, no union to widen — that's the "registry, not hardcode" win.
// ---------------------------------------------------------------------------

const hrefSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isSafeHref, "href must be a same-origin path or an http(s) URL")

// Icon name is a FREE string (resolved to a lucide component at render with a
// FileText fallback) — this is the open icon set that replaces the old 16-name
// enum. No allowlist here; unknown names degrade gracefully to the fallback.
const iconNameSchema = z.string().min(1).max(60)

export type PrimitiveKind = "container" | "leaf"

/** An array-valued prop whose items may carry an href. */
export interface NestedHrefProp {
  /** The array-valued prop name (e.g. "items"). */
  prop: string
  /** The href key within each item (e.g. "href"). */
  href: string
}

export interface PrimitiveDef {
  type: string
  kind: PrimitiveKind
  /** Strict object schema for this primitive's `props`. */
  propsSchema: z.ZodType
  /** Top-level string props that carry an href (for scope-filtering + safe-href). */
  hrefProps?: readonly string[]
  /** Array props whose items each carry an href, so the scope-filter can recurse. */
  nestedHrefProps?: readonly NestedHrefProp[]
}

function def(
  type: string,
  kind: PrimitiveKind,
  shape: z.ZodRawShape,
  hrefProps?: readonly string[],
): PrimitiveDef {
  return { type, kind, propsSchema: z.object(shape).strict(), hrefProps }
}

// ----- core primitives -------------------------------------------------------
export const CORE_PRIMITIVES: readonly PrimitiveDef[] = [
  // Layout containers.
  def("Box", "container", { ...containerStyleProps }),
  def("Stack", "container", { ...containerStyleProps }),
  def("Row", "container", { ...containerStyleProps, wrap: z.boolean().optional() }),
  def("Grid", "container", {
    ...containerStyleProps,
    columns: z.number().int().min(MIN_COLUMNS).max(MAX_COLUMNS).optional(),
  }),
  def("Section", "container", {
    ...containerStyleProps,
    title: z.string().max(160).optional(),
  }),
  def("Card", "container", { ...containerStyleProps }),

  // Content leaves.
  def("Divider", "leaf", {}),
  def("Text", "leaf", { text: z.string().max(4000), ...textStyleProps }),
  def("Heading", "leaf", {
    text: z.string().min(1).max(300),
    level: z.number().int().min(1).max(4).optional(),
    align: z.enum(["start", "center", "end"]).optional(),
  }),
  def(
    "Image",
    "leaf",
    {
      src: hrefSchema,
      alt: z.string().max(300).optional(),
      radius: z.enum(["none", "sm", "md", "lg", "xl", "2xl", "full"]).optional(),
      width: z.enum(["auto", "full", "prose", "sm", "md", "lg"]).optional(),
    },
    ["src"],
  ),
  def("Icon", "leaf", {
    name: iconNameSchema,
    size: z.enum(["sm", "md", "lg", "xl"]).optional(),
    tone: z.enum(["default", "muted", "accent"]).optional(),
  }),
  def(
    "Button",
    "leaf",
    {
      label: z.string().min(1).max(120),
      href: hrefSchema,
      variant: z.enum(["primary", "secondary", "ghost"]).optional(),
    },
    ["href"],
  ),
  def("Link", "leaf", { label: z.string().min(1).max(160), href: hrefSchema }, ["href"]),
  def("Badge", "leaf", {
    text: z.string().min(1).max(80),
    tone: z.enum(["default", "muted", "accent", "success", "warn", "danger"]).optional(),
  }),
]

// ----- legacy block leaves ----------------------------------------------------
// The 6 original body blocks expressed as DSL leaf primitives, so old `body[]`
// layouts upgrade losslessly into a tree (see dsl/body-to-tree) and the agent
// can place them alongside primitives. Props mirror the block schemas in
// @/lib/portal/schema (minus id/type/placement); the existing block React
// components render them (see dsl/render). CategoryGrid/ArticleList carry NESTED
// hrefs (items[]) — declared via nestedHrefProps so the recursive scope-filter
// reaches them.

const categoryItemShape = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  description: z.string().max(240).optional(),
  icon: iconNameSchema.optional(),
  href: hrefSchema,
})

const articleItemShape = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  href: hrefSchema,
  description: z.string().max(240).optional(),
  source: z.string().nullable().optional(),
  readTimeMinutes: z.number().int().min(1).max(999).optional(),
  date: z.string().max(40).optional(),
})

const checklistItemShape = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(200),
  description: z.string().max(400).optional(),
  href: hrefSchema.optional(),
})

export const LEGACY_LEAF_PRIMITIVES: readonly PrimitiveDef[] = [
  def("Hero", "leaf", {
    eyebrow: z.string().max(80).optional(),
    heading: z.string().min(1).max(160),
    subtitle: z.string().max(300).optional(),
  }),
  def("AskAiSearch", "leaf", {
    placeholder: z.string().max(160).optional(),
  }),
  {
    ...def("CategoryGrid", "leaf", { items: z.array(categoryItemShape).max(60) }),
    nestedHrefProps: [{ prop: "items", href: "href" }],
  },
  {
    ...def("ArticleList", "leaf", {
      title: z.string().max(80).optional(),
      // "changelog" renders the dated feed; other values (including the
      // removed "blog") render the default list. Props are strict, so legacy
      // values must still be accepted.
      variant: z.string().max(40).optional(),
      items: z.array(articleItemShape).max(60),
    }),
    nestedHrefProps: [{ prop: "items", href: "href" }],
  },
  def("RichText", "leaf", {
    html: z.string().max(100_000),
  }),
  def("Callout", "leaf", {
    tone: z.enum(["info", "warn", "success", "danger"]).optional(),
    title: z.string().max(120).optional(),
    body: z.string().min(1).max(20_000),
  }),
]

/** Goal-oriented primitives available to custom component-tree layouts. */
export const CUSTOM_LEAF_PRIMITIVES: readonly PrimitiveDef[] = [
  {
    ...def("Checklist", "leaf", {
      title: z.string().max(160).optional(),
      description: z.string().max(400).optional(),
      items: z.array(checklistItemShape).min(1).max(20),
    }),
    nestedHrefProps: [{ prop: "items", href: "href" }],
  },
]

/**
 * The full primitive set the validator and renderer resolve against: the pure
 * primitives plus legacy-compatible block leaves. CORE_PRIMITIVE_MAP /
 * CORE_PRIMITIVE_TYPES keep their names (existing importers) but cover both.
 */
export const REGISTRY_PRIMITIVES: readonly PrimitiveDef[] = [
  ...CORE_PRIMITIVES,
  ...LEGACY_LEAF_PRIMITIVES,
  ...CUSTOM_LEAF_PRIMITIVES,
]

export const CORE_PRIMITIVE_MAP: ReadonlyMap<string, PrimitiveDef> = new Map(
  REGISTRY_PRIMITIVES.map((d) => [d.type, d]),
)

/** Every resolvable primitive type name (for the agent's available-vocabulary list). */
export const CORE_PRIMITIVE_TYPES: readonly string[] = REGISTRY_PRIMITIVES.map((d) => d.type)
