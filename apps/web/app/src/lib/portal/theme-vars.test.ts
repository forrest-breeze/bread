import { describe, expect, it } from "vitest"
import { validatePortalLayout, type PortalLayout, type PortalTheme } from "./schema"
import {
  portalFontFaceCss,
  portalGoogleFontsHref,
  portalThemeCssVars,
  portalThemeDataAttributes,
} from "./theme-vars"

const baseTheme: PortalTheme = {
  brandName: "Acme",
  tagline: "",
  logoUrl: "",
  accentColor: "#2f5520",
  navLinks: [],
  cta: null,
  font: "sans",
  appearance: "auto",
}

function layoutWith(theme: Partial<PortalTheme>): PortalLayout {
  return {
    schemaVersion: 1,
    theme: { ...baseTheme, ...theme },
    header: { id: "header", type: "portal-header", search: { enabled: true, placeholder: "Search" } },
    body: [],
  }
}

describe("theme customization", () => {
  it("leaves an uncustomized theme's root untouched", () => {
    expect(portalThemeCssVars(baseTheme)).toEqual({ "--portal-accent": "#2f5520" })
    expect(Object.values(portalThemeDataAttributes(baseTheme)).filter(Boolean)).toEqual([])
    expect(portalGoogleFontsHref(baseTheme)).toBeNull()
  })

  it("emits vars and switches for every customized setting", () => {
    const theme: PortalTheme = {
      ...baseTheme,
      accentColorDark: "#7fb069",
      background: { light: "#f8fafc", dark: "#0b1020", decoration: "grid" },
      fonts: { heading: "Playfair Display", body: "Inter" },
      codeBlocks: "system",
    }
    expect(portalThemeCssVars(theme)).toMatchObject({
      "--portal-accent-dark": "#7fb069",
      "--portal-bg-light": "#f8fafc",
      "--portal-bg-dark": "#0b1020",
      "--portal-font-body": '"Inter"',
      "--portal-font-heading": '"Playfair Display"',
    })
    expect(portalThemeDataAttributes(theme)).toMatchObject({
      "data-portal-accent-dark": "",
      "data-portal-bg-light": "",
      "data-portal-bg-dark": "",
      "data-portal-decoration": "grid",
      "data-portal-font-body": "",
      "data-portal-font-heading": "",
      "data-portal-code": "system",
    })
    expect(portalGoogleFontsHref(theme)).toBe(
      "https://fonts.googleapis.com/css?family=Inter:400,500,600,700|Playfair+Display:400,500,600,700&display=swap",
    )
  })

  it("validates the new settings and rejects unsafe values", () => {
    expect(
      validatePortalLayout(
        layoutWith({
          accentColorDark: "#7fb069",
          appearanceLocked: true,
          fonts: { heading: "Space Grotesk" },
          background: { decoration: "gradient" },
          codeBlocks: "system",
          banner: { text: "v2 is live", linkLabel: "Read more", linkHref: "https://acme.dev", tone: "info", dismissible: true },
          showLastUpdated: false,
        }),
      ).ok,
    ).toBe(true)
    // A font name is interpolated into CSS and a URL, so only plain names pass.
    expect(validatePortalLayout(layoutWith({ fonts: { body: 'Inter"; }' } })).ok).toBe(false)
    expect(validatePortalLayout(layoutWith({ accentColorDark: "red" })).ok).toBe(false)
    expect(validatePortalLayout(layoutWith({ banner: { text: "x", linkHref: "javascript:alert(1)" } })).ok).toBe(false)
  })

  it("loads a self-hosted font through @font-face instead of Google Fonts", () => {
    const theme: PortalTheme = {
      ...baseTheme,
      fonts: {
        heading: "Neue Montreal",
        headingSource: "https://cdn.acme.dev/fonts/neue-montreal.woff2",
        body: "Inter",
      },
    }
    expect(portalFontFaceCss(theme)).toBe(
      '@font-face{font-family:"Neue Montreal";src:url("https://cdn.acme.dev/fonts/neue-montreal.woff2") format("woff2");font-weight:100 900;font-display:swap}',
    )
    expect(portalGoogleFontsHref(theme)).toBe(
      "https://fonts.googleapis.com/css?family=Inter:400,500,600,700&display=swap",
    )
    // The URL lands inside CSS, so anything that could break out is rejected.
    expect(
      validatePortalLayout(
        layoutWith({ fonts: { heading: "X", headingSource: 'https://x.dev/a.woff2");}body{' } }),
      ).ok,
    ).toBe(false)
    expect(validatePortalLayout(layoutWith({ fonts: { heading: "X", headingSource: "http://x.dev/a.woff2" } })).ok).toBe(false)
    expect(validatePortalLayout(layoutWith({ logoSize: "sm" })).ok).toBe(true)
  })
})
