"use client"

import { ArrowLeft } from "lucide-react"
import { useRouter } from "next/navigation"
import { WorkspaceMembersCard } from "@/components/settings/workspace-members-card"

export default function WorkspaceMembersPage() {
  const router = useRouter()

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <button
          onClick={() => router.push("/settings/workspace")}
          className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Back to Workspace
        </button>
        <h1 className="text-xl font-semibold">Members</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everyone in your workspace
        </p>
      </div>

      <WorkspaceMembersCard />
    </div>
  )
}
