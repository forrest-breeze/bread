import { describe, expect, it } from "vitest"
import {
  normalizePortalGenerationReply,
  PORTAL_GENERATION_REPLY_MAX_LENGTH,
} from "./generation"

describe("normalizePortalGenerationReply", () => {
  it("preserves a concise generated summary", () => {
    expect(normalizePortalGenerationReply("  Generated the portal.  ", "Fallback"))
      .toBe("Generated the portal.")
  })

  it("bounds an overlong summary instead of rejecting the generated portal", () => {
    const reply = "A".repeat(PORTAL_GENERATION_REPLY_MAX_LENGTH + 75)

    const normalized = normalizePortalGenerationReply(reply, "Fallback")

    expect(normalized).toHaveLength(PORTAL_GENERATION_REPLY_MAX_LENGTH)
    expect(normalized.endsWith("…")).toBe(true)
  })

  it("uses the fallback when the provider omits its summary", () => {
    expect(normalizePortalGenerationReply(undefined, "Generated a draft."))
      .toBe("Generated a draft.")
  })
})
