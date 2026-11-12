import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"

// Inline change highlighting for the proposal editor. The live document is
// word-diffed against `baseline` (the original document): words present only in
// the live doc are tinted green (added), words present only in the baseline are
// rendered as struck-through red widgets at the spot they were removed. So a
// librarian proposal's edits — and any further hand edits — read like tracked
// changes while the document stays fully editable. Recomputes on every change.

export interface DiffHighlightOptions {
  /** The original document content (HTML or plain text) to diff against. */
  baseline: string
}

// Ceiling on the per-region LCS matrix (after the common prefix/suffix is
// trimmed). A changed region larger than this falls back to a coarse "whole
// region replaced" diff instead of the word-level one — still highlighted, just
// less granular — so cost stays bounded without ever blanking the result.
const MAX_DIFF_CELLS = 4_000_000

// Styles are inlined on the decorations (not only a CSS class) so highlighting
// is guaranteed visible regardless of stylesheet load order or purging.
const ADDED_STYLE =
  "background-color:rgba(16,185,129,0.28);border-radius:2px;box-shadow:0 -1px 0 rgba(16,185,129,0.55) inset;"
const DELETED_STYLE =
  "color:rgb(220,38,38);background-color:rgba(239,68,68,0.16);text-decoration:line-through;border-radius:2px;margin-right:0.15rem;white-space:pre-wrap;user-select:none;"

const diffHighlightKey = new PluginKey<DecorationSet>("diffHighlight")

type DiffOp = { type: "equal" | "add" | "del"; token: string }

// Split into word and whitespace runs so positions stay exact and only words
// get highlighted.
function tokenize(value: string): string[] {
  return value.match(/\s+|\S+/g) ?? []
}

// The original document as plain text, blocks joined by newlines so word tokens
// never merge across block boundaries. Deliberately regex-based (no DOMParser)
// so the baseline is computed identically on the server and the client — a
// divergence there would leave the first render with the wrong decorations.
function baselineToText(baseline: string): string {
  if (!baseline.trim()) return ""
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(baseline)
  const text = looksLikeHtml
    ? baseline
        .replace(/<\/(p|li|h[1-6]|blockquote|pre|div|tr)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
    : baseline
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

// Token diff emitted in document order. The common prefix and suffix are
// trimmed first — edits are usually localized, so the expensive LCS only runs
// on the changed middle, which keeps per-keystroke cost low.
function diffTokens(a: string[], b: string[]): DiffOp[] {
  const ops: DiffOp[] = []
  let lo = 0
  const minLen = Math.min(a.length, b.length)
  while (lo < minLen && a[lo] === b[lo]) {
    ops.push({ type: "equal", token: b[lo]! })
    lo += 1
  }
  let aHi = a.length
  let bHi = b.length
  while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) {
    aHi -= 1
    bHi -= 1
  }
  diffRange(a, b, lo, aHi, lo, bHi, ops)
  for (let j = bHi; j < b.length; j += 1) ops.push({ type: "equal", token: b[j]! })
  return ops
}

// LCS diff of a[aLo,aHi) vs b[bLo,bHi), appended to `ops`. If the region is too
// large for a word-level matrix, fall back to a coarse "whole region replaced"
// (delete all old, add all new) so large rewrites still highlight rather than
// silently showing nothing.
function diffRange(
  a: string[],
  b: string[],
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  ops: DiffOp[],
): void {
  const n = aHi - aLo
  const m = bHi - bLo
  if (n === 0 && m === 0) return
  if (n === 0) {
    for (let j = bLo; j < bHi; j += 1) ops.push({ type: "add", token: b[j]! })
    return
  }
  if (m === 0) {
    for (let i = aLo; i < aHi; i += 1) ops.push({ type: "del", token: a[i]! })
    return
  }
  if (n * m > MAX_DIFF_CELLS) {
    for (let i = aLo; i < aHi; i += 1) ops.push({ type: "del", token: a[i]! })
    for (let j = bLo; j < bHi; j += 1) ops.push({ type: "add", token: b[j]! })
    return
  }

  const lcs: Int32Array[] = Array.from(
    { length: n + 1 },
    () => new Int32Array(m + 1),
  )
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        a[aLo + i] === b[bLo + j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[aLo + i] === b[bLo + j]) {
      ops.push({ type: "equal", token: b[bLo + j]! })
      i += 1
      j += 1
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ type: "del", token: a[aLo + i]! })
      i += 1
    } else {
      ops.push({ type: "add", token: b[bLo + j]! })
      j += 1
    }
  }
  while (i < n) ops.push({ type: "del", token: a[aLo + i++]! })
  while (j < m) ops.push({ type: "add", token: b[bLo + j++]! })
}

