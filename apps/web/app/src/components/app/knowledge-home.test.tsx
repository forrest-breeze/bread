// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock("@/components/ui/hover-prefetch-link", () => ({
  HoverPrefetchLink: ({
    href,
    children,
    className,
  }: {
    href: string
    children: React.ReactNode
    className?: string
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}))

vi.mock("@/hooks/swr", () => ({
  useDocumentHome: () => ({
    data: {
      total: 3,
      documents: [
        {
          id: "doc-1",
          title: "Deployment runbook",
          preview: "How to safely deploy the application and verify production.",
          source: "github",
          status: "Published",
          folder_id: "folder-1",
          updated_at: "2026-06-29T12:00:00.000Z",
        },
      ],
    },
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  useFolders: () => ({
    data: [
      {
        id: "folder-1",
        name: "engineering",
        display_name: "Engineering",
        kind: "user",
        parent_folder_id: null,
        document_count: 3,
      },
    ],
  }),
}))

import { KnowledgeHome } from "./knowledge-home"

afterEach(cleanup)

describe("KnowledgeHome", () => {
  it("surfaces document contents without folder pages", () => {
    const { container } = render(<KnowledgeHome />)

    expect(screen.getByText("Deployment runbook")).toBeInTheDocument()
    expect(
      screen.getByText(
        "How to safely deploy the application and verify production.",
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Deployment runbook/i })).toHaveAttribute(
      "href",
      "/knowledge/doc-1",
    )
    expect(
      container.querySelector('a[href="/knowledge/folder/folder-1"]'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Open the portal editor")).not.toBeInTheDocument()
  })
})
