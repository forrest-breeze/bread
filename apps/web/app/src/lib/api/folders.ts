// ---------------------------------------------------------------------------
// Folder client API — mutations for the KB folder tree (no fetch in
// components — see CLAUDE.md §3). Reads go through the `useFolders` SWR hook.
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
 * Persist an explicit order for folders of one kind (`sort_order` = array
 * index). "user" reorders the public portal sidebar's section headers;
 * "topic" reorders internal KB topics. Admin/owner only.
 */
export async function reorderFolders(
  kind: "topic" | "user",
  orderedIds: string[],
): Promise<{ ordered_ids: string[] }> {
  const res = await fetch("/api/folders/reorder", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, ordered_ids: orderedIds }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as { ordered_ids: string[] }
}
