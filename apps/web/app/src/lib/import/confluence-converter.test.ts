import { describe, it, expect } from "vitest";
import { storageToMarkdown } from "@/lib/import/confluence-converter";

describe("storageToMarkdown", () => {
  it("renders headings + paragraphs", () => {
    const md = storageToMarkdown("<h1>Title</h1><p>Hello world</p>");
    expect(md).toContain("# Title");
    expect(md).toContain("Hello world");
  });

  it("converts code macros", () => {
    const xhtml =
      `<ac:structured-macro ac:name="code">` +
      `<ac:parameter ac:name="language">ts</ac:parameter>` +
      `<ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body>` +
      `</ac:structured-macro>`;
    const md = storageToMarkdown(xhtml);
    expect(md).toContain("```ts");
    expect(md).toContain("const x = 1;");
  });

  it("renders info macros as blockquote", () => {
    const xhtml =
      `<ac:structured-macro ac:name="info">` +
      `<ac:rich-text-body><p>Heads up</p></ac:rich-text-body>` +
      `</ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toContain("> Heads up");
  });

  it("falls back to placeholder for unknown macros", () => {
    const xhtml =
      `<ac:structured-macro ac:name="status">` +
      `<ac:parameter ac:name="title">DONE</ac:parameter>` +
      `</ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toContain("unsupported Confluence macro");
  });

  it("converts links + inline emphasis + entities", () => {
    const md = storageToMarkdown(
      `<p><strong>Bold</strong> and <a href="https://x.test">link</a> &amp; entity</p>`,
    );
    expect(md).toContain("**Bold**");
    expect(md).toContain("[link](https://x.test)");
    expect(md).toContain("& entity");
  });

  it("preserves internal page references as wikilinks", () => {
    const md = storageToMarkdown(
      `<ac:link><ri:page ri:content-title="Other Page" /></ac:link>`,
    );
    expect(md).toContain("[[Other Page]]");
  });
});
