import { z } from "zod"

// ---------------------------------------------------------------------------
// Portal DSL — style-prop vocabulary.
//
// This is the ENTIRE styling surface a DSL node may use. Every style prop is a
// TOKEN from a fixed enum (gap: "md", columns: 3, bg: "card"), never a raw CSS
// value or a className. The resolver below maps tokens to a fixed set of
// Tailwind classes, so a node can only ever produce styles we've vetted — there
// is no arbitrary-class / arbitrary-CSS injection path. This is what lets the
// tree be "open-ended" (any composition) while staying as safe as the closed
// block system it replaces.
//
// Color tokens resolve to the portal's semantic Tailwind tokens (bg-card,
// text-muted-foreground, …) and to the `--portal-accent` CSS var. Custom theme
// colors arrive via `theme.tokens` (a later step) which re-points those same CSS
// vars — so authors recolor by setting tokens, never by emitting CSS here.
// ---------------------------------------------------------------------------

export const GAP = ["none", "xs", "sm", "md", "lg", "xl"] as const
export const PAD = ["none", "xs", "sm", "md", "lg", "xl", "2xl"] as const
export const ALIGN = ["start", "center", "end", "stretch"] as const
export const JUSTIFY = ["start", "center", "end", "between", "around"] as const
export const RADIUS = ["none", "sm", "md", "lg", "xl", "2xl", "full"] as const
export const SURFACE = ["none", "background", "card", "muted", "accent"] as const
export const TEXT_TONE = ["default", "muted", "accent", "onAccent"] as const
export const TEXT_SIZE = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"] as const
export const TEXT_WEIGHT = ["normal", "medium", "semibold", "bold"] as const
export const WIDTH = ["auto", "full", "prose", "sm", "md", "lg"] as const
export const MIN_COLUMNS = 1
export const MAX_COLUMNS = 6

// Zod fragments reused across primitive prop schemas (see ./registry/defs).
export const containerStyleProps = {
  pad: z.enum(PAD).optional(),
  gap: z.enum(GAP).optional(),
  align: z.enum(ALIGN).optional(),
  justify: z.enum(JUSTIFY).optional(),
  radius: z.enum(RADIUS).optional(),
  bg: z.enum(SURFACE).optional(),
  border: z.boolean().optional(),
  width: z.enum(WIDTH).optional(),
}

export const textStyleProps = {
  tone: z.enum(TEXT_TONE).optional(),
  size: z.enum(TEXT_SIZE).optional(),
  weight: z.enum(TEXT_WEIGHT).optional(),
  align: z.enum(["start", "center", "end"]).optional(),
}

// ----- token → Tailwind class maps ------------------------------------------

const GAP_CLASS: Record<(typeof GAP)[number], string> = {
  none: "gap-0",
  xs: "gap-1",
  sm: "gap-2",
  md: "gap-4",
  lg: "gap-6",
  xl: "gap-8",
}

const PAD_CLASS: Record<(typeof PAD)[number], string> = {
  none: "p-0",
  xs: "p-1",
  sm: "p-2",
  md: "p-4",
  lg: "p-6",
  xl: "p-8",
  "2xl": "p-12",
}

const ALIGN_CLASS: Record<(typeof ALIGN)[number], string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
}

const JUSTIFY_CLASS: Record<(typeof JUSTIFY)[number], string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
  around: "justify-around",
}

const RADIUS_CLASS: Record<(typeof RADIUS)[number], string> = {
  none: "rounded-none",
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
  full: "rounded-full",
}

const SURFACE_CLASS: Record<(typeof SURFACE)[number], string> = {
  none: "",
  background: "bg-background",
  card: "bg-card",
  muted: "bg-muted",
  // Accent surface uses the portal accent var (set on [data-portal-root]).
  accent: "bg-[var(--portal-accent)]",
}

const TEXT_TONE_CLASS: Record<(typeof TEXT_TONE)[number], string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  accent: "text-[var(--portal-accent)]",
  onAccent: "text-white",
}

