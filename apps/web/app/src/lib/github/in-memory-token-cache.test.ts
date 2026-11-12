import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { InMemoryTokenCache } from "./in-memory-token-cache";
import { runContractTests } from "./token-cache.test";

runContractTests("InMemoryTokenCache", () => new InMemoryTokenCache());

describe("InMemoryTokenCache — implementation-specific", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clear() with no argument empties every entry", async () => {
    const cache = new InMemoryTokenCache();
    const expiresAt = Date.now() + 3_600_000;
    await cache.set(1, "tok-one", expiresAt);
    await cache.set(2, "tok-two", expiresAt);
    await cache.set(3, "tok-three", expiresAt);

    await cache.clear();

    expect(await cache.get(1)).toBeNull();
    expect(await cache.get(2)).toBeNull();
    expect(await cache.get(3)).toBeNull();
  });

  it("isolates state between instances (no shared module state)", async () => {
    const a = new InMemoryTokenCache();
    const b = new InMemoryTokenCache();
    const expiresAt = Date.now() + 3_600_000;

    await a.set(42, "tok-in-a", expiresAt);

    expect((await a.get(42))?.token).toBe("tok-in-a");
    expect(await b.get(42)).toBeNull();
  });

  it("clear(id) on a missing key is a silent no-op", async () => {
    const cache = new InMemoryTokenCache();
    await expect(cache.clear(1234)).resolves.toBeUndefined();
  });
});
