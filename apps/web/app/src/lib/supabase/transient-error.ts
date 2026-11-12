export function isTransientSupabaseError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const { code, cause } = err as { code?: string; cause?: unknown };
    if (code && ["PGRST000", "PGRST001", "PGRST002", "PGRST003", "57014", "53300", "57P01"].includes(code)) return true;
    if (cause && cause !== err && isTransientSupabaseError(cause)) return true;
  }
  if (err instanceof TypeError) return true;

  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name?: unknown }).name)
      : "";
  if (name === "AbortError" || name === "TimeoutError") return true;

  const message =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === "string"
        ? err
        : typeof err === "object" && err !== null && "message" in err
          ? String(err.message)
          : "";

  return (
    message.includes("TimeoutError") ||
    message.includes("AbortError") ||
    message.includes("aborted due to timeout") ||
    message.includes("fetch failed") ||
    message.includes("network")
  );
}
