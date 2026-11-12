"use client"

import { useEffect, type RefObject } from "react"

// Tiny client island: enriches server-rendered (Shiki) code blocks with a copy
// button. The prose HTML is server-sanitized and injected via
// dangerouslySetInnerHTML, so there is no React subtree for the <pre> elements —
// this effect walks the container after mount and wires a button per block. It
// renders nothing itself; pass the prose container ref.
//
// Buttons are created imperatively (not stored HTML) so they never pass through
// the sanitizer and carry no untrusted markup. The click handler only reads the
// block's own textContent and writes it to the clipboard.

function copyLabel(button: HTMLButtonElement, text: string): void {
  const previous = button.textContent
  button.textContent = text
  window.setTimeout(() => {
    button.textContent = previous
  }, 1500)
}

export function CodeCopyButtons({
  containerRef,
  htmlKey,
}: {
  containerRef: RefObject<HTMLElement | null>
  /** Re-wire buttons whenever the injected prose HTML changes. */
  htmlKey?: string
}): null {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const cleanups: Array<() => void> = []

    for (const pre of Array.from(container.querySelectorAll<HTMLElement>("pre"))) {
      if (pre.dataset.copyWired === "true") continue
      pre.dataset.copyWired = "true"
      pre.classList.add("portal-code-block")

      const button = document.createElement("button")
      button.type = "button"
      button.textContent = "Copy"
      button.setAttribute("aria-label", "Copy code")
      button.className = "portal-code-copy"

      const onClick = (): void => {
        const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? ""
        navigator.clipboard
          .writeText(code)
          .then(() => copyLabel(button, "Copied"))
          .catch(() => copyLabel(button, "Failed"))
      }

      button.addEventListener("click", onClick)
      pre.appendChild(button)
      cleanups.push(() => {
        button.removeEventListener("click", onClick)
        button.remove()
        delete pre.dataset.copyWired
      })
    }

    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [containerRef, htmlKey])

  return null
}
