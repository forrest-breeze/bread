import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateAdminClient, mockGetWorkspaceSubscription } = vi.hoisted(() => ({
  mockCreateAdminClient: vi.fn(),
  mockGetWorkspaceSubscription: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}));

vi.mock("@/lib/db/subscription", () => ({
  getWorkspaceSubscription: mockGetWorkspaceSubscription,
}));

import { checkAiBudget, getMonthlyAiSpendUsd, recordAiUsage } from "./usage";

interface SpendRow {
  model: string;
  tokens_input: number | null;
  tokens_output: number | null;
}

/** Builds an admin-client mock whose select chain resolves to `rows`. */
function adminWithSpendRows(rows: SpendRow[]) {
  const gte = vi.fn().mockResolvedValue({ data: rows, error: null });
  const not = vi.fn(() => ({ gte }));
  const eq = vi.fn(() => ({ not }));
  const select = vi.fn(() => ({ eq }));
  const insert = vi.fn().mockResolvedValue({ error: null });
  mockCreateAdminClient.mockReturnValue({
    from: vi.fn(() => ({ select, insert })),
  });
  return { select, eq, not, gte, insert };
}

describe("recordAiUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes an 'interactive' llm_metrics row", async () => {
    const { insert } = adminWithSpendRows([]);
    await recordAiUsage({
      workspaceId: "ws-1",
      feature: "public_ask",
      model: "deepseek-chat",
      usage: { inputTokens: 100, outputTokens: 200 },
    });
    expect(insert).toHaveBeenCalledWith({
      workspace_id: "ws-1",
      stage: "interactive",
      operation: "public_ask",
      model: "deepseek-chat",
      tokens_input: 100,
      tokens_output: 200,
      duration_ms: 0,
      outcome: "success",
    });
  });

  it("swallows insert failures (metering never fails the request)", async () => {
    mockCreateAdminClient.mockImplementation(() => {
      throw new Error("no admin client");
    });
    await expect(
      recordAiUsage({
        workspaceId: "ws-1",
        feature: "public_ask",
        model: "deepseek-chat",
        usage: undefined,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("getMonthlyAiSpendUsd", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prices the workspace's current-month rows via the shared table", async () => {
    const { eq, gte } = adminWithSpendRows([
      // deepseek-chat: $0.3/M in, $1.2/M out → 1M each = $1.50
      { model: "deepseek-chat", tokens_input: 1_000_000, tokens_output: 1_000_000 },
      // claude-opus-4-8: $5/M in, $25/M out → 100k each = $3.00
      { model: "claude-opus-4-8", tokens_input: 100_000, tokens_output: 100_000 },
      // Unknown models price at $0 (visible in /ops/cost, not swallowed here).
      { model: "mystery-model", tokens_input: 1_000_000, tokens_output: 1_000_000 },
    ]);
    await expect(getMonthlyAiSpendUsd("ws-1")).resolves.toBeCloseTo(4.5, 6);
    expect(eq).toHaveBeenCalledWith("workspace_id", "ws-1");
    // Window starts at the first of the current UTC month.
    const sinceIso = gte.mock.calls[0]?.[1] as string;
    expect(sinceIso).toMatch(/-01T00:00:00\.000Z$/);
  });

  it("returns 0 on a query error (fail open)", async () => {
    const gte = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const not = vi.fn(() => ({ gte }));
    const eq = vi.fn(() => ({ not }));
    mockCreateAdminClient.mockReturnValue({
      from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })),
    });
    await expect(getMonthlyAiSpendUsd("ws-1")).resolves.toBe(0);
  });
});

describe("checkAiBudget", () => {
  beforeEach(() => vi.clearAllMocks());

  const activeSub = (planId: string) => ({
    plan_id: planId,
    tier: planId === "enterprise" ? "enterprise" : planId === "free" ? "free" : "pro",
    status: "active",
  });

  // Internal tool: billing is removed, so every workspace gets the top
  // (enterprise) AI ceiling regardless of its subscription row.
  it("gives a free-plan workspace the full budget", async () => {
    mockGetWorkspaceSubscription.mockResolvedValue(activeSub("free"));
    adminWithSpendRows([]);
    const status = await checkAiBudget("ws-1");
    expect(status.allowed).toBe(true);
    expect(status.budgetUsd).toBe(500);
  });

  it("gives a lapsed or missing subscription the full budget", async () => {
    mockGetWorkspaceSubscription.mockResolvedValue({
      plan_id: "business",
      tier: "pro",
      status: "canceled",
    });
    adminWithSpendRows([]);
    expect((await checkAiBudget("ws-1")).budgetUsd).toBe(500);

    mockGetWorkspaceSubscription.mockResolvedValue(null);
    adminWithSpendRows([]);
    expect((await checkAiBudget("ws-1")).budgetUsd).toBe(500);
  });

  it("allows a workspace under its budget", async () => {
    mockGetWorkspaceSubscription.mockResolvedValue(activeSub("business"));
    adminWithSpendRows([
      { model: "claude-opus-4-8", tokens_input: 100_000, tokens_output: 100_000 }, // $3
    ]);
    const status = await checkAiBudget("ws-1");
    expect(status.allowed).toBe(true);
  });

  it("still blocks a workspace at or over the abuse ceiling", async () => {
    mockGetWorkspaceSubscription.mockResolvedValue(activeSub("business"));
    adminWithSpendRows([
      // 20M output tokens of Opus = $500, exactly at the ceiling.
      { model: "claude-opus-4-8", tokens_input: 0, tokens_output: 20_000_000 },
    ]);
    const status = await checkAiBudget("ws-1");
    expect(status.allowed).toBe(false);
  });
});
