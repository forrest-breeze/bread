export type DiffLineType = "context" | "added" | "removed" | "skipped"

export interface DiffLine {
  type: DiffLineType
  value: string
}

interface BuildDiffOptions {
  contextLines?: number
  maxMatrixSize?: number
  maxVisibleLines?: number
}

function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n")
}

function buildChangedBlock(oldLines: string[], newLines: string[]): DiffLine[] {
  return [
    ...oldLines.map((value) => ({ type: "removed", value }) as DiffLine),
    ...newLines.map((value) => ({ type: "added", value }) as DiffLine),
  ]
}

function buildRawDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const oldCount = oldLines.length
  const newCount = newLines.length
  const matrix = Array.from({ length: oldCount + 1 }, () =>
    Array<number>(newCount + 1).fill(0),
  )

  for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newCount - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex]![newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? (matrix[oldIndex + 1]![newIndex + 1] ?? 0) + 1
          : Math.max(
              matrix[oldIndex + 1]![newIndex] ?? 0,
              matrix[oldIndex]![newIndex + 1] ?? 0,
            )
    }
  }

  const diff: DiffLine[] = []
  let oldIndex = 0
  let newIndex = 0

  while (oldIndex < oldCount && newIndex < newCount) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      diff.push({ type: "context", value: oldLines[oldIndex]! })
      oldIndex += 1
      newIndex += 1
      continue
    }

    if ((matrix[oldIndex + 1]![newIndex] ?? 0) >= (matrix[oldIndex]![newIndex + 1] ?? 0)) {
      diff.push({ type: "removed", value: oldLines[oldIndex]! })
      oldIndex += 1
    } else {
      diff.push({ type: "added", value: newLines[newIndex]! })
      newIndex += 1
    }
  }

  while (oldIndex < oldCount) {
    diff.push({ type: "removed", value: oldLines[oldIndex]! })
    oldIndex += 1
  }

  while (newIndex < newCount) {
    diff.push({ type: "added", value: newLines[newIndex]! })
    newIndex += 1
  }

  return diff
}

function collapseContext(
  lines: DiffLine[],
  contextLines: number,
  maxVisibleLines: number,
): DiffLine[] {
  const changedIndexes = lines
    .map((line, index) => (line.type === "context" ? -1 : index))
    .filter((index) => index >= 0)

  if (changedIndexes.length === 0) {
    return []
  }

  const keep = new Set<number>()
  for (const changedIndex of changedIndexes) {
    const start = Math.max(0, changedIndex - contextLines)
    const end = Math.min(lines.length - 1, changedIndex + contextLines)
    for (let index = start; index <= end; index += 1) {
      keep.add(index)
    }
  }

  const collapsed: DiffLine[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (keep.has(index)) {
      collapsed.push(lines[index]!)
      continue
    }

    if (collapsed.at(-1)?.type !== "skipped") {
      collapsed.push({ type: "skipped", value: "" })
    }
  }

  if (collapsed.length <= maxVisibleLines) {
    return collapsed
  }

  return [
    ...collapsed.slice(0, maxVisibleLines - 1),
    { type: "skipped", value: "" },
  ]
}

export function buildTextDiff(
  previousText: string,
  nextText: string,
  options: BuildDiffOptions = {},
): DiffLine[] {
  const contextLines = options.contextLines ?? 2
  const maxMatrixSize = options.maxMatrixSize ?? 40_000
  const maxVisibleLines = options.maxVisibleLines ?? 240

  if (previousText === nextText) {
    return []
  }

  const previousLines = normalizeLines(previousText)
  const nextLines = normalizeLines(nextText)
  const matrixSize = previousLines.length * nextLines.length

  const rawDiff =
    matrixSize > maxMatrixSize
      ? buildChangedBlock(previousLines, nextLines)
      : buildRawDiff(previousLines, nextLines)

  return collapseContext(rawDiff, contextLines, maxVisibleLines)
}

export interface DiffStatCounts {
  added: number
  removed: number
}

/**
 * Line counts for a diff, the way git summarises a commit.
 *
 * Counted from the RAW diff rather than the rendered one: `buildTextDiff`
 * collapses long runs of context and truncates past `maxVisibleLines`, so
 * counting its output would under-report a big edit — the exact case where an
 * accurate count matters most.
 */
export function buildDiffStat(
  previousText: string,
  nextText: string,
  options: Pick<BuildDiffOptions, "maxMatrixSize"> = {},
): DiffStatCounts {
  if (previousText === nextText) return { added: 0, removed: 0 }

  // Splitting "" yields a single empty line, which would report a phantom
  // removal when content is created from nothing (or a phantom addition when
  // it is emptied). Git counts those as pure additions/deletions.
  if (previousText === "") {
    return { added: normalizeLines(nextText).length, removed: 0 }
  }
  if (nextText === "") {
    return { added: 0, removed: normalizeLines(previousText).length }
  }

  const previousLines = normalizeLines(previousText)
  const nextLines = normalizeLines(nextText)
  const maxMatrixSize = options.maxMatrixSize ?? 40_000

  const rawDiff =
    previousLines.length * nextLines.length > maxMatrixSize
      ? buildChangedBlock(previousLines, nextLines)
      : buildRawDiff(previousLines, nextLines)

  let added = 0
  let removed = 0
  for (const line of rawDiff) {
    if (line.type === "added") added += 1
    else if (line.type === "removed") removed += 1
  }
  return { added, removed }
}
