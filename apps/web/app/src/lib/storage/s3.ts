// ---------------------------------------------------------------------------
// S3 object store — env-gated wrapper around the AWS SDK v3 S3 client.
//
// Large binary assets (image/video attachments, oversized document bodies)
// live in S3 rather than in Postgres `text` columns. Everything here is gated
// behind `isS3Configured()`: when the S3_* env is absent the module never
// constructs a client and callers fall back to their previous behavior. This
// keeps S3 a strictly-additive, opt-in backend — dev/CI without credentials
// behaves exactly as it did before.
//
// S3-compatible stores (Cloudflare R2, MinIO, Backblaze B2) work too: set
// S3_ENDPOINT (+ S3_FORCE_PATH_STYLE=1 for MinIO). Credentials resolve from
// S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY, falling back to the AWS_* pair and
// finally the SDK's default provider chain (IAM role / instance profile).
// ---------------------------------------------------------------------------

import "server-only";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  /** Optional CDN / public bucket origin for unsigned reads (no trailing slash). */
  publicBaseUrl?: string;
}

interface ResolvedS3Config extends S3Config {
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

function configuredCredentialPair(prefix: "S3" | "AWS"):
  | ResolvedS3Config["credentials"]
  | undefined {
  const accessKeyId = process.env[`${prefix}_ACCESS_KEY_ID`]?.trim();
  const secretAccessKey = process.env[`${prefix}_SECRET_ACCESS_KEY`]?.trim();
  const sessionToken = process.env[`${prefix}_SESSION_TOKEN`]?.trim();

  if (!accessKeyId && !secretAccessKey && !sessionToken) return undefined;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `${prefix}_ACCESS_KEY_ID and ${prefix}_SECRET_ACCESS_KEY must be set together. Refusing to fall back to another AWS identity.`,
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

function validateEndpoint(endpoint: string | undefined): void {
  if (!endpoint) return;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("S3_ENDPOINT must be a valid absolute URL.");
  }
  const localHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error(
      "S3_ENDPOINT must use HTTPS (plain HTTP is allowed only for localhost).",
    );
  }
}

function readConfig(): ResolvedS3Config | null {
  const bucket = process.env.S3_BUCKET?.trim();
  if (!bucket) return null;

  const region =
    process.env.S3_REGION?.trim() || process.env.AWS_REGION?.trim() || "us-east-1";
  const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
  validateEndpoint(endpoint);

  // Never mix halves from S3_* and AWS_* or silently fall through from a
  // partial explicit pair to the instance role. That can accidentally sign
  // with a broader production identity than the operator intended.
  const s3Credentials = configuredCredentialPair("S3");
  const awsCredentials = s3Credentials
    ? undefined
    : configuredCredentialPair("AWS");
  const credentials = s3Credentials ?? awsCredentials;
  if (endpoint && !credentials) {
    throw new Error(
      "S3_ENDPOINT requires an explicit S3_* or AWS_* credential pair.",
    );
  }
  const publicBaseUrl =
    process.env.S3_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || undefined;
  const forcePathStyle = /^(1|true|yes)$/i.test(
    process.env.S3_FORCE_PATH_STYLE?.trim() ?? "",
  );

  return {
    bucket,
    region,
    endpoint,
    forcePathStyle,
    credentials,
    publicBaseUrl,
  };
}

/**
 * True when an S3 bucket is configured. Callers MUST guard every S3 operation
 * on this — when false, `getS3Client()` throws and the feature degrades to its
 * pre-S3 behavior.
 */
export function isS3Configured(): boolean {
  return readConfig() !== null;
}

/** The resolved S3 config, or null when S3 is not configured. */
export function getS3Config(): S3Config | null {
  const config = readConfig();
  if (!config) return null;
  const { credentials: _credentials, ...safeConfig } = config;
  return safeConfig;
}

// Memoize the client per-process. Keyed on nothing — env is read once and the
// client is reused across invocations within a warm serverless container.
let cachedClient: S3Client | null = null;

function getS3Client(): { client: S3Client; config: S3Config } {
  const config = readConfig();
  if (!config) {
    throw new Error(
      "S3 is not configured. Set S3_BUCKET (and credentials) before calling the object store.",
    );
  }
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      ...(config.credentials ? { credentials: config.credentials } : {}),
    });
  }
  return { client: cachedClient, config };
}

export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
  /** Cache-Control header stored on the object (defaults to immutable, 1y). */
  cacheControl?: string;
  /** Arbitrary user metadata (x-amz-meta-*). Values must be ASCII strings. */
  metadata?: Record<string, string>;
  /** Optional base64 SHA-256, verified by the object store while receiving. */
  checksumSha256?: string;
}

