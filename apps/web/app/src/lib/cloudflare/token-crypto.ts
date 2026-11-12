import { decryptToken, encryptToken } from "@/lib/security/token-crypto";

export function encryptCloudflareToken(rawToken: string): string | null {
  return encryptToken(rawToken);
}

export function decryptCloudflareToken(ciphertext: string): string | null {
  return decryptToken(ciphertext);
}

