import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  SAFETY_MARGIN_MS,
  KEY_PREFIX,
  tokenCacheKey,
  type TokenCache,
} from "./token-cache";

describe("tokenCacheKey", () => {
  it("prefixes the installation id with KEY_PREFIX", () => {
    expect(tokenCacheKey(42)).toBe(`${KEY_PREFIX}42`);
    expect(tokenCacheKey(1)).toBe(`${KEY_PREFIX}1`);
  });

  it("serialises large ids without precision loss", () => {
    const large = 2_147_483_647;
    expect(tokenCacheKey(large)).toBe(`${KEY_PREFIX}${large}`);
  });
});

/**
 * Shared contract suite. Every TokenCache implementation's test file should
 * call `runContractTests(<name>, () => new <Impl>())` to exercise these
 * assertions. Implementations owning a mocked backend should wire it here.
 *
 * Assertions cover the contract surface documented in token-cache.ts — not
 * implementation details (e.g. whether `clear()` with no id empties all or
 * no-ops; that is a per-impl decision covered in the impl's own test file).
 */
export function runContractTests(
  suiteName: string,
  factory: () => TokenCache,
): void {
  describe(`${suiteName} — TokenCache contract`, () => {
    let cache: TokenCache;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-18T00:00:00Z"));
      cache = factory();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns null on a never-set key", async () => {
      const hit = await cache.get(999);
      expect(hit).toBeNull();
    });

    it("returns the cached entry after a fresh set", async () => {
      const expiresAt = Date.now() + 3_600_000;
      await cache.set(42, "tok-abc", expiresAt);

      const hit = await cache.get(42);
      expect(hit).toEqual({ token: "tok-abc", expiresAt });
    });

    it("returns null once the entry enters the safety margin (stale)", async () => {
      const expiresAt = Date.now() + 30_000;
      await cache.set(42, "tok-expiring", expiresAt);

      const hit = await cache.get(42);
      expect(hit).toBeNull();
    });

    it("returns null for an entry whose expiresAt has already passed", async () => {
      const expiresAt = Date.now() - 1_000;
      await cache.set(42, "tok-old", expiresAt);

      expect(await cache.get(42)).toBeNull();
    });

    it("refuses (no-op) to set when expiresAt is within the safety margin", async () => {
      const expiresAt = Date.now() + SAFETY_MARGIN_MS;
      await cache.set(42, "tok-borderline", expiresAt);

      expect(await cache.get(42)).toBeNull();
    });

    it("refuses (no-op) to set when expiresAt is already in the past", async () => {
      await cache.set(42, "tok-expired", Date.now() - 10_000);
      expect(await cache.get(42)).toBeNull();
    });

    it("keeps the entry while inside TTL and drops it when time advances past margin", async () => {
      const expiresAt = Date.now() + 10 * 60_000;
      await cache.set(42, "tok-soon", expiresAt);

      expect(await cache.get(42)).not.toBeNull();

      vi.setSystemTime(new Date(expiresAt - SAFETY_MARGIN_MS + 1));
      expect(await cache.get(42)).toBeNull();
    });

    it("boundary: expiresAt = now + SAFETY_MARGIN_MS + 1 is still returned", async () => {
      const expiresAt = Date.now() + SAFETY_MARGIN_MS + 1;
      await cache.set(42, "tok-edge", expiresAt);

      const hit = await cache.get(42);
      expect(hit).toEqual({ token: "tok-edge", expiresAt });
    });

    it("overwrites an existing entry on second set", async () => {
      const later = Date.now() + 3_600_000;
      await cache.set(42, "tok-first", later);
      await cache.set(42, "tok-second", later);

      expect(await cache.get(42)).toEqual({
        token: "tok-second",
        expiresAt: later,
      });
    });

    it("isolates entries by installationId", async () => {
      const expiresAt = Date.now() + 3_600_000;
      await cache.set(1, "tok-one", expiresAt);
      await cache.set(2, "tok-two", expiresAt);

      expect((await cache.get(1))?.token).toBe("tok-one");
      expect((await cache.get(2))?.token).toBe("tok-two");
    });

    it("clear(id) removes only the targeted entry", async () => {
      const expiresAt = Date.now() + 3_600_000;
      await cache.set(1, "tok-one", expiresAt);
      await cache.set(2, "tok-two", expiresAt);

      await cache.clear(1);

      expect(await cache.get(1)).toBeNull();
      expect((await cache.get(2))?.token).toBe("tok-two");
    });

    it("never throws from get / set / clear on normal inputs", async () => {
      await expect(cache.get(42)).resolves.toBeDefined();
      await expect(
        cache.set(42, "tok", Date.now() + 3_600_000),
      ).resolves.toBeUndefined();
      await expect(cache.clear(42)).resolves.toBeUndefined();
      await expect(cache.clear()).resolves.toBeUndefined();
    });
  });
}
