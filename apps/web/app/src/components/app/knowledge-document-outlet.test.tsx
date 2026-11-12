// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const A = "3f2b8c1e-5a47-4d09-9c3e-1b2a4d6f8e90"
const B = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

const state = vi.hoisted(() => ({
  pathname: "/knowledge",
  loaded: new Set<string>(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
}))
vi.mock("next/dynamic", () => ({
  default: () =>
    function DocumentEditorStub({ documentId }: { documentId: string }) {
      return <div data-testid="editor">{documentId}</div>
    },
}))
vi.mock("swr", () => ({
  useSWRConfig: () => ({ cache: new Map() }),
}))
vi.mock("@/hooks/swr", () => ({
  useDocument: (id: string | null) => ({
    data: id && state.loaded.has(id) ? { id } : undefined,
    error: undefined,
  }),
}))

import { KnowledgeDocumentOutlet } from "./knowledge-document-outlet"

function renderOutlet() {
  return render(
    <KnowledgeDocumentOutlet>
      <p>server page</p>
    </KnowledgeDocumentOutlet>,
  )
}

describe("KnowledgeDocumentOutlet", () => {
  beforeEach(() => {
    state.pathname = "/knowledge"
    state.loaded = new Set()
  })

  it("renders the server page on non-document routes", () => {
    renderOutlet()
    expect(screen.getByText("server page")).toBeTruthy()
    expect(screen.queryByTestId("editor")).toBeNull()
  })

  it("opens a document straight away when nothing else is on screen", () => {
    state.pathname = `/knowledge/${A}`
    renderOutlet()
    expect(screen.getByTestId("editor").textContent).toBe(A)
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it("keeps the current document until the next one has loaded", () => {
    state.pathname = `/knowledge/${A}`
    state.loaded.add(A)
    const view = renderOutlet()

    // Switch to a document that still has to be fetched.
    state.pathname = `/knowledge/${B}`
    view.rerender(
      <KnowledgeDocumentOutlet>
        <p>server page</p>
      </KnowledgeDocumentOutlet>,
    )
    expect(screen.getByTestId("editor").textContent).toBe(A)
    expect(screen.getByRole("progressbar")).toBeTruthy()

    // Its content arrives: swap in one step.
    state.loaded.add(B)
    view.rerender(
      <KnowledgeDocumentOutlet>
        <p>server page</p>
      </KnowledgeDocumentOutlet>,
    )
    expect(screen.getByTestId("editor").textContent).toBe(B)
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it("swaps immediately to a document that is already cached", () => {
    state.pathname = `/knowledge/${A}`
    state.loaded = new Set([A, B])
    const view = renderOutlet()

    state.pathname = `/knowledge/${B}`
    view.rerender(
      <KnowledgeDocumentOutlet>
        <p>server page</p>
      </KnowledgeDocumentOutlet>,
    )
    expect(screen.getByTestId("editor").textContent).toBe(B)
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it("returns to the server page when the document is closed", () => {
    state.pathname = `/knowledge/${A}`
    state.loaded.add(A)
    const view = renderOutlet()

    state.pathname = "/knowledge"
    view.rerender(
      <KnowledgeDocumentOutlet>
        <p>server page</p>
      </KnowledgeDocumentOutlet>,
    )
    expect(screen.getByText("server page")).toBeTruthy()
    expect(screen.queryByTestId("editor")).toBeNull()
  })
})
