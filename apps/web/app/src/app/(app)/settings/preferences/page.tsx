"use client"

import { useSyncExternalStore } from "react"
import { useTheme } from "@/components/app-theme-provider"
import { Sun, Moon, Monitor } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

function subscribeToClientReady(): () => void {
  return () => {}
}

function getClientReadySnapshot(): boolean {
  return true
}

function getServerReadySnapshot(): boolean {
  return false
}

export default function PreferencesPage(): React.ReactElement {
  const { theme, setTheme } = useTheme()
  const mounted = useSyncExternalStore(
    subscribeToClientReady,
    getClientReadySnapshot,
    getServerReadySnapshot,
  )
  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-xl font-semibold">Preferences</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Customize the look and feel of your experience
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Choose how Breezify looks to you
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label>Theme</Label>
              <p className="text-[13px] text-muted-foreground">
                Select your preferred theme
              </p>
            </div>
            {mounted && (
              <div className="flex items-center gap-1 rounded-lg border p-1">
                {([
                  { value: "light", icon: Sun, label: "Light" },
                  { value: "dark", icon: Moon, label: "Dark" },
                  { value: "system", icon: Monitor, label: "System" },
                ] as const).map(({ value, icon: Icon, label }) => (
                  <Button
                    key={value}
                    variant="ghost"
                    size="sm"
                    onClick={() => setTheme(value)}
                    className={cn(
                      "h-7 gap-1.5 px-3 text-xs",
                      theme === value && "bg-muted"
                    )}
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <KeyboardShortcutsCard />
    </div>
  )
}

interface ShortcutGroup {
  readonly title: string
  readonly items: readonly ShortcutItem[]
}

interface ShortcutItem {
  readonly keys: readonly string[]
  readonly label: string
}

const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "General",
    items: [
      { keys: ["⌘", "K"], label: "Open command palette" },
      { keys: ["Esc"], label: "Close dialogs and menus" },
    ],
  },
  {
    title: "Editor",
    items: [
      { keys: ["⌘", "S"], label: "Save document" },
    ],
  },
  {
    title: "Knowledge sidebar",
    items: [
      { keys: ["⌘", "Click"], label: "Toggle item in multi-select" },
      { keys: ["Shift", "↑/↓"], label: "Extend selection range" },
      { keys: ["Enter"], label: "Confirm rename" },
      { keys: ["Esc"], label: "Cancel rename or clear selection" },
    ],
  },
]

function KeyboardShortcutsCard(): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Keyboard shortcuts</CardTitle>
        <CardDescription>
          Built-in shortcuts available throughout the app. Not yet
          configurable.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {SHORTCUT_GROUPS.map((group) => (
          <div key={group.title} className="space-y-2">
            <h3 className="text-[13px] font-medium text-muted-foreground">
              {group.title}
            </h3>
            <ul className="divide-y divide-border rounded-md border">
              {group.items.map((item) => (
                <li
                  key={`${group.title}:${item.label}`}
                  className="flex items-center justify-between px-3 py-2"
                >
                  <span className="text-sm">{item.label}</span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    {item.keys.map((key, i) => (
                      <kbd
                        key={i}
                        className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                      >
                        {key}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
