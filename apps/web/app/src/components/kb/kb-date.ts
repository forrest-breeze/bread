export function formatKbEditedDate(value: string | null | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""

  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })
}

export function formatKbEditedLabel(value: string | null | undefined): string {
  const formatted = formatKbEditedDate(value)
  return formatted ? `Edited ${formatted}` : ""
}
