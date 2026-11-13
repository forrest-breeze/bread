import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

// ---------------------------------------------------------------------------
// App-level token encryption (AES-256-GCM).
//
// Integration credentials (Linear/Granola/Drive PATs, Slack bot tokens, Google
// OAuth refresh/access tokens) are encrypted in the Node app before they touch
// the database, and stored as a base64 string in a `text` column. This replaces
// the previous pgsodium/Vault-key scheme, which required a manually-provisioned
// DB key (and pgsodium is deprecated on Supabase / absent on this project).
//
// Format: base64( iv(12) || authTag(16) || ciphertext ). A fresh random IV per
// call means the same token encrypts to different ciphertext each time (no
// ciphertext equality), and GCM's auth tag detects tampering on decrypt.
//
// Key: BREEZIFY_TOKEN_ENC_KEY — 32 bytes, supplied as base64 (preferred,
// `openssl rand -base64 32`) or 64 hex chars. Missing/invalid key → encrypt and
// decrypt return null (callers surface a "not configured" error / fall back),
// never a throw. The key is intentionally NOT cached so a rotated env value
// takes effect without a restart and tests can stub it per-case.
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Parse BREEZIFY_TOKEN_ENC_KEY into a 32-byte Buffer, or null if missing/invalid. */
function loadKey(): Buffer | null {
  const raw = process.env.BREEZIFY_TOKEN_ENC_KEY?.trim();
  if (!raw) return null;

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    try {
      key = Buffer.from(raw, "base64");
    } catch {
      return null;
    }
  }
  return key.length === KEY_BYTES ? key : null;
}

/**
 * Encrypt a token. Returns base64(iv || tag || ciphertext), or null when the
 * input is empty or BREEZIFY_TOKEN_ENC_KEY is missing/invalid.
 */
export function encryptToken(plaintext: string): string | null {
  if (!plaintext) return null;
  const key = loadKey();
  if (!key) {
    console.error(
      "[Breezify] token-crypto: BREEZIFY_TOKEN_ENC_KEY missing or invalid (need 32 bytes as base64 or hex)",
    );
    return null;
  }
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString("base64");
  } catch (err) {
    console.error("[Breezify] token-crypto: encrypt failed:", err);
    return null;
  }
}

/**
 * Decrypt a base64(iv || tag || ciphertext) token. Returns null on any failure
 * — missing/invalid key, malformed input, or a failed auth-tag check (tamper).
 */
export function decryptToken(cipherB64: string): string | null {
  if (!cipherB64) return null;
  const key = loadKey();
  if (!key) {
    console.error(
      "[Breezify] token-crypto: BREEZIFY_TOKEN_ENC_KEY missing or invalid (need 32 bytes as base64 or hex)",
    );
    return null;
  }
  try {
    const buf = Buffer.from(cipherB64, "base64");
    if (buf.length < IV_BYTES + TAG_BYTES + 1) return null;
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(), // throws if the auth tag doesn't verify
    ]);
    return plaintext.toString("utf8");
  } catch (err) {
    console.error("[Breezify] token-crypto: decrypt failed:", err);
    return null;
  }
}
