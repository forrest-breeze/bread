let nextGroupId = 0

/** Enhance sanitized sections; without JavaScript every panel remains readable. */
export function enhanceDocumentTabs(root: HTMLElement): () => void {
  const cleanups: Array<() => void> = []
  root.querySelectorAll<HTMLElement>("[data-document-tabs]").forEach((group) => {
    const panels = Array.from(group.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute("data-document-tab"))
    if (!panels.length) return
    const id = `document-tabs-${++nextGroupId}`
    const list = document.createElement("div")
    list.setAttribute("role", "tablist")
    list.setAttribute("aria-label", "Document sections")
    const labels = panels.map((panel) => panel.querySelector<HTMLElement>(":scope > [data-tab-label]"))
    const buttons = panels.map((panel, index) => {
      const button = document.createElement("button")
      button.type = "button"
      button.id = `${id}-tab-${index}`
      button.textContent = panel.getAttribute("data-document-tab") || `Section ${index + 1}`
      button.setAttribute("role", "tab")
      button.setAttribute("aria-controls", `${id}-panel-${index}`)
      panel.id = `${id}-panel-${index}`
      panel.setAttribute("role", "tabpanel")
      panel.setAttribute("aria-labelledby", button.id)
      panel.tabIndex = 0
      if (labels[index]) labels[index]!.hidden = true
      list.append(button)
      return button
    })
    const select = (index: number, focus = false) => {
      buttons.forEach((button, i) => {
        button.setAttribute("aria-selected", String(i === index))
        button.tabIndex = i === index ? 0 : -1
        panels[i].hidden = i !== index
      })
      if (focus) buttons[index].focus()
    }
    buttons.forEach((button, index) => {
      button.onclick = () => select(index)
      button.onkeydown = (event) => {
        const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowRight" ? (index + 1) % buttons.length : event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length : null
        if (target === null) return
        event.preventDefault()
        select(target, true)
      }
    })
    group.prepend(list)
    select(0)
    cleanups.push(() => {
      list.remove()
      panels.forEach((panel, i) => {
        panel.hidden = false
        for (const attribute of ["id", "role", "aria-labelledby", "tabindex"]) panel.removeAttribute(attribute)
        if (labels[i]) labels[i]!.hidden = false
      })
    })
  })
  return () => cleanups.forEach((cleanup) => cleanup())
}
