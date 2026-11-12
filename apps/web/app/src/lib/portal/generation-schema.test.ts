import { describe, expect, it } from "vitest"
import { PORTAL_SCHEMA_VERSION_V2 } from "./schema"
import { generatedPortalSchema } from "./generation-schema"

const layout = {
  schemaVersion: PORTAL_SCHEMA_VERSION_V2,
  theme: {
    brandName: "Acme",
    tagline: "",
    logoUrl: "",
    accentColor: "#2f5520",
    navLinks: [],
    cta: null,
    font: "sans" as const,
    appearance: "auto" as const,
  },
  header: {
    id: "header",
    type: "portal-header" as const,
    search: { enabled: true, placeholder: "Search" },
  },
  body: [],
}

describe("portal generation schemas", () => {
  it("requires generation to return a version 2 component tree", () => {
    expect(generatedPortalSchema.safeParse({ layout }).success).toBe(false)
    expect(
      generatedPortalSchema.safeParse({
        layout: {
          ...layout,
          tree: {
            id: "custom-root",
            type: "Stack",
            children: [
              {
                id: "welcome",
                type: "Heading",
                props: { text: "Welcome", level: 1 },
              },
            ],
          },
        },
      }).success,
    ).toBe(true)
  })
})
