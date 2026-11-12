import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  safeJsonBody,
  safeFormData,
  safeSearchParams,
  safeRouteParams,
} from "../request"

const schema = z.object({ name: z.string().min(1) })

function makeJsonRequest(body: unknown): Request {
  return new Request("http://test/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("safeJsonBody", () => {
  it("returns ok=true for a valid body", async () => {
    const result = await safeJsonBody(makeJsonRequest({ name: "test" }), schema)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.name).toBe("test")
  })

  it("returns 400 with issues for a missing required field", async () => {
    const result = await safeJsonBody(makeJsonRequest({}), schema)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(400)
      const body = (await result.response.json()) as {
        error: string
        issues: unknown
      }
      expect(body.error).toBe("Invalid request body")
      expect(body.issues).toBeDefined()
    }
  })

  it("returns 400 with 'Invalid JSON' for malformed JSON", async () => {
    const result = await safeJsonBody(makeJsonRequest("{bad json"), schema)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(400)
      const body = (await result.response.json()) as { error: string }
      expect(body.error).toBe("Invalid JSON")
    }
  })
})

describe("safeFormData", () => {
  it("returns ok=true for valid form data", async () => {
    const fd = new FormData()
    fd.append("name", "hello")
    const req = new Request("http://test/", { method: "POST", body: fd })
    const result = await safeFormData(req, schema)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.name).toBe("hello")
  })

  it("returns 400 for a missing required field", async () => {
    const fd = new FormData()
    const req = new Request("http://test/", { method: "POST", body: fd })
    const result = await safeFormData(req, schema)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(400)
      const body = (await result.response.json()) as { error: string }
      expect(body.error).toBe("Invalid form data")
    }
  })
})

describe("safeSearchParams", () => {
  it("validates query params", () => {
    const url = new URL("http://test/?name=foo")
    const result = safeSearchParams(url, schema)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.name).toBe("foo")
  })

  it("returns 400 for a missing param", () => {
    const url = new URL("http://test/")
    const result = safeSearchParams(url, schema)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(400)
  })
})

describe("safeRouteParams", () => {
  it("validates params", () => {
    const result = safeRouteParams({ name: "x" }, schema)
    expect(result.ok).toBe(true)
  })

  it("returns 400 for invalid params", () => {
    const result = safeRouteParams({}, schema)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(400)
  })
})
