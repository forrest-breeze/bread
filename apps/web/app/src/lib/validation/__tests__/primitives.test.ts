import { describe, it, expect } from "vitest"
import {
  uuidParamSchema,
  paginationQuerySchema,
  roleEnum,
  slugSchema,
  emailSchema,
  nonEmptyTrimmedString,
} from "../primitives"

describe("uuidParamSchema", () => {
  it("accepts a valid uuid", () => {
    const result = uuidParamSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
    })
    expect(result.success).toBe(true)
  })

  it("rejects a non-uuid string", () => {
    const result = uuidParamSchema.safeParse({ id: "not-a-uuid" })
    expect(result.success).toBe(false)
  })

  it("rejects an empty object", () => {
    const result = uuidParamSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe("paginationQuerySchema", () => {
  it("applies default limit when absent", () => {
    const result = paginationQuerySchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.limit).toBe(25)
  })

  it("coerces numeric strings", () => {
    const result = paginationQuerySchema.safeParse({ limit: "10" })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.limit).toBe(10)
  })

  it("rejects limit greater than 100", () => {
    expect(paginationQuerySchema.safeParse({ limit: "101" }).success).toBe(false)
  })

  it("rejects limit less than 1", () => {
    expect(paginationQuerySchema.safeParse({ limit: "0" }).success).toBe(false)
  })

  it("accepts an opaque cursor string", () => {
    const result = paginationQuerySchema.safeParse({ cursor: "abc123" })
    expect(result.success).toBe(true)
  })
})

describe("roleEnum", () => {
  it.each(["owner", "admin", "editor", "viewer"])("accepts %s", (role) => {
    expect(roleEnum.safeParse(role).success).toBe(true)
  })

  it("rejects unknown role", () => {
    expect(roleEnum.safeParse("super-admin").success).toBe(false)
  })
})

describe("slugSchema", () => {
  it.each(["a", "lore-ops", "team-1", "abc-def-ghi"])("accepts %s", (slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(true)
  })

  it.each([
    "",
    "-leading",
    "trailing-",
    "Capitalized",
    "with space",
    "a".repeat(51),
  ])("rejects %s", (slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(false)
  })
})

describe("emailSchema", () => {
  it("trims and lowercases", () => {
    const result = emailSchema.safeParse("  Foo@Example.com  ")
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe("foo@example.com")
  })

  it("rejects malformed", () => {
    expect(emailSchema.safeParse("not-an-email").success).toBe(false)
  })

  it("rejects emails over 254 chars", () => {
    const long = `${"a".repeat(250)}@b.co`
    expect(emailSchema.safeParse(long).success).toBe(false)
  })
})

describe("nonEmptyTrimmedString", () => {
  const s = nonEmptyTrimmedString(10)

  it("trims and accepts within bounds", () => {
    const result = s.safeParse("  hi  ")
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe("hi")
  })

  it("rejects whitespace-only", () => {
    expect(s.safeParse("   ").success).toBe(false)
  })

  it("rejects strings over the max", () => {
    expect(s.safeParse("a".repeat(11)).success).toBe(false)
  })

  it("rejects an empty string", () => {
    expect(s.safeParse("").success).toBe(false)
  })
})
