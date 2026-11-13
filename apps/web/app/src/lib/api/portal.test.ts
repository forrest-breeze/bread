import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  generatePortalDraft,
  getPortalProjectDisplayVersion,
} from "@/lib/api/portal"
import type { PortalLayout } from "@/lib/portal/schema"

const originalFetch = globalThis.fetch

const layout: PortalLayout = {
  schemaVersion: 1,
  theme: {
    brandName: "Breezify",
    tagline: "Knowledge that ships",
    logoUrl: "",
    accentColor: "#111111",
    navLinks: [],
    cta: null,
    font: "sans",
    appearance: "auto",
  },
  header: {
    id: "header",
    type: "portal-header",
    search: { enabled: true, placeholder: "Search or ask AI" },
  },
  body: [
    {
      id: "hero",
      type: "hero",
      placement: "full",
      heading: "Docs",
    },
  ],
}

beforeEach(() => {
  globalThis.fetch = originalFetch
})

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

describe("generatePortalDraft", () => {
  it("fails fast without any network call: the AI portal agent is disabled", async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(
      generatePortalDraft({ layout, message: "Build docs", projectSlug: "docs" }),
    ).rejects.toThrow("AI features are disabled in this build.")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("getPortalProjectDisplayVersion", () => {
  it("shows version 1 for a newly created draft-only project", () => {
    expect(
      getPortalProjectDisplayVersion({ draftVersion: 1, publishedVersion: null }),
    ).toBe(1)
  })

  it("keeps showing the live version when a published project has a newer draft", () => {
    expect(
      getPortalProjectDisplayVersion({ draftVersion: 10, publishedVersion: 9 }),
    ).toBe(9)
  })
})
