import { diffArrays } from "diff"

interface LineEdit {
  /** Inclusive line offset in the base document. */
  start: number
  /** Exclusive line offset in the base document. */
  end: number
  replacement: string[]
}

export interface ThreeWayMergeConflict {
  baseStartLine: number
  baseEndLine: number
  local: string
  remote: string
}

export type ThreeWayMergeResult =
  | { ok: true; content: string; autoMerged: boolean }
  | { ok: false; conflicts: ThreeWayMergeConflict[] }

function splitLines(value: string): string[] {
  if (!value) return []
  const matches = value.match(/[^\n]*\n|[^\n]+$/g)
  return matches ?? []
}

function changesToEdits(base: string[], next: string[]): LineEdit[] {
  const changes = diffArrays(base, next)
  const edits: LineEdit[] = []
  let baseOffset = 0
  let pending: LineEdit | null = null

  const flush = (): void => {
    if (!pending) return
    edits.push(pending)
    pending = null
  }

  for (const change of changes) {
    const lines = change.value as string[]
    if (!change.added && !change.removed) {
      flush()
      baseOffset += lines.length
      continue
    }

    if (!pending) {
      pending = {
        start: baseOffset,
        end: baseOffset,
        replacement: [],
      }
    }

    if (change.removed) {
      pending.end += lines.length
      baseOffset += lines.length
    } else {
      pending.replacement.push(...lines)
    }
  }
  flush()
  return edits
}

function editsOverlap(left: LineEdit, right: LineEdit): boolean {
  // Insertions overlap another insertion at the same point and overlap a
  // replacement when they land inside it. An insertion exactly at a
  // replacement boundary remains independent.
  if (left.start === left.end && right.start === right.end) {
    return left.start === right.start
  }
  if (left.start === left.end) {
    return left.start > right.start && left.start < right.end
  }
  if (right.start === right.end) {
    return right.start > left.start && right.start < left.end
  }
  return left.start < right.end && right.start < left.end
}

function editsEqual(left: LineEdit, right: LineEdit): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.replacement.join("") === right.replacement.join("")
  )
}

/**
 * Merge independent line edits made from the same immutable base. The
 * algorithm intentionally returns structured conflicts instead of inserting
 * conflict markers into user-facing documentation.
 */
export function mergeTextThreeWay(
  baseContent: string,
  localContent: string,
  remoteContent: string,
): ThreeWayMergeResult {
  if (localContent === remoteContent) {
    return { ok: true, content: localContent, autoMerged: false }
  }
  if (localContent === baseContent) {
    return { ok: true, content: remoteContent, autoMerged: false }
  }
  if (remoteContent === baseContent) {
    return { ok: true, content: localContent, autoMerged: false }
  }

  const base = splitLines(baseContent)
  const localEdits = changesToEdits(base, splitLines(localContent))
  const remoteEdits = changesToEdits(base, splitLines(remoteContent))
  const conflicts: ThreeWayMergeConflict[] = []

  for (const local of localEdits) {
    for (const remote of remoteEdits) {
      if (!editsOverlap(local, remote) || editsEqual(local, remote)) continue
      conflicts.push({
        baseStartLine: local.start + 1,
        baseEndLine: Math.max(local.end, remote.end, local.start + 1),
        local: local.replacement.join(""),
        remote: remote.replacement.join(""),
      })
    }
  }

  if (conflicts.length > 0) return { ok: false, conflicts }

  const mergedEdits: LineEdit[] = []
  for (const edit of [...localEdits, ...remoteEdits]) {
    if (!mergedEdits.some((candidate) => editsEqual(candidate, edit))) {
      mergedEdits.push(edit)
    }
  }
  mergedEdits.sort((left, right) => {
    if (left.start !== right.start) return right.start - left.start
    return right.end - left.end
  })

  const merged = base.slice()
  for (const edit of mergedEdits) {
    merged.splice(edit.start, edit.end - edit.start, ...edit.replacement)
  }

  return { ok: true, content: merged.join(""), autoMerged: true }
}
