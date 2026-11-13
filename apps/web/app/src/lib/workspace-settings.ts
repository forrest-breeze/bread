import type { IngestionApprovalMode, WorkspaceSettings } from "@breezify/core";
import {
  parseStoredFooter,
  parseStoredHeader,
  type StoredFooter,
  type StoredHeader,
} from "@/lib/portal/schema";

export const DEFAULT_INGESTION_APPROVAL_MODE: IngestionApprovalMode = "smart";
export const DEFAULT_KB_BRAND_ACCENT = "#2f5520";
export const KB_BRAND_ACCENT_SWATCHES = [
  "#2f5520",
  "#0f766e",
  "#2563eb",
  "#7c3aed",
  "#dc2626",
] as const;

export type PortalChromeScope = "workspace" | "project";
export const DEFAULT_PORTAL_CHROME_SCOPE: PortalChromeScope = "workspace";
export type PortalAddressScope = "workspace" | "project";
export type PortalAddressMode = "breezify" | "path" | "domain";

export interface KbBranding {
  name: string;
  tagline: string;
  logoUrl: string;
  accentColor: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getIngestionApprovalMode(
  settings: WorkspaceSettings | Record<string, unknown> | null | undefined,
): IngestionApprovalMode {
  return settings?.ingestion_approval_mode === "always_review"
    ? "always_review"
    : DEFAULT_INGESTION_APPROVAL_MODE;
}

export function getAllowedDomains(
  settings: WorkspaceSettings | Record<string, unknown> | null | undefined,
): string[] {
  const raw = settings?.allowed_domains;
  if (!Array.isArray(raw)) return [];
  const cleaned = raw
    .map((d) => (typeof d === "string" ? d.trim().toLowerCase() : ""))
    .filter((d) => d.length > 0 && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  return Array.from(new Set(cleaned));
}

export function getKbPublic(
  settings: WorkspaceSettings | Record<string, unknown> | null | undefined,
): boolean {
  return settings?.kb_public === true;
}

/**
 * Normalize a user-entered landing-page / website URL to a canonical absolute
 * http(s) URL, or "" when missing/invalid. Tolerates a bare host ("acme.com")
 * by assuming https, requires a dotted hostname with a real TLD (rejects
 * "localhost" and bare words), and rejects non-http(s) schemes. Pure and
 * dependency-free so onboarding, the API route, and the portal builder share one
 * source of truth.
 */
export function normalizeLandingPageUrl(input: unknown): string {
  if (typeof input !== "string") return "";
  const raw = input.trim();
  if (!raw || raw.length > 2048) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return "";
  // Strip a bare trailing slash so the stored value is a clean origin/path.
  return url.toString().replace(/\/$/, "");
}

export function getLandingPageUrl(
  settings: WorkspaceSettings | Record<string, unknown> | null | undefined,
): string {
  return normalizeLandingPageUrl(settings?.landing_page_url);
}

/**
 * The crawled portal footer stored on the workspace (settings.kb_footer),
 * populated by the onboarding website import. Validated through the portal
 * schema's stored-footer parser, so a malformed value reads as "no footer"
 * rather than corrupting a layout. Returns null when absent/empty.
 */
export function getKbFooter(
  settings: WorkspaceSettings | Record<string, unknown> | null | undefined,
): StoredFooter | null {
  return parseStoredFooter(settings?.kb_footer);
}

export function getKbHeader(
  settings: WorkspaceSettings | Record<string, unknown> | null | undefined,
): StoredHeader | null {
  return parseStoredHeader(settings?.kb_header);
}

/**
 * Every portal project shares the workspace header and footer. The per-project
 * option was removed; a stored "project" value is ignored and normalized away
 * on the next settings save.
 */
export function getPortalChromeScope(
  _settings?: WorkspaceSettings | Record<string, unknown> | null,
): PortalChromeScope {
  return DEFAULT_PORTAL_CHROME_SCOPE;
}

export function getPortalAddressScope(
  settings: WorkspaceSettings | Record<string, unknown> | null | undefined,
): PortalAddressScope {
  if (settings?.portal_address_scope === "workspace") return "workspace";
  if (settings?.portal_address_scope === "project") return "project";
  // URL configuration historically lived in workspace settings. Keep existing
  // workspaces in that model until an admin explicitly opts into per-project
  // hosting.
  return "workspace";
}

export function getPortalAddressMode(
  settings: WorkspaceSettings | Record<string, unknown> | null | undefined,
): PortalAddressMode {
  const value = settings?.portal_address_mode;
  if (value === "breezify" || value === "path" || value === "domain") {
    return value;
  }
  return getKbCustomDomain(settings) ? "domain" : "breezify";
}

// A bare hostname: one or more dot-separated labels, ending in a 2+ char TLD.
// No scheme, port, path, or wildcard — those are stripped/rejected on save.
const CUSTOM_DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** Normalize a user-entered custom domain to a bare lowercase host, or "". */
export function normalizeCustomDomain(input: unknown): string {
  if (typeof input !== "string") return "";
  let host = input.trim().toLowerCase();
  if (!host) return "";
  // Tolerate pasted URLs ("https://docs.acme.com/path") and trailing dots.
  host = host.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
  host = host.replace(/\.$/, "");
  return CUSTOM_DOMAIN_RE.test(host) ? host : "";
}

export function getKbCustomDomain(
  settings: WorkspaceSettings | Record<string, unknown> | null | undefined,
): string {
  return normalizeCustomDomain(settings?.kb_custom_domain);
}

// A portal project slug: lowercase a-z/0-9/hyphen, no leading/trailing hyphen,
// 1–50 chars. Mirrors PORTAL_SLUG_RE in the portal builder so the root-redirect
// target validates against the same shape projects are created with.

/**
 * Removed: the "primary project" setting. The workspace has one portal and it
 * lives at the root (`/p/<workspace>`), so there is nothing to redirect to.
 * Always null; kept only so older callers compile. Saved values are dropped by
 * normalizeWorkspaceSettings and cleared by migration 20261112200400.
 */
export function getKbPrimaryProject(
  _settings?: WorkspaceSettings | Record<string, unknown> | null,
): string | null {
  return null;
}

/**
 * The CNAME target a customer points their custom domain at. Configurable via
 * `NEXT_PUBLIC_PORTAL_CNAME_TARGET`. No default: empty when unset.
 */
export function portalCnameTarget(): string {
  return process.env.NEXT_PUBLIC_PORTAL_CNAME_TARGET?.trim() ?? "";
}

export interface CustomDomainDnsRecord {
  type: "CNAME";
  /** The "Host"/"Name" cell value for the customer's DNS provider. */
  host: string;
  /** The CNAME target the record should point at. */
  target: string;
  /** True when the domain is a bare apex (e.g. "acme.com") — CNAME at the apex
   *  needs ALIAS/ANAME or CNAME-flattening support, so the UI warns about it. */
  isApex: boolean;
}

/**
 * Derive the DNS record a customer must add to point a custom domain at the
 * portal. For "help.acme.com" the host is "help" (most providers append the
 * zone); a two-label apex yields "@". Assumes a two-label registrable domain,
 * which covers the common case (multi-part TLDs like "co.uk" are an edge the
 * customer can adjust). Returns null for an invalid/empty domain.
 */
export function customDomainDnsRecord(
  domain: string,
): CustomDomainDnsRecord | null {
  const host = normalizeCustomDomain(domain);
  if (!host) return null;
  const labels = host.split(".");
  const isApex = labels.length <= 2;
  const recordHost = isApex ? "@" : labels.slice(0, labels.length - 2).join(".");
  return { type: "CNAME", host: recordHost, target: portalCnameTarget(), isApex };
}

/**
 * The app's own host (from `NEXT_PUBLIC_APP_URL`), bare-lowercased, or "".
 * A custom domain may never equal this — pointing the KB at the app host would
 * shadow the signed-in product surface.
 */
export function appHost(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "")
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0]
    .trim()
    .toLowerCase();
}

