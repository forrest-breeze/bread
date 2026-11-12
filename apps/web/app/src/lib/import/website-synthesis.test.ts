import { describe, expect, it } from "vitest"
import {
  crawledPagesToDocuments,
  isUnsafeSynthesizedTitle,
  sanitizeSynthesizedContent,
  sanitizeSynthesizedTitle,
} from "@/lib/import/website-synthesis"

describe("sanitizeSynthesizedContent", () => {
  it("removes duplicate title headings and unsafe marketing sections", () => {
    const content = `## API Platform

Supported capabilities remain.

## Implementation Timeline

- Week 1: Discovery
- Week 2: Deployment

## Authentication

OAuth 2.0 is supported.`

    expect(sanitizeSynthesizedContent("API Platform", content)).toBe(
      "Supported capabilities remain.\n\n## Authentication\n\nOAuth 2.0 is supported.",
    )
  })

  it("drops model-authored citations and quantitative marketing claims", () => {
    const content = `Core product description.

- 99.6% uptime SLA
- Role-based access control

_Sources: https://invented.example_`

    expect(sanitizeSynthesizedContent("Overview", content)).toBe(
      "Core product description.\n\n- Role-based access control",
    )
  })

  it("removes headings left empty after an unsafe answer is filtered", () => {
    const content = `## Supported systems

Guidewire is supported.

## How long does implementation take?

Most teams are live within a quarter.

## Security

Role-based access is supported.`

    expect(sanitizeSynthesizedContent("FAQ", content)).toBe(
      "## Supported systems\n\nGuidewire is supported.\n\n## Security\n\nRole-based access is supported.",
    )
  })

  it("rejects entire documents centered on inferred timelines", () => {
    expect(isUnsafeSynthesizedTitle("Typical Implementation Timeline")).toBe(true)
    expect(isUnsafeSynthesizedTitle("Deployment Timeline")).toBe(true)
    expect(isUnsafeSynthesizedTitle("Customer Case Studies")).toBe(true)
    expect(isUnsafeSynthesizedTitle("Integration Capabilities")).toBe(false)
  })
})

describe("sanitizeSynthesizedTitle", () => {
  it("removes markdown heading and emphasis syntax from navigation labels", () => {
    expect(sanitizeSynthesizedTitle("## **Onboarding and Support**")).toBe(
      "Onboarding and Support",
    )
    expect(sanitizeSynthesizedTitle("1. `Platform Overview`")).toBe("Platform Overview")
  })
})

describe("crawledPagesToDocuments", () => {
  it("imports each readable page verbatim, with no model call", () => {
    const docs = crawledPagesToDocuments({
      pages: [
        { url: "https://example.test/", title: "Home", text: "# Home\n\nWelcome to the docs." },
        { url: "https://example.test/pricing", title: "", text: "Plans and pricing." },
        { url: "https://example.test/dupe", title: "Home", text: "Duplicate title." },
        { url: "https://example.test/empty", title: "Empty", text: "   " },
      ],
    })
    expect(docs.map((d) => d.title)).toEqual(["Home", "pricing"])
    expect(docs[0]).toMatchObject({
      category: "Website",
      content: "Welcome to the docs.",
      sourceUrls: ["https://example.test/"],
    })
  })
})
