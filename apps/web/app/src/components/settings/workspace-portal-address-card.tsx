"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Folder,
  Globe,
  Link2,
  Loader2,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import { usePortalProjects, useWorkspace } from "@/hooks/swr"
import {
  clearWorkspaceCustomDomain,
  updateWorkspaceCustomDomain,
  updateWorkspacePortalAddressConfig,
  verifyPortalAddress,
  type PortalConnectionResult,
} from "@/lib/api/workspace"
import {
  customDomainDnsRecord,
  customDomainErrorMessage,
  getKbCustomDomain,
  getKbPublic,
  getPortalAddressMode,
  getPortalAddressScope,
  validateCustomDomain,
  type PortalAddressMode,
  type PortalAddressScope,
  type CustomDomainDnsRecord,
} from "@/lib/workspace-settings"
import type { WorkspaceRole } from "@breezify/core"
import { PortalDnsInstructions } from "@/components/portal-dns-instructions"
import { PortalReverseProxyInstructions } from "@/components/portal-reverse-proxy-instructions"
import type { CloudflareConnectorStatusResult } from "@/lib/api/cloudflare"
import {
  PortalConnectionBadge,
  type PortalConnectionStatus,
} from "@/components/portal-connection-badge"

export function WorkspacePortalAddressCard(): React.ReactElement | null {
  const { data: workspace, mutate } = useWorkspace()
  const hasHydrated = useHasHydrated()
  // Published projects feed the example URLs below. Only admins/owners can
  // read them, so gate the fetch on role to avoid a guaranteed 403 for viewers.
  const canManageProjects =
    workspace?.user_role === "admin" || workspace?.user_role === "owner"
  const { data: projectData } = usePortalProjects({
    workspaceId: workspace?.id,
    enabled: Boolean(workspace?.id) && canManageProjects,
  })
  const [scopeSaving, setScopeSaving] = useState(false)
  const [scopeError, setScopeError] = useState<string | null>(null)

  const savedDomain = getKbCustomDomain(workspace?.settings)
  const savedScope = getPortalAddressScope(workspace?.settings)
  const savedMode = getPortalAddressMode(workspace?.settings)
  const [domainInput, setDomainInput] = useState(savedDomain)
  const [lastAddressKey, setLastAddressKey] = useState(
    `${savedScope}:${savedMode}:${savedDomain}`,
  )
  const [savingDomain, setSavingDomain] = useState(false)
  const [domainError, setDomainError] = useState<string | null>(null)
  const [domainStatus, setDomainStatus] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [scope, setScope] = useState<PortalAddressScope>(savedScope)
  const [mode, setMode] = useState<PortalAddressMode>(savedMode)
  const [conn, setConn] = useState<PortalConnectionResult | null>(null)
  const [cloudflareStatus, setCloudflareStatus] =
    useState<CloudflareConnectorStatusResult | null>(null)
  const verifyRequestRef = useRef(0)
  const addressSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const addressKey = `${savedScope}:${savedMode}:${savedDomain}`
  if (addressKey !== lastAddressKey) {
    setLastAddressKey(addressKey)
    setDomainInput(savedDomain)
    setScope(savedScope)
    setDomainError(null)
    setDomainStatus(null)
    setMode(savedMode)
    setConn(null)
    setCloudflareStatus(null)
  }

  // The only configured address is a custom domain; the default /p/<slug> URL is
  // always on and needs no verification.
  const verifyType: "custom" | "path" | null =
    savedScope === "workspace" && savedDomain
      ? savedMode === "domain"
        ? "custom"
        : savedMode === "path"
          ? "path"
          : null
      : null

  const runVerify = useCallback(
    async (type: "custom" | "path", signal?: AbortSignal): Promise<void> => {
      const requestId = verifyRequestRef.current + 1
      verifyRequestRef.current = requestId
      const result = await verifyPortalAddress(type, signal)
      if (signal?.aborted || requestId !== verifyRequestRef.current) return
      setConn(result)
    },
    [],
  )

  useEffect(() => {
    const role = workspace?.user_role
    const admin = role === "admin" || role === "owner"
    if (!verifyType || !admin) return
    const controller = new AbortController()
    void runVerify(verifyType, controller.signal)
    return () => controller.abort()
  }, [verifyType, workspace?.user_role, runVerify])

  useEffect(
    () => () => {
      if (addressSaveTimerRef.current !== null) {
        clearTimeout(addressSaveTimerRef.current)
      }
    },
    [],
  )

  if (!workspace) return null

  const role = (workspace.user_role as WorkspaceRole | undefined) ?? "viewer"
  const isAdmin = role === "admin" || role === "owner"
  const isPublic = getKbPublic(workspace.settings)
  const customDnsRecord = savedDomain ? customDomainDnsRecord(savedDomain) : null
  const cloudflareWorkerNeedsUpdate = Boolean(
    mode === "path" &&
      cloudflareStatus?.connected &&
      cloudflareStatus.deployment?.status === "connected" &&
      cloudflareStatus.deployment.needsDeploy,
  )
  const connStatus: PortalConnectionStatus =
    mode === "breezify"
      ? isPublic
        ? "connected"
        : "pending"
      : savingDomain || scopeSaving || savedMode !== mode || !savedDomain || !conn
        ? "pending"
        : conn.connected
          ? "connected"
          : cloudflareWorkerNeedsUpdate
            ? "needs_update"
            : "not_connected"
  // The default URL is keyed on the workspace slug.
  const directPath = workspace.slug ? `/p/${workspace.slug}` : null
  const origin = hasHydrated ? window.location.origin : ""
  const directUrl = directPath ? `${origin}${directPath}` : null

  const publishedProjects = (projectData?.projects ?? []).filter(
    (p) => p.publishedVersion != null,
  )
  const exampleProject =
    publishedProjects.find((project) => project.slug !== workspace.slug) ??
    (projectData?.projects ?? []).find((project) => project.slug !== workspace.slug) ??
    (projectData?.projects ?? [])[0] ??
    null

  const onChangeScope = async (nextScope: PortalAddressScope): Promise<void> => {
    if (!isAdmin || scopeSaving || nextScope === scope) return
    if (addressSaveTimerRef.current !== null) {
      clearTimeout(addressSaveTimerRef.current)
      addressSaveTimerRef.current = null
    }
    const previous = scope
    setScope(nextScope)
    setScopeError(null)
    setDomainStatus(null)
    setScopeSaving(true)
    const result = await updateWorkspacePortalAddressConfig({
      scope: nextScope,
      mode,
    })
    setScopeSaving(false)
    if (!result.ok || !result.workspace) {
      setScope(previous)
      setScopeError(result.error ?? "Couldn't change URL ownership.")
      return
    }
    void mutate(result.workspace, false)
    window.dispatchEvent(new Event("workspace-updated"))
  }

  // Pass the saved domain so the workspace's own live domain never renders as
  // an error (the dogfood workspace legitimately holds the public-KB apex).
  const domainValidation = validateCustomDomain(domainInput, savedDomain)
  const trimmedDomain = domainInput.trim()
  const domainFormatError =
    trimmedDomain.length > 0 ? domainValidation.error : null
  const normalizedDomain = domainValidation.domain
  const previewDnsRecord = normalizedDomain
    ? customDomainDnsRecord(normalizedDomain)
    : null
  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(value)
      setTimeout(() => setCopied((current) => (current === value ? null : current)), 1500)
    } catch {
      // Clipboard unavailable in insecure contexts.
    }
  }

  async function persistAddress(
    nextMode: PortalAddressMode,
    rawDomain: string,
  ): Promise<void> {
    const validation = validateCustomDomain(rawDomain, savedDomain)
    if (nextMode !== "breezify" && (!validation.domain || validation.error)) return
    const nextDomain = validation.domain
    const nextDomainDirty = nextMode !== "breezify" && nextDomain !== savedDomain
    const configDirty = nextMode !== savedMode || scope !== savedScope
    if (!nextDomainDirty && !configDirty) {
      setDomainStatus("Saved automatically.")
      return
    }
    setSavingDomain(true)
    setDomainError(null)
    setDomainStatus("Saving automatically…")
    try {
      if (nextDomainDirty) {
        const domainResult = await updateWorkspaceCustomDomain(nextDomain)
        if (!domainResult.ok) {
          setDomainStatus(null)
          setDomainError(domainResult.error ?? "Couldn't save the custom domain.")
          return
        }
      }
      const result = await updateWorkspacePortalAddressConfig({
        scope,
        mode: nextMode,
      })
      if (!result.ok || !result.workspace) {
        setDomainStatus(null)
        setDomainError(result.error ?? "Couldn't save the portal address.")
        return
      }
      void mutate(result.workspace, false)
      window.dispatchEvent(new Event("workspace-updated"))
      setDomainStatus("Saved automatically.")
    } catch {
      setDomainStatus(null)
      setDomainError("Couldn't save the portal address.")
    } finally {
      setSavingDomain(false)
    }
  }

  function scheduleAddressSave(
    nextMode: PortalAddressMode,
    rawDomain: string,
    delay = 600,
  ): void {
    if (addressSaveTimerRef.current !== null) {
      clearTimeout(addressSaveTimerRef.current)
      addressSaveTimerRef.current = null
    }
    setDomainError(null)
    setDomainStatus(null)
    const validation = validateCustomDomain(rawDomain, savedDomain)
    if (nextMode !== "breezify" && (!validation.domain || validation.error)) return
    setDomainStatus("Saving automatically…")
    addressSaveTimerRef.current = setTimeout(() => {
      addressSaveTimerRef.current = null
      void persistAddress(nextMode, rawDomain)
    }, delay)
  }

  const onClearDomain = async (): Promise<void> => {
    if (addressSaveTimerRef.current !== null) {
      clearTimeout(addressSaveTimerRef.current)
      addressSaveTimerRef.current = null
    }
    setSavingDomain(true)
    setDomainError(null)
    setDomainStatus(null)
    const result = await clearWorkspaceCustomDomain()
    if (!result.ok) {
      setSavingDomain(false)
      setDomainError(result.error ?? "Couldn't remove the custom domain.")
      return
    }
    const configResult = await updateWorkspacePortalAddressConfig({
      scope,
      mode: "breezify",
    })
    if (!configResult.ok || !configResult.workspace) {
      setSavingDomain(false)
      setDomainError(
        configResult.error ?? "The domain was removed, but the URL mode could not be reset.",
      )
      void mutate()
      return
    }
    setSavingDomain(false)
    void mutate(configResult.workspace, false)
    window.dispatchEvent(new Event("workspace-updated"))
    setDomainInput("")
    setMode("breezify")
    setDomainStatus("Custom domain removed.")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace Portal Address</CardTitle>
        <CardDescription>
          Choose whether hosting is managed once for the workspace or separately
          inside each project.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          role="radiogroup"
          aria-label="Portal URL ownership"
          className="grid grid-cols-2 gap-1 rounded-lg border border-input bg-muted/20 p-1"
        >
          {(["workspace", "project"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              disabled={!isAdmin || scopeSaving}
              onClick={() => void onChangeScope(value)}
              className={`rounded-md px-3 py-2 text-center text-xs font-medium transition-colors disabled:opacity-60 ${
                scope === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
              }`}
            >
              {value === "workspace" ? "Workspace-specific" : "Project-specific"}
            </button>
          ))}
        </div>

        {scopeError ? (
          <p role="alert" className="text-xs text-destructive">
            {scopeError}
          </p>
        ) : null}

        {!isPublic ? (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Globe className="size-3.5" />
            Your portal isn&apos;t published yet — the address you choose goes
            live once you publish it.
          </p>
        ) : null}

        {scope === "project" ? (
          <div className="rounded-lg border border-input bg-muted/20 p-4">
            <p className="text-sm font-medium">Hosting is configured per project</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Each project chooses its own Breeze URL, custom sub-folder, or
              custom domain. Workspace hosting controls are hidden in this mode.
            </p>
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              render={<Link href="/knowledge" />}
              onClick={() => {
                window.sessionStorage.setItem(
                  "breezify-kb-builder-sidebar-view",
                  "customize",
                )
              }}
            >
              Open project configuration
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div role="radiogroup" aria-label="Workspace hosting method" className="space-y-2">
              <PortalOption
                selected={mode === "breezify"}
                onSelect={() => {
                  setMode("breezify")
                  scheduleAddressSave("breezify", domainInput, 0)
                }}
                disabled={!isAdmin || scopeSaving}
                title="Breeze URL"
                description="Use the built-in workspace address on the app domain."
                icon={<Link2 className="size-4 text-violet-500" />}
              />
              <PortalOption
                selected={mode === "path"}
                onSelect={() => {
                  setMode("path")
                  scheduleAddressSave("path", domainInput)
                }}
                disabled={!isAdmin || scopeSaving}
                title="Custom sub-folder"
                description="Keep your website and publish projects at customer.com/path."
                icon={<Folder className="size-4 text-orange-500" />}
                badge="Recommended"
                connectionStatus={
                  mode === "path" && (Boolean(savedDomain) || savingDomain)
                    ? connStatus
                    : undefined
                }
              />
              <PortalOption
                selected={mode === "domain"}
                onSelect={() => {
                  setMode("domain")
                  scheduleAddressSave("domain", domainInput)
                }}
                disabled={!isAdmin || scopeSaving}
                title="Custom domain"
                description="Use a dedicated domain such as docs.customer.com."
                icon={<Globe className="size-4 text-sky-500" />}
                connectionStatus={
                  mode === "domain" && (Boolean(savedDomain) || savingDomain)
                    ? connStatus
                    : undefined
                }
              />
            </div>

            {mode === "breezify" ? (
              directUrl ? (
                <UrlRow
                  url={directUrl}
                  href={directPath ?? undefined}
                  copied={copied === directUrl}
                  onCopy={() => void copy(directUrl)}
                />
              ) : null
            ) : (
              <div className="space-y-2 rounded-lg border border-input p-3">
                <Input
                  id="workspace-portal-custom-domain"
                  aria-label="Custom domain"
                  value={domainInput}
                  placeholder={mode === "path" ? "customer.com" : "docs.customer.com"}
                  disabled={!isAdmin}
                  className="max-w-lg font-mono lowercase"
                  onChange={(event) => {
                    const nextDomain = event.target.value
                    setDomainInput(nextDomain)
                    scheduleAddressSave(mode, nextDomain)
                  }}
                />
                {domainFormatError ? (
                  <StatusText tone="danger" icon="alert">
                    {customDomainErrorMessage(domainFormatError)}
                  </StatusText>
                ) : null}

                {mode === "path" && normalizedDomain && exampleProject ? (
                  <>
                    <PortalReverseProxyInstructions
                      domain={normalizedDomain}
                      mountPath={`/${exampleProject.slug}`}
                      portalPath={
                        exampleProject.slug === workspace.slug
                          ? `/p/${workspace.slug}`
                          : `/p/${workspace.slug}/${exampleProject.slug}`
                      }
                      routeMappings={(projectData?.projects ?? [])
                        .map((project) => ({
                          mountPath: `/${project.slug}`,
                          portalPath:
                            project.slug === workspace.slug
                              ? `/p/${workspace.slug}`
                              : `/p/${workspace.slug}/${project.slug}`,
                        }))}
                      breezifyOrigin={
                        process.env.NEXT_PUBLIC_APP_URL ?? ""
                      }
                      connectorReady={
                        normalizedDomain === savedDomain &&
                        savedMode === "path" &&
                        savedScope === "workspace"
                      }
                      verifyWorkerActivation={async () =>
                        (await verifyPortalAddress("path")).connected
                      }
                      onWorkerConnected={() => {
                        setConn(null)
                        void runVerify("path")
                      }}
                      onWorkerStatusChange={setCloudflareStatus}
                    />
                    {normalizedDomain === savedDomain ? (
                      <div className="flex flex-wrap items-center gap-2 rounded-md border border-input bg-muted/20 p-2.5">
                        <PortalConnectionBadge status={connStatus} />
                        <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                          {connStatus === "connected"
                            ? "Every published project path is staying on this domain."
                            : connStatus === "needs_update"
                              ? `The Worker is connected, but its routes are out of date. ${conn?.reason ?? "Update it to activate every published project path."}`
                              : conn?.reason ?? "Checking every published project path…"}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!isAdmin || connStatus === "pending"}
                          onClick={() => {
                            setConn(null)
                            void runVerify("path")
                          }}
                        >
                          Check connection
                        </Button>
                      </div>
                    ) : null}
                  </>
                ) : mode === "path" ? (
                  <p className="text-[11px] text-muted-foreground">
                    Save a project path to generate its proxy setup.
                  </p>
                ) : normalizedDomain && previewDnsRecord ? (
                  normalizedDomain === savedDomain && customDnsRecord ? (
                    <CustomDomainDns
                      domain={savedDomain}
                      record={customDnsRecord}
                      status={connStatus}
                      reason={conn?.reason ?? null}
                      onRecheck={() => {
                        setConn(null)
                        void runVerify("custom")
                      }}
                    />
                  ) : (
                    <PortalDnsInstructions
                      domain={normalizedDomain}
                      record={previewDnsRecord}
                    />
                  )
                ) : null}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {savedDomain && mode !== "breezify" && isAdmin ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={savingDomain}
                  onClick={() => void onClearDomain()}
                >
                  Remove saved domain
                </Button>
              ) : null}
              {savingDomain ? (
                <StatusText tone="muted" icon="loading">
                  Saving automatically…
                </StatusText>
              ) : domainStatus ? (
                <StatusText tone="primary" icon="saved">
                  {domainStatus}
                </StatusText>
              ) : null}
              {domainError ? (
                <p role="alert" className="text-xs text-destructive">
                  {domainError}
                </p>
              ) : null}
            </div>
          </div>
        )}

        {!isAdmin ? (
          <p className="text-xs text-muted-foreground">
            Ask an admin to change the portal address.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function PortalOption({
  selected,
  onSelect,
  title,
  description,
  icon,
  badge,
  disabled,
  connectionStatus,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  description: string
  icon: React.ReactNode
  badge?: string
  disabled?: boolean
  connectionStatus?: PortalConnectionStatus
}): React.ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      disabled={disabled}
      className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        selected
          ? "border-primary/50 bg-primary/[0.04] shadow-sm"
          : "border-input hover:border-foreground/20 hover:bg-muted/30"
      }`}
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {badge ? (
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
              {badge}
            </span>
          ) : null}
          {connectionStatus ? (
            <PortalConnectionBadge status={connectionStatus} />
          ) : null}
        </span>
        <span className="block text-[11px] text-muted-foreground">
          {description}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={`mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border ${
          selected ? "border-primary" : "border-muted-foreground/40"
        }`}
      >
        {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>
    </button>
  )
}

function CustomDomainDns({
  domain,
  record,
  status,
  reason,
  onRecheck,
}: {
  domain: string
  record: CustomDomainDnsRecord
  status: PortalConnectionStatus
  reason: string | null
  onRecheck: () => void
}): React.ReactElement {
  return (
    <div className="mt-1 max-w-lg space-y-3 rounded-md border border-input bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm">{domain}</span>
        <PortalConnectionBadge status={status} />
      </div>
      {status === "connected" ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <CheckCircle2 className="size-3.5 text-primary" />
          Live and serving this workspace&apos;s portal.
        </p>
      ) : (
        <>
          <PortalDnsInstructions domain={domain} record={record} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={status === "pending"}
              onClick={onRecheck}
            >
              {status === "pending" && (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              )}
              Check connection
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {status === "pending"
                ? "Checking…"
                : (reason ??
                  "DNS changes can take a while to propagate.")}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function StatusText({
  tone,
  icon,
  children,
}: {
  tone: "primary" | "danger" | "muted"
  icon: "alert" | "check" | "loading" | "saved"
  children: React.ReactNode
}): React.ReactElement {
  const className =
    tone === "danger"
      ? "text-destructive"
      : tone === "primary"
        ? "text-primary"
        : "text-muted-foreground"
  return (
    <p className={`flex items-center gap-1 text-xs ${className}`}>
      {icon === "alert" ? <AlertCircle className="size-3 shrink-0" /> : null}
      {icon === "check" ? <Check className="size-3 shrink-0" /> : null}
      {icon === "loading" ? (
        <Loader2 className="size-3 shrink-0 animate-spin" />
      ) : null}
      {icon === "saved" ? <CheckCircle2 className="size-3 shrink-0" /> : null}
      {children}
    </p>
  )
}

function UrlRow({
  url,
  href,
  copied,
  onCopy,
}: {
  url: string
  href?: string
  copied: boolean
  onCopy: () => void
}): React.ReactElement {
  return (
    <div className="flex min-w-0 max-w-2xl items-center gap-2">
      <code
        title={url}
        className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border bg-muted/50 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground"
      >
        {url}
      </code>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Copy portal URL"
        onClick={onCopy}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open portal URL"
          className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-background transition-colors hover:bg-muted"
        >
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}
    </div>
  )
}
