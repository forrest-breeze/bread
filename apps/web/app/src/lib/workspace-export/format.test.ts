import { describe, it, expect } from "vitest";
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  parseWorkspaceExport,
  type WorkspaceExport,
} from "@/lib/workspace-export/format";

function makeValid(): WorkspaceExport {
  return {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: "2026-04-24T00:00:00.000Z",
    source: {
      workspace_id: "11111111-1111-1111-1111-111111111111",
      workspace_slug: "test",
      workspace_name: "Test",
    },
    scope: "workspace",
    scope_folder_id: null,
    workspace: { name: "Test", settings: {} },
    folders: [
      {
        id: "22222222-2222-2222-2222-222222222222",
        name: "Blog",
        display_name: "Blog",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        created_at: "2026-04-24T00:00:00.000Z",
      },
    ],
    documents: [
      {
        id: "33333333-3333-3333-3333-333333333333",
        folder_id: "22222222-2222-2222-2222-222222222222",
        title: "Hello",
        content: "<p>body</p>",
        source: "Manual",
        author: "Forrest",
        status: "Draft",
        created_at: "2026-04-24T00:00:00.000Z",
        updated_at: "2026-04-24T00:00:00.000Z",
      },
    ],
    counts: { folders: 1, documents: 1 },
  };
}

describe("parseWorkspaceExport", () => {
  it("round-trips a valid export through JSON", () => {
    const input = makeValid();
    const parsed = parseWorkspaceExport(JSON.parse(JSON.stringify(input)));
    expect(parsed.format).toBe(EXPORT_FORMAT);
    expect(parsed.format_version).toBe(EXPORT_FORMAT_VERSION);
    expect(parsed.folders).toHaveLength(1);
    expect(parsed.documents[0].title).toBe("Hello");
    expect(parsed.scope).toBe("workspace");
  });

  it("rejects a non-object root", () => {
    expect(() => parseWorkspaceExport("nope")).toThrow(/must be a JSON object/);
    expect(() => parseWorkspaceExport(null)).toThrow(/must be a JSON object/);
  });

  it("rejects the wrong format discriminator", () => {
    const input = { ...makeValid(), format: "random-dump" };
    expect(() => parseWorkspaceExport(input)).toThrow(/Not a Bread workspace export/);
  });

  it("rejects the old v1 payload the user shared", () => {
    const v1Shape = {
      format_version: 1,
      exported_at: "2026-04-24",
      source: { workspace_id: "x", workspace_slug: "x", workspace_name: "x" },
      documents: [],
    };
    expect(() => parseWorkspaceExport(v1Shape)).toThrow(
      /Not a Bread workspace export/,
    );
  });

  it("rejects a mismatched format_version", () => {
    const input = { ...makeValid(), format_version: 99 };
    expect(() => parseWorkspaceExport(input)).toThrow(
      /Unsupported export format_version/,
    );
  });

  it("rejects documents missing title or content", () => {
    const base = makeValid();
    const missingTitle = {
      ...base,
      documents: [{ ...base.documents[0], title: "" }],
    };
    expect(() => parseWorkspaceExport(missingTitle)).toThrow(/title must be/);

    const missingContent = {
      ...base,
      documents: [{ ...base.documents[0], content: 123 }],
    };
    expect(() => parseWorkspaceExport(missingContent)).toThrow(/content must be/);
  });

  it("coerces scope to 'folder' when provided, else 'workspace'", () => {
    const asFolder = { ...makeValid(), scope: "folder" };
    expect(parseWorkspaceExport(asFolder).scope).toBe("folder");

    const unknown = { ...makeValid(), scope: "whatever" };
    expect(parseWorkspaceExport(unknown).scope).toBe("workspace");
  });

  it("defaults visibility to 'workspace' when not 'role'", () => {
    const base = makeValid();
    const weirdVis = {
      ...base,
      folders: [{ ...base.folders[0], visibility: "private" }],
    };
    expect(parseWorkspaceExport(weirdVis).folders[0].visibility).toBe("workspace");
  });

  it("keeps settings when workspace.settings is a record, else {}", () => {
    const base = makeValid();
    const withSettings = {
      ...base,
      workspace: { name: "Test", settings: { allowed_domains: ["a.com"] } },
    };
    expect(
      (parseWorkspaceExport(withSettings).workspace.settings as Record<string, unknown>)
        .allowed_domains,
    ).toEqual(["a.com"]);

    const bogus = {
      ...base,
      workspace: { name: "Test", settings: "oops" as unknown as object },
    };
    expect(parseWorkspaceExport(bogus).workspace.settings).toEqual({});
  });
});
