import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import {
  consumeCloudflareOAuthState,
  issueCloudflareOAuthState,
} from "./oauth";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Cloudflare OAuth state", () => {
  it("stores only a hash of the short-lived state", async () => {
    const cleanupLt = vi.fn().mockResolvedValue({ error: null });
    const cleanupDelete = vi.fn(() => ({ lt: cleanupLt }));
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({ delete: cleanupDelete, insert }));
    vi.mocked(createAdminClient).mockReturnValue({ from } as never);

    const state = await issueCloudflareOAuthState({
      workspaceId: "workspace-id",
      userId: "user-id",
      targetDomain: "customer.com",
      returnPath: "/settings",
    });
    const expectedHash = createHash("sha256").update(state).digest("hex");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        state_hash: expectedHash,
        workspace_id: "workspace-id",
        user_id: "user-id",
        target_domain: "customer.com",
        return_path: "/settings",
        expires_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
    expect(JSON.stringify(insert.mock.calls)).not.toContain(state);
  });

  it("atomically consumes a non-expired state and returns its deployment target", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        workspace_id: "workspace-id",
        user_id: "user-id",
        target_domain: "customer.com",
        return_path: "/kb?project=docs",
      },
      error: null,
    });
    const select = vi.fn(() => ({ maybeSingle }));
    const gt = vi.fn(() => ({ select }));
    const eq = vi.fn(() => ({ gt }));
    const del = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ delete: del }));
    vi.mocked(createAdminClient).mockReturnValue({ from } as never);

    const result = await consumeCloudflareOAuthState("secret-state");
    expect(eq).toHaveBeenCalledWith(
      "state_hash",
      createHash("sha256").update("secret-state").digest("hex"),
    );
    expect(gt).toHaveBeenCalledWith(
      "expires_at",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
    expect(result).toEqual({
      workspaceId: "workspace-id",
      userId: "user-id",
      targetDomain: "customer.com",
      returnPath: "/kb?project=docs",
    });
  });
});

