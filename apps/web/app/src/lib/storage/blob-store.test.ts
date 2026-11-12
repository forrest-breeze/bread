import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  offloadThresholdBytes,
  shouldOffloadText,
  isBinaryMedia,
  extForMime,
  contentHash,
  buildMediaKey,
  buildDocBodyKey,
} from "@/lib/storage/blob-store"

// ---------------------------------------------------------------------------
// extForMime() — mime → key extension
// ---------------------------------------------------------------------------
describe("extForMime", () => {
  it("maps known mimes to friendly extensions", () => {
    expect(extForMime("image/png")).toBe("png")
    expect(extForMime("image/jpeg")).toBe("jpg")
    expect(extForMime("video/mp4")).toBe("mp4")
    expect(extForMime("image/svg+xml")).toBe("svg")
  })

  it("is case-insensitive and trims", () => {
    expect(extForMime("  IMAGE/PNG ")).toBe("png")
  })

  it("derives a sane extension for unknown mimes", () => {
    // structured-suffix mimes collapse to the suffix
    expect(extForMime("application/foo+json")).toBe("json")
    // parameters are stripped
    expect(extForMime("image/heic; charset=binary")).toBe("heic")
  })

  it("falls back to bin for garbage", () => {
    expect(extForMime("nonsense")).toBe("bin")
  })
})

// ---------------------------------------------------------------------------
// isBinaryMedia()
// ---------------------------------------------------------------------------
describe("isBinaryMedia", () => {
  it("recognizes image/video/audio", () => {
    expect(isBinaryMedia("image/png")).toBe(true)
    expect(isBinaryMedia("video/mp4")).toBe(true)
    expect(isBinaryMedia("audio/mpeg")).toBe(true)
  })

  it("rejects text and application types", () => {
    expect(isBinaryMedia("text/markdown")).toBe(false)
    expect(isBinaryMedia("application/pdf")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// contentHash() — deterministic, content-addressed
// ---------------------------------------------------------------------------
describe("contentHash", () => {
  it("is stable for identical bytes and differs for different bytes", () => {
    const a = contentHash(Buffer.from("hello"))
    const b = contentHash(Buffer.from("hello"))
    const c = contentHash(Buffer.from("world"))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// buildMediaKey() / buildDocBodyKey()
// ---------------------------------------------------------------------------
describe("key builders", () => {
  it("builds a workspace-prefixed, content-addressed media key", () => {
    const key = buildMediaKey({
      workspaceId: "ws-1",
      hash: "abc123",
      mime: "image/png",
    })
    expect(key).toBe("media/ws-1/abc123.png")
  })

  it("builds a doc body key grouped by document id", () => {
    const key = buildDocBodyKey({
      workspaceId: "ws-1",
      documentId: "doc-9",
      hash: "deadbeef",
    })
    expect(key).toBe("docs/ws-1/doc-9/deadbeef.md")
  })
})

// ---------------------------------------------------------------------------
// offload threshold
// ---------------------------------------------------------------------------
describe("text offload threshold", () => {
  const original = process.env.S3_OFFLOAD_THRESHOLD_BYTES

  beforeEach(() => {
    delete process.env.S3_OFFLOAD_THRESHOLD_BYTES
  })
  afterEach(() => {
    if (original === undefined) delete process.env.S3_OFFLOAD_THRESHOLD_BYTES
    else process.env.S3_OFFLOAD_THRESHOLD_BYTES = original
  })

  it("defaults to 256 KiB", () => {
    expect(offloadThresholdBytes()).toBe(256 * 1024)
  })

  it("honors a valid env override", () => {
    process.env.S3_OFFLOAD_THRESHOLD_BYTES = "1024"
    expect(offloadThresholdBytes()).toBe(1024)
  })

  it("ignores a non-numeric / non-positive override", () => {
    process.env.S3_OFFLOAD_THRESHOLD_BYTES = "nope"
    expect(offloadThresholdBytes()).toBe(256 * 1024)
    process.env.S3_OFFLOAD_THRESHOLD_BYTES = "0"
    expect(offloadThresholdBytes()).toBe(256 * 1024)
  })

  it("offloads only at or above the threshold", () => {
    process.env.S3_OFFLOAD_THRESHOLD_BYTES = "10"
    expect(shouldOffloadText("123456789")).toBe(false) // 9 bytes
    expect(shouldOffloadText("1234567890")).toBe(true) // 10 bytes
  })

  it("measures UTF-8 byte length, not character count", () => {
    process.env.S3_OFFLOAD_THRESHOLD_BYTES = "4"
    // "€" is 3 bytes; two of them = 6 bytes >= 4
    expect(shouldOffloadText("€€")).toBe(true)
    expect(shouldOffloadText("a")).toBe(false)
  })
})
