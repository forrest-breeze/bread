import { isAuthError, isAuthRetryableFetchError } from "@supabase/supabase-js";

/** A backend failure is not evidence that the session is invalid. */
export function isTransientAuthFailure(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  if (isAuthError(error)) {
    return error.status === undefined || error.status >= 500 ||
      [408, 409, 429].includes(error.status);
  }
  return true;
}
