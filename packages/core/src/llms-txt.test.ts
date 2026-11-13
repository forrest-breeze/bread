import { describe, expect, it } from "vitest";
import { renderLlmsTxt, renderLlmsTxtLink } from "./llms-txt.js";

// ---------------------------------------------------------------------------
// llms.txt renderer contract (https://llmstxt.org): H1, optional blockquote
// summary, detail paragraphs, then H2 sections of `- [title](url): note` links.
// Consumers are fetchers, so the skeleton must stay exact and links parseable.
// ---------------------------------------------------------------------------

describe("renderLlmsTxt", () => {
  it("renders the spec skeleton in order", () => {
    const out = renderLlmsTxt({
      title: "Breezify",
      summary: "A knowledge base that writes itself.",
      details: ["Some context."],
      sections: [
        {
          heading: "Docs",
          links: [{ title: "Install", url: "https://x.dev/doc/install", note: "setup" }],
        },
      ],
    });

    expect(out).toBe(
      [
        "# Breezify",
        "",
        "> A knowledge base that writes itself.",
        "",
        "Some context.",
        "",
        "## Docs",
        "",
        "- [Install](https://x.dev/doc/install): setup",
        "",
      ].join("\n"),
    );
  });

  it("collapses newlines in the summary so the blockquote stays one line", () => {
    const out = renderLlmsTxt({ title: "T", summary: "one\ntwo   three" });
    expect(out).toContain("> one two three");
    expect(out.split("\n").filter((l) => l.startsWith(">"))).toHaveLength(1);
  });

  it("drops sections with neither body nor links", () => {
    const out = renderLlmsTxt({
      title: "T",
      sections: [
        { heading: "Empty" },
        { heading: "Empty links", links: [] },
        { heading: "Kept", body: ["text"] },
      ],
    });
    expect(out).not.toContain("## Empty");
    expect(out).toContain("## Kept");
  });

  it("renders section body blocks before its links", () => {
    const out = renderLlmsTxt({
      title: "T",
      sections: [
        {
          heading: "S",
          body: ["intro"],
          links: [{ title: "A", url: "https://a.dev" }],
        },
      ],
    });
    expect(out.indexOf("intro")).toBeLessThan(out.indexOf("- [A]"));
  });

  it("always ends with exactly one trailing newline", () => {
    const out = renderLlmsTxt({ title: "T" });
    expect(out).toBe("# T\n");
  });
});

describe("renderLlmsTxtLink", () => {
  it("omits the colon when there is no note", () => {
    expect(renderLlmsTxtLink({ title: "A", url: "https://a.dev" })).toBe(
      "- [A](https://a.dev)",
    );
  });

  it("escapes brackets in the title so the link can't be broken", () => {
    expect(
      renderLlmsTxtLink({ title: "How [not] to", url: "https://a.dev" }),
    ).toBe("- [How \\[not\\] to](https://a.dev)");
  });

  it("encodes parens and spaces in the URL", () => {
    expect(
      renderLlmsTxtLink({ title: "A", url: "https://a.dev/doc/a (b)" }),
    ).toBe("- [A](https://a.dev/doc/a%20%28b%29)");
  });

  it("flattens a multi-line note onto the link line", () => {
    const line = renderLlmsTxtLink({
      title: "A",
      url: "https://a.dev",
      note: "first\nsecond",
    });
    expect(line).toBe("- [A](https://a.dev): first second");
  });

  it("falls back to a placeholder title rather than emitting an empty label", () => {
    expect(renderLlmsTxtLink({ title: "   ", url: "https://a.dev" })).toBe(
      "- [Untitled](https://a.dev)",
    );
  });
});
