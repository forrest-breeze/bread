"use client"

import { useState } from "react"
import { PORTAL_GLYPHS } from "@/components/icons/portal-glyphs"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { setTheme } from "@/lib/portal/builder-ops"
import type { PortalAssistant, PortalLayout } from "@/lib/portal/schema"

// The panel's headline mark uses the same brand glyph the portal assistant
// ships with, so the builder previews what visitors will see.
const ChatGlyph = PORTAL_GLYPHS["messages-square"]!

const DEFAULT_ASSISTANT: PortalAssistant = {
  enabled: false,
  placement: "corner",
  label: "Ask AI",
}

export function PortalAiAssistantControls({
  layout,
  onLayoutChange,
  canUseAi,
}: {
  layout: PortalLayout
  onLayoutChange: (layout: PortalLayout) => void
  canUseAi: boolean
}): React.ReactElement {
  const assistant = layout.theme.assistant ?? DEFAULT_ASSISTANT
  const [label, setLabel] = useState(assistant.label)
  const [error, setError] = useState<string | null>(null)

  const patch = (next: Partial<PortalAssistant>): void => {
    try {
      setError(null)
      onLayoutChange(
        setTheme(layout, { assistant: { ...assistant, ...next } }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed")
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex min-w-0 gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <ChatGlyph className="size-4" />
          </span>
          <div className="space-y-1">
            <Label htmlFor="portal-ai-assistant">AI assistant</Label>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Let visitors ask questions and receive cited answers from this portal.
            </p>
          </div>
        </div>
        <Switch
          id="portal-ai-assistant"
          checked={assistant.enabled && canUseAi}
          disabled={!canUseAi}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
      </div>

      {!canUseAi ? (
        <p className="rounded-lg border border-dashed border-border p-3 text-xs leading-relaxed text-muted-foreground">
          Add an Anthropic API key (ANTHROPIC_API_KEY) to enable the AI assistant.
        </p>
      ) : null}

      {canUseAi && assistant.enabled ? (
        <>
          <p className="text-xs text-muted-foreground">
            A floating button opens the assistant in a side drawer on every page.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="portal-ai-label">Button label</Label>
            <Input
              id="portal-ai-label"
              value={label}
              maxLength={60}
              onChange={(event) => setLabel(event.target.value)}
              onBlur={() => {
                if (label !== assistant.label) patch({ label })
              }}
              placeholder="Ask AI"
            />
          </div>
        </>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}
