import type { WorkspaceWithRole } from "@/hooks/swr";
import type { StoredFooter, StoredHeader } from "@/lib/portal/schema";
import type {
  PortalAddressMode,
  PortalAddressScope,
  PortalChromeScope,
} from "@/lib/workspace-settings";

// ---------------------------------------------------------------------------
// Client-side workspace mutations. Kept out of components per the project
// convention that fetch calls live in dedicated API modules, not UI.
// ---------------------------------------------------------------------------

export interface AvailabilityResult {
  available: boolean;
  /** User-facing reason when unavailable; null when available. */
  error: string | null;
}

export interface UpdateIdentifierResult {
  ok: boolean;
  /** The refreshed workspace row on success — feed straight into SWR mutate(). */
  workspace?: WorkspaceWithRole;
  /** User-facing error on failure (e.g. the 409 "already taken" message). */
  error?: string;
}

/**
 * Advisory availability check for a workspace `slug` (the editable identifier in
 * the `/p/<slug>` portal URL). Never throws — a network/abort failure resolves
 * to "unavailable" so the authoritative check is the unique constraint on save.
 */
export async function checkSlugAvailability(
  slug: string,
  signal?: AbortSignal,
): Promise<AvailabilityResult> {
  try {
    const res = await fetch(
      `/api/workspace/slug/check?slug=${encodeURIComponent(slug)}`,
      { signal },
    );
    if (!res.ok) return { available: false, error: "Couldn't check availability." };
    return (await res.json()) as AvailabilityResult;
  } catch {
    return { available: false, error: "Couldn't check availability." };
  }
}

/**
 * Change the workspace's `slug`. Unlike the handle, the slug is required (it
 * keys every `/p/<slug>` link), so empty input is rejected server-side.
 * Validation + global uniqueness are enforced by PUT /api/workspace
 * (format/reserved → 400, taken → 409). Changing it breaks links to the old URL.
 */
export async function updateWorkspaceSlug(
  slug: string,
): Promise<UpdateIdentifierResult> {
  const res = await fetch("/api/workspace", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  const body = (await res.json().catch(() => ({}))) as
    | WorkspaceWithRole
    | { error?: string };
  if (!res.ok) {
    return {
      ok: false,
      error: (body as { error?: string }).error ?? "Couldn't save the identifier.",
    };
  }
  return { ok: true, workspace: body as WorkspaceWithRole };
}

export interface UpdateCustomDomainResult {
  ok: boolean;
  domain?: string | null;
  error?: string;
}

export async function updateWorkspacePortalAddressConfig(input: {
  scope: PortalAddressScope;
  mode: PortalAddressMode;
}): Promise<UpdateIdentifierResult> {
  const res = await fetch("/api/workspace", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settings: {
        portal_address_scope: input.scope,
        portal_address_mode: input.mode,
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as
    | WorkspaceWithRole
    | { error?: string };
  if (!res.ok) {
    return {
      ok: false,
      error:
        (body as { error?: string }).error ??
        "Couldn't update the portal URL configuration.",
    };
  }
  return { ok: true, workspace: body as WorkspaceWithRole };
}

/** Set the workspace's public-KB custom domain. */
export async function updateWorkspaceCustomDomain(
  domain: string,
): Promise<UpdateCustomDomainResult> {
  const res = await fetch("/api/workspace/kb-domain", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain }),
  });
  const body = (await res.json().catch(() => ({}))) as
    | { kb_custom_domain?: string | null }
    | { error?: string };
  if (!res.ok) {
    return {
      ok: false,
      error: (body as { error?: string }).error ?? "Couldn't save the custom domain.",
    };
  }
  return {
    ok: true,
    domain: (body as { kb_custom_domain?: string | null }).kb_custom_domain ?? null,
  };
}

/** Clear the workspace's public-KB custom domain. */
export async function clearWorkspaceCustomDomain(): Promise<UpdateCustomDomainResult> {
  const res = await fetch("/api/workspace/kb-domain", { method: "DELETE" });
  const body = (await res.json().catch(() => ({}))) as
    | { kb_custom_domain?: string | null }
    | { error?: string };
  if (!res.ok) {
    return {
      ok: false,
      error: (body as { error?: string }).error ?? "Couldn't remove the custom domain.",
    };
  }
  return {
    ok: true,
    domain: (body as { kb_custom_domain?: string | null }).kb_custom_domain ?? null,
  };
}

export interface UpdatePortalVisibilityResult {
  ok: boolean;
  isPublic?: boolean;
  error?: string;
}

/**
 * Set whether this workspace's portal is publicly visible (`kb_public`). When
 * `false` the portal is private: anonymous visitors get a sign-in prompt and
 * only active workspace members can view it. Enforcement lives in
 * `gatePortalWorkspace` (public-kb.ts); this only flips the flag. Workspace-wide
 * — it applies to every project under the portal, not a single project.
 * Settings are merged server-side, so other settings keys are preserved.
 */