export interface PutObjectResult {
  key: string;
  bucket: string;
}

export interface SignedUploadInput {
  key: string;
  contentType: string;
  checksumSha256: string;
  /** Exact browser request body length. Included in the SigV4 signed headers. */
  contentLength: number;
  expiresInSeconds?: number;
}

/** Short enough to make leaked/replayed upload URLs low-value bearer tokens. */
export const MAX_SIGNED_UPLOAD_TTL_SECONDS = 60;
export const MAX_SIGNED_READ_TTL_SECONDS = 5 * 60;
const SIGNED_UPLOAD_HEADERS = new Set([
  "cache-control",
  "content-length",
  "content-type",
  "x-amz-checksum-sha256",
]);

export interface ObjectMetadata {
  contentLength: number | null;
  contentType: string | null;
  checksumSha256: string | null;
}

/** Upload an object. Throws if S3 is unconfigured (guard with isS3Configured). */
export async function putObject(input: PutObjectInput): Promise<PutObjectResult> {
  const { client, config } = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      CacheControl: input.cacheControl ?? "private, max-age=31536000, immutable",
      ...(input.checksumSha256
        ? { ChecksumSHA256: input.checksumSha256 }
        : {}),
      ...(input.metadata ? { Metadata: input.metadata } : {}),
    }),
  );
  return { key: input.key, bucket: config.bucket };
}

/**
 * Create a short-lived, checksum-bound PUT URL so browser uploads travel
 * directly to S3 instead of through the Next.js function or Supabase Storage.
 */
export async function getSignedUploadUrl(
  input: SignedUploadInput,
): Promise<string> {
  const { client, config } = getS3Client();
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
      ChecksumSHA256: input.checksumSha256,
      CacheControl: "private, max-age=31536000, immutable",
    }),
    {
      expiresIn: Math.max(
        1,
        Math.min(
          input.expiresInSeconds ?? MAX_SIGNED_UPLOAD_TTL_SECONDS,
          MAX_SIGNED_UPLOAD_TTL_SECONDS,
        ),
      ),
      signableHeaders: SIGNED_UPLOAD_HEADERS,
    },
  );
}

/** Read object metadata after a direct upload without downloading its bytes. */
export async function headObject(key: string): Promise<ObjectMetadata> {
  const { client, config } = getS3Client();
  const result = await client.send(
    new HeadObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ChecksumMode: "ENABLED",
    }),
  );
  return {
    contentLength: result.ContentLength ?? null,
    contentType: result.ContentType ?? null,
    checksumSha256: result.ChecksumSHA256 ?? null,
  };
}

/** Fetch only enough leading bytes to validate an uploaded media signature. */
export async function getObjectPrefix(
  key: string,
  maxBytes = 64,
): Promise<Uint8Array> {
  const boundedBytes = Math.max(1, Math.min(Math.trunc(maxBytes), 1024));
  const { client, config } = getS3Client();
  const result = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Range: `bytes=0-${boundedBytes - 1}`,
    }),
  );
  if (!result.Body) return new Uint8Array();
  return result.Body.transformToByteArray();
}

/**
 * A time-limited signed GET URL for a private object. The five-minute hard cap
 * limits bearer-URL replay while still letting an in-flight media response
 * finish. Use publicUrlFor() only with an independently protected CDN.
 */
export async function getSignedReadUrl(
  key: string,
  expiresInSeconds = MAX_SIGNED_READ_TTL_SECONDS,
): Promise<string> {
  const { client, config } = getS3Client();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    {
      expiresIn: Math.max(
        1,
        Math.min(expiresInSeconds, MAX_SIGNED_READ_TTL_SECONDS),
      ),
    },
  );
}

/** Delete an object. No-op-safe: S3 returns success for a missing key. */
export async function deleteObject(key: string): Promise<void> {
  const { client, config } = getS3Client();
  await client.send(
    new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
  );
}

/**
 * The unsigned, CDN-served URL for a key, or null when no public base is
 * configured (in which case callers should fall back to getSignedReadUrl).
 */
export function publicUrlFor(key: string): string | null {
  const config = readConfig();
  if (!config?.publicBaseUrl) return null;
  return `${config.publicBaseUrl}/${key}`;
}

/** Test-only: drop the memoized client so a new env can take effect. */
export function __resetS3ClientForTests(): void {
  cachedClient = null;
}
