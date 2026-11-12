// @vitest-environment happy-dom

import type { ReactNode } from "react"
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/hooks/use-resizable", () => ({
  useResizable: () => ({
    handleRef: { current: null },
    isDragging: false,
  }),
}))

vi.mock("@/components/app/sub-sidebar-context", () => ({
  useSubSidebar: () => ({
    isOpen: true,
    width: 260,
    setWidth: vi.fn(),
  }),
}))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => (
    <div data-testid="scroll-region">{children}</div>
  ),
}))

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

import { MobileSubSidebar, SubSidebar } from "./sub-sidebar"

afterEach(cleanup)

describe("SubSidebar footer", () => {
  it("keeps desktop actions outside the scrolling navigation region", () => {
    render(
      <SubSidebar
        title="Knowledge"
        footer={<button type="button">Publish workspace</button>}
      >
        <div>Document tree</div>
      </SubSidebar>,
    )

    const scrollRegion = screen.getByTestId("scroll-region")
    expect(within(scrollRegion).getByText("Document tree")).toBeInTheDocument()
    expect(
      within(scrollRegion).queryByRole("button", { name: "Publish workspace" }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Publish workspace" }).parentElement,
    ).toHaveAttribute("data-slot", "sub-sidebar-footer")
  })

  it("keeps mobile actions outside the scrolling navigation region", () => {
    render(
      <MobileSubSidebar
        title="Knowledge"
        open
        onOpenChange={vi.fn()}
        footer={<button type="button">Publish workspace</button>}
      >
        <div>Document tree</div>
      </MobileSubSidebar>,
    )

    const scrollRegion = screen.getByTestId("scroll-region")
    expect(within(scrollRegion).getByText("Document tree")).toBeInTheDocument()
    expect(
      within(scrollRegion).queryByRole("button", { name: "Publish workspace" }),
    ).not.toBeInTheDocument()
  })
})

describe("SubSidebar scroll ownership", () => {
  it("lets desktop content provide its own bounded scroll region", () => {
    render(
      <SubSidebar title="Knowledge" scrollContent={false}>
        <div>Knowledge navigation</div>
      </SubSidebar>,
    )

    expect(screen.queryByTestId("scroll-region")).not.toBeInTheDocument()
    expect(
      screen.getByText("Knowledge navigation").parentElement,
    ).toHaveAttribute("data-slot", "sub-sidebar-contained-content")
  })

  it("lets mobile content provide its own bounded scroll region", () => {
    render(
      <MobileSubSidebar
        title="Knowledge"
        scrollContent={false}
        open
        onOpenChange={vi.fn()}
      >
        <div>Knowledge navigation</div>
      </MobileSubSidebar>,
    )

    expect(screen.queryByTestId("scroll-region")).not.toBeInTheDocument()
    expect(
      screen.getByText("Knowledge navigation").parentElement,
    ).toHaveAttribute("data-slot", "sub-sidebar-contained-content")
  })
})
