/**
 * `requireRouteUser` contract tests.
 *
 * The load-bearing behaviours:
 *   - valid claims → RouteUser with id/email/user_metadata from the JWT
 *   - no session / definitive 4xx → 401 (a real "not logged in" answer)
 *   - timeout or transient failure → 503, NEVER 401 — a momentary backend
 *     blip must not read as "logged out"
 *
 * The global vitest setup mocks this module for the route suites (they stub
 * `auth.getUser` directly); unmock to exercise the real implementation here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AuthError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
} from "@supabase/supabase-js";

vi.unmock("@/lib/auth/route-auth");

import { requireRouteUser } from "./route-auth";
import type { createClient } from "@/lib/supabase/server";

type ServerClient = Awaited<ReturnType<typeof createClient>>;

const getClaims = vi.fn();
const supabase = { auth: { getClaims } } as unknown as ServerClient;

beforeEach(() => {
  getClaims.mockReset();
});

describe("requireRouteUser", () => {
  it.each([409, 429])("returns retryable 503 for auth %s", async (status) => {
    getClaims.mockResolvedValue({ data: null, error: new AuthError("temporarily unavailable", status) });
    const result = await requireRouteUser(supabase);
    expect(result.response?.status).toBe(503);
    expect(result.response?.headers.get("Retry-After")).toBe("2");
  });

  it("returns a RouteUser decoded from verified claims", async () => {
    getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: "u1",
          email: "u1@breeze.com",
          user_metadata: { name: "U One" },
        },
      },
      error: null,
    });
    const result = await requireRouteUser(supabase);
    expect(result.user).toEqual({
      id: "u1",
      email: "u1@breeze.com",
      user_metadata: { name: "U One" },
    });
    expect(result.response).toBeNull();
  });

  it("defaults user_metadata when absent from claims", async () => {
    getClaims.mockResolvedValue({
      data: { claims: { sub: "u1", email: "u1@breeze.cash" } },
      error: null,
    });
    const result = await requireRouteUser(supabase);
    expect(result.user).toEqual({
      id: "u1",
      email: "u1@breeze.cash",
      user_metadata: {},
    });
  });

  it.each([undefined, "u1@gmail.com", "u1@breeze.com.evil.io"])(
    "403s a valid session whose email (%s) is not a Breeze account",
    async (email) => {
      getClaims.mockResolvedValue({
        data: { claims: { sub: "u1", ...(email ? { email } : {}) } },
        error: null,
      });
      const result = await requireRouteUser(supabase);
      expect(result.user).toBeNull();
      expect(result.response?.status).toBe(403);
    },
  );

  it("401s when there is no session", async () => {
    getClaims.mockResolvedValue({
      data: null,
      error: new AuthSessionMissingError(),
    });
    const result = await requireRouteUser(supabase);
    expect(result.user).toBeNull();
    expect(result.response?.status).toBe(401);
  });

  it("401s on a definitive 4xx (invalid/expired session)", async () => {
    getClaims.mockResolvedValue({
      data: null,
      error: new AuthError("bad jwt", 401, "bad_jwt"),
    });
    const result = await requireRouteUser(supabase);
    expect(result.user).toBeNull();
    expect(result.response?.status).toBe(401);
  });

  it("503s (not 401) on a retryable fetch failure", async () => {
    getClaims.mockResolvedValue({
      data: null,
      error: new AuthRetryableFetchError("service unavailable", 503),
    });
    const result = await requireRouteUser(supabase);
    expect(result.user).toBeNull();
    expect(result.response?.status).toBe(503);
  });

  it("503s (not 401) when the auth call rejects (network)", async () => {
    getClaims.mockRejectedValue(new TypeError("fetch failed"));
    const result = await requireRouteUser(supabase);
    expect(result.user).toBeNull();
    expect(result.response?.status).toBe(503);
  });

  it("503s (not 401) when the auth call hangs past the timeout", async () => {
    vi.useFakeTimers();
    try {
      getClaims.mockReturnValue(new Promise(() => {}));
      const pending = requireRouteUser(supabase);
      await vi.advanceTimersByTimeAsync(8_100);
      const result = await pending;
      expect(result.user).toBeNull();
      expect(result.response?.status).toBe(503);
      expect(getClaims).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses and accepts a slow claims check that settles during the grace window", async () => {
    vi.useFakeTimers();
    try {
      let resolveClaims:
        | ((value: {
            data: { claims: { sub: string; email: string } };
            error: null;
          }) => void)
        | undefined;
      getClaims.mockReturnValue(
        new Promise((resolve) => {
          resolveClaims = resolve;
        })
      );

      const pending = requireRouteUser(supabase);
      await vi.advanceTimersByTimeAsync(3_100);
      resolveClaims?.({
        data: { claims: { sub: "slow-user", email: "slow@breeze.com" } },
        error: null,
      });

      const result = await pending;
      expect(result.user).toEqual({
        id: "slow-user",
        email: "slow@breeze.com",
        user_metadata: {},
      });
      expect(result.response).toBeNull();
      expect(getClaims).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
