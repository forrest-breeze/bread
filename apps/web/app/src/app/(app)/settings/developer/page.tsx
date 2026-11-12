"use client"

import { useState } from "react"
import { useApiKeys, usePersonalAccessTokens } from "@/hooks/swr"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Copy,
  Check,
  ExternalLink,
  Loader2,
  Trash2,
  Clock,
  Plus,
  KeyRound,
  Eye,
  EyeOff,
  RefreshCw,
  Pencil,
} from "lucide-react"

export default function DeveloperPage(): React.JSX.Element {
  const { data: keysData, mutate: mutateKeys, isLoading: loadingKeys } = useApiKeys()
  const { data: patData, mutate: mutatePats, isLoading: loadingPats } = usePersonalAccessTokens()

  const keys = keysData?.keys ?? []
  const hasKeys = keys.length > 0
  const pats = patData?.tokens ?? []
  const hasPats = pats.length > 0

  const [copiedCurl, setCopiedCurl] = useState(false)

  const [revokingId, setRevokingId] = useState<string | null>(null)

  const [isGenerating, setIsGenerating] = useState(false)
  const [newKeyName, setNewKeyName] = useState("API Key")
  // Folder-visibility tier the key acts as. Capped server-side at the
  // creator's own role.
  const [newKeyRole, setNewKeyRole] = useState<
    "admin" | "editor" | "viewer" | "agent-only"
  >("viewer")
  const [newKeyScope, setNewKeyScope] = useState<
    "read" | "admin"
  >("read")
  // "never" maps to null ttl_days (no expiry); otherwise a day count.
  const [newKeyTtl, setNewKeyTtl] = useState<"never" | "30" | "90" | "365">(
    "never",
  )
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [copiedNewKey, setCopiedNewKey] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // Revealed secrets are held in memory only, keyed by api_keys.id — never
  // written to storage, and dropped on navigation. `revealErrors` covers the
  // legacy-key 409 and a bad BREAD_TOKEN_ENC_KEY, which are per-row failures.
  const [revealedKeys, setRevealedKeys] = useState<Record<string, string>>({})
  const [revealingId, setRevealingId] = useState<string | null>(null)
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({})
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null)
  const [rotatingId, setRotatingId] = useState<string | null>(null)
  // Id of the key whose name is being edited inline, plus the draft value.
  const [editingNameId, setEditingNameId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState("")
  const [savingNameId, setSavingNameId] = useState<string | null>(null)

  // PAT state is separate from workspace API keys: different endpoint
  // (/api/user/pat), different scope (user, not workspace), different
  // rotation behavior (POST replaces any existing user PAT).
  const [revokingPatId, setRevokingPatId] = useState<string | null>(null)
  const [patDialogOpen, setPatDialogOpen] = useState(false)
  const [patGenerating, setPatGenerating] = useState(false)
  const [patName, setPatName] = useState("Personal Token")
  const [generatedPat, setGeneratedPat] = useState<string | null>(null)
  const [copiedNewPat, setCopiedNewPat] = useState(false)
  const [patError, setPatError] = useState<string | null>(null)

  const handleCopy = (text: string, setter: (val: boolean) => void) => {
    navigator.clipboard.writeText(text)
    setter(true)
    setTimeout(() => setter(false), 2000)
  }

  const handleToggleReveal = async (id: string) => {
    // Second click hides it again rather than re-fetching.
    if (revealedKeys[id]) {
      setRevealedKeys((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      return
    }

    setRevealingId(id)
    setRevealErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      const res = await fetch(`/api/workspace/api-keys/${id}/reveal`, {
        method: "POST",
      })
      const body = await res.json()
      if (!res.ok || typeof body.key !== "string") {
        setRevealErrors((prev) => ({
          ...prev,
          [id]: body.error ?? `Failed (${res.status})`,
        }))
        return
      }
      setRevealedKeys((prev) => ({ ...prev, [id]: body.key }))
    } catch (err) {
      setRevealErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : "Unknown error",
      }))
    } finally {
      setRevealingId(null)
    }
  }

  const startRename = (id: string, currentName: string) => {
    setEditingNameId(id)
    setNameDraft(currentName)
  }

  const handleRename = async (id: string) => {
    const name = nameDraft.trim()
    // Unchanged or emptied — treat as a cancel rather than a failed request.
    if (!name) {
      setEditingNameId(null)
      return
    }

    setSavingNameId(id)
    setRevealErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      const res = await fetch(`/api/workspace/api-keys?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setRevealErrors((prev) => ({
          ...prev,
          [id]: body.error ?? `Rename failed (${res.status})`,
        }))
        return
      }
      setEditingNameId(null)
      await mutateKeys()
    } catch (err) {
      setRevealErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : "Unknown error",
      }))
    } finally {
      setSavingNameId(null)
    }
  }

  const handleRotate = async (id: string, name: string) => {
    if (
      !confirm(
        `Rotate "${name}"? The current secret stops working immediately — any client using it must be updated.`,
      )
    )
      return

    setRotatingId(id)
    setRevealErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      const res = await fetch(`/api/workspace/api-keys/${id}/rotate`, {
        method: "POST",
      })
      const body = await res.json()
      if (!res.ok || typeof body.key !== "string") {
        setRevealErrors((prev) => ({
          ...prev,
          [id]: body.error ?? `Failed (${res.status})`,
        }))
        return
      }
      // Show the new secret straight away — the user needs it to update
      // whatever was using the old one.
      setRevealedKeys((prev) => ({ ...prev, [id]: body.key }))
      await mutateKeys()
    } catch (err) {
      setRevealErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : "Unknown error",
      }))
    } finally {
      setRotatingId(null)
    }
  }

  const handleCopyKey = (id: string, secret: string) => {
    navigator.clipboard.writeText(secret)
    setCopiedKeyId(id)
    setTimeout(() => setCopiedKeyId(null), 2000)
  }

  const handleRevoke = async (id: string) => {
    if (!confirm("Are you sure you want to revoke this API key?")) return
    setRevokingId(id)
    try {
      const res = await fetch(`/api/workspace/api-keys?id=${id}`, { method: "DELETE" })
      if (res.ok) await mutateKeys()
    } catch (err) {
      console.error(err)
    } finally {
      setRevokingId(null)
    }
  }

  const handleGenerateKey = async () => {
    if (!newKeyName.trim()) return
    setIsGenerating(true)
    setKeyError(null)
    try {
      const res = await fetch("/api/workspace/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newKeyName.trim(),
          role: newKeyRole,
          scopes: newKeyScope === "read" ? ["read"] : ["read", newKeyScope],
          ttl_days: newKeyTtl === "never" ? null : Number(newKeyTtl),
        }),
      })
      const data = await res.json()
      if (!res.ok || typeof data.key !== "string") {
        setKeyError(data.error ?? `Failed (${res.status})`)
        return
      }
      setGeneratedKey(data.key)
      await mutateKeys()
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setIsGenerating(false)
    }
  }

  const resetGenerateModal = (open: boolean) => {
    setDialogOpen(open)
    if (!open) {
      setTimeout(() => {
        setGeneratedKey(null)
        setNewKeyName("API Key")
        setNewKeyRole("viewer")
        setNewKeyScope("read")
        setNewKeyTtl("never")
        setCopiedNewKey(false)
        setKeyError(null)
      }, 300)
    }
  }

  const handleRevokePat = async (id: string) => {
    if (!confirm("Revoke this personal access token? Any client using it will stop working.")) return
    setRevokingPatId(id)
    try {
      const res = await fetch(`/api/user/pat?id=${id}`, { method: "DELETE" })
      if (res.ok) await mutatePats()
    } catch (err) {
      console.error(err)
    } finally {
      setRevokingPatId(null)
    }
  }

  const handleGeneratePat = async () => {
    setPatGenerating(true)
    setPatError(null)
    try {
      const res = await fetch("/api/user/pat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: patName.trim() || "Personal Token",
          scopes: ["read"],
        }),
      })
      const body = await res.json()
      if (!res.ok || typeof body.token !== "string") {
        setPatError(body.error ?? `Failed (${res.status})`)
        return
      }
      setGeneratedPat(body.token)
      await mutatePats()
    } catch (err) {
      setPatError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setPatGenerating(false)
    }
  }

  const resetPatModal = (open: boolean) => {
    setPatDialogOpen(open)
    if (!open) {
      setTimeout(() => {
        setGeneratedPat(null)
        setPatName("Personal Token")
        setCopiedNewPat(false)
        setPatError(null)
      }, 300)
    }
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""

  const curlExample = `curl -X GET "${appUrl}/api/v1/search?q=deployment" \\
  -H "Authorization: Bearer YOUR_API_KEY"`

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-xl font-semibold">Developer</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tokens, keys, and integration reference for programmatic access.
        </p>
      </div>

      <div className="grid gap-6">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
            <div>
              <CardTitle>Personal Access Tokens</CardTitle>
              <CardDescription>
                User-scoped API tokens.
              </CardDescription>
            </div>
            <Dialog open={patDialogOpen} onOpenChange={resetPatModal}>
              <DialogTrigger render={<Button size="sm" variant="outline" className="shrink-0" />}>
                <Plus className="mr-2 size-4" />
                Generate Token
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Generate Personal Access Token</DialogTitle>
                  <DialogDescription>
                    Mint a scoped token tied to your user account.
                  </DialogDescription>
                </DialogHeader>

                {generatedPat ? (
                  <div className="space-y-4 py-4">
                    <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                      <p className="font-semibold">Copy this token now!</p>
                      <p className="mt-1">You won&apos;t be able to see it again after closing this dialog.</p>
                    </div>
                    <div className="relative">
                      <pre className="rounded border bg-muted p-4 font-mono text-xs overflow-x-auto">
                        <code>{generatedPat}</code>
                      </pre>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute right-2 top-2 h-8 w-8 text-muted-foreground"
                        onClick={() => handleCopy(generatedPat, setCopiedNewPat)}
                      >
                        {copiedNewPat ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Copy and store it somewhere safe.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="patName">Token Name</Label>
                      <Input
                        id="patName"
                        autoComplete="off"
                        value={patName}
                        onChange={(e) => setPatName(e.target.value)}
                        placeholder="e.g. Personal Token"
                      />
                      <p className="text-xs text-muted-foreground">
                        Scope is <code className="bg-muted px-1 py-0.5 rounded text-[11px]">read</code>; expires in 90 days.
                      </p>
                    </div>
                    {patError && (
                      <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
                        {patError}
                      </div>
                    )}
                  </div>
                )}

                {!generatedPat && (
                  <DialogFooter>
                    <Button variant="ghost" onClick={() => resetPatModal(false)} disabled={patGenerating}>
                      Cancel
                    </Button>
                    <Button onClick={handleGeneratePat} disabled={patGenerating} className="gap-1.5">
                      {patGenerating ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
                      Generate
                    </Button>
                  </DialogFooter>
                )}
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent>
            {loadingPats ? (
              <div className="space-y-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : !hasPats ? (
              <div className="text-sm text-muted-foreground">
                No personal access tokens yet.
              </div>
            ) : (
              <div className="space-y-2">
                {pats.map((token) => (
                  <div key={token.id} className="flex items-center justify-between rounded-md border bg-muted/30 p-2 text-xs">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-sm">{token.name}</span>
                      <span className="text-muted-foreground flex items-center gap-1">
                        <Clock className="size-3" />
                        Created {new Date(token.created_at).toLocaleDateString()}
                        {token.last_used_at && (
                          <> &middot; Last used {new Date(token.last_used_at).toLocaleDateString()}</>
                        )}
                        {token.expires_at && (
                          <> &middot; Expires {new Date(token.expires_at).toLocaleDateString()}</>
                        )}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRevokePat(token.id)}
                      disabled={revokingPatId === token.id}
                    >
                      {revokingPatId === token.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                      <span className="sr-only">Revoke</span>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
            <div>
              <CardTitle>Workspace API Keys</CardTitle>
              <CardDescription>
                Keys are scoped to this workspace and can be used by anyone on your team to connect AI tools.
              </CardDescription>
            </div>
            <Dialog open={dialogOpen} onOpenChange={resetGenerateModal}>
              <DialogTrigger render={<Button size="sm" className="shrink-0" />}>
                <Plus className="mr-2 size-4" />
                Generate API Key
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Generate New API Key</DialogTitle>
                  <DialogDescription>
                    Create a workspace API key to authenticate REST API requests.
                  </DialogDescription>
                </DialogHeader>

                {generatedKey ? (
                  <div className="space-y-4 py-4">
                    <div className="rounded-md border-border bg-muted/40 border p-3 text-sm text-muted-foreground">
                      <p className="font-semibold text-foreground">Your new API key</p>
                      <p className="mt-1">
                        Copy it now, or reveal it again later from the list below.
                      </p>
                    </div>
                    <div className="relative">
                      <pre className="rounded border bg-muted p-4 font-mono text-xs overflow-x-auto">
                        <code>{generatedKey}</code>
                      </pre>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute right-2 top-2 h-8 w-8 text-muted-foreground"
                        onClick={() => handleCopy(generatedKey, setCopiedNewKey)}
                      >
                        {copiedNewKey ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="keyName">Key Name</Label>
                      <Input
                        id="keyName"
                        autoComplete="off"
                        value={newKeyName}
                        onChange={(e) => setNewKeyName(e.target.value)}
                        placeholder="e.g. Cursor Integration"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="keyRole">Role</Label>
                        <select
                          id="keyRole"
                          value={newKeyRole}
                          onChange={(e) =>
                            setNewKeyRole(
                              e.target.value as
                                | "admin"
                                | "editor"
                                | "viewer"
                                | "agent-only",
                            )
                          }
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <option value="admin">admin</option>
                          <option value="editor">editor</option>
                          <option value="viewer">viewer</option>
                          <option value="agent-only">agent-only</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="keyTtl">Expires</Label>
                        <select
                          id="keyTtl"
                          value={newKeyTtl}
                          onChange={(e) =>
                            setNewKeyTtl(
                              e.target.value as "never" | "30" | "90" | "365",
                            )
                          }
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <option value="never">Never</option>
                          <option value="30">30 days</option>
                          <option value="90">90 days</option>
                          <option value="365">365 days</option>
                        </select>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="keyScope">Permissions</Label>
                      <select
                        id="keyScope"
                        value={newKeyScope}
                        onChange={(e) =>
                          setNewKeyScope(e.target.value as "read" | "admin")
                        }
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                      >
                        <option value="read">Read only</option>
                        <option value="admin">Admin actions</option>
                      </select>
                      <p className="text-xs text-muted-foreground">
                        Admin actions enables write access, such as editing
                        documents through the API.
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      The key sees folders its role may access. It can&apos;t be
                      created with a role above your own.
                    </p>
                    {keyError && (
                      <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
                        {keyError}
                      </div>
                    )}
                  </div>
                )}

                <DialogFooter>
                  {generatedKey ? (
                    <Button onClick={() => resetGenerateModal(false)}>Done</Button>
                  ) : (
                    <>
                      <Button variant="outline" onClick={() => resetGenerateModal(false)}>Cancel</Button>
                      <Button onClick={handleGenerateKey} disabled={isGenerating || !newKeyName.trim()}>
                        {isGenerating ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                        Generate Key
                      </Button>
                    </>
                  )}
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent>
            {loadingKeys ? (
              <div className="space-y-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : !hasKeys ? (
              <div className="text-sm text-muted-foreground">
                No API keys generated yet. Create one to get started.
              </div>
            ) : (
              <div className="space-y-2">
                {keys.map((key) => {
                  const secret = revealedKeys[key.id]
                  const revealError = revealErrors[key.id]

                  return (
                    <div key={key.id} className="rounded-md border bg-muted/30 p-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex flex-col gap-1">
                          {editingNameId === key.id ? (
                            <Input
                              autoFocus
                              autoComplete="off"
                              maxLength={120}
                              className="h-7 w-56 text-sm"
                              value={nameDraft}
                              disabled={savingNameId === key.id}
                              onChange={(e) => setNameDraft(e.target.value)}
                              onBlur={() => handleRename(key.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleRename(key.id)
                                if (e.key === "Escape") setEditingNameId(null)
                              }}
                            />
                          ) : (
                            <span className="font-medium text-sm flex items-center gap-2">
                              <button
                                type="button"
                                className="group inline-flex items-center gap-1.5 text-left hover:text-foreground"
                                onClick={() => startRename(key.id, key.name)}
                              >
                                {key.name}
                                <Pencil className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
                                <span className="sr-only">Rename key</span>
                              </button>
                              {key.role && (
                                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
                                  {key.role}
                                </span>
                              )}
                            </span>
                          )}
                          <span className="text-muted-foreground flex items-center gap-1">
                            <Clock className="size-3" />
                            Created {new Date(key.created_at).toLocaleDateString()}
                            {key.last_used_at && (
                              <> &middot; Last used {new Date(key.last_used_at).toLocaleDateString()}</>
                            )}
                            {key.expires_at && (
                              <> &middot; Expires {new Date(key.expires_at).toLocaleDateString()}</>
                            )}
                          </span>
                          {!key.revealable && (
                            <span className="text-muted-foreground/80">
                              Created before keys became viewable — revoke and
                              regenerate if you&apos;ve lost the secret.
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center">
                          {key.revealable && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                              onClick={() => handleToggleReveal(key.id)}
                              disabled={revealingId === key.id}
                            >
                              {revealingId === key.id ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : secret ? (
                                <EyeOff className="size-3.5" />
                              ) : (
                                <Eye className="size-3.5" />
                              )}
                              <span className="sr-only">
                                {secret ? "Hide key" : "Reveal key"}
                              </span>
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                            onClick={() => handleRotate(key.id, key.name)}
                            disabled={rotatingId === key.id}
                          >
                            {rotatingId === key.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="size-3.5" />
                            )}
                            <span className="sr-only">Rotate key</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => handleRevoke(key.id)}
                            disabled={revokingId === key.id}
                          >
                            {revokingId === key.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="size-3.5" />
                            )}
                            <span className="sr-only">Revoke</span>
                          </Button>
                        </div>
                      </div>

                      {secret && (
                        <div className="relative mt-2">
                          <pre className="overflow-x-auto rounded border bg-background p-2 pr-10 font-mono text-[11px]">
                            <code>{secret}</code>
                          </pre>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="absolute right-1 top-1 h-7 w-7 text-muted-foreground"
                            onClick={() => handleCopyKey(key.id, secret)}
                          >
                            {copiedKeyId === key.id ? (
                              <Check className="size-3.5" />
                            ) : (
                              <Copy className="size-3.5" />
                            )}
                            <span className="sr-only">Copy key</span>
                          </Button>
                        </div>
                      )}

                      {revealError && (
                        <p className="mt-2 rounded-md border border-destructive/20 bg-destructive/5 p-2 text-[11px] text-destructive">
                          {revealError}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>REST API Reference</CardTitle>
            <CardDescription>
              Build your own integrations using the raw REST API
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Search Knowledge Base</p>
              <div className="relative">
                <pre className="rounded border border-border bg-muted/50 p-4 font-mono text-xs overflow-x-auto text-muted-foreground">
                  <code>{curlExample}</code>
                </pre>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-2 h-8 w-8 text-muted-foreground"
                  onClick={() => handleCopy(curlExample, setCopiedCurl)}
                >
                  {copiedCurl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="pt-2 text-sm text-muted-foreground flex items-center gap-1.5 hover:text-foreground transition-colors cursor-pointer w-fit">
              <ExternalLink className="size-3.5" />
              View Full API Documentation
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
