"use client"

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Globe2, LoaderCircle, RefreshCw } from "lucide-react"
import type {
  PortalLanguage,
  PortalLocalization,
} from "@/lib/portal/schema"
import {
  PORTAL_LANGUAGE_COOKIE_MAX_AGE_SECONDS,
  portalLanguageCookieName,
  portalLanguagePreferenceKey,
  validPortalLanguage,
} from "@/lib/portal/language-preference"
import { publicPortalApiPath } from "@/lib/portal/public-base-path"

const LANGUAGE_LABELS: Record<PortalLanguage, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  zh: "简体中文",
}

const TRANSLATABLE_ATTRIBUTES = ["placeholder", "title", "aria-label"] as const
const SKIP_SELECTOR =
  "script, style, code, pre, kbd, samp, textarea, [contenteditable], [translate='no'], [data-no-translate]"
const MAX_BATCH_STRINGS = 16
const MAX_BATCH_CHARACTERS = 12_000
const TRANSLATION_REQUEST_TIMEOUT_MS = 30_000
const TRANSLATION_REQUEST_ATTEMPTS = 2
const TRANSLATION_RETRY_DELAY_MS = 250

/** useLayoutEffect warns during SSR; the portal shell renders on the server. */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

interface StoredText {
  source: string
  translated: string | null
}

interface StoredAttribute {
  source: string
  translated: string | null
}

type TranslationHideScope = "all" | "content"

interface PortalTranslationContextValue {
  language: PortalLanguage
  languages: PortalLanguage[]
  isTranslating: boolean
  translationError: boolean
  setLanguage: (language: PortalLanguage) => void
  retryTranslation: () => void
}

const PortalTranslationContext =
  createContext<PortalTranslationContextValue | null>(null)

function sourceText(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 6_000 || !/\p{L}/u.test(trimmed)) return null
  if (
    /^(?:https?:\/\/|mailto:|tel:|\/[^\s]*$)/i.test(trimmed) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
  ) {
    return null
  }
  return trimmed
}

function translationBatches(strings: string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let characters = 0
  for (const value of strings) {
    if (
      current.length >= MAX_BATCH_STRINGS ||
      (current.length > 0 && characters + value.length > MAX_BATCH_CHARACTERS)
    ) {
      batches.push(current)
      current = []
      characters = 0
    }
    current.push(value)
    characters += value.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Whether a node introduced by a mutation carries anything worth translating.
 * Empty markers, spacers, icons, and wrapper elements do not.
 */
function containsTranslatableText(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return Boolean(sourceText((node as Text).data))
  }
  if (!(node instanceof Element) || node.closest(SKIP_SELECTOR)) return false
  return Boolean(sourceText(node.textContent ?? ""))
}

function textNodesWithin(root: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current) {
    const text = current as Text
    const parent = text.parentElement
    if (parent && !parent.closest(SKIP_SELECTOR) && sourceText(text.data)) {
      nodes.push(text)
    }
    current = walker.nextNode()
  }
  return nodes
}

