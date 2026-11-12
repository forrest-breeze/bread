import { describe, expect, it } from "vitest"
import {
  matchesMediaFileSignature,
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  MEDIA_UPLOAD_PREPARES_PER_HOUR,
} from "./media-upload-policy"

describe("media upload cost limits", () => {
  it("pins the exact per-object and hourly limits", () => {
    expect(MAX_IMAGE_UPLOAD_BYTES).toBe(20_971_520)
    expect(MAX_VIDEO_UPLOAD_BYTES).toBe(262_144_000)
    expect(MEDIA_UPLOAD_PREPARES_PER_HOUR).toBe(30)
  })
})

describe("matchesMediaFileSignature", () => {
  it("accepts the supported image signatures", () => {
    expect(
      matchesMediaFileSignature(
        Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
        "image/png",
      ),
    ).toBe(true)
    expect(
      matchesMediaFileSignature(
        Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]),
        "image/jpeg",
      ),
    ).toBe(true)
    expect(
      matchesMediaFileSignature(
        new TextEncoder().encode("GIF89a"),
        "image/gif",
      ),
    ).toBe(true)
    expect(
      matchesMediaFileSignature(
        new TextEncoder().encode("RIFF\0\0\0\0WEBP"),
        "image/webp",
      ),
    ).toBe(true)
    expect(
      matchesMediaFileSignature(
        Uint8Array.from([
          0, 0, 0, 24, 102, 116, 121, 112, 97, 118, 105, 102,
        ]),
        "image/avif",
      ),
    ).toBe(true)
  })

  it("accepts supported video containers", () => {
    expect(
      matchesMediaFileSignature(
        Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]),
        "video/webm",
      ),
    ).toBe(true)
    expect(
      matchesMediaFileSignature(
        Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112]),
        "video/mp4",
      ),
    ).toBe(true)
  })

  it("rejects a payload disguised by an allowed MIME type", () => {
    expect(
      matchesMediaFileSignature(
        new TextEncoder().encode("<html><script>alert(1)</script></html>"),
        "image/png",
      ),
    ).toBe(false)
  })
})
