import { vi, type Mock } from "vitest"
import type { ActiveWorkspace } from "@/lib/db/workspace"
import { TEST_USER, TEST_WORKSPACE, type TestUser } from "@/test/fixtures/workspace"

/**
 * Wires the common API-route mock triplet (Supabase `auth.getUser`,
 * `getActiveWorkspace`) to a signed-in user + active workspace.
 *
 * Each test file still declares its own `vi.mock(...)` blocks at module
 * scope (required by vitest hoisting) and passes the resulting spies here.
 * This keeps the per-file boilerplate minimal without forcing a hidden
 * indirection layer.
 */
export interface AuthenticatedRouteOptions {
  user?: Partial<TestUser>
  workspace?: Partial<ActiveWorkspace>
}

export function authenticateRoute(
  getUserSpy: Mock,
  getActiveWorkspaceSpy: Mock,
  opts: AuthenticatedRouteOptions = {},
): { user: TestUser; workspace: ActiveWorkspace } {
  const user: TestUser = { ...TEST_USER, ...opts.user }
  const workspace: ActiveWorkspace = { ...TEST_WORKSPACE, ...opts.workspace }
  getUserSpy.mockResolvedValue({ data: { user } })
  vi.mocked(getActiveWorkspaceSpy).mockResolvedValue(workspace)
  return { user, workspace }
}

/**
 * Configures `getUserSpy` to return a signed-out state. Use for 401
 * regression tests.
 */
export function unauthenticateRoute(getUserSpy: Mock): void {
  getUserSpy.mockResolvedValue({ data: { user: null } })
}

/**
 * Drops the workspace resolution so the route returns 404.
 */
export function removeWorkspace(getActiveWorkspaceSpy: Mock): void {
  vi.mocked(getActiveWorkspaceSpy).mockResolvedValue(null)
}
