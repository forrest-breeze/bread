import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { DashboardShell } from "@/components/app/sidebar"
import { SWRProvider } from "@/components/swr-provider"
import { AppThemeProvider } from "@/components/app-theme-provider"
import { APP_THEME_INIT_SCRIPT } from "@/lib/app-theme-init"
import { CommandPaletteProvider } from "@/components/app/command-palette"
import { getAuthUser } from "@/lib/auth/get-auth-user"
import { createAdminClient } from "@/lib/supabase/admin"
import { ensureBreezeWorkspaceMember } from "@/lib/breeze-workspace"
import { TimeoutError, withTimeout } from "@/lib/utils"

/** Budget for the membership check; same rationale as the auth timeout. */
const MEMBERSHIP_TIMEOUT_MS = 3000

function isTransientMembershipFailure(err: unknown): boolean {
  if (err instanceof TimeoutError) return true
  if (err instanceof TypeError) return true
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  )
}

export const metadata: Metadata = {
  title: { template: "%s", default: "Breezify" },
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await getAuthUser()

  if (!user) {
    redirect("/login")
  }

  // Breeze internal tool: one workspace, no onboarding. First visit adds the
  // user to the Breeze workspace (see lib/breeze-workspace.ts).
  try {
    await withTimeout(
      ensureBreezeWorkspaceMember(createAdminClient(), user.id),
      MEMBERSHIP_TIMEOUT_MS
    )
  } catch (err) {
    // A transient failure renders the shell; child loaders and API routes
    // enforce their own workspace checks and the next load retries the join.
    if (isTransientMembershipFailure(err)) {
      console.warn("[Breeze] workspace membership check unavailable:", err)
    } else {
      console.error("[Breeze] workspace membership check:", err)
      throw err
    }
  }

  return (
    <AppThemeProvider>
      {/* Runs during HTML parse, before the shell paints. */}
      <script dangerouslySetInnerHTML={{ __html: APP_THEME_INIT_SCRIPT }} />
      <SWRProvider userId={user.id}>
        <CommandPaletteProvider>
          <DashboardShell>{children}</DashboardShell>
        </CommandPaletteProvider>
      </SWRProvider>
    </AppThemeProvider>
  )
}
