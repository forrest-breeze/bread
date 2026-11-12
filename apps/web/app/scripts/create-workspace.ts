#!/usr/bin/env -S npx tsx
// =============================================================================
// create-workspace.ts — provision a workspace for a customer by hand.
//
// Mirrors POST /api/workspace (workspace row, owner membership, subscription
// row) for setups done outside the app, e.g. hosting a customer's docs before
// they sign up. `--plan` writes the subscription row directly with NO Stripe
// customer or subscription behind it: a manual grant that Stripe webhooks never
// touch, so remove or replace it when the customer starts paying.
//
// Idempotent: re-running reuses the workspace (by slug), membership and
// subscription row.
//
// USAGE
//   npx tsx scripts/create-workspace.ts --name Breeze --slug breeze \
//     --owner-email you@example.com [--plan business] [--site https://breeze.cash]
// =============================================================================

import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { normalizeWorkspaceSettings } from "../src/lib/workspace-settings"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

// Plan id → the tier the billing catalog pairs it with.
const PLAN_TIERS: Record<string, string> = { free: "free", basic: "basic", business: "pro" }

async function loadLocalEnv(): Promise<void> {
  try {
    const raw = await readFile(path.join(SCRIPT_DIR, "../.env.local"), "utf8")
    for (const line of raw.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2")
      }
    }
  } catch {
    // Env may come from the shell instead.
  }
}

function inviteCode(length = 8): string {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789"
  return Array.from(randomBytes(length), (b) => chars[b % chars.length]).join("")
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const name = flag("name")
  const slug = flag("slug")
  const ownerEmail = flag("owner-email")?.toLowerCase()
  const plan = flag("plan") ?? "free"
  const site = flag("site")
  if (!name || !slug || !ownerEmail) throw new Error("--name, --slug and --owner-email are required")
  const tier = PLAN_TIERS[plan]
  if (!tier) throw new Error(`--plan must be one of ${Object.keys(PLAN_TIERS).join(", ")}`)

  await loadLocalEnv()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required")
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

  let userId: string | null = null
  for (let page = 1; !userId; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`user lookup: ${error.message}`)
    userId = data.users.find((user) => user.email?.toLowerCase() === ownerEmail)?.id ?? null
    if (data.users.length < 200) break
  }
  if (!userId) throw new Error(`no Bread user with email ${ownerEmail}`)

  const { data: existing, error: lookupError } = await admin
    .from("workspaces")
    .select("id, slug")
    .eq("slug", slug)
    .maybeSingle()
  if (lookupError) throw new Error(`workspace lookup: ${lookupError.message}`)
  let workspace = existing as { id: string; slug: string } | null
  if (!workspace) {
    const { data, error } = await admin
      .from("workspaces")
      .insert({
        name,
        slug,
        settings: normalizeWorkspaceSettings({
          invite_code: inviteCode(),
          kb_public: true,
          ...(site ? { landing_page_url: site } : {}),
        }),
      })
      .select("id, slug")
      .single()
    if (error || !data) throw new Error(`workspace create: ${error?.message}`)
    workspace = data as { id: string; slug: string }
    console.log(`Created workspace ${workspace.slug} (${workspace.id})`)
  } else {
    console.log(`Workspace ${workspace.slug} already exists (${workspace.id})`)
  }

  const { error: memberError } = await admin
    .from("workspace_members")
    .upsert(
      { workspace_id: workspace.id, user_id: userId, role: "owner", status: "active" },
      { onConflict: "workspace_id,user_id" },
    )
  if (memberError) throw new Error(`owner membership: ${memberError.message}`)

  const { data: subscription, error: subLookupError } = await admin
    .from("subscriptions")
    .select("id, stripe_subscription_id")
    .eq("workspace_id", workspace.id)
    .maybeSingle()
  if (subLookupError) throw new Error(`subscription lookup: ${subLookupError.message}`)
  if (subscription?.stripe_subscription_id) {
    console.log("Subscription is managed by Stripe; leaving it unchanged.")
  } else {
    const row = { workspace_id: workspace.id, plan_id: plan, tier, status: "active" }
    const { error } = subscription
      ? await admin.from("subscriptions").update(row).eq("id", subscription.id)
      : await admin.from("subscriptions").insert(row)
    if (error) throw new Error(`subscription: ${error.message}`)
    console.log(`Plan: ${plan} (manual, no Stripe subscription)`)
  }
  console.log(`Owner: ${ownerEmail}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
