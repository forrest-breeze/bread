// Same-origin path / http(s) URL guard for portal hrefs.
//
// Extracted from `./schema` so the DSL registry (`dsl/registry/defs`) and
// validator can reuse it without forming an import cycle: schema.ts now imports
// the DSL validator (to gate a layout's `tree`), and the DSL validator's
// dependencies need `isSafeHref` — routing both through this leaf module keeps
// the dependency graph acyclic. `schema.ts` re-exports `isSafeHref` so existing
// `@/lib/portal/schema` importers are unaffected.
//
// Blocks `javascript:` / `data:` and other schemes — matters once the agent can
// author hrefs.
export function isSafeHref(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) return true
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}
