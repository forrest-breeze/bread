import { NextRequest } from "next/server"

/**
 * Options for `makeJsonRequest` — every field is optional so the common case
 * (POST with a JSON body) stays a one-liner.
 */
export interface JsonRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  url?: string
  headers?: Record<string, string>
}

const DEFAULT_URL = "https://app.example.dev/api/test"

// Next's `NextRequest` constructor accepts a narrower `RequestInit` than the
// lib.dom version (its `signal` type excludes `null`). Use the constructor's
// declared parameter type so helpers stay portable across Next upgrades.
type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>

/**
 * Build a `NextRequest` with a JSON body. For GET/DELETE requests the body
 * is dropped (the Fetch spec rejects bodies on those verbs).
 */
export function makeJsonRequest(
  body: unknown,
  opts: JsonRequestOptions = {},
): NextRequest {
  const method = opts.method ?? "POST"
  const headers = new Headers({
    "content-type": "application/json",
    ...(opts.headers ?? {}),
  })
  const init: NextRequestInit = { method, headers }
  if (method !== "GET" && method !== "DELETE") {
    init.body = typeof body === "string" ? body : JSON.stringify(body)
  }
  return new NextRequest(opts.url ?? DEFAULT_URL, init)
}

/**
 * Build a `NextRequest` with no body — the common shape for GET/DELETE
 * handlers that only read the URL/headers.
 */
export function makeEmptyRequest(
  opts: Omit<JsonRequestOptions, "method"> & { method?: "GET" | "DELETE" } = {},
): NextRequest {
  const method = opts.method ?? "GET"
  const init: NextRequestInit = {
    method,
    headers: new Headers(opts.headers ?? {}),
  }
  return new NextRequest(opts.url ?? DEFAULT_URL, init)
}

/**
 * Helper for Next 15+ dynamic-route handlers that receive `params` as a
 * Promise. Returns a handler context object with a resolved promise for
 * `params`.
 */
export function makeRouteContext<T extends Record<string, string>>(
  params: T,
): { params: Promise<T> } {
  return { params: Promise.resolve(params) }
}
