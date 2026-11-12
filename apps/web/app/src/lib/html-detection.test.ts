import { describe, expect, it } from "vitest"
import { looksLikeHtml } from "./html-detection"

describe("looksLikeHtml", () => {
  it("detects authored editor HTML", () => {
    expect(looksLikeHtml("<p>Deploy the <strong>web</strong> app.</p>")).toBe(
      true,
    )
  })

  it("treats plain Markdown as Markdown", () => {
    expect(looksLikeHtml("# Runbook\n\nRestart the worker.")).toBe(false)
  })

  it("ignores tags mentioned inside fenced code blocks", () => {
    expect(
      looksLikeHtml(
        "# Security\n\nNever render user input raw:\n\n```html\n<script>alert(1)</script>\n```\n\nSanitize first.",
      ),
    ).toBe(false)
  })

  it("ignores tags mentioned inside inline code spans", () => {
    expect(
      looksLikeHtml("Wrap the embed in a `<div>` before mounting it."),
    ).toBe(false)
  })

  it("still detects HTML that surrounds a code sample", () => {
    expect(
      looksLikeHtml("<p>Example:</p>\n\n```html\n<script></script>\n```"),
    ).toBe(true)
  })
})
