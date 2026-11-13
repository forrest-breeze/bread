/**
 * Whether the Claude-backed portal features (visitor "Ask AI" assistant and
 * machine translation) can run. Gated only on the server-only
 * `ANTHROPIC_API_KEY`; evaluates to false in the browser, where the variable is
 * never exposed. Kept free of the SDK import so entitlement code can call it
 * cheaply.
 */
export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}
