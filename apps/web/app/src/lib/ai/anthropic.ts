import "server-only";

import Anthropic from "@anthropic-ai/sdk";

/**
 * Shared Anthropic (Claude) client for the portal AI features: the visitor
 * "Ask AI" assistant and machine translation.
 *
 * Both features are gated ONLY on `ANTHROPIC_API_KEY` being set (server-only;
 * never expose it through a NEXT_PUBLIC_ variable). With no key the features
 * report themselves unavailable: the builder shows a setup hint, the portal
 * hides the assistant and language selector, and the public routes return 503.
 */

/** Grounded answers for portal visitors. */
export const PORTAL_ASK_MODEL = "claude-opus-5-5";
/** Short UI/documentation strings; a small, fast model is enough. */
export const PORTAL_TRANSLATE_MODEL = "claude-haiku-5-5";

export { isAnthropicConfigured } from "@/lib/ai/config";

let cached: { key: string; client: Anthropic } | null = null;

/** Returns null when ANTHROPIC_API_KEY is not configured. */
export function getAnthropicClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (cached?.key !== key) {
    cached = {
      key,
      // Bounded so a slow upstream can't pin a serverless function: one retry,
      // 60s per attempt.
      client: new Anthropic({ apiKey: key, maxRetries: 1, timeout: 60_000 }),
    };
  }
  return cached.client;
}
