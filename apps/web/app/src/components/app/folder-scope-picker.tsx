"use client"

import type { FolderVisibility, WorkspaceMemberRole } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Building2, Shield } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export interface FolderScope {
  visibility: FolderVisibility
  required_role: WorkspaceMemberRole | null
}

// "workspace" (everyone) sits in the same list as the individual roles — from
// the user's point of view it's just one more "who can see this" choice.
const WORKSPACE_SCOPE_KEY = "workspace"

type ScopeKey = typeof WORKSPACE_SCOPE_KEY | WorkspaceMemberRole

const SCOPE_OPTIONS: ReadonlyArray<{
  key: ScopeKey
  label: string
  hint: string
}> = [
  {
    key: WORKSPACE_SCOPE_KEY,
    label: "Everyone in the workspace",
    hint: "Everyone in the workspace can see this folder.",
  },
  { key: "owner", label: "Owners", hint: roleHint("Owners") },
  { key: "admin", label: "Admins", hint: roleHint("Admins") },
  { key: "editor", label: "Editors", hint: roleHint("Editors") },
  { key: "viewer", label: "Viewers", hint: roleHint("Viewers") },
  { key: "agent-only", label: "Agents only", hint: roleHint("Agents") },
]

function roleHint(label: string): string {
  return `Only ${label} (or higher) can see this folder.`
}

function scopeToKey(value: FolderScope): ScopeKey {
  return value.visibility === "workspace"
    ? WORKSPACE_SCOPE_KEY
    : value.required_role ?? "admin"
}

function keyToScope(key: ScopeKey): FolderScope {
  return key === WORKSPACE_SCOPE_KEY
    ? { visibility: "workspace", required_role: null }
    : { visibility: "role", required_role: key }
}

export function FolderScopePicker({
  value,
  onChange,
  className,
}: {
  value: FolderScope
  onChange: (next: FolderScope) => void
  className?: string
}): React.ReactElement {
  const selectedKey = scopeToKey(value)
  const selected = SCOPE_OPTIONS.find((opt) => opt.key === selectedKey)

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Who can see this folder
      </p>

      <Select
        value={selectedKey}
        onValueChange={(key) => onChange(keyToScope(key as ScopeKey))}
      >
        <SelectTrigger className="h-8 w-full text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCOPE_OPTIONS.map((opt) => (
            <SelectItem key={opt.key} value={opt.key}>
              <span className="flex items-center gap-2">
                {opt.key === WORKSPACE_SCOPE_KEY ? (
                  <Building2 className="size-3.5 text-muted-foreground" />
                ) : (
                  <Shield className="size-3.5 text-muted-foreground" />
                )}
                {opt.label}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <p className="text-[11px] leading-snug text-muted-foreground">
        {selected?.hint}
      </p>
    </div>
  )
}