/**
 * The configured public-KB base domain (`NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN`),
 * bare-lowercased, or "". Custom domains may not be this apex or a subdomain of
 * it — those are reserved for the built-in `<handle>.<base>` subdomain routing.
 */
export function publicKbBaseHost(): string {
  return (process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN ?? "")
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0]
    .trim()
    .toLowerCase();
}

export type CustomDomainError =
  | "invalid_format"
  | "own_host"
  | "reserved_base"
  | "infra_host";

export interface CustomDomainValidation {
  /** Canonical bare-lowercase host when valid, else "". */
  domain: string;
  /** Stable machine reason when `domain` is "" and input was non-empty. */
  error: CustomDomainError | null;
}

// Obvious infrastructure / placeholder hosts that must never be claimed as a
// public-KB custom domain even if they pass the syntactic check. A match on the
// bare host OR any subdomain of these apexes is rejected. Kept lowercase.
const RESERVED_CUSTOM_DOMAINS: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "example.com",
  "example.org",
  "example.net",
  "vercel.app",
  "netlify.app",
  "supabase.co",
  "supabase.in",
  "amazonaws.com",
  "cloudfront.net",
  "github.io",
]);

/**
 * Validate a user-entered custom domain for the public KB.
 *
 * Empty/whitespace input is treated as "clear the domain" — `{domain: "",
 * error: null}` — so admins can remove a domain by saving an empty field.
 *
 * Beyond the syntactic {@link normalizeCustomDomain} check, this rejects the
 * app's own host, the public-KB base domain (and its subdomains), and obvious
 * shared-infra hosts. Pure and dependency-free so the API route, UI, and tests
 * share one source of truth.
 *
 * `currentDomain` — the domain this workspace already has saved. When the
 * input matches it, the policy checks are skipped: a workspace keeps a domain
 * it legitimately holds even if the reservation rules tightened after it was
 * saved (e.g. the dogfood workspace owns the public-KB apex itself). Only
 * *new* claims are policy-checked.
 */
