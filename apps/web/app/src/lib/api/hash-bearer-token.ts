import { createHash } from "crypto";
import type { NextRequest } from "next/server";

/**
 * Extract the bearer token from an Authorization header and return its
 * SHA-256 hex digest. Returns null when the header is absent, does not
 * start with "Bearer ", or has an empty token after the prefix.
 *
 * Single source of truth for how Breezify maps a bearer secret to an
 * `api_keys.key_hash` lookup value — used by both `authenticateApiKey`
 * (REST) and `authenticateMcp` (MCP streamable-HTTP).
 */
export function hashBearerToken(request: NextRequest): string | null {
  const token = extractBearer(request);
  if (token === null) return null;

  return createHash("sha256").update(token).digest("hex");
}

/**
 * Extract the raw bearer token, or null when the header is absent, malformed,
 * or empty after the prefix. Callers that need the token itself (rather than
 * its digest) use this — notably the MCP authenticator, which must inspect the
 * token's prefix to tell an API key from an OAuth access token.
 */
export function extractBearer(request: NextRequest): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  return token.length === 0 ? null : token;
}
