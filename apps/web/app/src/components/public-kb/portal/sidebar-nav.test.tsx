// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import type { SidebarBlock } from "@/lib/portal/schema"

const route = vi.hoisted(() => ({
  pathname: "/p/acme",
}))

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useRouter: () => ({ prefetch: vi.fn() }),
}))

vi.mock("@/components/ui/hover-prefetch-link", () => ({
  HoverPrefetchLink: ({
    href,
    children,
    className,
    "aria-current": ariaCurrent,
  }: {
    href: string
    children: ReactNode
    className?: string
    "aria-current"?: "page"
  }) => (
    <a href={href} className={className} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
}))

import { SidebarNav } from "./sidebar-nav"
import { resetPortalNavMemory } from "@/lib/portal/nav-memory"

const block: SidebarBlock = {
  id: "sidebar",
  type: "sidebar-nav",
  groups: [
    {
      id: "developer",
      label: "Developer",
      icon: "folder",
      href: "/p/acme/folder/developer",
      items: [],
      children: [
        {
          id: "mcp",
          label: "MCP",
          icon: "folder",
          href: "/p/acme/folder/mcp",
          items: [
            {
              id: "mcp-tools",
              label: "MCP Tools",
              href: "/p/acme/doc/mcp-tools",
            },
          ],
        },
      ],
    },
    {
      id: "setup",
      label: "Setup",
      icon: "folder",
      href: "/p/acme/folder/setup",
      items: [
        {
          id: "slack",
          label: "Slack Integration",
          href: "/p/acme/doc/slack",
        },
      ],
    },
  ],
}

describe("SidebarNav", () => {
  // Open-folder state is remembered across navigations for the life of the
  // tab; start each test from a fresh tab.
  beforeEach(() => {
    resetPortalNavMemory()
  })

  afterEach(() => {
    cleanup()
    route.pathname = "/p/acme"
  })

  it("keeps root folders open while nested folders stay collapsed", async () => {
    render(<SidebarNav block={block} />)

    expect(screen.queryByRole("button", { name: "Expand Developer" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Developer" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "MCP" })).not.toBeInTheDocument()
    expect(screen.getByText("Developer")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "MCP Tools" })).not.toBeInTheDocument()

    const mcpToggle = screen.getByRole("button", { name: "Expand MCP" })
    await userEvent.click(mcpToggle)

    expect(mcpToggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("link", { name: "MCP Tools" })).toHaveAttribute(
      "href",
      "/p/acme/doc/mcp-tools",
    )
  })

  it("opens the group that contains the current document", () => {
    route.pathname = "/p/acme/doc/slack"

    render(<SidebarNav block={block} />)

    expect(screen.queryByRole("button", { name: "Collapse Setup" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Slack Integration" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "MCP Tools" })).not.toBeInTheDocument()
  })

  it("highlights the resolved document and opens its ancestors when the URL differs", () => {
    route.pathname = "/docs/doc/legacy-tools-slug"

    const { rerender } = render(
      <SidebarNav block={block} variant="docs" activeDocumentId="mcp-tools" />,
    )

    expect(screen.getByRole("button", { name: "Collapse MCP" })).toHaveAttribute(
      "aria-expanded", "true",
    )
    expect(screen.getByRole("link", { name: "MCP Tools" })).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("link", { name: "MCP Tools" })).toHaveClass("bg-blue-500/10", "text-blue-600")
    expect(screen.getByRole("link", { name: "Slack Integration" })).not.toHaveAttribute("aria-current")

    rerender(<SidebarNav block={block} variant="docs" activeDocumentId="slack" />)

    expect(screen.getByRole("link", { name: "Slack Integration" })).toHaveAttribute("aria-current", "page")
    // The folder it came from stays open; only the highlight moves.
    expect(screen.getByRole("link", { name: "MCP Tools" })).not.toHaveAttribute("aria-current")
  })

  it("opens every ancestor for the current nested document", () => {
    route.pathname = "/p/acme/doc/mcp-tools"

    render(<SidebarNav block={block} />)

    expect(screen.getByRole("button", { name: "Collapse MCP" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(screen.getByRole("link", { name: "MCP Tools" })).toBeInTheDocument()
  })

  it("reopens a folder collapsed on another page when navigating into it", async () => {
    route.pathname = "/p/acme/doc/mcp-tools"
    const { rerender } = render(<SidebarNav block={block} variant="docs" activeDocumentId="mcp-tools" />)

    // Collapsing the current folder sticks while staying on the page.
    await userEvent.click(screen.getByRole("button", { name: "Collapse MCP" }))
    expect(screen.getByRole("button", { name: "Expand MCP" })).toHaveAttribute("aria-expanded", "false")

    // Leave the folder, then come back to a page inside it: it opens again.
    route.pathname = "/p/acme/doc/slack"
    rerender(<SidebarNav block={block} variant="docs" activeDocumentId="slack" />)
    route.pathname = "/p/acme/doc/mcp-tools"
    rerender(<SidebarNav block={block} variant="docs" activeDocumentId="mcp-tools" />)
    expect(screen.getByRole("button", { name: "Collapse MCP" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("link", { name: "MCP Tools" })).toHaveAttribute("aria-current", "page")
  })

  it("keeps a folder open after navigating to a document outside it", () => {
    route.pathname = "/p/acme/doc/mcp-tools"
    const { rerender } = render(<SidebarNav block={block} variant="docs" activeDocumentId="mcp-tools" />)
    expect(screen.getByRole("button", { name: "Collapse MCP" })).toHaveAttribute("aria-expanded", "true")

    // Open a document in a different folder: MCP must not collapse behind us.
    route.pathname = "/p/acme/doc/slack"
    rerender(<SidebarNav block={block} variant="docs" activeDocumentId="slack" />)
    expect(screen.getByRole("button", { name: "Collapse MCP" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("link", { name: "MCP Tools" })).toBeInTheDocument()
  })

  it("restores open folders when the rail is rebuilt by a page navigation", () => {
    // The portal renders the rail inside each document page, so a navigation
    // unmounts it and mounts a new one.
    route.pathname = "/p/acme/doc/mcp-tools"
    const first = render(<SidebarNav block={block} variant="docs" activeDocumentId="mcp-tools" />)
    first.unmount()

    route.pathname = "/p/acme/doc/slack"
    render(<SidebarNav block={block} variant="docs" activeDocumentId="slack" />)

    expect(screen.getByRole("button", { name: "Collapse MCP" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("link", { name: "MCP Tools" })).toBeInTheDocument()
  })
})
