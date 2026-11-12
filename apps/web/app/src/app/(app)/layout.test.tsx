import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(() => ({ admin: true })),
  ensureMemberMock: vi.fn(),
  getAuthUserMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))

vi.mock("next/navigation", () => ({ redirect: hoisted.redirectMock }))
vi.mock("@/components/app/sidebar", () => ({
  DashboardShell: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/components/swr-provider", () => ({
  SWRProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/components/app-theme-provider", () => ({
  AppThemeProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/components/app/command-palette", () => ({
  CommandPaletteProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/lib/auth/get-auth-user", () => ({ getAuthUser: hoisted.getAuthUserMock }))
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: hoisted.createAdminClientMock }))
vi.mock("@/lib/breeze-workspace", () => ({
  ensureBreezeWorkspaceMember: hoisted.ensureMemberMock,
}))

import DashboardLayout from "./layout"
import { TimeoutError } from "@/lib/utils"

describe("DashboardLayout (single Breeze workspace, no onboarding)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.getAuthUserMock.mockResolvedValue({ id: "user_123", email: "a@breeze.com" })
    hoisted.ensureMemberMock.mockResolvedValue({ workspaceId: "ws_1", joined: false })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("sends signed-out visitors to /login", async () => {
    hoisted.getAuthUserMock.mockResolvedValue(null)
    await expect(DashboardLayout({ children: "page" })).rejects.toThrow("NEXT_REDIRECT:/login")
    expect(hoisted.ensureMemberMock).not.toHaveBeenCalled()
  })

  it("adds the user to the Breeze workspace and renders the shell, never onboarding", async () => {
    hoisted.ensureMemberMock.mockResolvedValue({ workspaceId: "ws_1", joined: true })
    const result = await DashboardLayout({ children: "page" })
    expect(result).toBeTruthy()
    expect(hoisted.ensureMemberMock).toHaveBeenCalledWith({ admin: true }, "user_123")
    expect(hoisted.redirectMock).not.toHaveBeenCalled()
  })

  it("renders the shell when the membership step times out", async () => {
    hoisted.ensureMemberMock.mockRejectedValue(new TimeoutError(3000))
    await expect(DashboardLayout({ children: "page" })).resolves.toBeTruthy()
    expect(hoisted.redirectMock).not.toHaveBeenCalled()
  })

  it("throws unexpected membership errors", async () => {
    hoisted.ensureMemberMock.mockRejectedValue(new Error("permission denied"))
    await expect(DashboardLayout({ children: "page" })).rejects.toThrow("permission denied")
  })
})
