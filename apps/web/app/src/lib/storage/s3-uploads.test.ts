import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockSend, mockGetSignedUrl } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockGetSignedUrl: vi.fn(),
}))

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    input: Record<string, unknown>

    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  }

  return {
    S3Client: class {
      send = mockSend
    },
    PutObjectCommand: Command,
    GetObjectCommand: Command,
    DeleteObjectCommand: Command,
    HeadObjectCommand: Command,
  }
})

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}))

import {
  __resetS3ClientForTests,
  getSignedUploadUrl,
  getObjectPrefix,
  getSignedReadUrl,
  headObject,
} from "@/lib/storage/s3"

describe("direct S3 media uploads", () => {
  beforeEach(() => {
    process.env.S3_BUCKET = "media-bucket"
    process.env.S3_REGION = "us-west-2"
    __resetS3ClientForTests()
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.S3_BUCKET
    delete process.env.S3_REGION
    __resetS3ClientForTests()
  })

  it("signs a checksum-bound PUT with a short expiry", async () => {
    mockGetSignedUrl.mockResolvedValue("https://bucket.example/signed")

    await expect(
      getSignedUploadUrl({
        key: "media/ws/hash.mp4",
        contentType: "video/mp4",
        checksumSha256: "checksum",
        contentLength: 42,
      }),
    ).resolves.toBe("https://bucket.example/signed")

    const command = mockGetSignedUrl.mock.calls[0]?.[1] as {
      input: Record<string, unknown>
    }
    expect(command.input).toMatchObject({
      Bucket: "media-bucket",
      Key: "media/ws/hash.mp4",
      ContentType: "video/mp4",
      ContentLength: 42,
      ChecksumSHA256: "checksum",
      CacheControl: "private, max-age=31536000, immutable",
    })
    expect(mockGetSignedUrl.mock.calls[0]?.[2]).toEqual({
      expiresIn: 60,
      signableHeaders: new Set([
        "cache-control",
        "content-length",
        "content-type",
        "x-amz-checksum-sha256",
      ]),
    })
  })

  it("never signs an upload URL for longer than 60 seconds", async () => {
    mockGetSignedUrl.mockResolvedValue("https://bucket.example/signed")

    await getSignedUploadUrl({
      key: "media/ws/hash.mp4",
      contentType: "video/mp4",
      checksumSha256: "checksum",
      contentLength: 42,
      expiresInSeconds: 3600,
    })

    expect(mockGetSignedUrl.mock.calls[0]?.[2]).toEqual({
      expiresIn: 60,
      signableHeaders: new Set([
        "cache-control",
        "content-length",
        "content-type",
        "x-amz-checksum-sha256",
      ]),
    })
  })

  it("heads the uploaded object with checksum metadata enabled", async () => {
    mockSend.mockResolvedValue({
      ContentLength: 42,
      ContentType: "video/mp4",
      ChecksumSHA256: "checksum",
    })

    await expect(headObject("media/ws/hash.mp4")).resolves.toEqual({
      contentLength: 42,
      contentType: "video/mp4",
      checksumSha256: "checksum",
    })

    const command = mockSend.mock.calls[0]?.[0] as {
      input: Record<string, unknown>
    }
    expect(command.input).toEqual({
      Bucket: "media-bucket",
      Key: "media/ws/hash.mp4",
      ChecksumMode: "ENABLED",
    })
  })

  it("reads only a bounded prefix for server-side file signature checks", async () => {
    const bytes = Uint8Array.from([1, 2, 3])
    mockSend.mockResolvedValue({
      Body: { transformToByteArray: vi.fn().mockResolvedValue(bytes) },
    })

    await expect(getObjectPrefix("media/ws/hash.png", 64)).resolves.toEqual(
      bytes,
    )

    const command = mockSend.mock.calls[0]?.[0] as {
      input: Record<string, unknown>
    }
    expect(command.input).toEqual({
      Bucket: "media-bucket",
      Key: "media/ws/hash.png",
      Range: "bytes=0-63",
    })
  })

  it("caps private read bearer URLs at five minutes", async () => {
    mockGetSignedUrl.mockResolvedValue("https://bucket.example/read")

    await expect(
      getSignedReadUrl("media/ws/hash.png", 3600),
    ).resolves.toBe("https://bucket.example/read")

    expect(mockGetSignedUrl.mock.calls[0]?.[2]).toEqual({ expiresIn: 300 })
  })
})