export function validateCustomDomain(
  input: unknown,
  currentDomain?: string,
): CustomDomainValidation {
  if (typeof input !== "string") return { domain: "", error: null };
  if (!input.trim()) return { domain: "", error: null };

  const domain = normalizeCustomDomain(input);
  if (!domain) return { domain: "", error: "invalid_format" };

  const current = normalizeCustomDomain(currentDomain);
  if (current && domain === current) return { domain, error: null };

  const app = appHost();
  if (app && (domain === app || domain.endsWith(`.${app}`))) {
    return { domain: "", error: "own_host" };
  }

  const base = publicKbBaseHost();
  if (base && (domain === base || domain.endsWith(`.${base}`))) {
    return { domain: "", error: "reserved_base" };
  }

  for (const reserved of RESERVED_CUSTOM_DOMAINS) {
    if (domain === reserved || domain.endsWith(`.${reserved}`)) {
      return { domain: "", error: "infra_host" };
    }
  }

  return { domain, error: null };
}

/**
 * Validate a project-level portal route domain. A path-mounted project may use
 * the configured public-KB apex itself (for example example.com/docs), because it
 * does not claim a built-in subdomain. Dedicated project domains retain the
 * stricter custom-domain rules.
 */
export function validatePortalRouteDomain(
  input: unknown,
  pathMounted: boolean,
  currentDomain?: string,
): CustomDomainValidation {
  const validation = validateCustomDomain(input, currentDomain);
  if (!pathMounted || validation.error !== "reserved_base") return validation;

  const domain = normalizeCustomDomain(input);
  const base = publicKbBaseHost();
  return domain && domain === base
    ? { domain, error: null }
    : validation;
}

