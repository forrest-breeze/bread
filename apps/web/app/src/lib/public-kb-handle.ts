// ---------------------------------------------------------------------------
// Public-KB subdomain handle: validation, reserved words, and URL building.
//
// A workspace `handle` is the label in `<handle>.<base>` (e.g. "acme" in
// acme.example.com). It must be a valid DNS label AND not collide with the app's
// own infrastructure subdomains (app., www., api., ...), because the base
// domain is the bare apex `example.com` — a sibling of app.example.com.
//
// This module is pure and edge-safe: it is imported by the proxy (Next
// middleware), so it must NOT pull in `server-only`, Node APIs, or React cache.
// ---------------------------------------------------------------------------

export const HANDLE_MIN_LENGTH = 2;
export const HANDLE_MAX_LENGTH = 63; // DNS label limit.

// Subdomains that must never be claimable as a handle and must never be
// rewritten to a public KB. Covers the app host, marketing/www, mail + DNS
// infra, and common product/auth surfaces we may want later. Kept lowercase.
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // App + marketing surfaces
  "app",
  "www",
  "breezify",
  "kb",
  "p",
  "public",
  "portal",
  "dashboard",
  "account",
  "accounts",
  "billing",
  "admin",
  "auth",
  "login",
  "logout",
  "signup",
  "register",
  // API / assets / CDN
  "api",
  "cdn",
  "assets",
  "static",
  "media",
  "img",
  "images",
  "files",
  "download",
  "downloads",
  // Mail + DNS infra
  "mail",
  "email",
  "webmail",
  "smtp",
  "imap",
  "pop",
  "mx",
  "ns",
  "ns1",
  "ns2",
  "dns",
  // Docs / support / status
  "docs",
  "doc",
  "help",
  "support",
  "status",
  "blog",
  "about",
  "careers",
  "jobs",
  "security",
  "legal",
  "privacy",
  "terms",
  "contact",
  // Environments / short-links
  "staging",
  "stage",
  "dev",
  "test",
  "demo",
  "sandbox",
  "preview",
  "go",
  "link",
  "links",
]);

// A single DNS label: lowercase a-z / 0-9 / hyphen, no leading/trailing hyphen.
// Length is checked separately so we can return precise reasons.
const HANDLE_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase());
}

/**
 * Normalize and validate a candidate handle.
 *
 * Returns the canonical lowercase handle when valid, or `null` when the input
 * is empty/invalid/reserved. Callers that need to distinguish *why* it failed
 * should use {@link validateHandle}.
 */
export function normalizeHandle(input: unknown): string | null {
  return validateHandle(input).handle;
}

export interface HandleValidation {
  handle: string | null;
  /** Stable machine reason when `handle` is null and input was non-empty. */
  error:
    | null
    | "too_short"
    | "too_long"
    | "invalid_chars"
    | "reserved";
}

/**
 * Validate a candidate handle, returning the normalized value or a reason.
 * Empty/whitespace input is treated as "clear the handle" — `{handle: null,
 * error: null}` — so admins can remove a handle by saving an empty field.
 */
export function validateHandle(input: unknown): HandleValidation {
  if (typeof input !== "string") return { handle: null, error: null };
  const value = input.trim().toLowerCase();
  if (value.length === 0) return { handle: null, error: null };
  if (value.length < HANDLE_MIN_LENGTH) return { handle: null, error: "too_short" };
  if (value.length > HANDLE_MAX_LENGTH) return { handle: null, error: "too_long" };
  if (!HANDLE_LABEL_RE.test(value)) return { handle: null, error: "invalid_chars" };
  if (isReservedHandle(value)) return { handle: null, error: "reserved" };
  return { handle: value, error: null };
}

/** User-facing copy for a validation failure — shared by the API and the UI. */
export function handleErrorMessage(
  error: Exclude<HandleValidation["error"], null>,
): string {
  switch (error) {
    case "too_short":
      return `Identifier must be at least ${HANDLE_MIN_LENGTH} characters.`;
    case "too_long":
      return `Identifier must be at most ${HANDLE_MAX_LENGTH} characters.`;
    case "invalid_chars":
      return "Use lowercase letters, numbers, and hyphens only (no leading or trailing hyphen).";
    case "reserved":
      return "That identifier is reserved. Pick another.";
  }
}

/**
 * The configured public-KB base domain (`NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN`),
 * normalized to a bare host, or null when the feature is not configured.
 */
export function publicKbBaseDomain(): string | null {
  const raw = process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN;
  if (!raw) return null;
  const base = raw
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0]
    .trim()
    .toLowerCase();
  return base || null;
}
