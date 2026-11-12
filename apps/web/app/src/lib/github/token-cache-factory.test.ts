import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { InMemoryTokenCache } from "./in-memory-token-cache";
import {
  TieredTokenCache,
  getTokenCache,
  __resetTokenCacheForTests,
  __setTokenCacheForTests,
} from "./token-cache-factory";
import type { TokenCache } from "./token-cache";

describe("TieredTokenCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the local hit without calling shared", async () => {
    const local = new InMemoryTokenCache();
    const shared = new InMemoryTokenCache();
    const sharedGet = vi.spyOn(shared, "get");
    const cache = new TieredTokenCache(local, shared);

    const expiresAt = Date.now() + 3_600_000;
    await local.set(42, "local-tok", expiresAt);

    const hit = await cache.get(42);
    expect(hit?.token).toBe("local-tok");
    expect(sharedGet).not.toHaveBeenCalled();
  });

  it("falls back to shared on local miss and writes through", async () => {
    const local = new InMemoryTokenCache();
    const shared = new InMemoryTokenCache();
    const cache = new TieredTokenCache(local, shared);

    const expiresAt = Date.now() + 3_600_000;
    await shared.set(42, "shared-tok", expiresAt);

    const hit = await cache.get(42);
    expect(hit?.token).toBe("shared-tok");
    // write-through means a second call hits local without touching shared
    const sharedGet = vi.spyOn(shared, "get");
    const hit2 = await cache.get(42);
    expect(hit2?.token).toBe("shared-tok");
    expect(sharedGet).not.toHaveBeenCalled();
  });

  it("returns null when both tiers miss", async () => {
    const local = new InMemoryTokenCache();
    const shared = new InMemoryTokenCache();
    const cache = new TieredTokenCache(local, shared);

    expect(await cache.get(999)).toBeNull();
  });

  it("writes set to both tiers", async () => {
    const local = new InMemoryTokenCache();
    const shared = new InMemoryTokenCache();
    const localSet = vi.spyOn(local, "set");
    const sharedSet = vi.spyOn(shared, "set");
    const cache = new TieredTokenCache(local, shared);

    const expiresAt = Date.now() + 3_600_000;
    await cache.set(42, "tok", expiresAt);

    expect(localSet).toHaveBeenCalledWith(42, "tok", expiresAt);
    expect(sharedSet).toHaveBeenCalledWith(42, "tok", expiresAt);
  });

  it("clear(id) removes from both tiers", async () => {
    const local = new InMemoryTokenCache();
    const shared = new InMemoryTokenCache();
    const cache = new TieredTokenCache(local, shared);

    const expiresAt = Date.now() + 3_600_000;
    await local.set(42, "l", expiresAt);
    await shared.set(42, "s", expiresAt);

    await cache.clear(42);
    expect(await local.get(42)).toBeNull();
    expect(await shared.get(42)).toBeNull();
  });

  it("clear() empties both tiers", async () => {
    const local = new InMemoryTokenCache();
    const shared = new InMemoryTokenCache();
    const cache = new TieredTokenCache(local, shared);

    const expiresAt = Date.now() + 3_600_000;
    await local.set(1, "a", expiresAt);
    await shared.set(2, "b", expiresAt);

    await cache.clear();
    expect(await local.get(1)).toBeNull();
    expect(await shared.get(2)).toBeNull();
  });

  it("does not throw when shared throws on get", async () => {
    const local = new InMemoryTokenCache();
    const shared: TokenCache = {
      get: vi.fn().mockRejectedValue(new Error("shared down")),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new TieredTokenCache(local, shared);

    await expect(cache.get(42)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("getTokenCache()", () => {
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  beforeEach(() => {
    __resetTokenCacheForTests();
  });

  afterEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    __resetTokenCacheForTests();
  });

  it("returns an InMemoryTokenCache when no Upstash env vars are set", () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const cache = getTokenCache();
    expect(cache).toBeInstanceOf(InMemoryTokenCache);
  });

  it("returns a TieredTokenCache when both Upstash env vars are set", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

    const cache = getTokenCache();
    expect(cache).toBeInstanceOf(TieredTokenCache);
  });

  it("falls back to InMemory if only one env var is set", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    expect(getTokenCache()).toBeInstanceOf(InMemoryTokenCache);
  });

  it("memoises the instance (singleton)", () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const a = getTokenCache();
    const b = getTokenCache();
    expect(a).toBe(b);
  });

  it("__setTokenCacheForTests replaces the singleton", () => {
    const fake: TokenCache = {
      get: async () => null,
      set: async () => undefined,
      clear: async () => undefined,
    };
    __setTokenCacheForTests(fake);
    expect(getTokenCache()).toBe(fake);
  });

  it("__resetTokenCacheForTests clears the singleton so env is re-read", () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const a = getTokenCache();

    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    __resetTokenCacheForTests();

    const b = getTokenCache();
    expect(b).not.toBe(a);
    expect(b).toBeInstanceOf(TieredTokenCache);
  });

  it("__setTokenCacheForTests throws when NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() =>
        __setTokenCacheForTests({
          get: async () => null,
          set: async () => undefined,
          clear: async () => undefined,
        }),
      ).toThrow(/test-only seam/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("__resetTokenCacheForTests throws when NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => __resetTokenCacheForTests()).toThrow(/test-only seam/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