/** User-facing copy for a custom-domain validation failure. Shared by API + UI. */
export function customDomainErrorMessage(error: CustomDomainError): string {
  switch (error) {
    case "invalid_format":
      return "Enter a valid domain, e.g. docs.acme.com (no http://, path, or port).";
    case "own_host":
      return "That's the app's own domain. Use a domain you control.";
    case "reserved_base":
      return "That domain is reserved for Breezify-hosted portals. Use a domain you control.";
    case "infra_host":
      return "That host can't be used as a custom domain.";
  }
}

export function normalizeKbBrandText(input: unknown, maxLength: number): string {
  if (typeof input !== "string") return "";
  return input.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

export function normalizeKbBrandAccent(input: unknown): string {
  if (typeof input !== "string") return "";
  const value = input.trim().toLowerCase();
  const match = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return "";
  const hex = match[1].toLowerCase();
  return hex.length === 3
    ? `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    : `#${hex}`;
}

export function normalizeKbBrandLogoUrl(input: unknown): string {
  if (typeof input !== "string") return "";
  const value = input.trim();
  if (!value || value.length > 2048) return "";
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

export function getKbBranding(
  settings: WorkspaceSettings | Record<string, unknown> | null | undefined,
  fallbackName: string,
  fallbackLogoUrl?: string | null,
): KbBranding {
  const name =
    normalizeKbBrandText(settings?.kb_brand_name, 80) ||
    normalizeKbBrandText(fallbackName, 80) ||
    "Knowledge Base";
  return {
    name,
    tagline: normalizeKbBrandText(settings?.kb_brand_tagline, 180),
    logoUrl:
      normalizeKbBrandLogoUrl(settings?.kb_brand_logo_url) ||
      normalizeKbBrandLogoUrl(fallbackLogoUrl),
    accentColor:
      normalizeKbBrandAccent(settings?.kb_brand_accent) ||
      DEFAULT_KB_BRAND_ACCENT,
  };
}

export function normalizeWorkspaceSettings(
  settings: unknown,
): WorkspaceSettings {
  const normalized: WorkspaceSettings = isRecord(settings) ? { ...settings } : {};
  normalized.ingestion_approval_mode = getIngestionApprovalMode(normalized);
  normalized.allowed_domains = getAllowedDomains(normalized);
  normalized.kb_public = getKbPublic(normalized);
  normalized.portal_chrome_scope = getPortalChromeScope(normalized);
  normalized.portal_address_scope = getPortalAddressScope(normalized);
  normalized.portal_address_mode = getPortalAddressMode(normalized);
  const header = getKbHeader(normalized);
  if (header) normalized.kb_header = header;
  else delete normalized.kb_header;
  const footer = getKbFooter(normalized);
  if (footer) normalized.kb_footer = footer;
  else delete normalized.kb_footer;
  const domain = getKbCustomDomain(normalized);
  if (domain) normalized.kb_custom_domain = domain;
  else delete normalized.kb_custom_domain;
  delete normalized.kb_primary_project;
  const brandName = normalizeKbBrandText(normalized.kb_brand_name, 80);
  if (brandName) normalized.kb_brand_name = brandName;
  else delete normalized.kb_brand_name;
  const brandTagline = normalizeKbBrandText(normalized.kb_brand_tagline, 180);
  if (brandTagline) normalized.kb_brand_tagline = brandTagline;
  else delete normalized.kb_brand_tagline;
  const brandLogoUrl = normalizeKbBrandLogoUrl(normalized.kb_brand_logo_url);
  if (brandLogoUrl) normalized.kb_brand_logo_url = brandLogoUrl;
  else delete normalized.kb_brand_logo_url;
  const brandAccent = normalizeKbBrandAccent(normalized.kb_brand_accent);
  if (brandAccent) normalized.kb_brand_accent = brandAccent;
  else delete normalized.kb_brand_accent;
  const landingPageUrl = normalizeLandingPageUrl(normalized.landing_page_url);
  if (landingPageUrl) normalized.landing_page_url = landingPageUrl;
  else delete normalized.landing_page_url;
  return normalized;
}
