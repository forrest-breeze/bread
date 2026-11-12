import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  isS3Configured,
  getS3Config,
  publicUrlFor,
  __resetS3ClientForTests,
} from "@/lib/storage/s3"

// The module reads process.env on each call (config is not frozen at import),
// so we mutate env per-test and restore afterward.
const S3_VARS = [
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_SESSION_TOKEN",
  "S3_ENDPOINT",
  "S3_FORCE_PATH_STYLE",
  "S3_PUBLIC_BASE_URL",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const

describe("S3 config gating", () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const k of S3_VARS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    __resetS3ClientForTests()
  })

  afterEach(() => {
    for (const k of S3_VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    __resetS3ClientForTests()
  })

  it("is unconfigured when S3_BUCKET is absent", () => {
    expect(isS3Configured()).toBe(false)
    expect(getS3Config()).toBeNull()
  })

  it("is configured once S3_BUCKET is set, defaulting region", () => {
    process.env.S3_BUCKET = "my-bucket"
    expect(isS3Configured()).toBe(true)
    const cfg = getS3Config()
    expect(cfg?.bucket).toBe("my-bucket")
    expect(cfg?.region).toBe("us-east-1")
    expect(cfg?.forcePathStyle).toBe(false)
  })

  it("falls back to AWS_REGION when S3_REGION is unset", () => {
    process.env.S3_BUCKET = "b"
    process.env.AWS_REGION = "eu-west-2"
    expect(getS3Config()?.region).toBe("eu-west-2")
  })

  it("parses forcePathStyle truthy values", () => {
    process.env.S3_BUCKET = "b"
    process.env.S3_FORCE_PATH_STYLE = "true"
    expect(getS3Config()?.forcePathStyle).toBe(true)
  })

  it("treats a blank bucket as unconfigured", () => {
    process.env.S3_BUCKET = "   "
    expect(isS3Configured()).toBe(false)
  })

  it("fails closed on a partial explicit credential pair", () => {
    process.env.S3_BUCKET = "b"
    process.env.S3_ACCESS_KEY_ID = "only-half"

    expect(() => isS3Configured()).toThrow(/must be set together/)
  })

  it("does not expose credentials through the public config helper", () => {
    process.env.S3_BUCKET = "b"
    process.env.S3_ACCESS_KEY_ID = "access"
    process.env.S3_SECRET_ACCESS_KEY = "secret"
    process.env.S3_SESSION_TOKEN = "session"

    expect(getS3Config()).toEqual({
      bucket: "b",
      region: "us-east-1",
      endpoint: undefined,
      forcePathStyle: false,
      publicBaseUrl: undefined,
    })
    expect(JSON.stringify(getS3Config())).not.toContain("secret")
  })

  it("requires HTTPS for non-local custom endpoints", () => {
    process.env.S3_BUCKET = "b"
    process.env.S3_ENDPOINT = "http://objects.example.com"
    process.env.S3_ACCESS_KEY_ID = "access"
    process.env.S3_SECRET_ACCESS_KEY = "secret"

    expect(() => getS3Config()).toThrow(/must use HTTPS/)
  })
})

describe("publicUrlFor", () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = { S3_BUCKET: process.env.S3_BUCKET, S3_PUBLIC_BASE_URL: process.env.S3_PUBLIC_BASE_URL }
    process.env.S3_BUCKET = "b"
  })

  afterEach(() => {
    if (saved.S3_BUCKET === undefined) delete process.env.S3_BUCKET
    else process.env.S3_BUCKET = saved.S3_BUCKET
    if (saved.S3_PUBLIC_BASE_URL === undefined) delete process.env.S3_PUBLIC_BASE_URL
    else process.env.S3_PUBLIC_BASE_URL = saved.S3_PUBLIC_BASE_URL
  })

  it("returns null when no public base url is configured", () => {
    delete process.env.S3_PUBLIC_BASE_URL
    expect(publicUrlFor("media/ws/abc.png")).toBeNull()
  })

  it("joins the base url and key, trimming a trailing slash", () => {
    process.env.S3_PUBLIC_BASE_URL = "https://cdn.example.com/"
    expect(publicUrlFor("media/ws/abc.png")).toBe(
      "https://cdn.example.com/media/ws/abc.png",
    )
  })
})
