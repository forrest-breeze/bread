import type { ActiveWorkspace } from "@/lib/db/workspace"

/**
 * Canonical `ActiveWorkspace` fixture. Every field is a stable literal so
 * test assertions can compare against it without hand-typing UUIDs.
 */
export const TEST_WORKSPACE: ActiveWorkspace = {
  id: "wm-0000-0000-0000-000000000001",
  workspace_id: "ws-0000-0000-0000-000000000001",
  role: "admin",
}

/** Build a fresh ActiveWorkspace with overrides applied. */
export function makeActiveWorkspace(
  overrides: Partial<ActiveWorkspace> = {},
): ActiveWorkspace {
  return { ...TEST_WORKSPACE, ...overrides }
}

/**
 * Stable test user payload in the shape returned by
 * `supabase.auth.getUser()`. Accepts overrides on `user_metadata` etc.
 */
export interface TestUser {
  id: string
  email: string
  user_metadata: Record<string, unknown>
}

export const TEST_USER: TestUser = {
  id: "user-0000-0000-0000-000000000001",
  email: "test@example.com",
  user_metadata: {},
}

export function makeUser(overrides: Partial<TestUser> = {}): TestUser {
  return { ...TEST_USER, ...overrides }
}
