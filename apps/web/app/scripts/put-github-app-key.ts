#!/usr/bin/env -S npx tsx

// ---------------------------------------------------------------------------
// Provision the GitHub App private key into Upstash Redis.
//
// `getAppJWT()` resolves the key from GITHUB_APP_PRIVATE_KEY first and falls
// back to the Upstash key below — the fallback exists because a Lambda env var
// caps at 4KB. Deployments that use the fallback need this key present or every
// GitHub call (hosted-docs sync, repo sweep, PR sessions) fails before it makes
// a single request.
//
// Reads the key from the environment (or apps/web/app/.env.local), validates it
// the same way the app does, writes it, then reads it back and re-validates —
// so a successful run proves the exact round trip the runtime performs. The key
// itself is never printed.
//
// Run it through the npm script — it passes `--tsconfig` so the `@/` alias this
// module's imports rely on resolves no matter which directory you are in:
//
//   # target whichever Upstash database the deployment uses
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... npm run github:app-key
//
//   npm run github:app-key -- --dry-run   # validate the key, write nothing
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Redis } from "@upstash/redis"
import { parseAppPrivateKey } from "../src/lib/github/github"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..")

/** Must match PRIVATE_KEY_REDIS_KEY in src/lib/github/github.ts. */
const PRIVATE_KEY_REDIS_KEY = "github:app:private-key"

async function loadLocalEnv(): Promise<void> {
  const envPath = path.join(REPO_ROOT, "apps/web/app/.env.local")
  let raw: string
  try {
    raw = await readFile(envPath, "utf8")
  } catch {
    return
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const separator = trimmed.indexOf("=")
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    // Anything already exported wins, so prod Upstash credentials can be
    // supplied inline without editing .env.local.
    if (process.env[key] === undefined) process.env[key] = value
  }
}

async function main(): Promise<void> {
  await loadLocalEnv()
  const dryRun = process.argv.includes("--dry-run")

  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim()
  if (!privateKey) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is required (base64 PKCS#1 DER: openssl rsa -in key.pem -outform DER | base64)",
    )
  }
  // Fail before writing rather than storing bytes the runtime cannot use.
  parseAppPrivateKey(privateKey)

  if (dryRun) {
    console.log(
      JSON.stringify(
        { validated: true, bytes: privateKey.length, wrote: false },
        null,
        2,
      ),
    )
    return
  }

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required to write the key",
    )
  }
  const redis = new Redis({ url, token })
  await redis.set(PRIVATE_KEY_REDIS_KEY, privateKey)

  // Read back through the same client the app uses: `get` runs the stored value
  // through JSON parsing, so this is the only honest proof the runtime will
  // recover the identical string.
  const readBack = await redis.get<string>(PRIVATE_KEY_REDIS_KEY)
  if (readBack !== privateKey) {
    throw new Error(
      `read-back mismatch for "${PRIVATE_KEY_REDIS_KEY}" — the runtime would not recover this key`,
    )
  }
  parseAppPrivateKey(readBack)

  console.log(
    JSON.stringify(
      {
        key: PRIVATE_KEY_REDIS_KEY,
        bytes: privateKey.length,
        wrote: true,
        readBackMatches: true,
        appIdConfiguredHere: Boolean(process.env.GITHUB_APP_ID),
      },
      null,
      2,
    ),
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
