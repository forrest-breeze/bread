// Strip PostgREST special characters before composing .ilike(), .or(), or
// other filter strings. Always run on validated free-text user input — the
// schema bounds length, this strips the metacharacters that would otherwise
// break the filter syntax or be exploitable for injection.
export function sanitizeForPostgrest(input: string): string {
  return input.replace(/[(),.*\\%_]/g, "")
}
