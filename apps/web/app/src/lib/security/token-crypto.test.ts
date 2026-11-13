import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken, decryptToken } from "@/lib/security/token-crypto";

// A valid 32-byte key, supplied as base64 (the documented default form).
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const KEY_HEX = Buffer.alloc(32, 9).toString("hex");

beforeEach(() => {
  vi.stubEnv("BREEZIFY_TOKEN_ENC_KEY", KEY_B64);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("token-crypto", () => {
  it("round-trips a token (encrypt → decrypt)", () => {
    const token = "lin_api_abcdef1234567890";
    const cipher = encryptToken(token);
    expect(cipher).toBeTypeOf("string");
    expect(cipher).not.toContain(token);
    expect(decryptToken(cipher as string)).toBe(token);
  });

  it("produces different ciphertext each call (random IV) that both decrypt", () => {
    const token = "xoxb-secret";
    const a = encryptToken(token);
    const b = encryptToken(token);
    expect(a).not.toBe(b);
    expect(decryptToken(a as string)).toBe(token);
    expect(decryptToken(b as string)).toBe(token);
  });

  it("accepts a hex-encoded key as well as base64", () => {
    vi.stubEnv("BREEZIFY_TOKEN_ENC_KEY", KEY_HEX);
    const cipher = encryptToken("tok");
    expect(decryptToken(cipher as string)).toBe("tok");
  });

  it("returns null when the key is missing", () => {
    vi.stubEnv("BREEZIFY_TOKEN_ENC_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(encryptToken("tok")).toBeNull();
    expect(decryptToken("whatever")).toBeNull();
  });

  it("returns null when the key is the wrong length", () => {
    vi.stubEnv("BREEZIFY_TOKEN_ENC_KEY", Buffer.alloc(16).toString("base64"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(encryptToken("tok")).toBeNull();
  });

  it("returns null for empty input without needing a key", () => {
    expect(encryptToken("")).toBeNull();
    expect(decryptToken("")).toBeNull();
  });

  it("returns null when the ciphertext is tampered (auth-tag failure)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cipher = encryptToken("tok") as string;
    const buf = Buffer.from(cipher, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(decryptToken(buf.toString("base64"))).toBeNull();
  });

  it("returns null when decrypting with a different key", () => {
    const cipher = encryptToken("tok") as string;
    vi.stubEnv("BREEZIFY_TOKEN_ENC_KEY", Buffer.alloc(32, 1).toString("base64"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(decryptToken(cipher)).toBeNull();
  });

  it("returns null on malformed (too-short) ciphertext", () => {
    expect(decryptToken("YWI=")).toBeNull(); // 2 bytes — below iv+tag+1
  });
});
