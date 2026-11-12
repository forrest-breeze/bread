"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

interface SettingsNavItem {
  readonly label: string
  readonly href: string
}

interface SettingsNavGroup {
  readonly label: string
  readonly items: readonly SettingsNavItem[]
}

const settingsNav: readonly SettingsNavGroup[] = [
  {
    label: "Workspace",
    items: [
      { label: "General", href: "/settings/workspace" },
      { label: "Portal", href: "/settings/projects" },
      { label: "Usage", href: "/settings/usage" },
    ],
  },
  {
    label: "Account",
    items: [
      { label: "Profile", href: "/settings/profile" },
      { label: "Preferences", href: "/settings/preferences" },
    ],
  },
  {
    label: "Data management",
    items: [
      { label: "Export data", href: "/settings/export" },
      { label: "Trash", href: "/settings/trash" },
    ],
  },
  {
    label: "Developer",
    items: [{ label: "API & tokens", href: "/settings/developer" }],
  },
]

export function SettingsSubNav() {
  const pathname = usePathname()

  return (
    <nav className="space-y-4">
      {settingsNav.map((group) => (
        <div key={group.label} className="space-y-0.5">
          <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            {group.label}
          </p>
          {group.items.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(item.href + "/")

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                  isActive
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
              >
                {item.label}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
