import { describe, it, expect } from "vitest";
import { rewriteWikilinks } from "@/lib/import/obsidian";

describe("rewriteWikilinks", () => {
  it("rewrites simple wikilink to placeholder", () => {
    const out = rewriteWikilinks("See [[Postgres Runbook]]");
    expect(out).toContain("[Postgres Runbook](bread-wikilink:postgres%20runbook)");
  });

  it("respects alias syntax", () => {
    const out = rewriteWikilinks("See [[Postgres Runbook|the runbook]]");
    expect(out).toContain("[the runbook](bread-wikilink:postgres%20runbook)");
  });

  it("leaves non-wikilink text unchanged", () => {
    const out = rewriteWikilinks("Plain markdown [link](https://x)");
    expect(out).toContain("[link](https://x)");
  });
});
