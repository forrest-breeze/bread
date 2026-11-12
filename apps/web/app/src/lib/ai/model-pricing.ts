/**
 * Per-million-token USD pricing for every model the Bread app emits
 * into llm_metrics. Update entries when the vendor bumps their
 * pricing — the "Last verified" comment + URL is the maintenance record.
 *
 * Unknown models (anything not in this table, including null) cost 0.
 * That's deliberate: it surfaces the unknown-model row in `costByModel`
 * with $0 so the operator notices and updates the table, instead of
 * silently swallowing the spend or guessing.
 *
 * If we ever bill customers from this, switch to integer cents — float
 * USD is fine for back-office reporting at the volumes we see.
 */

export interface ModelRate {
  /** USD per 1M input tokens. */
  input: number
  /** USD per 1M output tokens. 0 for embedding-only models. */
  output: number
}

// Rates last verified 2026-07.
// Anthropic: https://www.anthropic.com/pricing
// Google AI: https://ai.google.dev/pricing
// DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
// Moonshot (Kimi): https://platform.moonshot.ai/docs/pricing
//
// Frozen at runtime so a stray test or a misbehaving import can't zero out
// the rates and silently destroy every cost calculation. TS's `Readonly`
// is shallow; `Object.freeze` is the only enforcement that survives `as`
// casts and erased types at runtime.
export const MODEL_PRICING: Readonly<Record<string, Readonly<ModelRate>>> =
  Object.freeze({
    "claude-opus-4-8": Object.freeze({ input: 5.0, output: 25.0 }),
    "claude-opus-4-7": Object.freeze({ input: 15.0, output: 75.0 }),
    "claude-sonnet-4-6": Object.freeze({ input: 3.0, output: 15.0 }),
    "claude-haiku-4-5": Object.freeze({ input: 1.0, output: 5.0 }),
    "gemini-2.5-flash": Object.freeze({ input: 0.075, output: 0.3 }),
    "gemini-embedding-001": Object.freeze({ input: 0.025, output: 0 }),
    "deepseek-chat": Object.freeze({ input: 0.3, output: 1.2 }),
    "deepseek-reasoner": Object.freeze({ input: 0.6, output: 2.2 }),
    "kimi-k2-0711-preview": Object.freeze({ input: 0.6, output: 2.5 }),
    // Flat across the full 1M context window — no length tiering.
    "kimi-k3": Object.freeze({ input: 3.0, output: 15.0 }),
  })

const TOKENS_PER_MILLION = 1_000_000

function safeTokens(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

/**
 * Pure function — no I/O. Returns USD as a number; round at the
 * formatting layer (`formatUsd`) so we don't lose precision when
 * summing many small rows.
 */
export function dollarsFor(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!model) return 0
  const rate = MODEL_PRICING[model]
  if (!rate) return 0
  const inUsd = (safeTokens(inputTokens) * rate.input) / TOKENS_PER_MILLION
  const outUsd = (safeTokens(outputTokens) * rate.output) / TOKENS_PER_MILLION
  return inUsd + outUsd
}
