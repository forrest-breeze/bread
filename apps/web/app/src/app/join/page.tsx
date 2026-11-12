"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Image from "next/image"
import { createClient } from "@/lib/supabase/client"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

function JoinContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const code = searchParams.get("code")

  const [status, setStatus] = useState<"loading" | "success" | "error" | "no-code" | "login-required">(
    code ? "loading" : "no-code"
  )
  const [message, setMessage] = useState("")

  useEffect(() => {
    if (!code) return

    let cancelled = false

    async function processInvite() {
      const supabase = createClient()
      const { data: claimsData } = await supabase.auth.getClaims()

      if (cancelled) return

      if (!claimsData?.claims?.sub) {
        setStatus("login-required")
        return
      }

      try {
        const res = await fetch("/api/workspace/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invite_code: code }),
        })

        if (cancelled) return
        const data = await res.json()

        if (res.ok) {
          document.cookie = `bread-workspace=${data.workspace_id}; path=/; max-age=31536000; samesite=lax`
          setStatus("success")
          setMessage("You've joined the workspace!")
          setTimeout(() => router.push("/knowledge"), 1500)
        } else if (res.status === 409) {
          setStatus("success")
          setMessage("You're already a member of this workspace.")
          setTimeout(() => router.push("/knowledge"), 1500)
        } else if (res.status === 410) {
          setStatus("error")
          setMessage(data.error || "This invite link is no longer valid")
        } else {
          setStatus("error")
          setMessage(data.error || "Failed to join workspace")
        }
      } catch {
        if (!cancelled) {
          setStatus("error")
          setMessage("Something went wrong. Please try again.")
        }
      }
    }

    processInvite()
    return () => { cancelled = true }
  }, [code, router])

  const handleLoginRedirect = () => {
    if (code) {
      sessionStorage.setItem("bread:pending-invite", code)
    }
    router.push("/login")
  }

  return (
    <>
      {status === "loading" && (
        <div className="space-y-3">
          <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Joining workspace...</p>
        </div>
      )}

      {status === "success" && (
        <div className="space-y-3">
          <p className="text-sm font-medium">{message}</p>
          <p className="text-xs text-muted-foreground">Redirecting to dashboard...</p>
        </div>
      )}

      {status === "error" && (
        <div className="space-y-4">
          <p className="text-sm text-destructive">{message}</p>
          <Button variant="outline" size="sm" onClick={() => router.push("/knowledge")}>
            Go to dashboard
          </Button>
        </div>
      )}

      {status === "no-code" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            No invite code found. Ask your team admin for an invite link.
          </p>
          <Button variant="outline" size="sm" onClick={() => router.push("/knowledge")}>
            Go to dashboard
          </Button>
        </div>
      )}

      {status === "login-required" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Sign in to join this workspace.
          </p>
          <Button size="sm" onClick={handleLoginRedirect}>
            Sign in
          </Button>
        </div>
      )}
    </>
  )
}

export default function JoinPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6 text-center">
        <Image
          src="/breeze-mark.png"
          alt="Breeze"
          width={26}
          height={26}
          className="mx-auto object-contain"
        />
        <Suspense
          fallback={
            <div className="space-y-3">
              <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
          }
        >
          <JoinContent />
        </Suspense>
      </div>
    </div>
  )
}
