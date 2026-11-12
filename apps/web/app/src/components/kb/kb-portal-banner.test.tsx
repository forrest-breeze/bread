// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({
  workspace: {
    slug: "acme",
    settings: {},
    user_role: "owner",
  },
}))

vi.mock("@/hooks/swr", () => ({
  useWorkspace: () => ({
    data: hoisted.workspace,
  }),
}))

vi.mock("@/components/ui/hover-prefetch-link", () => ({
  HoverPrefetchLink: ({
    href,
    children,
    className,
  }: {
    href: string
    children: ReactNode
    className?: string
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}))

import { KbPortalBanner } from "./kb-portal-banner"

describe("KbPortalBanner", () => {
  beforeEach(() => {
    hoisted.workspace.settings = {}
    hoisted.workspace.user_role = "owner"
  })

  afterEach(() => {
    cleanup()
  })

  it("shows the portal link when the workspace is private", () => {
    render(<KbPortalBanner />)

    expect(screen.getByText("Private portal")).toBeInTheDocument()
    expect(screen.getByText(/\/p\/acme$/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /visit/i })).toHaveAttribute(
      "href",
      "/p/acme",
    )
    expect(screen.getByRole("link", { name: /customize/i })).toHaveAttribute(
      "href",
      "/kb",
    )
    expect(screen.getByRole("link", { name: /publish/i })).toHaveAttribute(
      "href",
      "/settings/workspace",
    )
  })

  it("uses the custom domain for published portals", () => {
    hoisted.workspace.settings = {
      kb_public: true,
      kb_custom_domain: "docs.acme.com",
    }

    render(<KbPortalBanner />)

    expect(screen.getByText("Public portal")).toBeInTheDocument()
    expect(screen.getByText("https://docs.acme.com")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /visit/i })).toHaveAttribute(
      "href",
      "https://docs.acme.com",
    )
  })
})
