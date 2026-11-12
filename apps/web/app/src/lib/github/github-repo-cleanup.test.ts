import { describe, expect, it, vi } from "vitest";

import { deactivateGitHubRepositoryIndex } from "./github-repo-cleanup";

function updateChain(result: { error: { message: string } | null }) {
  const terminalIs = vi.fn().mockResolvedValue(result);
  const contains = vi.fn().mockReturnValue({ is: terminalIs });
  const eq2 = vi.fn().mockReturnValue({ contains });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const update = vi.fn().mockReturnValue({ eq: eq1 });
  return { update, eq1, eq2, contains, terminalIs };
}

describe("deactivateGitHubRepositoryIndex", () => {
  it("marks file state removed and soft-deletes only matching generated documents", async () => {
    const filesIs = vi.fn().mockResolvedValue({ error: null });
    const filesEq2 = vi.fn().mockReturnValue({ is: filesIs });
    const filesEq1 = vi.fn().mockReturnValue({ eq: filesEq2 });
    const filesUpdate = vi.fn().mockReturnValue({ eq: filesEq1 });
    const documents = updateChain({ error: null });
    const from = vi.fn((table: string) =>
      table === "github_repo_files"
        ? { update: filesUpdate }
        : { update: documents.update },
    );

    await deactivateGitHubRepositoryIndex(
      { from } as never,
      "workspace-1",
      123,
    );

    expect(filesEq1).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(filesEq2).toHaveBeenCalledWith("repo_id", 123);
    expect(filesIs).toHaveBeenCalledWith("removed_at", null);
    expect(documents.eq1).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(documents.eq2).toHaveBeenCalledWith("source", "GitHub");
    expect(documents.contains).toHaveBeenCalledWith("source_metadata", {
      kind: "repository_file",
      repo_id: 123,
    });
    expect(documents.terminalIs).toHaveBeenCalledWith("deleted_at", null);
  });

  it("does not touch documents when file-state deactivation fails", async () => {
    const filesIs = vi
      .fn()
      .mockResolvedValue({ error: { message: "database unavailable" } });
    const filesUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ is: filesIs }),
      }),
    });
    const documentUpdate = vi.fn();
    const from = vi.fn((table: string) =>
      table === "github_repo_files"
        ? { update: filesUpdate }
        : { update: documentUpdate },
    );

    await expect(
      deactivateGitHubRepositoryIndex(
        { from } as never,
        "workspace-1",
        123,
      ),
    ).rejects.toThrow("deactivate repository file state");
    expect(documentUpdate).not.toHaveBeenCalled();
  });
});
