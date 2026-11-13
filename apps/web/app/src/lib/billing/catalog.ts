import type { SubscriptionPlanId, SubscriptionRow } from "@/lib/types";
import { isAnthropicConfigured } from "@/lib/ai/config";

/**
 * Max active members per plan. `null` means uncapped (business, enterprise).
 * Enforced server-side in /api/team and /api/workspace/join.
 */
export const PLAN_MEMBER_LIMITS: Record<SubscriptionPlanId, number | null> = {
  free: 3,
  basic: 25,
  business: null,
  enterprise: null,
};

/**
 * Max documents a workspace may hold per plan. `null` means uncapped. The Free
 * tier is hard-capped to keep it a try-it scratchpad rather than a usable
 * knowledge base. The database enforces this with the
 * `enforce_free_document_limit` trigger.
 */
export const PLAN_DOCUMENT_LIMITS: Record<SubscriptionPlanId, number | null> = {
  free: 50,
  basic: null,
  business: null,
  enterprise: null,
};

/**
 * Hard S3 media-storage ceilings per workspace. These are abuse guardrails,
 * enforced transactionally by the `media_objects` database trigger, including
 * concurrent uploads and non-editor capture paths. Enterprise remains bounded
 * by default; bespoke increases should be an explicit, reviewed product change.
 */
export const PLAN_MEDIA_STORAGE_LIMIT_BYTES: Record<SubscriptionPlanId, number> = {
  free: 512 * 1024 * 1024,
  basic: 5 * 1024 * 1024 * 1024,
  business: 25 * 1024 * 1024 * 1024,
  enterprise: 100 * 1024 * 1024 * 1024,
};

/**
 * Max persisted public portal projects per plan. `null` means uncapped.
 * Portal projects can create storage, analytics, public traffic, and LLM spend
 * via the builder, so the free tier does not include the editor.
 */
export const PLAN_PORTAL_PROJECT_LIMITS: Record<SubscriptionPlanId, number | null> = {
  free: 0,
  basic: 1,
  business: 5,
  enterprise: null,
};

/**
 * Max portal reporting lookback per plan. `0` means reporting unavailable;
 * `null` means custom/uncapped by the app-level preset list.
 */
export const PLAN_PORTAL_REPORTING_MAX_DAYS: Record<SubscriptionPlanId, number | null> = {
  free: 0,
  basic: 0,
  business: 90,
  enterprise: null,
};

/**
 * Monthly per-workspace LLM spend ceiling per plan, in whole USD. Enforced by
 * `checkAiBudget` (lib/ai/usage.ts) before the interactive AI routes (public
 * Ask AI, portal builder agent, chat agent) call a model, against estimated
 * costs derived from `llm_metrics` rows (the same source the /ops/cost
 * dashboard prices). Even Business/Enterprise get a ceiling
 * so heavy public-portal traffic can't run up an unbounded provider bill —
 * these are abuse guardrails, not product limits, and should sit well above
 * organic usage. `0` means no interactive AI (free/basic are also feature-
 * gated off these routes, so the budget is a second line of defense).
 */
export const PLAN_AI_MONTHLY_BUDGET_USD: Record<SubscriptionPlanId, number> = {
  free: 0,
  basic: 0,
  business: 100,
  enterprise: 500,
};

export type BillingPlanId = SubscriptionPlanId;

const PLAN_IDS: readonly BillingPlanId[] = ["free", "basic", "business", "enterprise"];

export function isBillingPlanId(value: string | null): value is BillingPlanId {
  return PLAN_IDS.includes(value as BillingPlanId);
}

export interface PortalPlanEntitlements {
  planId: BillingPlanId;
  portalEditor: boolean;
  portalProjectLimit: number | null;
  /** AI portal *builder* (generate a portal with AI). Off: no server routes. */
  portalAiBuilder: boolean;
  /** Visitor "Ask AI" assistant on the portal. On when ANTHROPIC_API_KEY is set. */
  portalAssistant: boolean;
  /** Machine translation of the portal. On when ANTHROPIC_API_KEY is set. */
  portalTranslations: boolean;
  portalReporting: boolean;
  portalReportingMaxDays: number | null;
  portalBrandingRemoval: boolean;
}

/**
 * Internal tool: billing is gone, so every workspace resolves to the top
 * (enterprise) limits regardless of what its `subscriptions` row says. The
 * argument is kept so callers don't need to change shape.
 */
export function resolveEntitlementPlanId(
  _subscription?: Pick<SubscriptionRow, "plan_id" | "tier" | "status"> | null,
): BillingPlanId {
  return "enterprise";
}

export function getPortalPlanEntitlements(
  planId: BillingPlanId,
): PortalPlanEntitlements {
  const portalProjectLimit = PLAN_PORTAL_PROJECT_LIMITS[planId];
  const portalReportingMaxDays = PLAN_PORTAL_REPORTING_MAX_DAYS[planId];
  const businessOrAbove = planId === "business" || planId === "enterprise";
  return {
    planId,
    portalEditor: portalProjectLimit === null || portalProjectLimit > 0,
    portalProjectLimit,
    // The AI portal builder has no server routes in this build, so it stays
    // off. The visitor assistant (/api/public/ask) and machine translation
    // (/api/public/translate) run on Claude and are on whenever
    // ANTHROPIC_API_KEY is configured, independent of plan.
    portalAiBuilder: false,
    portalAssistant: isAnthropicConfigured(),
    portalTranslations: isAnthropicConfigured(),
    portalReporting: businessOrAbove,
    portalReportingMaxDays,
    portalBrandingRemoval: planId === "enterprise",
  };
}

export function resolvePortalPlanEntitlements(
  subscription: Pick<SubscriptionRow, "plan_id" | "tier" | "status"> | null,
): PortalPlanEntitlements {
  return getPortalPlanEntitlements(resolveEntitlementPlanId(subscription));
}
