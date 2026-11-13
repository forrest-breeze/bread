import { describe, it, expect, vi } from "vitest"
import {
  PLAN_AI_MONTHLY_BUDGET_USD,
  PLAN_MEMBER_LIMITS,
  isBillingPlanId,
  resolveEntitlementPlanId,
  resolvePortalPlanEntitlements,
} from "@/lib/billing/catalog"
import type { SubscriptionRow } from "@/lib/types"

const freeRow: Pick<SubscriptionRow, "plan_id" | "tier" | "status"> = {
  plan_id: "free",
  tier: "free",
  status: "active",
}

describe("resolveEntitlementPlanId (internal tool: no billing)", () => {
  it("resolves every workspace to enterprise, whatever its subscription row says", () => {
    expect(resolveEntitlementPlanId(null)).toBe("enterprise")
    expect(resolveEntitlementPlanId(undefined)).toBe("enterprise")
    expect(resolveEntitlementPlanId(freeRow)).toBe("enterprise")
    expect(resolveEntitlementPlanId({ ...freeRow, status: "canceled" })).toBe("enterprise")
  })

  it("gives uncapped members and a non-zero AI budget", () => {
    const plan = resolveEntitlementPlanId(freeRow)
    expect(PLAN_MEMBER_LIMITS[plan]).toBeNull()
    expect(PLAN_AI_MONTHLY_BUDGET_USD[plan]).toBeGreaterThan(0)
  })
})

describe("resolvePortalPlanEntitlements", () => {
  it("unlocks the portal editor, reporting and branding removal for every workspace", () => {
    const e = resolvePortalPlanEntitlements(freeRow)
    expect(e.planId).toBe("enterprise")
    expect(e.portalEditor).toBe(true)
    expect(e.portalProjectLimit).toBeNull()
    expect(e.portalReporting).toBe(true)
    expect(e.portalBrandingRemoval).toBe(true)
  })

  it("keeps the AI builder off and gates assistant + translations on ANTHROPIC_API_KEY", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "")
    const off = resolvePortalPlanEntitlements(null)
    expect(off.portalAiBuilder).toBe(false)
    expect(off.portalAssistant).toBe(false)
    expect(off.portalTranslations).toBe(false)

    vi.stubEnv("ANTHROPIC_API_KEY", "test-key")
    const on = resolvePortalPlanEntitlements(null)
    expect(on.portalAiBuilder).toBe(false)
    expect(on.portalAssistant).toBe(true)
    expect(on.portalTranslations).toBe(true)
    vi.unstubAllEnvs()
  })
})

describe("isBillingPlanId", () => {
  it("accepts known plan ids only", () => {
    expect(isBillingPlanId("free")).toBe(true)
    expect(isBillingPlanId("enterprise")).toBe(true)
    expect(isBillingPlanId("gold")).toBe(false)
    expect(isBillingPlanId(null)).toBe(false)
  })
})
