// @vitest-environment happy-dom
/**
 * DocumentEditor save/recovery regressions.
 *
 * These mock TipTap so the tests can drive the same onUpdate/ref path the
 * component uses in production without loading ProseMirror.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SWRConfig } from "swr"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const harness = vi.hoisted(() => {
  const baseDoc = {
    id: "doc-1",
    title: "Untitled",
    content: "",
    source: "manual",
    source_metadata: null as Record<string, unknown> | null,
    status: "Draft",
    author: "Forrest",
    deleted_at: null as string | null,
    created_at: "2026-06-01T12:00:00.000Z",
    updated_at: "2026-06-01T12:00:00.000Z",
  }

  return {
    baseDoc,
    doc: { ...baseDoc },
    mutateDocument: vi.fn(),
    mutateGitHubState: vi.fn(),
    githubState: undefined as unknown,
    githubStateError: undefined as unknown,
    githubStateLoading: false,
    routerPush: vi.fn(),
    editor: {
      html: "",
      props: null as null | {
        content?: string
        editable?: boolean
        onUpdate?: (html: string) => void
      },
    },
  }
})

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: harness.routerPush }),
}))

vi.mock("@/hooks/swr", () => ({
  useDocument: () => ({
    data: harness.doc,
    isLoading: false,
    mutate: harness.mutateDocument,
  }),
  useGitHubDocumentState: () => ({
    data: harness.githubState,
    isLoading: harness.githubStateLoading,
    error: harness.githubStateError,
    mutate: harness.mutateGitHubState,
  }),
  useWorkspace: () => ({
    data: { user_role: "admin" },
  }),
}))

vi.mock("@/lib/supabase/client", () => {
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  }
  channel.on.mockReturnValue(channel)
  channel.subscribe.mockReturnValue(channel)

  return {
    createClient: () => ({
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
    }),
  }
})

vi.mock("@/components/app/editor/tiptap-editor", async () => {
  const React = await vi.importActual<typeof import("react")>("react")

  return {
    TiptapEditor: React.forwardRef(function MockTiptapEditor(
      props: {
        content?: string
        editable?: boolean
        onUpdate?: (html: string) => void
      },
      ref,
    ) {
      harness.editor.props = props
      React.useImperativeHandle(ref, () => ({
        focus: vi.fn(),
        getEditor: () => ({
          getHTML: () => harness.editor.html,
          commands: { focus: vi.fn() },
        }),
      }))

      return React.createElement("div", {
        "data-testid": "mock-tiptap",
        "data-content": props.content ?? "",
        "data-editable": String(props.editable ?? true),
      })
    }),
  }
})

vi.mock("@/components/app/version-history-panel", () => ({
  VersionHistoryPanel: ({
    onClose,
  }: {
    onClose?: () => void
  }) => (
    <div data-testid="version-history-panel">
      <button type="button" onClick={onClose} aria-label="Close version history" />
    </div>
  ),
}))

import { DocumentEditor } from "./document-editor"
import { DocumentControlsSlotProvider } from "./document-controls-slot"
import {
  saveActiveDocumentBeforeWorkspacePublish,
  subscribeToWorkspaceDocumentSaves,
} from "@/lib/workspace-publish-events"

function renderEditor(): void {
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <DocumentEditor documentId="doc-1" />
    </SWRConfig>,
  )
}

function installDeferredFetch(): {
  fetchMock: ReturnType<typeof vi.fn>
  resolvers: Array<(response: Response) => void>
} {
  const resolvers: Array<(response: Response) => void> = []
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        resolvers.push(resolve)
      }),
  )
  vi.stubGlobal("fetch", fetchMock)
  return { fetchMock, resolvers }
}

function okResponse(): Response {
  return { ok: true, status: 200, json: async () => ({}) } as Response
}

function savedBody(fetchMock: ReturnType<typeof vi.fn>, index: number): {
  content: string
  title: string
  finalize_version: boolean
} {
  const [, init] = fetchMock.mock.calls[index] as [string, RequestInit]
  return JSON.parse(init.body as string) as {
    content: string
    title: string
    finalize_version: boolean
  }
}

async function emitEditorUpdate(html: string): Promise<void> {
  await act(async () => {
    harness.editor.html = html
    harness.editor.props?.onUpdate?.(html)
  })
}

beforeEach(() => {
  cleanup()
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  })
  window.localStorage.clear()
  harness.doc = { ...harness.baseDoc }
  harness.editor.html = ""
  harness.editor.props = null
  harness.routerPush.mockReset()
  harness.mutateDocument.mockReset()
  harness.mutateGitHubState.mockReset()
  harness.githubState = undefined
  harness.githubStateError = undefined
  harness.githubStateLoading = false
  harness.mutateDocument.mockImplementation(
    async (
      next?:
        | typeof harness.doc
        | ((current: typeof harness.doc) => typeof harness.doc),
    ) => {
      if (typeof next === "function") {
        harness.doc = next(harness.doc)
      } else if (next) {
        harness.doc = next
      }
      return harness.doc
    },
  )
})

afterEach(() => {
  // Unmounting an editor with pending edits saves them. Park those
  // teardown saves so a late response can't leak into the next test's doc.
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})))
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("DocumentEditor save races", () => {
  it("saves the visible editor HTML even when the parent mirror is stale", async () => {
    const user = userEvent.setup()
    const { fetchMock, resolvers } = installDeferredFetch()
    renderEditor()

    harness.editor.html = "<p>visible note body</p>"
    await user.clear(screen.getByPlaceholderText("Untitled"))
    await user.type(screen.getByPlaceholderText("Untitled"), "My note")

    fireEvent.keyDown(window, { key: "s", metaKey: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(savedBody(fetchMock, 0)).toMatchObject({
      title: "My note",
      content: "<p>visible note body</p>",
      finalize_version: true,
    })

    await act(async () => {
      resolvers[0]?.(okResponse())
    })
  })

  it("keeps newer edits dirty when an older in-flight save resolves", async () => {
    const user = userEvent.setup()
    const { fetchMock, resolvers } = installDeferredFetch()
    renderEditor()

    await emitEditorUpdate("<p>first draft</p>")
    fireEvent.keyDown(window, { key: "s", metaKey: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(savedBody(fetchMock, 0).content).toBe("<p>first draft</p>")

    await emitEditorUpdate("<p>second draft</p>")

    await act(async () => {
      resolvers[0]?.(okResponse())
    })

    // The newer edit is still unsaved, so the next ⌘S persists it.
    fireEvent.keyDown(window, { key: "s", metaKey: true })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
    expect(savedBody(fetchMock, 1).content).toBe("<p>second draft</p>")
    await act(async () => {
      resolvers[1]?.(okResponse())
    })
  })

  it("queues a follow-up save with the latest editor HTML when saving is already in flight", async () => {
    const { fetchMock, resolvers } = installDeferredFetch()
    renderEditor()

    await emitEditorUpdate("<p>first draft</p>")
    fireEvent.keyDown(window, { key: "s", metaKey: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)

    await emitEditorUpdate("<p>second draft</p>")
    fireEvent.keyDown(window, { key: "s", metaKey: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolvers[0]?.(okResponse())
    })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
    expect(savedBody(fetchMock, 1).content).toBe("<p>second draft</p>")

    await act(async () => {
      resolvers[1]?.(okResponse())
    })

    await waitFor(() => {
      expect(screen.queryByTitle("Save changes")).not.toBeInTheDocument()
      expect(screen.getAllByText("Saved")).not.toHaveLength(0)
    })
  })

  it("shows the saved confirmation temporarily beside the edited time", async () => {
    const user = userEvent.setup()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse()))
    renderEditor()

    await emitEditorUpdate("<p>saved body</p>")
    fireEvent.keyDown(window, { key: "s", metaKey: true })

    await waitFor(() => {
      expect(screen.getAllByText("Saved")).not.toHaveLength(0)
    })
    await waitFor(
      () => {
        expect(screen.queryAllByText("Saved")).toHaveLength(0)
      },
      { timeout: 3_000 },
    )
  })
})

describe("DocumentEditor autosave", () => {
  it("has no Save button and autosaves a non-final version once typing pauses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse())
    vi.stubGlobal("fetch", fetchMock)
    renderEditor()

    expect(screen.queryByTitle("Save changes")).not.toBeInTheDocument()
    await emitEditorUpdate("<p>typed body</p>")
    expect(fetchMock).not.toHaveBeenCalled()

    await waitFor(
      () => {
        expect(fetchMock).toHaveBeenCalledTimes(1)
      },
      { timeout: 3_000 },
    )
    expect(savedBody(fetchMock, 0)).toMatchObject({
      content: "<p>typed body</p>",
      finalize_version: false,
    })
  })

  it("saves pending edits as a final version when the document closes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse())
    vi.stubGlobal("fetch", fetchMock)
    // Keep the SWR provider mounted (as the app shell does) and close only
    // the editor, like switching to another document.
    const swrValue = { provider: () => new Map() }
    const view = render(
      <SWRConfig value={swrValue}>
        <DocumentEditor documentId="doc-1" />
      </SWRConfig>,
    )

    await emitEditorUpdate("<p>leaving now</p>")
    view.rerender(<SWRConfig value={swrValue}>{null}</SWRConfig>)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    expect(savedBody(fetchMock, 0)).toMatchObject({
      content: "<p>leaving now</p>",
      finalize_version: true,
    })
  })
})

describe("DocumentEditor history access", () => {
  it("opens version history from the edited status", async () => {
    const user = userEvent.setup()
    renderEditor()

    expect(
      screen.queryByRole("button", { name: "Version history" }),
    ).not.toBeInTheDocument()

    const historyButtons = screen.getAllByRole("button", {
      name: "Open version history",
    })
    expect(historyButtons).toHaveLength(1)
    historyButtons.forEach((button) => {
      expect(button.querySelector(".lucide-history")).toBeInTheDocument()
      expect(button).toHaveTextContent("Edited")
      expect(button).not.toHaveTextContent("Version history")
    })

    await user.click(historyButtons[0])
    expect(screen.getByTestId("version-history-panel")).toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "Version history" })).toContainElement(
      screen.getByTestId("version-history-panel"),
    )
    expect(screen.queryByRole("separator", { name: "Resize version history" })).toBeNull()

    await user.click(
      within(screen.getByTestId("version-history-panel")).getByRole("button", {
        name: "Close version history",
      }),
    )
    expect(screen.queryByTestId("version-history-panel")).not.toBeInTheDocument()
  })
})

describe("DocumentEditor controls slot", () => {
  it("renders save state and history in the builder rail slot, not a toolbar", async () => {
    const user = userEvent.setup()
    const slot = document.createElement("div")
    slot.dataset.testid = "rail-slot"
    document.body.appendChild(slot)
    try {
      render(
        <SWRConfig value={{ provider: () => new Map() }}>
          <DocumentControlsSlotProvider value={slot}>
            <DocumentEditor documentId="doc-1" />
          </DocumentControlsSlotProvider>
        </SWRConfig>,
      )

      const historyButton = within(slot).getByRole("button", {
        name: "Open version history",
      })
      expect(screen.getAllByRole("button", { name: "Open version history" })).toHaveLength(1)
      expect(screen.queryByRole("button", { name: "Export document" })).toBeNull()
      expect(
        screen.queryByRole("button", { name: "Toggle document outline" }),
      ).toBeNull()

      await user.click(historyButton)
      expect(screen.getByTestId("version-history-panel")).toBeInTheDocument()
    } finally {
      slot.remove()
    }
  })
})

describe("DocumentEditor publishing", () => {
  it("announces a persisted edit so GitHub status refreshes immediately", async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    const unsubscribe = subscribeToWorkspaceDocumentSaves(onSaved)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse()))
    renderEditor()

    await emitEditorUpdate("<p>fresh GitHub diff</p>")
    fireEvent.keyDown(window, { key: "s", metaKey: true })

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: "doc-1" }),
      )
    })
    unsubscribe()
  })

  it("removes document-level publishing and saves before workspace publishing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse())
    vi.stubGlobal("fetch", fetchMock)

    renderEditor()

    expect(screen.queryByText("Under Review")).not.toBeInTheDocument()
    expect(screen.queryByText("Draft")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument()

    await emitEditorUpdate("<p>workspace-ready change</p>")
    await saveActiveDocumentBeforeWorkspacePublish()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/documents/doc-1")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(String(init.body))).toMatchObject({
      content: "<p>workspace-ready change</p>",
      finalize_version: true,
    })
  })

  it("does not include raw repository-file drafts in workspace publishing", async () => {
    harness.doc = {
      ...harness.baseDoc,
      source: "GitHub",
      source_metadata: {
        kind: "repository_file",
        path: "docs/example.md",
      },
    }
    harness.githubState = {
      editable: true,
      repository: {
        repo_id: 1,
        repo_full_name: "example-org/bread-docs",
        file_path: "docs/example.md",
        deploy_branch: "main",
        commit_sha: "commit-1",
        blob_sha: "blob-1",
        html_url: "https://github.test/file",
      },
      repository_content: "# Repository file\n",
      session: null,
      behind_deployment: false,
      editor_path: "/knowledge/doc-1",
    }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    renderEditor()
    await saveActiveDocumentBeforeWorkspacePublish()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not let a viewed trash item block publishing its workspace deletion", async () => {
    harness.doc = {
      ...harness.baseDoc,
      deleted_at: "2026-08-18T12:00:00.000Z",
    }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    renderEditor()
    await saveActiveDocumentBeforeWorkspacePublish()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("DocumentEditor GitHub fallback", () => {
  it("shows the indexed copy read-only when live GitHub access fails", async () => {
    const user = userEvent.setup()
    harness.doc = {
      ...harness.baseDoc,
      title: "example-org/bread-docs/docs/example.md",
      content: "# Cached repository content",
      source: "GitHub",
      source_metadata: {
        kind: "repository_file",
        path: "docs/example.md",
      },
    }
    harness.githubStateError = new Error("GitHub unavailable")

    renderEditor()

    expect(
      await screen.findByText("Live GitHub access is unavailable"),
    ).toBeInTheDocument()
    expect(screen.getByTestId("mock-tiptap")).toHaveAttribute(
      "data-content",
      "# Cached repository content",
    )
    expect(screen.getByTestId("mock-tiptap")).toHaveAttribute(
      "data-editable",
      "false",
    )
    expect(
      screen.getByRole("button", { name: "GitHub settings" }),
    ).toHaveAttribute("href", "/settings/integrations/github")

    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(harness.mutateGitHubState).toHaveBeenCalledTimes(1)
  })

  it("leaves linked Bread documents to workspace-level publishing", async () => {
    harness.doc = {
      ...harness.baseDoc,
      title: "Setup",
      content: "Hosted Bread content",
      source: "docs",
      source_metadata: {
        kind: "github_hosted_document",
        canonical_repo_path: "docs/product/setup.mdx",
        repo_full_name: "example-org/bread-docs",
        repository_document_id: "raw-repository-doc-1",
      },
    }

    renderEditor()

    expect(screen.queryByText("Linked GitHub document")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument()
    expect(screen.queryByText(/prepare review draft/i)).not.toBeInTheDocument()
  })

  it("resolves an inbound conflict on the affected linked document", async () => {
    const user = userEvent.setup()
    harness.doc = {
      ...harness.baseDoc,
      title: "Bread setup",
      content: "Bread instructions",
      source: "docs",
      source_metadata: {
        kind: "github_hosted_document",
        canonical_repo_path: "docs/product/setup.mdx",
        repo_full_name: "example-org/bread-docs",
        repository_document_id: "raw-repository-doc-1",
        github_hosted_conflict: true,
      },
    }
    harness.githubState = {
      editable: true,
      repository: {
        repo_id: 1185697075,
        repo_full_name: "example-org/bread-docs",
        file_path: "docs/product/setup.mdx",
        deploy_branch: "main",
        commit_sha: "commit-2",
        blob_sha: "blob-2",
        html_url: "https://github.test/file",
      },
      repository_content: "---\ntitle: Setup\n---\n\n# GitHub instructions\n",
      session: null,
      behind_deployment: false,
      editor_path: "/knowledge/raw-repository-doc-1",
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resolved: true }), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    renderEditor()

    expect(
      await screen.findByText("GitHub and Bread both changed"),
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Review conflict" }))
    expect(
      screen.getByRole("heading", {
        name: "Resolve GitHub and Bread changes",
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: "Keep Bread for workspace publish",
      }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Use GitHub version" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/documents/doc-1/github-hosted-conflict",
        { method: "POST" },
      )
    })
  })
})