export async function updateWorkspacePortalVisibility(
  isPublic: boolean,
): Promise<UpdatePortalVisibilityResult> {
  const res = await fetch("/api/workspace", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: { kb_public: isPublic } }),
  });
  const body = (await res.json().catch(() => ({}))) as
    | WorkspaceWithRole
    | { error?: string };
  if (!res.ok) {
    return {
      ok: false,
      error:
        (body as { error?: string }).error ??
        "Couldn't update portal visibility.",
    };
  }
  return { ok: true, isPublic };
}

/**
 * Set whether portal projects share one workspace header/footer
 * (`portal_chrome_scope`). Settings are merged server-side, so the other
 * settings keys are preserved.
 */
export async function updateWorkspacePortalChromeScope(
  scope: PortalChromeScope,
): Promise<UpdateIdentifierResult> {
  const res = await fetch("/api/workspace", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: { portal_chrome_scope: scope } }),
  });
  const body = (await res.json().catch(() => ({}))) as
    | WorkspaceWithRole
    | { error?: string };
  if (!res.ok) {
    return {
      ok: false,
      error:
        (body as { error?: string }).error ??
        "Couldn't update the portal header and footer scope.",
    };
  }
  return { ok: true, workspace: body as WorkspaceWithRole };
}

/**
 * Persist the workspace-shared portal chrome (`kb_header` / `kb_footer`).
 * Both keys go in ONE request: settings updates are read-merge-write
 * server-side, so two parallel PUTs could drop one key's change.
 */
export async function updateWorkspacePortalChrome(chrome: {
  header?: StoredHeader;
  footer?: StoredFooter;
}): Promise<UpdateIdentifierResult> {
  const settings: Record<string, unknown> = {};
  if (chrome.header) settings.kb_header = chrome.header;
  if (chrome.footer) settings.kb_footer = chrome.footer;
  const res = await fetch("/api/workspace", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  const body = (await res.json().catch(() => ({}))) as
    | WorkspaceWithRole
    | { error?: string };
  if (!res.ok) {
    return {
      ok: false,
      error:
        (body as { error?: string }).error ??
        "Couldn't update the shared portal chrome.",
    };
  }
  return { ok: true, workspace: body as WorkspaceWithRole };
}

export async function updateWorkspacePortalHeader(
  header: StoredHeader,
): Promise<UpdateIdentifierResult> {
  return updateWorkspacePortalChrome({ header });
}

export interface UpdatePrimaryProjectResult {
  ok: boolean;
  projectSlug?: string | null;
  error?: string;
}

/** Set the portal project the workspace root redirects to. */
export async function updateWorkspacePrimaryProject(
  projectSlug: string,
): Promise<UpdatePrimaryProjectResult> {
  const res = await fetch("/api/workspace/kb-primary-project", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectSlug }),
  });
  const body = (await res.json().catch(() => ({}))) as
    | { kb_primary_project?: string | null }
    | { error?: string };
  if (!res.ok) {
    return {
      ok: false,
      error:
        (body as { error?: string }).error ??
        "Couldn't set the primary project.",
    };
  }
  return {
    ok: true,
    projectSlug:
      (body as { kb_primary_project?: string | null }).kb_primary_project ??
      null,
  };
}

/** Clear the primary project (root falls back to the default project). */
export async function clearWorkspacePrimaryProject(): Promise<UpdatePrimaryProjectResult> {
  const res = await fetch("/api/workspace/kb-primary-project", {
    method: "DELETE",
  });
  const body = (await res.json().catch(() => ({}))) as
    | { kb_primary_project?: string | null }
    | { error?: string };
  if (!res.ok) {
    return {
      ok: false,
      error:
        (body as { error?: string }).error ??
        "Couldn't clear the primary project.",
    };
  }
  return { ok: true, projectSlug: null };
}

export interface PortalConnectionResult {
  connected: boolean;
  host: string | null;
  reason: string | null;
}

/**
 * Probe whether the workspace's configured portal address (custom domain or
 * subdomain) actually resolves to this workspace's portal. Returns a not-
 * connected result on any failure so the caller can render a pending state.
 */
export async function verifyPortalAddress(
  type: "custom" | "subdomain" | "path",
  signal?: AbortSignal,
): Promise<PortalConnectionResult> {
  try {
    const res = await fetch(`/api/workspace/kb-domain/verify?type=${type}`, {
      signal,
    });
    if (!res.ok) {
      return { connected: false, host: null, reason: "Couldn't check the connection." };
    }
    return (await res.json()) as PortalConnectionResult;
  } catch {
    return { connected: false, host: null, reason: "Couldn't check the connection." };
  }
}

/** Verify the saved project-specific domain or sub-folder route. */
export async function verifyPortalProjectAddress(
  projectSlug: string,
  signal?: AbortSignal,
): Promise<PortalConnectionResult> {
  try {
    const params = new URLSearchParams({
      type: "project",
      project: projectSlug,
    });
    const res = await fetch(`/api/workspace/kb-domain/verify?${params}`, {
      signal,
    });
    if (!res.ok) {
      return { connected: false, host: null, reason: "Couldn't check the connection." };
    }
    return (await res.json()) as PortalConnectionResult;
  } catch {
    return { connected: false, host: null, reason: "Couldn't check the connection." };
  }
}
