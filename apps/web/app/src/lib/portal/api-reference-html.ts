import "server-only"

import { JSDOM } from "jsdom"
import { highlightCodeHtml, renderPublicHtml } from "@/lib/public-kb-render"
import { generateRequestSamples } from "@/lib/portal/request-samples"

const EXAMPLE_HEADING = /^(?:(?:request|response|code) examples?|example (?:request|response)s?)$/i
// A heading that only names the shell ("### Shell") is redundant once the
// block carries a language picker.
const SHELL_HEADING = /^(?:shell|curl|bash)$/i

/**
 * Put language variants of one request behind a single picker:
 * - a cURL block gains generated Node / Ruby / PHP / Python equivalents;
 * - authored runs of adjacent blocks in different languages are grouped as-is.
 * Groups are plain `<div data-code-group>` wrappers; the client enhancer
 * (enhance-code-groups.ts) adds the dropdown, and without JS every variant
 * stays visible with its own language tag.
 */
function groupCodeSamples(container: DocumentFragment): void {
  const document = container.ownerDocument

  for (const pre of Array.from(container.children).filter((child) => child.matches("pre[data-language]"))) {
    // Already absorbed into an earlier group.
    if (pre.parentNode !== container) continue

    // Collect an authored run of adjacent, distinctly tagged code blocks.
    const run: Element[] = [pre]
    const seen = new Set([pre.getAttribute("data-language")])
    for (let next = pre.nextElementSibling; next?.matches("pre[data-language]"); next = next.nextElementSibling) {
      const language = next.getAttribute("data-language")
      if (seen.has(language)) break
      seen.add(language)
      run.push(next)
    }

    if (run.length === 1) {
      if (pre.getAttribute("data-language") !== "cURL") continue
      const samples = generateRequestSamples(pre.textContent ?? "")
      if (!samples.length) continue
      for (const sample of samples) {
        const generated = JSDOM.fragment(highlightCodeHtml(sample.source, sample.lang)).querySelector("pre")
        if (!generated) continue
        generated.setAttribute("data-language", sample.label)
        const imported = document.importNode(generated, true)
        run.at(-1)!.after(imported)
        run.push(imported)
      }
      // The nearest heading above, skipping intro paragraphs ("### Shell" →
      // "Replace path placeholders…" → block).
      let heading = pre.previousElementSibling
      while (heading?.tagName === "P") heading = heading.previousElementSibling
      if (heading?.tagName === "H3" && SHELL_HEADING.test(heading.textContent?.trim() ?? "")) heading.remove()
    }

    const group = document.createElement("div")
    group.setAttribute("data-code-group", "")
    run[0]!.before(group)
    group.append(...run)
  }
}

/**
 * Add request-sample language pickers to already rendered (sanitized) HTML.
 * Used for API endpoint documents shown through the ordinary doc view.
 */
export function withCodeSampleGroups(html: string): string {
  const fragment = JSDOM.fragment(html)
  groupCodeSamples(fragment)
  const serializer = fragment.ownerDocument.createElement("div")
  serializer.append(fragment)
  return serializer.innerHTML
}

/** Organize ordinary Markdown (or editor HTML) using explicit h2 example sections. */
export function renderApiReferenceHtml(content: string): {
  html: string
  examplesHtml: string
} {
  const fragment = JSDOM.fragment(renderPublicHtml(content))
  groupCodeSamples(fragment)
  const serializer = fragment.ownerDocument.createElement("div")
  serializer.append(fragment.cloneNode(true))
  const html = serializer.innerHTML
  const body = fragment.ownerDocument.createElement("div")
  const examples = fragment.ownerDocument.createElement("div")
  let inExample = false

  for (const node of Array.from(fragment.childNodes)) {
    if (node.nodeType === 1) {
      const element = node as Element
      if (element.tagName === "H1" || element.tagName === "H2") {
        inExample = element.tagName === "H2" && EXAMPLE_HEADING.test(element.textContent?.trim() ?? "")
      }
    }
    ;(inExample ? examples : body).appendChild(node)
  }

  // Preserve the original reading layout for guides made entirely of examples.
  if (!body.textContent?.trim() || !examples.textContent?.trim()) {
    return { html, examplesHtml: "" }
  }
  return { html: body.innerHTML, examplesHtml: examples.innerHTML }
}
