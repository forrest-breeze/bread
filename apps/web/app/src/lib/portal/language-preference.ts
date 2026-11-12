import type { PortalLanguage } from "@/lib/portal/schema"

export const PORTAL_LANGUAGE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

export function portalLanguagePreferenceKey(
  portal: string,
  preview: boolean,
): string {
  return `bread-portal-language:${preview ? "preview:" : ""}${portal}`
}

export function portalLanguageCookieName(
  portal: string,
  preview: boolean,
): string {
  return `bread_portal_language_${encodeURIComponent(
    `${preview ? "preview:" : ""}${portal}`,
  )}`
}

export function validPortalLanguage(
  value: string | null | undefined,
  languages: PortalLanguage[],
): PortalLanguage | null {
  return value && languages.includes(value as PortalLanguage)
    ? (value as PortalLanguage)
    : null
}

/** Runs during HTML parsing so an older localStorage-only preference cannot paint English. */
export function portalLanguageBootstrapScript(
  portal: string,
  preview: boolean,
  languages: PortalLanguage[],
): string {
  const key = JSON.stringify(
    portalLanguagePreferenceKey(portal, preview),
  ).replaceAll("<", "\\u003c")
  const allowed = JSON.stringify(languages).replaceAll("<", "\\u003c")
  return `try{var l=window.localStorage.getItem(${key});if(l!=="en"&&${allowed}.includes(l)){document.documentElement.setAttribute("data-portal-translation-bootstrap","all")}}catch{}`
}
