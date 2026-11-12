/** Maximum length of the agent summary returned alongside a generated layout. */
export const PORTAL_GENERATION_REPLY_MAX_LENGTH = 500

/**
 * Keep an overlong human-readable summary from invalidating an otherwise valid
 * generated portal. Provider output is validated for structure first, then the
 * summary is bounded here before it reaches the builder transcript.
 */
export function normalizePortalGenerationReply(
  reply: string | undefined,
  fallback: string,
): string {
  const normalized = reply?.trim() || fallback
  if (normalized.length <= PORTAL_GENERATION_REPLY_MAX_LENGTH) return normalized
  return `${normalized
    .slice(0, PORTAL_GENERATION_REPLY_MAX_LENGTH - 1)
    .trimEnd()}…`
}
