import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { UpstashTokenCache } from "./upstash-token-cache";
import { KEY_PREFIX, SAFETY_MARGIN_MS } from "./token-cache";
import { runContractTests } from "./token-cache.test";

/**
 * Minimal in-memory Redis test double that models the tiny slice of the
 * Upstash API we touch: get / set (with EX) / del / scan. Good enough to
 * exercise the adapter's behaviour end-to-end without a real network call.
 * TTLs are enforced lazily on read (Upstash itself evicts, but for our tests
 * lazy is plenty — tests never advance wall-clock beyond what vi.useFakeTimers
 * controls).
 */
class FakeRedis {
  private store = new Map<string, { value: string; expiresAtMs: number | null }>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as unknown as T;
  }

  async set(
    key: string,
    value: string,
    opts?: { ex?: number },
  ): Promise<"OK"> {
    const expiresAtMs = opts?.ex ? Date.now() + opts.ex * 1000 : null;
    this.store.set(key, { value, expiresAtMs });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n += 1;
    return n;
  }

  async scan(
    _cursor: string | number,
    opts?: { match?: string; count?: number },
  ): Promise<[string, string[]]> {
    const match = opts?.match ?? "*";
    const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));
    return ["0", keys];
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  // Test helpers — not part of the Upstash Redis surface.
  _size(): number {
    return this.store.size;
  }
}

runContractTests(
  "UpstashTokenCache",
  () => new UpstashTokenCache(new FakeRedis() as any),
);

describe("UpstashTokenCache — implementation-specific", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stores entries under the KEY_PREFIX namespace", async () => {
    const redis = new FakeRedis();
    const cache = new UpstashTokenCache(redis as any);
    await cache.set(99, "tok-ns", Date.now() + 3_600_000);

    const raw = await redis.get<string>(`${KEY_PREFIX}99`);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.token).toBe("tok-ns");
  });

  it("passes an EX seconds TTL to redis.set derived from expiresAt - now", async () => {
    const redis = new FakeRedis();
    const setSpy = vi.spyOn(redis, "set");
    const cache = new UpstashTokenCache(redis as any);

    const expiresAt = Date.now() + 3_600_000;
    await cache.set(5, "tok-ex", expiresAt);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const call = setSpy.mock.calls[0];
    expect(call[0]).toBe(`${KEY_PREFIX}5`);
    expect(call[2]).toEqual({ ex: 3600 });
  });

  it("clear(id) issues a DEL for the single prefixed key", async () => {
    const redis = new FakeRedis();
    const delSpy = vi.spyOn(redis, "del");
    const cache = new UpstashTokenCache(redis as any);

    await cache.clear(7);
    expect(delSpy).toHaveBeenCalledWith(`${KEY_PREFIX}7`);
  });

  it("clear() scans by prefix and deletes every matching key", async () => {
    const redis = new FakeRedis();
    const cache = new UpstashTokenCache(redis as any);
    const expiresAt = Date.now() + 3_600_000;

    await cache.set(1, "a", expiresAt);
    await cache.set(2, "b", expiresAt);
    await cache.set(3, "c", expiresAt);
    expect(redis._size()).toBe(3);

    await cache.clear();
    expect(redis._size()).toBe(0);
  });

  it("get returns null and logs a warning when redis throws", async () => {
    const redis = new FakeRedis();
    vi.spyOn(redis, "get").mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new UpstashTokenCache(redis as any);

    const hit = await cache.get(42);
    expect(hit).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("set is a silent no-op when redis throws", async () => {
    const redis = new FakeRedis();
    vi.spyOn(redis, "set").mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new UpstashTokenCache(redis as any);

    await expect(
      cache.set(42, "tok", Date.now() + 3_600_000),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("clear is a silent no-op when redis throws", async () => {
    const redis = new FakeRedis();
    vi.spyOn(redis, "del").mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new UpstashTokenCache(redis as any);

    await expect(cache.clear(1)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("tolerates non-JSON stored under a key (treats as miss)", async () => {
    const redis = new FakeRedis();
    // Simulate a corrupted entry written by another process.
    await redis.set(`${KEY_PREFIX}11`, "not-json", { ex: 3600 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new UpstashTokenCache(redis as any);

    const hit = await cache.get(11);
    expect(hit).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("clear() terminates when scan returns a numeric-0 cursor (Upstash SDK variant)", async () => {
    // Upstash's REST SDK can return the terminating cursor as either "0" or 0.
    // Before the fix, `cursor !== "0"` was `true` for numeric 0, spinning forever.
    const redis = new FakeRedis();
    const cache = new UpstashTokenCache(
      redis as any,
    );
    const expiresAt = Date.now() + 3_600_000;
    await cache.set(1, "a", expiresAt);
    await cache.set(2, "b", expiresAt);

    // Override scan to return numeric 0 as the terminating cursor.
    vi.spyOn(redis, "scan").mockImplementation(async () => [
      0 as unknown as string,
      [`${KEY_PREFIX}1`, `${KEY_PREFIX}2`],
    ]);

    await expect(cache.clear()).resolves.toBeUndefined();
  });

  it("does not call redis.set when expiresAt is inside the safety margin", async () => {
    const redis = new FakeRedis();
    const setSpy = vi.spyOn(redis, "set");
    const cache = new UpstashTokenCache(redis as any);

    await cache.set(42, "tok", Date.now() + SAFETY_MARGIN_MS);
    expect(setSpy).not.toHaveBeenCalled();
  });
});
