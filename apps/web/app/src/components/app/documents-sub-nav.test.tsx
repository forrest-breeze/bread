// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({
  globalMutateMock: vi.fn(),
  mutateDocsMock: vi.fn(),
  mutateFoldersMock: vi.fn(),
  useDocumentsMock: vi.fn(),
  useFoldersMock: vi.fn(),
  reorderFoldersMock: vi.fn(),
  routerPushMock: vi.fn(),
  routerPrefetchMock: vi.fn(),
  pathname: "/knowledge",
  documentsData: undefined as Array<Record<string, unknown>> | undefined,
  foldersData: undefined as Array<Record<string, unknown>> | undefined,
  documentsLoading: true,
  foldersLoading: true,
}))

vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  usePathname: () => hoisted.pathname,
  useRouter: () => ({
    prefetch: hoisted.routerPrefetchMock,
    push: hoisted.routerPushMock,
  }),
}))

vi.mock("swr", () => ({
  preload: vi.fn(),
  useSWRConfig: () => ({
    mutate: hoisted.globalMutateMock,
  }),
}))

vi.mock("@/hooks/swr", () => ({
  useDocuments: (options: unknown) => {
    hoisted.useDocumentsMock(options)
    return {
      data: hoisted.documentsData,
      isLoading: hoisted.documentsLoading,
      mutate: hoisted.mutateDocsMock,
    }
  },
  useFolders: (options: unknown) => {
    hoisted.useFoldersMock(options)
    return {
      data: hoisted.foldersData,
      isLoading: hoisted.foldersLoading,
      mutate: hoisted.mutateFoldersMock,
    }
  },
  useWorkspace: () => ({
    data: { id: "ws-1" },
  }),
}))

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: () => ({
      on: () => ({
        on: () => ({
          subscribe: () => ({}),
        }),
      }),
    }),
    removeChannel: () => {},
  }),
}))

vi.mock("@/lib/api/folders", () => ({
  reorderFolders: hoisted.reorderFoldersMock,
}))

import { DocumentsSubNav } from "./documents-sub-nav"

const FOLDER_DRAG_TYPE = "application/x-bread-folder-id"

function createDataTransfer(initialData: Record<string, string>) {
  const data = new Map(Object.entries(initialData))
  const types = Object.keys(initialData)
  return {
    dataTransfer: {
      types,
      files: [],
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn((type: string, value: string) => {
        data.set(type, value)
        if (!types.includes(type)) types.push(type)
      }),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
    },
  }
}

function dispatchDragEvent(
  target: Element,
  type: "dragover" | "drop",
  event: ReturnType<typeof createDataTransfer>,
  clientY: number,
): Event {
  const dragEvent = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(dragEvent, "dataTransfer", {
    value: event.dataTransfer,
  })
  Object.defineProperty(dragEvent, "clientY", { value: clientY })
  fireEvent(target, dragEvent)
  return dragEvent
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  hoisted.pathname = "/knowledge"
  hoisted.documentsData = undefined
  hoisted.foldersData = undefined
  hoisted.documentsLoading = true
  hoisted.foldersLoading = true
})

