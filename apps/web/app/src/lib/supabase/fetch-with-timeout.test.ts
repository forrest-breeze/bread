import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { fetchWithTimeout } from "./fetch-with-timeout";

const url = "https://example.supabase.co/rest/v1/workspace_members";
const mockFetch = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function client() {
  return createClient("https://example.supabase.co", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout },
  });
}

describe("fetchWithTimeout", () => {
  it("lets the SDK recover a 503 without multiplying retries", async () => {
    mockFetch.mockResolvedValueOnce(new Response('{"code":"PGRST002"}', { status: 503 }))
      .mockResolvedValueOnce(new Response("[]"));
    const pending = Promise.resolve(client().from("workspace_members").select("id"));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).error).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("bounds persistent 503s at the SDK retry limit", async () => {
    mockFetch.mockImplementation(async () => new Response('{"code":"PGRST002","message":"unavailable"}', { status: 503 }));
    const pending = Promise.resolve(client().from("workspace_members").select("id"));
    await vi.advanceTimersByTimeAsync(8000);
    expect((await pending).error?.code).toBe("PGRST002");
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("stops SDK retries when the lookup deadline expires", async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(async () => new Response('{"code":"PGRST002"}', { status: 503 }));
    const pending = Promise.resolve(client().from("workspace_members").select("id").abortSignal(controller.signal));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect((await pending).error).not.toBeNull();
    await vi.advanceTimersByTimeAsync(8000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["POST", "PATCH", "DELETE"])("does not retry a %s", async method => {
    mockFetch.mockResolvedValue(new Response("busy", { status: 503 }));
    expect((await fetchWithTimeout(url, { method })).status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("preserves the signal embedded in a Request", async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    const pending = fetchWithTimeout(new Request(url, { signal: controller.signal }));
    const check = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await check;
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
