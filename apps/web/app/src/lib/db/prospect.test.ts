import { describe, expect, it } from "vitest"

import {
  PROSPECT_PORTAL_TTL_DAYS,
  isProspectPortalExpired,
  prospectPortalExpiresAt,
} from "@/lib/db/prospect"

const NOW = new Date("2026-07-08T12:00:00.000Z")

function publishedDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

describe("prospectPortalExpiresAt", () => {
  it("is published_at + TTL for an unconverted prospect", () => {
    const publishedAt = "2026-07-01T00:00:00.000Z"
    expect(prospectPortalExpiresAt({ published_at: publishedAt })).toBe(
      new Date(
        Date.parse(publishedAt) + PROSPECT_PORTAL_TTL_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString(),
    )
  })

  it("never expires a converted prospect", () => {
    expect(
      prospectPortalExpiresAt({
        published_at: publishedDaysAgo(90),
        converted_at: publishedDaysAgo(45),
      }),
    ).toBeNull()
  })

  it("has nothing to measure without a publish stamp", () => {
    expect(prospectPortalExpiresAt({})).toBeNull()
    expect(prospectPortalExpiresAt({ published_at: "not-a-date" })).toBeNull()
  })
})

describe("isProspectPortalExpired", () => {
  it("ignores non-prospect workspaces", () => {
    expect(isProspectPortalExpired(null, NOW)).toBe(false)
    expect(isProspectPortalExpired({}, NOW)).toBe(false)
    expect(isProspectPortalExpired({ kb_public: true }, NOW)).toBe(false)
  })

  it("keeps a fresh unconverted portal live", () => {
    const settings = { prospect: { published_at: publishedDaysAgo(5) } }
    expect(isProspectPortalExpired(settings, NOW)).toBe(false)
  })

  it("expires an unconverted portal past the TTL", () => {
    const settings = {
      prospect: { published_at: publishedDaysAgo(PROSPECT_PORTAL_TTL_DAYS + 1) },
    }
    expect(isProspectPortalExpired(settings, NOW)).toBe(true)
  })

  it("expires exactly at the TTL boundary", () => {
    const settings = {
      prospect: { published_at: publishedDaysAgo(PROSPECT_PORTAL_TTL_DAYS) },
    }
    expect(isProspectPortalExpired(settings, NOW)).toBe(true)
  })

  it("never expires a converted portal", () => {
    const settings = {
      prospect: {
        published_at: publishedDaysAgo(90),
        converted_at: publishedDaysAgo(45),
      },
    }
    expect(isProspectPortalExpired(settings, NOW)).toBe(false)
  })

  it("keeps a stamp-less prospect live rather than guessing", () => {
    expect(isProspectPortalExpired({ prospect: { id: "x" } }, NOW)).toBe(false)
  })
})
