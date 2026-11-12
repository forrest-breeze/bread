#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const METRICS = ["statements", "branches", "functions", "lines"]
const TURBO_TASK = "test:coverage:repo"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, "..")
const rootCoverageDir = path.join(rootDir, "coverage")

const rootPackage = await readJson(path.join(rootDir, "package.json"))
const workspaces = await getWorkspacePackages(rootPackage.workspaces ?? [])
const coverageWorkspaces = workspaces.filter(({ pkg }) => pkg.scripts?.[TURBO_TASK])
const skippedWorkspaces = workspaces.filter(({ pkg }) => !pkg.scripts?.[TURBO_TASK])

if (coverageWorkspaces.length === 0) {
  console.error(`No workspaces define a ${TURBO_TASK} script.`)
  process.exit(1)
}

await cleanCoverageDirs(coverageWorkspaces)

console.log(`Running coverage for ${coverageWorkspaces.length} workspaces:`)
for (const workspace of coverageWorkspaces) {
  console.log(`- ${workspace.pkg.name} (${workspace.relativePath})`)
}
if (skippedWorkspaces.length > 0) {
  console.log("")
  console.log(`Skipping workspaces without repo coverage collection (${TURBO_TASK}):`)
  for (const workspace of skippedWorkspaces) {
    console.log(`- ${workspace.pkg.name} (${workspace.relativePath})`)
  }
}
console.log("")

const turboBin = path.join(
  rootDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "turbo.cmd" : "turbo",
)

if (!existsSync(turboBin)) {
  console.error("Could not find Turbo. Run `npm install` from the repo root first.")
  process.exit(1)
}

const result = spawnSync(turboBin, ["run", TURBO_TASK, "--output-logs=full"], {
  cwd: rootDir,
  stdio: "inherit",
  env: process.env,
})

if (result.error) {
  throw result.error
}

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const summaries = []
const missingSummaries = []

for (const workspace of coverageWorkspaces) {
  const summaryPath = path.join(workspace.dir, "coverage", "coverage-summary.json")
  if (!existsSync(summaryPath)) {
    missingSummaries.push(path.relative(rootDir, summaryPath))
    continue
  }

  const summary = await readJson(summaryPath)
  summaries.push({
    name: workspace.pkg.name,
    path: workspace.relativePath,
    files: Object.keys(summary).filter((key) => key !== "total").length,
    total: normalizeTotal(summary.total),
  })
}

if (missingSummaries.length > 0) {
  console.error("Missing coverage summary files:")
  for (const file of missingSummaries) {
    console.error(`- ${file}`)
  }
  process.exit(1)
}

const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run test:coverage",
  total: aggregateTotals(summaries.map((summary) => summary.total)),
  workspaces: summaries,
  skippedWorkspaces: skippedWorkspaces.map((workspace) => ({
    name: workspace.pkg.name,
    path: workspace.relativePath,
  })),
}

await mkdir(rootCoverageDir, { recursive: true })
await writeFile(
  path.join(rootCoverageDir, "repo-summary.json"),
  `${JSON.stringify(report, null, 2)}\n`,
)
await writeFile(path.join(rootCoverageDir, "repo-summary.md"), renderMarkdown(report))

console.log("")
console.log(renderConsoleTable(report))
console.log("")
console.log("Wrote aggregate coverage reports:")
console.log("- coverage/repo-summary.json")
console.log("- coverage/repo-summary.md")

async function cleanCoverageDirs(workspacesToClean) {
  await rm(rootCoverageDir, { recursive: true, force: true })
  await Promise.all(
    workspacesToClean.map((workspace) =>
      rm(path.join(workspace.dir, "coverage"), { recursive: true, force: true }),
    ),
  )
}

