import type { CSSProperties } from "react"
import type { PortalTheme } from "@/lib/portal/schema"

// ---------------------------------------------------------------------------
// Portal theme → CSS variables for the portal root (data-portal-root).
//
// --portal-accent is always emitted (from theme.accentColor) so the accent path
// keeps working exactly as before. theme.tokens (v2) re-points the remaining
// --portal-* vars when present; `fontFamily` is applied directly so a custom
// font takes effect immediately (inherited by the subtree). Color tokens are
// emitted for primitives that opt into the vars; absent tokens emit nothing, so
// the default appearance is byte-identical to pre-v2.
// ---------------------------------------------------------------------------

export function portalThemeCssVars(theme: PortalTheme): CSSProperties {
  const t = theme.tokens
  const vars: Record<string, string> = {
    "--portal-accent": t?.accent ?? theme.accentColor,
  }
  if (t?.bg) vars["--portal-bg"] = t.bg
  if (t?.surface) vars["--portal-surface"] = t.surface
  if (t?.text) vars["--portal-text"] = t.text
  if (t?.muted) vars["--portal-muted"] = t.muted
  if (t?.border) vars["--portal-border"] = t.border
  if (t?.radius) vars["--portal-radius"] = t.radius
  if (t?.fontFamily) vars.fontFamily = t.fontFamily
  // Theme customization (see portal-docs.css "Theme customization"): each var
  // is paired with a data attribute from portalThemeDataAttributes.
  if (theme.accentColorDark) vars["--portal-accent-dark"] = theme.accentColorDark
  if (theme.background?.light) vars["--portal-bg-light"] = theme.background.light
  if (theme.background?.dark) vars["--portal-bg-dark"] = theme.background.dark
  if (theme.fonts?.body) vars["--portal-font-body"] = cssFontFamily(theme.fonts.body)
  if (theme.fonts?.heading) vars["--portal-font-heading"] = cssFontFamily(theme.fonts.heading)
  return vars as CSSProperties
}

function cssFontFamily(family: string): string {
  return `"${family.replace(/"/g, "")}"`
}

/** Data attributes that switch on the CSS rules for the customized theme. */
export function portalThemeDataAttributes(
  theme: PortalTheme,
): Record<string, string | undefined> {
  return {
    "data-portal-accent-dark": theme.accentColorDark ? "" : undefined,
    "data-portal-bg-light": theme.background?.light ? "" : undefined,
    "data-portal-bg-dark": theme.background?.dark ? "" : undefined,
    "data-portal-decoration":
      theme.background?.decoration && theme.background.decoration !== "none"
        ? theme.background.decoration
        : undefined,
    "data-portal-font-body": theme.fonts?.body ? "" : undefined,
    "data-portal-font-heading": theme.fonts?.heading ? "" : undefined,
    "data-portal-code": theme.codeBlocks === "system" ? "system" : undefined,
  }
}

/**
 * Google Fonts stylesheet for the theme's custom fonts, or null. Uses the v1
 * CSS API, which serves whichever of the requested weights a family has
 * instead of failing the whole request on a missing weight.
 */
export function portalGoogleFontsHref(theme: PortalTheme): string | null {
  // Self-hosted families load through portalFontFaceCss instead.
  const families = [
    ...new Set([
      theme.fonts?.bodySource ? undefined : theme.fonts?.body,
      theme.fonts?.headingSource ? undefined : theme.fonts?.heading,
    ].filter(Boolean)),
  ] as string[]
  if (families.length === 0) return null
  const family = families
    .map((name) => `${name.trim().replace(/\s+/g, "+")}:400,500,600,700`)
    .join("|")
  return `https://fonts.googleapis.com/css?family=${family}&display=swap`
}

const FONT_FORMATS: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
}

/**
 * @font-face rules for self-hosted fonts, or null. Family names and URLs are
 * schema-validated (no quotes or parentheses), so they interpolate safely.
 */
export function portalFontFaceCss(theme: PortalTheme): string | null {
  const faces = [
    [theme.fonts?.heading, theme.fonts?.headingSource],
    [theme.fonts?.body, theme.fonts?.bodySource],
  ].flatMap(([family, source]) => {
    if (!family || !source) return []
    const extension = /\.([a-z0-9]+)(?:\?|$)/i.exec(source)?.[1]?.toLowerCase() ?? "woff2"
    const format = FONT_FORMATS[extension] ?? "woff2"
    return [
      `@font-face{font-family:${cssFontFamily(family)};src:url("${source}") format("${format}");font-weight:100 900;font-display:swap}`,
    ]
  })
  return faces.length ? [...new Set(faces)].join("") : null
}
