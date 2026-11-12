import { NextResponse } from "next/server"
import type { z } from "zod"

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse }

function badRequest(error: string, issues?: unknown): NextResponse {
  return NextResponse.json({ error, issues }, { status: 400 })
}

export async function safeJsonBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<ParseResult<z.infer<S>>> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return { ok: false, response: badRequest("Invalid JSON") }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      response: badRequest("Invalid request body", parsed.error.flatten()),
    }
  }
  return { ok: true, data: parsed.data }
}

export async function safeFormData<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<ParseResult<z.infer<S>>> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return { ok: false, response: badRequest("Invalid form data") }
  }
  const obj = Object.fromEntries(form.entries())
  const parsed = schema.safeParse(obj)
  if (!parsed.success) {
    return {
      ok: false,
      response: badRequest("Invalid form data", parsed.error.flatten()),
    }
  }
  return { ok: true, data: parsed.data }
}

export function safeSearchParams<S extends z.ZodTypeAny>(
  url: URL,
  schema: S,
): ParseResult<z.infer<S>> {
  const obj = Object.fromEntries(url.searchParams.entries())
  const parsed = schema.safeParse(obj)
  if (!parsed.success) {
    return {
      ok: false,
      response: badRequest("Invalid query parameters", parsed.error.flatten()),
    }
  }
  return { ok: true, data: parsed.data }
}

export function safeRouteParams<S extends z.ZodTypeAny>(
  params: unknown,
  schema: S,
): ParseResult<z.infer<S>> {
  const parsed = schema.safeParse(params)
  if (!parsed.success) {
    return {
      ok: false,
      response: badRequest("Invalid route parameters", parsed.error.flatten()),
    }
  }
  return { ok: true, data: parsed.data }
}