async function getWorkspacePackages(patterns) {
  const packageDirs = new Set()

  for (const pattern of patterns) {
    for (const dir of await expandWorkspacePattern(pattern)) {
      if (existsSync(path.join(dir, "package.json"))) {
        packageDirs.add(dir)
      }
    }
  }

  const packages = []
  for (const dir of packageDirs) {
    const pkg = await readJson(path.join(dir, "package.json"))
    packages.push({
      dir,
      relativePath: path.relative(rootDir, dir),
      pkg,
    })
  }

  return packages.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

async function expandWorkspacePattern(pattern) {
  if (!pattern.includes("*")) {
    return [path.join(rootDir, pattern)]
  }

  const firstStar = pattern.indexOf("*")
  const secondStar = pattern.indexOf("*", firstStar + 1)
  if (secondStar !== -1) {
    throw new Error(`Unsupported workspace pattern with multiple wildcards: ${pattern}`)
  }

  const beforeStar = pattern.slice(0, firstStar)
  const afterStar = pattern.slice(firstStar + 1)
  const baseDir = path.join(rootDir, beforeStar)

  if (!existsSync(baseDir)) {
    return []
  }

  const entries = await readdir(baseDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, `${entry.name}${afterStar}`))
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

function normalizeTotal(total) {
  return Object.fromEntries(
    METRICS.map((metric) => [metric, normalizeMetric(total?.[metric])]),
  )
}

function normalizeMetric(metric) {
  const total = Number(metric?.total ?? 0)
  const covered = Number(metric?.covered ?? 0)
  const skipped = Number(metric?.skipped ?? 0)
  return {
    total,
    covered,
    skipped,
    pct: percentage(covered, total),
  }
}

function aggregateTotals(totals) {
  const aggregate = {}
  for (const metric of METRICS) {
    const total = totals.reduce((sum, item) => sum + item[metric].total, 0)
    const covered = totals.reduce((sum, item) => sum + item[metric].covered, 0)
    const skipped = totals.reduce((sum, item) => sum + item[metric].skipped, 0)
    aggregate[metric] = {
      total,
      covered,
      skipped,
      pct: percentage(covered, total),
    }
  }
  return aggregate
}

function percentage(covered, total) {
  if (total === 0) {
    return 100
  }
  return Math.round((covered / total) * 10000) / 100
}

function renderMarkdown(report) {
  const lines = [
    "# Repo Coverage Summary",
    "",
    `Generated by \`${report.command}\` at ${report.generatedAt}.`,
    "",
    "| Workspace | Path | Files | Statements | Branches | Functions | Lines |",
    "| :--- | :--- | ---: | ---: | ---: | ---: | ---: |",
  ]

  for (const workspace of report.workspaces) {
    lines.push(
      `| ${workspace.name} | \`${workspace.path}\` | ${workspace.files} | ${formatMetric(
        workspace.total.statements,
      )} | ${formatMetric(workspace.total.branches)} | ${formatMetric(
        workspace.total.functions,
      )} | ${formatMetric(workspace.total.lines)} |`,
    )
  }

  lines.push(
    `| **Total** |  | ${sumFiles(report.workspaces)} | **${formatMetric(
      report.total.statements,
    )}** | **${formatMetric(report.total.branches)}** | **${formatMetric(
      report.total.functions,
    )}** | **${formatMetric(report.total.lines)}** |`,
  )

  if (report.skippedWorkspaces.length > 0) {
    lines.push("")
    lines.push("## Skipped Workspaces")
    lines.push("")
    lines.push(`These workspaces do not define repo coverage collection (\`${TURBO_TASK}\`):`)
    lines.push("")
    for (const workspace of report.skippedWorkspaces) {
      lines.push(`- ${workspace.name} (\`${workspace.path}\`)`)
    }
  }

  lines.push("")
  return `${lines.join("\n")}\n`
}

function renderConsoleTable(report) {
  const rows = [
    ["Workspace", "Files", "Statements", "Branches", "Functions", "Lines"],
    ...report.workspaces.map((workspace) => [
      workspace.name,
      String(workspace.files),
      formatMetric(workspace.total.statements),
      formatMetric(workspace.total.branches),
      formatMetric(workspace.total.functions),
      formatMetric(workspace.total.lines),
    ]),
    [
      "TOTAL",
      String(sumFiles(report.workspaces)),
      formatMetric(report.total.statements),
      formatMetric(report.total.branches),
      formatMetric(report.total.functions),
      formatMetric(report.total.lines),
    ],
  ]

  const widths = rows[0].map((_, index) =>
    Math.max(...rows.map((row) => row[index].length)),
  )

  return rows
    .map((row, rowIndex) => {
      const line = row
        .map((cell, index) => cell.padEnd(widths[index]))
        .join("  ")
      if (rowIndex === 0) {
        return `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}`
      }
      return line
    })
    .join("\n")
}

function formatMetric(metric) {
  return `${metric.pct.toFixed(2)}% (${metric.covered}/${metric.total})`
}

function sumFiles(workspacesToSum) {
  return workspacesToSum.reduce((sum, workspace) => sum + workspace.files, 0)
}
