// Client-safe GitHub types (no node:crypto imports), so both the server-only
// `github.ts` API layer and client code (SWR hooks, settings UI) can share one
// definition without dragging the App-auth crypto module into the browser bundle.

/**
 * A repository the workspace's GitHub App installation can access, as returned
 * by `GET /api/github/repos/available`. The dropdown on the GitHub settings
 * page is built from these so admins pick a repo instead of typing "owner/repo".
 */
export interface GitHubAvailableRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
}

export interface GitHubHostedDocsTree {
  repoId: number;
  repoFullName: string;
  ref: string;
  commitSha: string;
  truncated: boolean;
  /** Repository-relative directory paths, sorted parent-first. */
  folders: string[];
}