describe("DocumentsSubNav loading state", () => {
  it("adds a visibility action to a folder row menu", () => {
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = []
    hoisted.foldersData = [
      {
        id: "folder-1",
        name: "blog",
        display_name: "Blog",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 0,
        sort_order: null,
        icon: null,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]

    render(<DocumentsSubNav />)

    fireEvent.click(screen.getByText("Blog"))
    expect(hoisted.routerPushMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Actions for Blog" }))
    expect(
      screen.getByRole("button", { name: "Change visibility" }),
    ).toBeInTheDocument()
  })

  it("keeps a document's folder open after clicking away from that document", () => {
    window.localStorage.clear()
    const folder = (id: string, display: string, parent: string | null) => ({
      id,
      name: id,
      display_name: display,
      kind: "user",
      parent_folder_id: parent,
      visibility: "workspace",
      required_role: null,
      document_count: 1,
      sort_order: null,
      icon: null,
      last_seen_at: "2026-07-08T00:00:00.000Z",
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    })
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.foldersData = [folder("guides", "Guides", null), folder("payments", "Payments", "guides")]
    hoisted.documentsData = [
      { id: "11111111-1111-4111-8111-111111111111", title: "Refunds", source: "Manual", folder_id: "payments", updated_at: "2026-07-08T00:00:00.000Z" },
      { id: "22222222-2222-4222-8222-222222222222", title: "Welcome", source: "Manual", folder_id: null, updated_at: "2026-07-08T00:00:00.000Z" },
    ]

    // Open a doc that lives two folders deep.
    hoisted.pathname = "/knowledge/11111111-1111-4111-8111-111111111111"
    const { rerender } = render(<DocumentsSubNav />)
    expect(screen.getByText("Refunds")).toBeInTheDocument()

    // Click away to a document outside those folders: they stay open.
    hoisted.pathname = "/knowledge/22222222-2222-4222-8222-222222222222"
    rerender(<DocumentsSubNav />)
    expect(screen.getByText("Payments")).toBeInTheDocument()
    expect(screen.getByText("Refunds")).toBeInTheDocument()
  })

  it("keeps the knowledge controls outside the scrolling document tree", () => {
    const { container } = render(<DocumentsSubNav />)

    const controls = container.querySelector(
      '[data-slot="documents-sub-nav-controls"]',
    )
    const tree = container.querySelector('[data-slot="documents-sub-nav-tree"]')

    expect(controls).toHaveClass("shrink-0", "bg-background")
    expect(controls).not.toHaveClass("sticky")
    expect(
      within(controls as HTMLElement).getByPlaceholderText(/filter/i),
    ).toBeInTheDocument()
    expect(
      within(controls as HTMLElement).getByRole("button", { name: /new doc/i }),
    ).toBeInTheDocument()
    expect(
      within(controls as HTMLElement).getByRole("button", {
        name: /new folder/i,
      }),
    ).toBeInTheDocument()
    expect(tree).toHaveClass(
      "min-h-0",
      "overflow-y-auto",
      "overscroll-y-none",
    )
    expect(controls?.contains(tree)).toBe(false)
    expect(tree?.contains(controls)).toBe(false)
  })

  it("keeps the builder tree in its existing parent-owned scroll region", () => {
    hoisted.pathname = "/kb"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = []
    hoisted.foldersData = []

    const { container } = render(
      <DocumentsSubNav chrome="builder" routeRoot="kb" />,
    )

    const tree = container.querySelector('[data-slot="documents-sub-nav-tree"]')
    expect(tree).not.toHaveClass("overflow-y-auto", "overscroll-y-none")
    expect(
      container.querySelector('[data-slot="documents-sub-nav-controls"]'),
    ).toBeNull()
  })

  it("renders a tree-shaped skeleton while documents and folders load", () => {
    const { container } = render(<DocumentsSubNav />)

    expect(screen.getByRole("status")).toHaveTextContent(/loading documents/i)
    expect(container.querySelectorAll("[aria-hidden='true']").length).toBeGreaterThan(10)
    expect(screen.getByPlaceholderText(/filter/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /new doc/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /new folder/i })).toBeInTheDocument()
  })

  it("shows a promoted project root's contents without rendering the root folder", () => {
    hoisted.pathname = "/kb"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = [
      {
        id: "doc-1",
        title: "Getting started",
        source: "Manual",
        folder_id: "root-folder",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]
    hoisted.foldersData = [
      {
        id: "root-folder",
        name: "developer-docs",
        display_name: "Developer Docs",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 1,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "child-folder",
        name: "api",
        display_name: "API",
        kind: "user",
        parent_folder_id: "root-folder",
        visibility: "workspace",
        required_role: null,
        document_count: 0,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]

    render(
      <DocumentsSubNav
        chrome="builder"
        routeRoot="kb"
        promotedRootFolderIds={new Set(["root-folder"])}
        projectRootFolderId="root-folder"
      />,
    )

    expect(screen.queryByText("Developer Docs")).not.toBeInTheDocument()
    expect(screen.getByText("API")).toBeInTheDocument()
    expect(screen.getByText("Getting started")).toBeInTheDocument()
  })

  it("shows only the selected portal page's folders and documents", () => {
    hoisted.pathname = "/kb"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = [
      {
        id: "api-doc",
        title: "List entries",
        source: "Manual",
        folder_id: "api-folder",
        sort_order: 0,
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "guide-doc",
        title: "Getting started",
        source: "Manual",
        folder_id: "guide-folder",
        sort_order: 0,
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "secret-doc",
        title: "Internal roadmap",
        source: "Manual",
        folder_id: "secret-folder",
        sort_order: 0,
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]
    hoisted.foldersData = [
      {
        id: "root-folder",
        name: "developer-docs",
        display_name: "Developer Docs",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 2,
        sort_order: 0,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "api-folder",
        name: "api",
        display_name: "API",
        kind: "user",
        parent_folder_id: "root-folder",
        visibility: "workspace",
        required_role: null,
        document_count: 1,
        sort_order: 0,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "guide-folder",
        name: "guides",
        display_name: "Guides",
        kind: "user",
        parent_folder_id: "root-folder",
        visibility: "workspace",
        required_role: null,
        document_count: 1,
        sort_order: 1,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "secret-folder",
        name: "internal",
        display_name: "Internal",
        kind: "user",
        parent_folder_id: null,
        visibility: "private",
        required_role: "member",
        document_count: 1,
        sort_order: 2,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]

    render(
      <DocumentsSubNav
        chrome="builder"
        routeRoot="kb"
        projectSlug="developers"
        portalPageSlug="api-reference"
        portalPageScope={["api-folder"]}
        promotedRootFolderIds={new Set(["root-folder"])}
        projectRootFolderId="root-folder"
      />,
    )

    expect(hoisted.useDocumentsMock).toHaveBeenCalledWith({ projectSlug: null })
    expect(hoisted.useFoldersMock).toHaveBeenCalledWith({ projectSlug: null })

    expect(screen.getByText("API")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Expand folder" }))
    expect(screen.getByText("List entries")).toBeInTheDocument()
    expect(screen.queryByText("Guides")).not.toBeInTheDocument()
    expect(screen.queryByText("Getting started")).not.toBeInTheDocument()
    expect(screen.queryByText("Internal")).not.toBeInTheDocument()
    expect(screen.queryByText("Internal roadmap")).not.toBeInTheDocument()

    fireEvent.click(screen.getByText("List entries"))
    expect(hoisted.routerPushMock).toHaveBeenCalledWith(
      "/kb/doc/api-doc?project=developers&page=api-reference",
    )
  })

  it("hides restricted folders from a workspace-wide portal page", () => {
    hoisted.pathname = "/kb"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = [
      {
        id: "public-doc",
        title: "Public guide",
        source: "Manual",
        document_type: "page",
        folder_id: "public-folder",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "secret-doc",
        title: "Internal roadmap",
        source: "Manual",
        document_type: "page",
        folder_id: "secret-folder",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]
    hoisted.foldersData = [
      {
        id: "public-folder",
        name: "public",
        display_name: "Public",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 1,
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "secret-folder",
        name: "internal",
        display_name: "Internal",
        kind: "user",
        parent_folder_id: null,
        visibility: "private",
        required_role: "member",
        document_count: 1,
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]

    render(
      <DocumentsSubNav
        chrome="builder"
        routeRoot="kb"
        projectSlug="developers"
        portalPageSlug="everything"
        portalPageScope={null}
      />,
    )

    expect(screen.getByText("Public")).toBeInTheDocument()
    expect(screen.queryByText("Internal")).not.toBeInTheDocument()
    expect(screen.queryByText("Internal roadmap")).not.toBeInTheDocument()
  })

  it("creates a new builder document inside the selected project root", async () => {
    hoisted.pathname = "/kb"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = []
    hoisted.foldersData = []
    const onRootDocumentCreated = vi.fn()
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "created-doc",
            title: "Untitled",
            folder_id: "root-folder",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    render(
      <DocumentsSubNav
        chrome="builder"
        routeRoot="kb"
        projectRootFolderId="root-folder"
        onRootDocumentCreated={onRootDocumentCreated}
      />,
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Create document or folder" }),
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "New doc" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(request.body as string)).toEqual(
      expect.objectContaining({ folder_id: "root-folder" }),
    )
    await waitFor(() =>
      expect(onRootDocumentCreated).toHaveBeenCalledWith("created-doc"),
    )
  })

  it("rejects a root-to-root folder drop but still moves a nested folder to root", async () => {
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = []
    hoisted.foldersData = [
      {
        id: "root-folder",
        name: "root-folder",
        display_name: "Root folder",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 0,
        sort_order: 0,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "nested-folder",
        name: "nested-folder",
        display_name: "Nested folder",
        kind: "user",
        parent_folder_id: "root-folder",
        visibility: "workspace",
        required_role: null,
        document_count: 0,
        sort_order: 0,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    render(<DocumentsSubNav />)

    fireEvent.click(screen.getByRole("button", { name: "Expand folder" }))
    const rootDropZone = screen.getByTestId("documents-root-drop-zone")
    const rootFolder = screen
      .getByText("Root folder")
      .closest("[draggable='true']")
    const nestedFolder = screen
      .getByText("Nested folder")
      .closest("[draggable='true']")
    expect(rootFolder).not.toBeNull()
    expect(nestedFolder).not.toBeNull()

    const rootDrag = createDataTransfer({})
    fireEvent.dragStart(rootFolder!, rootDrag)
    const rootDragOver = dispatchDragEvent(rootDropZone, "dragover", rootDrag, 0)

    expect(rootDragOver.defaultPrevented).toBe(false)
    expect(rootDrag.dataTransfer.dropEffect).toBe("none")
    expect(screen.queryByText("Drop to root")).not.toBeInTheDocument()

    dispatchDragEvent(rootDropZone, "drop", rootDrag, 0)
    expect(hoisted.mutateFoldersMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    const nestedDrag = createDataTransfer({})
    fireEvent.dragStart(nestedFolder!, nestedDrag)
    const nestedDragOver = dispatchDragEvent(
      rootDropZone,
      "dragover",
      nestedDrag,
      0,
    )

    expect(nestedDragOver.defaultPrevented).toBe(true)
    expect(nestedDrag.dataTransfer.dropEffect).toBe("move")
    expect(screen.getByText("Drop to root")).toBeInTheDocument()

    dispatchDragEvent(rootDropZone, "drop", nestedDrag, 0)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/folders/nested-folder",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ parent_folder_id: null }),
        }),
      )
    })
  })

  it("persists builder sidebar folder order by dragging a folder after another", async () => {
    hoisted.pathname = "/kb"
    hoisted.documentsLoading = false
    hoisted.foldersLoading = false
    hoisted.documentsData = []
    hoisted.foldersData = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "alpha",
        display_name: "Alpha",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 0,
        sort_order: 0,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        name: "beta",
        display_name: "Beta",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        document_count: 0,
        sort_order: 1,
        last_seen_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ]
    hoisted.reorderFoldersMock.mockResolvedValue({
      ordered_ids: [
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000001",
      ],
    })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 240,
      height: 30,
      top: 0,
      right: 240,
      bottom: 30,
      left: 0,
      toJSON: () => {},
    })
    const onFoldersReordered = vi.fn()

    render(
      <DocumentsSubNav
        chrome="builder"
        routeRoot="kb"
        onFoldersReordered={onFoldersReordered}
      />,
    )

    const beta = screen.getByText("Beta").closest("[draggable='true']")
    expect(beta).not.toBeNull()
    const event = createDataTransfer({
      [FOLDER_DRAG_TYPE]: "00000000-0000-4000-8000-000000000001",
    })
    dispatchDragEvent(beta!, "dragover", event, 29)
    dispatchDragEvent(beta!, "drop", event, 29)

    await waitFor(() => {
      expect(hoisted.reorderFoldersMock).toHaveBeenCalledWith("user", [
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000001",
      ])
      expect(onFoldersReordered).toHaveBeenCalled()
    })
  })
})