export function PortalTranslationProvider({
  portal,
  localization,
  initialLanguage,
  preview = false,
  projectSlug,
  children,
}: {
  portal: string
  localization: PortalLocalization
  initialLanguage?: PortalLanguage | null
  preview?: boolean
  projectSlug?: string | null
  children: React.ReactNode
}): React.ReactElement {
  const languages = useMemo<PortalLanguage[]>(
    () => ["en", ...localization.enabledLanguages],
    [localization.enabledLanguages],
  )
  const preferenceKey = portalLanguagePreferenceKey(portal, preview)
  const cookieName = portalLanguageCookieName(portal, preview)
  const resolvedInitialLanguage =
    validPortalLanguage(initialLanguage, languages) ??
    localization.defaultLanguage
  const [language, setLanguageState] = useState<PortalLanguage>(
    resolvedInitialLanguage,
  )
  const [isTranslating, setIsTranslating] = useState(
    resolvedInitialLanguage !== "en",
  )
  const [translationError, setTranslationError] = useState(false)
  const [retryEpoch, setRetryEpoch] = useState(0)
  const textState = useRef(new WeakMap<Text, StoredText>())
  const attributeState = useRef(
    new WeakMap<Element, Map<string, StoredAttribute>>(),
  )
  const translationCache = useRef(
    new Map<string, Map<string, string>>(),
  )
  const settledLanguage = useRef<PortalLanguage | null>(null)

  // Restore the visitor's language before the browser paints, not a tick after.
  // Deferring this to a passive effect made every load render the default
  // language first, then re-run the whole translation pass against the stored
  // one — visible as a flash back to English on each navigation.
  const restoredPreferenceKey = useRef<string | null>(null)
  useIsomorphicLayoutEffect(() => {
    if (restoredPreferenceKey.current === preferenceKey) return
    restoredPreferenceKey.current = preferenceKey
    const stored = validPortalLanguage(
      window.localStorage.getItem(preferenceKey),
      languages,
    )
    if (!stored) return
    // Mirror the older localStorage preference into a cookie so subsequent
    // server renders can hide source-language HTML before hydration starts.
    document.cookie = `${cookieName}=${stored}; path=/; max-age=${PORTAL_LANGUAGE_COOKIE_MAX_AGE_SECONDS}; samesite=lax`
    setLanguageState((current) => (current === stored ? current : stored))
    if (stored !== "en") setIsTranslating(true)
  }, [cookieName, languages, preferenceKey])

  useIsomorphicLayoutEffect(() => {
    let active = true
    let running = false
    let rerun = false
    let rerunHideScope: TranslationHideScope | null = null
    const pendingRequests = new Set<AbortController>()
    const cacheForLanguage =
      translationCache.current.get(language) ?? new Map<string, string>()
    translationCache.current.set(language, cacheForLanguage)
    let hiddenRoot: HTMLElement | null = null
    let observer: MutationObserver | null = null
    /** True while this effect is writing translations back into the DOM. */
    let applying = false

    function hideUntranslated(
      root: HTMLElement,
      scope: TranslationHideScope,
    ): void {
      hiddenRoot = root
      const current = root.getAttribute("data-portal-translating")
      root.setAttribute(
        "data-portal-translating",
        current === "all" || scope === "all" ? "all" : "content",
      )
    }

    function revealTranslated(): void {
      hiddenRoot?.removeAttribute("data-portal-translating")
      hiddenRoot = null
    }

    async function requestTranslations(
      strings: string[],
      onBatch: () => void,
    ): Promise<void> {
      const missing = [...new Set(strings)].filter(
        (value) => !cacheForLanguage.has(value),
      )

      async function requestBatch(batch: string[]): Promise<void> {
        let lastError: unknown = null
        for (
          let attempt = 0;
          attempt < TRANSLATION_REQUEST_ATTEMPTS;
          attempt += 1
        ) {
          if (!active) throw new DOMException("Aborted", "AbortError")
          const controller = new AbortController()
          pendingRequests.add(controller)
          const timeout = window.setTimeout(
            () => controller.abort(),
            TRANSLATION_REQUEST_TIMEOUT_MS,
          )
          let retryable = true
          try {
            const response = await fetch(publicPortalApiPath("translate"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: controller.signal,
              body: JSON.stringify({
                portal,
                language,
                strings: batch,
                preview,
                projectSlug: projectSlug ?? undefined,
              }),
            })
            if (!response.ok) {
              retryable = response.status >= 500
              throw new Error(`Translation failed (${response.status})`)
            }
            const body = (await response.json()) as {
              translations?: unknown
            }
            if (
              !Array.isArray(body.translations) ||
              body.translations.length !== batch.length ||
              body.translations.some((value) => typeof value !== "string")
            ) {
              throw new Error("Translation response was malformed")
            }
            const translations = body.translations as string[]
            batch.forEach((source, index) => {
              cacheForLanguage.set(source, translations[index])
            })
            // Paint this batch now instead of waiting on its siblings: one slow
            // batch used to hold the entire page in English.
            onBatch()
            return
          } catch (error) {
            lastError = error
            if (
              !active ||
              !retryable ||
              attempt === TRANSLATION_REQUEST_ATTEMPTS - 1
            ) {
              throw error
            }
          } finally {
            window.clearTimeout(timeout)
            pendingRequests.delete(controller)
          }
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, TRANSLATION_RETRY_DELAY_MS)
          })
        }
        throw lastError ?? new Error("Translation failed")
      }

      try {
        await Promise.all(translationBatches(missing).map(requestBatch))
      } catch (error) {
        for (const request of pendingRequests) request.abort()
        throw error
      }
    }

    function collectRoot(): HTMLElement | null {
      return document.querySelector<HTMLElement>("[data-portal-root]")
    }

    function restoreEnglish(root: HTMLElement): void {
      for (const node of textNodesWithin(root)) {
        const stored = textState.current.get(node)
        if (stored && node.data === stored.translated) {
          const leading = node.data.match(/^\s*/)?.[0] ?? ""
          const trailing = node.data.match(/\s*$/)?.[0] ?? ""
          node.data = `${leading}${stored.source}${trailing}`
        }
        if (stored) stored.translated = null
      }
      for (const element of root.querySelectorAll<HTMLElement>("*")) {
        const attributes = attributeState.current.get(element)
        if (!attributes) continue
        for (const [name, stored] of attributes) {
          if (element.getAttribute(name) === stored.translated) {
            element.setAttribute(name, stored.source)
          }
          stored.translated = null
        }
      }
    }

    async function translateRoot(
      hideScope: TranslationHideScope | null = null,
    ): Promise<void> {
      if (!active) return
      if (running) {
        rerun = true
        if (hideScope) {
          rerunHideScope =
            rerunHideScope === "all" || hideScope === "all"
              ? "all"
              : "content"
          const root = collectRoot()
          if (root) hideUntranslated(root, hideScope)
        }
        return
      }
      const root = collectRoot()
      if (!root) {
        setIsTranslating(false)
        return
      }
      running = true
      setTranslationError(false)
      try {
        if (language === "en") {
          applying = true
          try {
            restoreEnglish(root)
          } finally {
            observer?.takeRecords()
            applying = false
          }
          settledLanguage.current = "en"
          return
        }

        const nodes = textNodesWithin(root)
        const sources: string[] = []
        for (const node of nodes) {
          const current = sourceText(node.data)
          if (!current) continue
          const stored = textState.current.get(node)
          if (!stored) {
            textState.current.set(node, { source: current, translated: null })
            sources.push(current)
          } else if (current !== stored.translated && current !== stored.source) {
            stored.source = current
            stored.translated = null
            sources.push(current)
          } else {
            sources.push(stored.source)
          }
        }

        const attributeTargets: Array<{
          element: Element
          name: string
          stored: StoredAttribute
        }> = []
        for (const element of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
          if (element.closest(SKIP_SELECTOR)) continue
          let storedAttributes = attributeState.current.get(element)
          for (const name of TRANSLATABLE_ATTRIBUTES) {
            const current = sourceText(element.getAttribute(name) ?? "")
            if (!current) continue
            if (!storedAttributes) {
              storedAttributes = new Map()
              attributeState.current.set(element, storedAttributes)
            }
            let stored = storedAttributes.get(name)
            if (!stored) {
              stored = { source: current, translated: null }
              storedAttributes.set(name, stored)
            } else if (current !== stored.translated && current !== stored.source) {
              stored.source = current
              stored.translated = null
            }
            sources.push(stored.source)
            attributeTargets.push({ element, name, stored })
          }
        }

        // Writes every string the cache currently holds. Safe to call repeatedly
        // — untranslated nodes are skipped and translated ones are idempotent.
        function applyTranslations(): void {
          if (!active) return
          applying = true
          try {
            writeTranslations()
          } finally {
            // Drop the records our own writes just queued so the guard above
            // cannot race the observer's microtask delivery.
            observer?.takeRecords()
            applying = false
          }
        }

        function writeTranslations(): void {
          for (const node of nodes) {
            const stored = textState.current.get(node)
            if (!stored) continue
            const translated = cacheForLanguage.get(stored.source)
            if (!translated) continue
            const leading = node.data.match(/^\s*/)?.[0] ?? ""
            const trailing = node.data.match(/\s*$/)?.[0] ?? ""
            stored.translated = translated
            const next = `${leading}${translated}${trailing}`
            if (node.data !== next) node.data = next
          }
          for (const { element, name, stored } of attributeTargets) {
            const translated = cacheForLanguage.get(stored.source)
            if (!translated) continue
            stored.translated = translated
            if (element.getAttribute(name) !== translated) {
              element.setAttribute(name, translated)
            }
          }
        }

        const untranslated = nodes.filter((node) => {
          const stored = textState.current.get(node)
          return stored ? !cacheForLanguage.has(stored.source) : false
        }).length
        // Only a bulk arrival — a navigation swapping the whole body — is worth
        // hiding. A widget inserting a few nodes must not blink the page, and a
        // fully cached pass applies synchronously below with nothing to hide.
        if (
          untranslated > 0 &&
          (hideScope || untranslated >= nodes.length * 0.25)
        ) {
          hideUntranslated(root, hideScope ?? "content")
        }
        // Only claim to be translating when something actually has to go to the
        // network; otherwise every incremental mutation flickers the spinner.
        setIsTranslating(untranslated > 0)

        applyTranslations()
        await requestTranslations(sources, applyTranslations)
        if (!active) return
        applyTranslations()
        settledLanguage.current = language
      } catch (error) {
        if (active && language !== "en") setTranslationError(true)
        console.warn(
          "[Bread] portal translation:",
          error instanceof Error ? error.message : error,
        )
      } finally {
        running = false
        revealTranslated()
        if (active) {
          setIsTranslating(false)
          if (rerun) {
            rerun = false
            const nextHideScope = rerunHideScope
            rerunHideScope = null
            void translateRoot(nextHideScope)
          }
        }
      }
    }

    document.documentElement.lang = language
    // The first pass for a language hides all chrome. Once that language has
    // settled, a new `children` payload represents page navigation and only the
    // content area needs to wait; the translated header can remain visible.
    void translateRoot(
      settledLanguage.current === language ? "content" : "all",
    )
    const root = collectRoot()
    observer = new MutationObserver((mutations) => {
      // Writing translations back into the DOM is itself a mutation. Without
      // this guard every apply schedules another pass over the whole document.
      if (applying) return
      const hasTranslatableMutation = mutations.some((mutation) => {
        const target =
          mutation.target instanceof Element
            ? mutation.target
            : mutation.target.parentElement
        if (target?.closest(SKIP_SELECTOR)) return false
        // A childList change that carries no text cannot affect translation.
        // Scroll-driven UI does this constantly — the blog table of contents
        // inserts and removes an empty marker span as the active heading
        // changes — and re-walking the document for each one is pure churn.
        if (mutation.type === "childList") {
          return Array.from(mutation.addedNodes).some(containsTranslatableText)
        }
        return true
      })
      // MutationObserver callbacks run in the microtask checkpoint before the
      // browser paints. Start the pass now so a React render that restores an
      // English source string is replaced from the in-memory cache in that same
      // checkpoint. The old 120 ms debounce exposed the English intermediate
      // state every time scroll-driven chrome rendered.
      if (hasTranslatableMutation) {
        const main = root?.querySelector(":scope > main")
        const replacesPageContent = mutations.some((mutation) => {
          if (mutation.type !== "childList") return false
          const target = mutation.target
          if (!(target instanceof Element) || !main) return false
          if (target !== main && target.parentElement !== main) return false
          return Array.from(mutation.addedNodes).some(containsTranslatableText)
        })
        void translateRoot(replacesPageContent ? "content" : null)
      }
    })
    if (root) {
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
      })
    }

    return () => {
      active = false
      observer?.disconnect()
      revealTranslated()
      for (const request of pendingRequests) request.abort()
      pendingRequests.clear()
    }
  }, [children, language, portal, preview, projectSlug, retryEpoch])

  function setLanguage(next: PortalLanguage): void {
    if (!languages.includes(next)) return
    window.localStorage.setItem(preferenceKey, next)
    document.cookie = `${cookieName}=${next}; path=/; max-age=${PORTAL_LANGUAGE_COOKIE_MAX_AGE_SECONDS}; samesite=lax`
    setTranslationError(false)
    setLanguageState(next)
  }

  function retryTranslation(): void {
    setTranslationError(false)
    setRetryEpoch((current) => current + 1)
  }

  return (
    <PortalTranslationContext.Provider
      value={{
        language,
        languages,
        isTranslating,
        translationError,
        setLanguage,
        retryTranslation,
      }}
    >
      {children}
    </PortalTranslationContext.Provider>
  )
}

