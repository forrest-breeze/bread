// Turns server-rendered `<div data-code-group>` wrappers (see
// portal/api-reference-html.ts) into one code block with a language dropdown.
// The picked language is remembered for the reader and applied to every group
// on the page, so choosing "Python" once carries across endpoints. Without JS,
// every variant stays visible with its own language tag.

const STORAGE_KEY = "portal-code-language"
const CHANGE_EVENT = "portal-code-language-change"

function readPreferred(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writePreferred(language: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, language)
  } catch {
    // Preference is a convenience; the in-page switch still works.
  }
}

let nextGroupId = 0

export function enhanceCodeGroups(root: HTMLElement): () => void {
  const cleanups: Array<() => void> = []

  root.querySelectorAll<HTMLElement>("[data-code-group]").forEach((group) => {
    if (group.dataset.codeGroupWired === "true") return
    const blocks = Array.from(group.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.matches("pre[data-language]"),
    )
    if (blocks.length < 2) return
    group.dataset.codeGroupWired = "true"

    const id = `code-group-${++nextGroupId}`
    const bar = document.createElement("div")
    bar.className = "portal-code-group-bar"
    const label = document.createElement("label")
    label.className = "sr-only"
    label.htmlFor = id
    label.textContent = "Language"
    const select = document.createElement("select")
    select.id = id
    select.className = "portal-code-group-select"
    blocks.forEach((block, index) => {
      const option = document.createElement("option")
      option.value = String(index)
      option.textContent = block.dataset.language ?? `Example ${index + 1}`
      select.append(option)
    })
    bar.append(label, select)
    group.prepend(bar)

    const show = (language: string | null): void => {
      const index = Math.max(0, blocks.findIndex((block) => block.dataset.language === language))
      select.value = String(index)
      blocks.forEach((block, i) => {
        block.hidden = i !== index
      })
    }

    const onChange = (): void => {
      const language = blocks[Number(select.value)]?.dataset.language
      if (!language) return
      writePreferred(language)
      // Keep sibling groups (request + webhook samples, other endpoints) in step.
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: language }))
    }
    const onSync = (event: Event): void => {
      const language = (event as CustomEvent<string>).detail
      if (blocks.some((block) => block.dataset.language === language)) show(language)
    }

    select.addEventListener("change", onChange)
    window.addEventListener(CHANGE_EVENT, onSync)
    group.classList.add("portal-code-group")
    show(readPreferred())

    cleanups.push(() => {
      select.removeEventListener("change", onChange)
      window.removeEventListener(CHANGE_EVENT, onSync)
      bar.remove()
      group.classList.remove("portal-code-group")
      blocks.forEach((block) => {
        block.hidden = false
      })
      delete group.dataset.codeGroupWired
    })
  })

  return () => cleanups.forEach((cleanup) => cleanup())
}
