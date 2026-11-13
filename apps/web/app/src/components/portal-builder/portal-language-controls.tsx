"use client"

import { Languages, LockKeyhole } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { setHeader, setLocalization } from "@/lib/portal/builder-ops"
import {
  DEFAULT_PORTAL_LANGUAGE_PLACEMENT,
  PORTAL_TRANSLATION_LANGUAGES,
  type PortalLanguage,
  type PortalLayout,
  type PortalLanguagePlacement,
  type PortalTranslationLanguage,
} from "@/lib/portal/schema"
import type { PortalChromeScope } from "@/lib/workspace-settings"
import { cn } from "@/lib/utils"

const LANGUAGE_LABELS: Record<PortalLanguage, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  zh: "Chinese (Simplified)",
}

export function PortalLanguageControls({
  layout,
  onLayoutChange,
  onSharedLayoutChange,
  chromeScope,
  canUseTranslations,
}: {
  layout: PortalLayout
  onLayoutChange: (layout: PortalLayout) => void
  onSharedLayoutChange: (layout: PortalLayout) => void
  chromeScope: PortalChromeScope
  canUseTranslations: boolean
}): React.ReactElement {
  const enabled = layout.localization?.enabledLanguages ?? []
  const defaultLanguage = layout.localization?.defaultLanguage ?? "en"
  const languagePlacement =
    layout.header.languagePlacement ?? DEFAULT_PORTAL_LANGUAGE_PLACEMENT
  const commitHeaderLayout =
    chromeScope === "workspace" ? onSharedLayoutChange : onLayoutChange

  function setLanguagePlacement(placement: PortalLanguagePlacement): void {
    commitHeaderLayout(setHeader(layout, { languagePlacement: placement }))
  }

  function toggleLanguage(
    language: PortalTranslationLanguage,
    checked: boolean,
  ): void {
    const nextEnabled = checked
      ? PORTAL_TRANSLATION_LANGUAGES.filter(
          (candidate) => candidate === language || enabled.includes(candidate),
        )
      : enabled.filter((candidate) => candidate !== language)
    onLayoutChange(
      setLocalization(layout, {
        enabledLanguages: [...nextEnabled],
        defaultLanguage:
          !checked && defaultLanguage === language ? "en" : defaultLanguage,
      }),
    )
  }

  function setDefaultLanguage(value: unknown): void {
    if (typeof value !== "string") return
    const language = value
    const next = language as PortalLanguage
    if (next !== "en" && !enabled.includes(next)) return
    onLayoutChange(
      setLocalization(layout, {
        enabledLanguages: [...enabled],
        defaultLanguage: next,
      }),
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div>
          <Label>Selector position</Label>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Place the language selector directly to the right of the logo or with
            the actions on the far right of the header.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {([
            ["brand", "Right of logo"],
            ["actions", "Far right"],
          ] as const).map(([placement, label]) => (
            <button
              key={placement}
              type="button"
              aria-pressed={languagePlacement === placement}
              className={cn(
                "rounded-lg border px-3 py-2.5 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                languagePlacement === placement
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
              onClick={() => setLanguagePlacement(placement)}
            >
              {label}
            </button>
          ))}
        </div>
        {chromeScope === "workspace" ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            This position is shared by every portal project in the workspace.
          </p>
        ) : null}
      </div>

      {canUseTranslations ? (
        <>
          <div className="rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-sm ring-1 ring-border">
                <Languages className="size-4" />
              </span>
              <div>
                <p className="text-sm font-medium">Visitor languages</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Visitors can switch languages from the portal header. Article
                  content and portal controls are translated automatically.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            {PORTAL_TRANSLATION_LANGUAGES.map((language) => (
              <div
                key={language}
                className="flex min-h-12 items-center justify-between gap-4 border-b border-border/70 py-2 last:border-b-0"
              >
                <Label
                  htmlFor={`portal-language-${language}`}
                  className="cursor-pointer text-sm font-normal"
                >
                  {LANGUAGE_LABELS[language]}
                </Label>
                <Switch
                  id={`portal-language-${language}`}
                  checked={enabled.includes(language)}
                  onCheckedChange={(checked) => toggleLanguage(language, checked)}
                />
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <Label htmlFor="portal-default-language">Default language</Label>
            <Select value={defaultLanguage} onValueChange={setDefaultLanguage}>
              <SelectTrigger id="portal-default-language" className="h-11 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">{LANGUAGE_LABELS.en}</SelectItem>
                {enabled.map((language) => (
                  <SelectItem key={language} value={language}>
                    {LANGUAGE_LABELS[language]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs leading-relaxed text-muted-foreground">
              This is the first language visitors see. English remains available as
              the source language.
            </p>
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-border bg-muted/30 p-4">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-sm ring-1 ring-border">
              <LockKeyhole className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">Translations unavailable</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Add an Anthropic API key (ANTHROPIC_API_KEY) to enable machine
                translation.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
