// ---------------------------------------------------------------------------
// Document client API — mutations for the KB document tree (no fetch in
// components — see CLAUDE.md §3). Reads go through the `useDocuments` SWR hook.
// ---------------------------------------------------------------------------

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string }
    return body.message ?? body.error ?? `Request failed (${res.status})`
  } catch {
    return `Request failed (${res.status})`
  }
}

/**
 * Persist an explicit order for documents (`sort_order` = array index). The
 * ids should be the full sibling list of one folder so indexes stay dense.
 * Admin/owner only.
 */
export async function reorderDocuments(
  orderedIds: string[],
): Promise<{ ordered_ids: string[] }> {
  const res = await fetch("/api/documents/reorder", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ordered_ids: orderedIds }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as { ordered_ids: string[] }
}