export function PortalLanguageSelector(): React.ReactElement | null {
  const translation = useContext(PortalTranslationContext)
  if (!translation || translation.languages.length <= 1) return null

  return (
    <div
      data-no-translate
      aria-busy={translation.isTranslating}
      title={
        translation.translationError
          ? "Translation failed. Retry translation."
          : undefined
      }
      className={`relative flex h-9 items-center gap-1.5 rounded-lg border bg-background px-2 text-xs font-medium text-foreground shadow-sm ${
        translation.translationError
          ? "border-destructive/60"
          : "border-border"
      }`}
    >
      {translation.isTranslating ? (
        <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
      ) : translation.translationError ? (
        <button
          type="button"
          aria-label="Retry portal translation"
          title="Retry translation"
          onClick={translation.retryTranslation}
          className="rounded-sm text-destructive outline-none hover:text-destructive/80 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className="size-3.5" />
        </button>
      ) : (
        <Globe2 className="size-3.5 text-muted-foreground" />
      )}
      <span className="sr-only">Portal language</span>
      <select
        aria-label="Portal language"
        value={translation.language}
        onChange={(event) =>
          translation.setLanguage(event.target.value as PortalLanguage)
        }
        className="max-w-24 cursor-pointer appearance-none bg-transparent pr-3 outline-none"
      >
        {translation.languages.map((language) => (
          <option key={language} value={language}>
            {LANGUAGE_LABELS[language]}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground"
      >
        ▾
      </span>
    </div>
  )
}
