// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const harness = vi.hoisted(() => ({
  pathname: "/knowledge/doc-1",
  checkingGitHub: false,
  loading: false,
}))

vi.mock("next/navigation", () => ({
  usePathname: () => harness.pathname,
}))

vi.mock("@/components/app/workspace-changes-context", () => ({
  useWorkspaceChanges: () => ({
    changedFileCount: 2,
    checkingGitHub: harness.checkingGitHub,
    data: harness.loading ? undefined : { files: [] },
    loading: harness.loading,
  }),
}))

vi.mock("@/components/app/documents-sub-nav", () => ({
  DocumentsSubNav: () => <div>Document tree</div>,
}))

vi.mock("@/components/app/workspace-changes-commit-panel", () => ({
  WorkspaceChangesCommitPanel: () => <div>Commit controls</div>,
}))

vi.mock("@/components/app/workspace-changes-file-list", () => ({
  WorkspaceChangesFileList: () => <div>Changed files</div>,
}))

import { KnowledgeSubNav } from "./knowledge-sub-nav"

beforeEach(() => {
  harness.pathname = "/knowledge/doc-1"
  harness.checkingGitHub = false
  harness.loading = false
})

afterEach(cleanup)

describe("KnowledgeSubNav", () => {
  it("switches between document navigation and the full changes route", () => {
    const view = render(<KnowledgeSubNav />)

    expect(screen.getByRole("tab", { name: "Documents" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    expect(screen.getByRole("tab", { name: "Changes 2" })).toHaveAttribute(
      "href",
      "/knowledge/changes",
    )
    expect(screen.getByText("Document tree")).toBeInTheDocument()

    harness.pathname = "/knowledge/changes"
    view.rerender(<KnowledgeSubNav />)

    expect(screen.getByRole("tab", { name: "Changes 2" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    expect(screen.getByText("Commit controls")).toBeInTheDocument()
    expect(screen.getByText("Changed files")).toBeInTheDocument()
    expect(screen.queryByText("Document tree")).not.toBeInTheDocument()
  })

  it("shows one sidebar loading bar while Documents stays open", () => {
    harness.checkingGitHub = true
    render(<KnowledgeSubNav />)

    expect(
      screen.getByRole("progressbar", {
        name: "Checking saved changes against GitHub",
      }),
    ).toBeInTheDocument()
  })

  it("leaves loading progress to the diff pane on Changes", () => {
    harness.pathname = "/knowledge/changes"
    harness.checkingGitHub = true
    render(<KnowledgeSubNav />)

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })
})
