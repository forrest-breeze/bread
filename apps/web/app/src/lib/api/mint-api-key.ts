import { createHash, randomBytes } from "crypto";
import { encryptToken } from "@/lib/security/token-crypto";

/**
 * Mints a workspace API key secret and the two derived columns stored with it.
 *
 * Shared by key creation and key rotation so the two can't drift on format or
 * on which columns get written — a rotation that forgot `key_encrypted` would
 * silently make a key unrevealable.
 *
 * `key_hash` is the authentication path (see `authenticateApiKey` /
 * `authenticateMcp`). `key_encrypted` is the reversible copy that backs the
 * admin-gated reveal endpoint, and is null when BREEZIFY_TOKEN_ENC_KEY is
 * missing or invalid — the key still works, it just can't be revealed later.
 */
/**
 * Prefix on every workspace API key. Also the discriminator that lets the MCP
 * authenticator route a bearer token to the API-key path rather than the OAuth
 * one, so it must stay in sync with what `mintApiKey` produces.
 */
export const API_KEY_PREFIX = "breezify_sk_";

export interface MintedApiKey {
  /** The plaintext secret. Returned to the caller once; never stored as-is. */
  rawKey: string;
  keyHash: string;
  keyEncrypted: string | null;
}

export function mintApiKey(): MintedApiKey {
  const rawKey = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;

  return {
    rawKey,
    keyHash: createHash("sha256").update(rawKey).digest("hex"),
    keyEncrypted: encryptToken(rawKey),
  };
}
