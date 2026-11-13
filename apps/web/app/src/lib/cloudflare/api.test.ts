import { afterEach, describe, expect, it, vi } from "vitest";
import {
  selectCloudflareZone,
  uploadCloudflareWorker,
  workerRoutePatterns,
} from "./api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cloudflare API helpers", () => {
  it("selects the longest accessible zone matching a host", () => {
    const zone = selectCloudflareZone("docs.eu.customer.com", [
      { id: "root", name: "customer.com", account: { id: "a" } },
      { id: "eu", name: "eu.customer.com", account: { id: "b" } },
      { id: "other", name: "other.com", account: { id: "c" } },
    ]);
    expect(zone?.id).toBe("eu");
  });

  it("creates exact and descendant Worker route patterns", () => {
    expect(
      workerRoutePatterns("customer.com", {
        "/help": "/p/acme/help",
        "/docs": "/p/acme/docs",
      }),
    ).toEqual([
      "customer.com/docs",
      "customer.com/docs/*",
      "customer.com/help",
      "customer.com/help/*",
    ]);
  });

  it("uploads generated variables with the Worker module", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await uploadCloudflareWorker({
      accessToken: "oauth-token",
      accountId: "account-id",
      scriptName: "breezify-portal-test",
      domain: "customer.com",
      breezifyOrigin: "https://app.example.com",
      routes: { "/docs": "/p/acme/docs" },
      source: "export default { fetch() { return new Response('ok') } }",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer oauth-token",
    );
    const form = init?.body as FormData;
    const metadata = form.get("metadata") as Blob;
    const parsed = JSON.parse(await metadata.text()) as {
      bindings: Array<{ name: string; text: string }>;
    };
    expect(Object.fromEntries(parsed.bindings.map((b) => [b.name, b.text]))).toEqual({
      EXPECTED_HOST: "customer.com",
      BREEZIFY_ORIGIN: "https://app.example.com",
      BREEZIFY_ROUTES: '{"/docs":"/p/acme/docs"}',
    });
  });
});