// Flatten the live doc into text + a per-character map back to document
// positions, inserting newline separators at block boundaries.
function collectText(doc: ProseMirrorNode): { text: string; posMap: number[] } {
  const posMap: number[] = []
  let text = ""
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (text.length > 0 && !text.endsWith("\n")) {
        text += "\n"
        posMap.push(pos)
      }
      return true
    }
    if (node.isText && node.text) {
      for (let k = 0; k < node.text.length; k += 1) {
        text += node.text[k]
        posMap.push(pos + k)
      }
    }
    return true
  })
  return { text, posMap }
}

function buildDecorations(
  doc: ProseMirrorNode,
  baselineText: string,
): DecorationSet {
  const { text, posMap } = collectText(doc)
  const aTokens = tokenize(baselineText)
  const bTokens = tokenize(text)
  if (aTokens.length === 0 && bTokens.length === 0) return DecorationSet.empty

  const bOffsets: number[] = []
  let acc = 0
  for (const token of bTokens) {
    bOffsets.push(acc)
    acc += token.length
  }

  const docPosAt = (charOffset: number): number => {
    if (charOffset < posMap.length) return posMap[charOffset]!
    return posMap.length > 0 ? posMap[posMap.length - 1]! + 1 : 1
  }

  // Walk the op stream into added character ranges and contiguous deletion
  // runs. Whitespace tokens aren't decorated on their own, but they're folded
  // into neighbouring runs below so a changed phrase reads as one highlight.
  const addedRanges: Array<[number, number]> = []
  const deletions: Array<{ pos: number; text: string }> = []
  let bIndex = 0
  let delText = ""
  let delPos = -1
  const flushDeletion = (): void => {
    if (delText.trim().length > 0 && delPos >= 0) {
      deletions.push({ pos: delPos, text: delText })
    }
    delText = ""
    delPos = -1
  }

  for (const op of diffTokens(aTokens, bTokens)) {
    if (op.type === "del") {
      if (delPos < 0) {
        const at = bIndex < bOffsets.length ? bOffsets[bIndex]! : text.length
        delPos = docPosAt(at)
      }
      delText += op.token
      continue
    }
    flushDeletion()
    const start = bOffsets[bIndex]!
    const token = bTokens[bIndex]!
    bIndex += 1
    if (op.type === "add" && token.trim().length > 0) {
      addedRanges.push([start, start + token.length])
    }
  }
  flushDeletion()

  const decorations: Decoration[] = []

  // Merge added ranges separated only by whitespace into one highlight, pulling
  // the whitespace in so consecutive changed words read as a single phrase.
  let mergeStart = -1
  let mergeEnd = -1
  const flushAdded = (): void => {
    if (mergeStart < 0) return
    const from = docPosAt(mergeStart)
    const to = docPosAt(mergeEnd - 1) + 1
    if (to > from) {
      decorations.push(
        Decoration.inline(from, to, { class: "diff-added", style: ADDED_STYLE }),
      )
    }
    mergeStart = -1
    mergeEnd = -1
  }
  for (const [start, end] of addedRanges) {
    if (mergeStart < 0) {
      mergeStart = start
      mergeEnd = end
    } else if (text.slice(mergeEnd, start).trim().length === 0) {
      mergeEnd = end
    } else {
      flushAdded()
      mergeStart = start
      mergeEnd = end
    }
  }
  flushAdded()

  // One struck-through widget per contiguous removed run.
  let delKey = 0
  for (const { pos, text: removed } of deletions) {
    delKey += 1
    decorations.push(
      Decoration.widget(
        pos,
        () => {
          const span = document.createElement("span")
          span.className = "diff-deleted"
          span.setAttribute("style", DELETED_STYLE)
          span.textContent = removed
          return span
        },
        { side: -1, key: `del-${pos}-${delKey}`, ignoreSelection: true },
      ),
    )
  }

  return DecorationSet.create(doc, decorations)
}

export const DiffHighlight = Extension.create<DiffHighlightOptions>({
  name: "diffHighlight",

  addOptions() {
    return { baseline: "" }
  },

  addProseMirrorPlugins() {
    const baselineText = baselineToText(this.options.baseline)
    return [
      new Plugin<DecorationSet>({
        key: diffHighlightKey,
        state: {
          init: (_config, state) => buildDecorations(state.doc, baselineText),
          apply: (tr, value) =>
            tr.docChanged ? buildDecorations(tr.doc, baselineText) : value,
        },
        props: {
          decorations(state) {
            return diffHighlightKey.getState(state) ?? DecorationSet.empty
          },
        },
      }),
    ]
  },
})
