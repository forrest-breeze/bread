import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceSubscription } from "@/lib/db/subscription";
import { dollarsFor } from "@/lib/ai/model-pricing";
import {
  PLAN_AI_MONTHLY_BUDGET_USD,
  resolveEntitlementPlanId,
} from "@/lib/billing/catalog";

/**
 * Per-workspace AI usage metering and monthly budget enforcement.
 *
 * Storage is the existing `llm_metrics` table (the same one the
 * ingestion pipeline writes via withMetrics and the /ops/cost dashboard
 * reads) — interactive AI calls land there under stage 'interactive', so
 * they surface on the ops cost page with no extra plumbing. Pricing is the
 * single shared table in lib/ai/model-pricing.ts.
 *
 * The interactive AI routes (public Ask AI, portal builder agent, chat
 * agent) gate on `checkAiBudget` before calling a model and record with
 * `recordAiUsage` after. Costs are read-time estimates — guardrails, not
 * billing-grade.
 */

/**
 * Stage value for user-triggered AI calls in llm_metrics. Kept out of
 * withMetrics' PipelineStage union on purpose — pipeline stages describe the
 * ingestion funnel; this bucket is interactive product surfaces. The ops cost
 * page rolls unknown stages into its 'other' bucket, which is where these
 * belong until it grows a dedicated one.
 */
const INTERACTIVE_STAGE = "interactive";

export type AiUsageFeature =
  | "public_ask"
  | "portal_translation"
  | "portal_agent"
  | "chat_agent"
  | (string & {});

export interface AiTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Record one interactive LLM call. Fire-and-forget: metering must never fail
 * the request that incurred the cost, so callers invoke this without awaiting
 * (or await and ignore — it swallows its own errors either way).
 *
 * `outcome` defaults to 'success' so existing callers are unaffected. Recording
 * failed attempts matters on fallback chains: a provider that times out costs
 * latency without producing tokens, and without an 'error' row that time is
 * invisible in llm_metrics — the only trace is a console warning.
 */
export async function recordAiUsage(params: {
  workspaceId: string;
  feature: AiUsageFeature;
  model: string;
  usage: AiTokenUsage | undefined;
  durationMs?: number;
  outcome?: "success" | "error";
}): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("llm_metrics").insert({
      workspace_id: params.workspaceId,
      stage: INTERACTIVE_STAGE,
      operation: params.feature,
      model: params.model,
      tokens_input: params.usage?.inputTokens ?? 0,
      tokens_output: params.usage?.outputTokens ?? 0,
      duration_ms: params.durationMs ?? 0,
      outcome: params.outcome ?? "success",
    });
    if (error) {
      console.error("[Bread] recordAiUsage insert failed:", error.message);
    }
  } catch (err) {
    console.error("[Bread] recordAiUsage:", err);
  }
}

/**
 * Estimated LLM spend across ALL stages (ingestion pipeline + interactive)
 * since the start of the current UTC month, in USD. Priced at read time via
 * the shared MODEL_PRICING table, matching what /ops/cost shows.
 */
export async function getMonthlyAiSpendUsd(
  workspaceId: string,
): Promise<number> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("llm_metrics")
    .select("model, tokens_input, tokens_output")
    .eq("workspace_id", workspaceId)
    .not("model", "is", null)
    .gte("created_at", monthStart.toISOString());
  if (error) {
    console.error("[Bread] getMonthlyAiSpendUsd:", error.message);
    return 0;
  }
  return (data ?? []).reduce(
    (sum, row) =>
      sum + dollarsFor(row.model, row.tokens_input ?? 0, row.tokens_output ?? 0),
    0,
  );
}

export interface AiBudgetStatus {
  allowed: boolean;
  spentUsd: number;
  budgetUsd: number;
}

/**
 * Whether the workspace may make another interactive LLM call this month.
 * The budget is a plan-level abuse guardrail (see PLAN_AI_MONTHLY_BUDGET_USD)
 * against the workspace's TOTAL monthly AI spend, checked by the interactive
 * AI routes *after* their feature gate and *before* the model call. Pipeline
 * features (ingestion, sweep) are never blocked — only the interactive
 * surfaces stop when the ceiling is hit.
 *
 * Fails open on metering-read errors (the spend query already returns 0 on
 * failure) — a broken metering read should degrade to "AI works, untracked",
 * not take the feature down. The per-IP and per-portal rate limits remain the
 * availability backstop.
 */
export async function checkAiBudget(
  workspaceId: string,
): Promise<AiBudgetStatus> {
  const sub = await getWorkspaceSubscription(workspaceId);
  const planId = resolveEntitlementPlanId(sub);
  const budgetUsd = PLAN_AI_MONTHLY_BUDGET_USD[planId];
  if (budgetUsd <= 0) {
    return { allowed: false, spentUsd: 0, budgetUsd };
  }
  const spentUsd = await getMonthlyAiSpendUsd(workspaceId);
  return { allowed: spentUsd < budgetUsd, spentUsd, budgetUsd };
}
