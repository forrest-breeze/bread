/** Recognize imported Mermaid fences, including sequence diagrams whose
 * language metadata was lost during an earlier import. */
export function mermaidCodeSource(pre: HTMLElement): string | null {
  const code = pre.querySelector("code")
  if (!code) return null
  const source = code.textContent ?? ""
  const language = code.className.match(/(?:^|\s)language-(\S+)/)?.[1]
    ?? pre.getAttribute("data-language")
  if (language === "mermaid") return source
  if (language && !["text", "plaintext", "txt"].includes(language)) return null
  return /^\s*(?:%%[^\n]*\n\s*)*sequenceDiagram\b/.test(source) ? source : null
}
