import { describe, it, expect } from "vitest";
import { renderBlocksToMarkdown } from "@/lib/import/notion";

describe("renderBlocksToMarkdown", () => {
  it("renders paragraphs and headings", () => {
    const md = renderBlocksToMarkdown([
      {
        id: "1",
        type: "heading_1",
        heading_1: { rich_text: [{ plain_text: "Title" }] },
      },
      {
        id: "2",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "Hello world" }] },
      },
    ]);
    expect(md).toContain("# Title");
    expect(md).toContain("Hello world");
  });

  it("renders bullet + todo + numbered list items", () => {
    const md = renderBlocksToMarkdown([
      {
        id: "1",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ plain_text: "bullet" }] },
      },
      {
        id: "2",
        type: "to_do",
        to_do: { rich_text: [{ plain_text: "todo" }], checked: true },
      },
      {
        id: "3",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: [{ plain_text: "numbered" }] },
      },
    ]);
    expect(md).toContain("- bullet");
    expect(md).toContain("- [x] todo");
    expect(md).toContain("1. numbered");
  });

  it("emits placeholder for unknown block types instead of throwing", () => {
    const md = renderBlocksToMarkdown([
      {
        id: "1",
        type: "synced_block",
        synced_block: {},
      },
    ]);
    expect(md).toContain("synced_block");
  });

  it("renders code blocks with language", () => {
    const md = renderBlocksToMarkdown([
      {
        id: "1",
        type: "code",
        code: {
          rich_text: [{ plain_text: "console.log(1)" }],
          language: "javascript",
        },
      },
    ]);
    expect(md).toContain("```javascript");
    expect(md).toContain("console.log(1)");
  });
});
