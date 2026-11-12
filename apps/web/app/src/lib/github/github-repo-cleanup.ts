import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Deactivate the generated search corpus for a monitored repository.
 *
 * File state is marked removed before documents are soft-deleted. If the
 * second update or the caller's monitored-repo delete fails, the monitor row
 * remains and the next repository sweep sees `removed_at` and restores the
 * affected documents. Re-adding a disconnected repository is recoverable for
 * the same reason.
 */
export async function deactivateGitHubRepositoryIndex(
  admin: SupabaseClient,
  workspaceId: string,
  repoId: number,
): Promise<void> {
  const removedAt = new Date().toISOString();

  const { error: fileError } = await admin
    .from("github_repo_files")
    .update({ removed_at: removedAt, last_synced_at: removedAt })
    .eq("workspace_id", workspaceId)
    .eq("repo_id", repoId)
    .is("removed_at", null);
  if (fileError) {
    throw new Error(`deactivate repository file state: ${fileError.message}`);
  }

  const { error: documentError } = await admin
    .from("documents")
    .update({ deleted_at: removedAt, updated_at: removedAt })
    .eq("workspace_id", workspaceId)
    .eq("source", "GitHub")
    .contains("source_metadata", {
      kind: "repository_file",
      repo_id: repoId,
    })
    .is("deleted_at", null);
  if (documentError) {
    throw new Error(
      `deactivate repository documents: ${documentError.message}`,
    );
  }
}