const TEXT_SIZE_CLASS: Record<(typeof TEXT_SIZE)[number], string> = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
  xl: "text-xl",
  "2xl": "text-2xl",
  "3xl": "text-3xl",
  "4xl": "text-4xl",
}

const TEXT_WEIGHT_CLASS: Record<(typeof TEXT_WEIGHT)[number], string> = {
  normal: "font-normal",
  medium: "font-medium",
  semibold: "font-semibold",
  bold: "font-bold",
}

const TEXT_ALIGN_CLASS: Record<"start" | "center" | "end", string> = {
  start: "text-left",
  center: "text-center",
  end: "text-right",
}

const WIDTH_CLASS: Record<(typeof WIDTH)[number], string> = {
  auto: "w-auto",
  full: "w-full",
  prose: "max-w-prose",
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
}

const COLUMNS_CLASS: Record<number, string> = {
  1: "grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-5",
  6: "sm:grid-cols-2 lg:grid-cols-6",
}

function pushClass(out: string[], value: string | undefined): void {
  if (value) out.push(value)
}

/** Token props common to container primitives → a Tailwind class string. */
export function resolveContainerClasses(props: Record<string, unknown> = {}): string {
  const out: string[] = []
  if (typeof props.gap === "string") pushClass(out, GAP_CLASS[props.gap as keyof typeof GAP_CLASS])
  if (typeof props.pad === "string") pushClass(out, PAD_CLASS[props.pad as keyof typeof PAD_CLASS])
  if (typeof props.align === "string") pushClass(out, ALIGN_CLASS[props.align as keyof typeof ALIGN_CLASS])
  if (typeof props.justify === "string")
    pushClass(out, JUSTIFY_CLASS[props.justify as keyof typeof JUSTIFY_CLASS])
  if (typeof props.radius === "string")
    pushClass(out, RADIUS_CLASS[props.radius as keyof typeof RADIUS_CLASS])
  if (typeof props.bg === "string") pushClass(out, SURFACE_CLASS[props.bg as keyof typeof SURFACE_CLASS])
  if (props.border === true) pushClass(out, "border border-border")
  if (typeof props.width === "string")
    pushClass(out, WIDTH_CLASS[props.width as keyof typeof WIDTH_CLASS])
  return out.join(" ")
}

/** Token props common to text primitives → a Tailwind class string. */
export function resolveTextClasses(props: Record<string, unknown> = {}): string {
  const out: string[] = []
  if (typeof props.tone === "string")
    pushClass(out, TEXT_TONE_CLASS[props.tone as keyof typeof TEXT_TONE_CLASS])
  if (typeof props.size === "string")
    pushClass(out, TEXT_SIZE_CLASS[props.size as keyof typeof TEXT_SIZE_CLASS])
  if (typeof props.weight === "string")
    pushClass(out, TEXT_WEIGHT_CLASS[props.weight as keyof typeof TEXT_WEIGHT_CLASS])
  if (typeof props.align === "string")
    pushClass(out, TEXT_ALIGN_CLASS[props.align as keyof typeof TEXT_ALIGN_CLASS])
  return out.join(" ")
}

/**
 * Radius / width tokens for LEAF primitives that carry them directly (Image).
 * Containers get the same tokens through `resolveContainerClasses`; these exist
 * so a leaf never has to interpolate a token into a class name — Tailwind only
 * emits classes it can see as literals, so `rounded-${token}` is not a class the
 * build is guaranteed to produce.
 */
export function resolveRadiusClass(radius: unknown): string {
  if (typeof radius !== "string") return ""
  return RADIUS_CLASS[radius as keyof typeof RADIUS_CLASS] ?? ""
}

export function resolveWidthClass(width: unknown): string {
  if (typeof width !== "string") return ""
  return WIDTH_CLASS[width as keyof typeof WIDTH_CLASS] ?? ""
}

/** Clamp + map a columns count (1–6) to responsive grid classes. */
export function resolveColumnsClass(columns: unknown): string {
  const n = typeof columns === "number" ? Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.round(columns))) : 1
  return COLUMNS_CLASS[n] ?? COLUMNS_CLASS[1]
}
