#!/usr/bin/env node
// Phase 5 enforcement guard for the input-validation rollout.
//
// Walks apps/web/app/src/app/api/**/route.ts and fails when an input-reading
// expression isn't paired with the matching safe-wrapper from @/lib/validation
// (or, for routes that handle their own validation, an explicit Zod safeParse
// call). This stops new routes from regressing on CLAUDE.md §1.
//
// The guard checks four input vectors and their required pairings:
//   request.json() / req.json()             →  safeJsonBody(   or  schema.safeParse(  or  schema.parse(
//   request.formData() / req.formData()     →  safeFormData(   or  schema.safeParse(  or  schema.parse(
//   searchParams.get / searchParams.getAll  →  safeSearchParams(  or  schema.safeParse(  or  schema.parse(
//   await params (dynamic [id] segments)    →  safeRouteParams(   or  schema.safeParse(  or  schema.parse(
//
// Run from apps/web/app/. Exits non-zero on any violation.

import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

const ROUTE_ROOT = "src/app/api"
const REPO_ROOT = process.cwd()

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile() && entry.name === "route.ts") {
      yield full
    }
  }
}

// Pairs: input-vector regex → required-wrapper regex(es). A route is flagged
// when an input vector matches but none of its paired wrappers do.
const RULES = [
  {
    label: "request.json()",
    input: /\b(?:req|request)\.json\(\)/,
    wrappers: [/\bsafeJsonBody\(/, /\bsafeParse\(/, /\.parse\(/],
  },
  {
    label: "request.formData()",
    input: /\b(?:req|request)\.formData\(\)/,
    wrappers: [/\bsafeFormData\(/, /\bsafeParse\(/, /\.parse\(/],
  },
  {
    label: "searchParams.get()",
    input: /\bsearchParams\.(?:get|getAll)\(/,
    wrappers: [/\bsafeSearchParams\(/, /\bsafeParse\(/, /\.parse\(/],
  },
  {
    label: "await params",
    input: /\bawait\s+(?:context\.)?params\b/,
    wrappers: [/\bsafeRouteParams\(/, /\bsafeParse\(/, /\.parse\(/, /UUID_RE\.test\(/],
  },
]

const violations = []

for (const fullPath of walk(join(REPO_ROOT, ROUTE_ROOT))) {
  const src = readFileSync(fullPath, "utf-8")
  const file = relative(REPO_ROOT, fullPath)

  for (const rule of RULES) {
    if (!rule.input.test(src)) continue
    const paired = rule.wrappers.some((w) => w.test(src))
    if (!paired) {
      violations.push(`${file}  (reads ${rule.label} without a Zod-backed wrapper)`)
    }
  }
}

if (violations.length > 0) {
  console.error(
    "\n[check-route-validation] These routes read user input without pairing it with a Zod-backed wrapper:\n",
  )
  for (const v of violations) {
    console.error(`  - ${v}`)
  }
  console.error(
    "\nUse safeJsonBody / safeFormData / safeSearchParams / safeRouteParams from @/lib/validation,",
  )
  console.error(
    "or call schema.safeParse() / schema.parse() inline against the input.",
  )
  console.error("See apps/web/app/src/lib/validation/ for the helpers.\n")
  process.exit(1)
}

console.log(
  `[check-route-validation] ✓ every input-reading expression is paired with a Zod-backed wrapper`,
)
