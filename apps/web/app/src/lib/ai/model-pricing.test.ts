/**
 * model-pricing — pure helper that turns (model, tokens_in, tokens_out)
 * into USD.
 *
 * Contract:
 *   - Known model names hit the lookup table and produce USD = sum of
 *     (tokens × per-million rate / 1_000_000) for each side.
 *   - Unknown / null / empty model names return 0 (the pipeline's
 *     telemetry has nullable model strings; surfacing $0 makes them
 *     visible in costByModel under "unknown" rather than swallowed).
 *   - Negative or non-finite token counts collapse to 0.
 *   - Numerically stable at 1e9 tokens.
 */

import { describe, expect, it } from "vitest"

import { dollarsFor, MODEL_PRICING } from "./model-pricing"

describe("MODEL_PRICING table", () => {
  it("covers every model the app emits today", () => {
    expect(MODEL_PRICING).toHaveProperty("claude-opus-4-8")
    expect(MODEL_PRICING).toHaveProperty("claude-opus-4-7")
    expect(MODEL_PRICING).toHaveProperty("claude-sonnet-4-6")
    expect(MODEL_PRICING).toHaveProperty("claude-haiku-4-5")
    expect(MODEL_PRICING).toHaveProperty("gemini-2.5-flash")
    expect(MODEL_PRICING).toHaveProperty("gemini-embedding-001")
    // Cheap-model chain for public Ask AI (lib/ai/cheap-model.ts).
    expect(MODEL_PRICING).toHaveProperty("deepseek-chat")
    expect(MODEL_PRICING).toHaveProperty("kimi-k2-0711-preview")
    // Frontier primary for the portal agent + Business sweep (post-Anthropic).
    expect(MODEL_PRICING).toHaveProperty("kimi-k3")
  })

  it("uses non-negative numbers for every input + output rate", () => {
    for (const [name, rate] of Object.entries(MODEL_PRICING)) {
      expect(rate.input, `${name}.input`).toBeGreaterThanOrEqual(0)
      expect(rate.output, `${name}.output`).toBeGreaterThanOrEqual(0)
    }
  })
})

describe("dollarsFor — known models", () => {
  it("computes Gemini Flash cost from input + output rates", () => {
    // Flash: 0.075/M input, 0.30/M output. 1M each → $0.375.
    const usd = dollarsFor("gemini-2.5-flash", 1_000_000, 1_000_000)
    expect(usd).toBeCloseTo(0.375, 6)
  })

  it("computes Sonnet cost", () => {
    // Sonnet: 3/M input, 15/M output. 100k each → $0.30 + $1.50 = $1.80.
    const usd = dollarsFor("claude-sonnet-4-6", 100_000, 100_000)
    expect(usd).toBeCloseTo(1.8, 6)
  })

  it("zeros the output side for embedding models", () => {
    // Embeddings have no output rate; passing output > 0 is harmless
    // because the rate is 0.
    const usd = dollarsFor("gemini-embedding-001", 1_000_000, 1_000_000)
    expect(usd).toBeCloseTo(0.025, 6)
  })

  it("scales linearly with token count", () => {
    const a = dollarsFor("claude-opus-4-7", 1_000, 1_000)
    const b = dollarsFor("claude-opus-4-7", 10_000, 10_000)
    expect(b).toBeCloseTo(a * 10, 6)
  })

  it("is numerically stable at 1e9 tokens", () => {
    const usd = dollarsFor("gemini-2.5-flash", 1_000_000_000, 1_000_000_000)
    expect(Number.isFinite(usd)).toBe(true)
    expect(usd).toBeCloseTo(375, 3)
  })
})

describe("dollarsFor — unknown / degenerate inputs", () => {
  it("returns 0 for an unknown model string", () => {
    expect(dollarsFor("definitely-not-a-real-model", 1_000, 1_000)).toBe(0)
  })

  it("returns 0 for a null model", () => {
    expect(dollarsFor(null, 1_000, 1_000)).toBe(0)
  })

  it("returns 0 for an empty model string", () => {
    expect(dollarsFor("", 1_000, 1_000)).toBe(0)
  })

  it("returns 0 for a composite/garbage model string we don't recognise", () => {
    // llm_metrics has this in prod for one row; treat as unknown
    // until upstream is fixed rather than substring-matching.
    expect(dollarsFor("gemini:gemini-2.5-flash:key-1", 1_000, 1_000)).toBe(0)
  })

  it("treats negative or NaN token counts as 0", () => {
    expect(dollarsFor("gemini-2.5-flash", -1_000, 1_000)).toBeCloseTo(
      dollarsFor("gemini-2.5-flash", 0, 1_000),
      6,
    )
    expect(dollarsFor("gemini-2.5-flash", Number.NaN, 1_000)).toBeCloseTo(
      dollarsFor("gemini-2.5-flash", 0, 1_000),
      6,
    )
  })

  it("returns 0 when both token counts are 0", () => {
    expect(dollarsFor("claude-opus-4-7", 0, 0)).toBe(0)
  })
})
