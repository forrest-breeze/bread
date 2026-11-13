import type { WorkspaceSettings } from "@breezify/core";

// ---------------------------------------------------------------------------
// Strict Breezify workspace export format.
//
// Only this shape is accepted on import. `format` + `format_version` are the
// discriminator. Embeddings are intentionally omitted — they are regenerated
// on import so the workspace stays in whatever vector space is current.
// ---------------------------------------------------------------------------

export const EXPORT_FORMAT = "breezify-workspace-export" as const;
export const EXPORT_FORMAT_VERSION = 2 as const;

export type ExportScope = "workspace" | "folder";

export interface ExportedFolder {
  id: string;
  name: string;
  display_name: string;
  parent_folder_id: string | null;
  visibility: "workspace" | "role";
  required_role: string | null;
  created_at: string;
}

export interface ExportedDocument {
  id: string;
  folder_id: string | null;
  title: string;
  content: string;
  source: string | null;
  author: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceExport {
  format: typeof EXPORT_FORMAT;
  format_version: typeof EXPORT_FORMAT_VERSION;
  exported_at: string;
  source: {
    workspace_id: string;
    workspace_slug: string | null;
    workspace_name: string;
  };
  scope: ExportScope;
  scope_folder_id: string | null;
  workspace: {
    name: string;
    settings: WorkspaceSettings;
  };
  folders: ExportedFolder[];
  documents: ExportedDocument[];
  counts: {
    folders: number;
    documents: number;
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateFolder(value: unknown, index: number): ExportedFolder {
  if (!isRecord(value)) {
    throw new Error(`folders[${index}] must be an object`);
  }
  if (!isNonEmptyString(value.id)) {
    throw new Error(`folders[${index}].id must be a non-empty string`);
  }
  if (!isNonEmptyString(value.name)) {
    throw new Error(`folders[${index}].name must be a non-empty string`);
  }
  const visibility = value.visibility === "role" ? "role" : "workspace";
  return {
    id: value.id,
    name: value.name,
    display_name:
      typeof value.display_name === "string" ? value.display_name : value.name,
    parent_folder_id:
      typeof value.parent_folder_id === "string" ? value.parent_folder_id : null,
    visibility,
    required_role:
      visibility === "role" && typeof value.required_role === "string"
        ? value.required_role
        : null,
    created_at:
      typeof value.created_at === "string"
        ? value.created_at
        : new Date(0).toISOString(),
  };
}

function validateDocument(value: unknown, index: number): ExportedDocument {
  if (!isRecord(value)) {
    throw new Error(`documents[${index}] must be an object`);
  }
  if (!isNonEmptyString(value.title)) {
    throw new Error(`documents[${index}].title must be a non-empty string`);
  }
  if (typeof value.content !== "string") {
    throw new Error(`documents[${index}].content must be a string`);
  }
  return {
    id: isNonEmptyString(value.id) ? value.id : "",
    folder_id: typeof value.folder_id === "string" ? value.folder_id : null,
    title: value.title,
    content: value.content,
    source: typeof value.source === "string" ? value.source : null,
    author: typeof value.author === "string" ? value.author : null,
    status: typeof value.status === "string" ? value.status : null,
    created_at:
      typeof value.created_at === "string"
        ? value.created_at
        : new Date().toISOString(),
    updated_at:
      typeof value.updated_at === "string"
        ? value.updated_at
        : new Date().toISOString(),
  };
}

/**
 * Validates a parsed JSON value against the Breezify export format. Throws with
 * a descriptive message on any deviation. Only accepts the strict shape —
 * third-party JSON dumps will be rejected here.
 */
export function parseWorkspaceExport(value: unknown): WorkspaceExport {
  if (!isRecord(value)) {
    throw new Error("Export file must be a JSON object");
  }
  if (value.format !== EXPORT_FORMAT) {
    throw new Error(
      `Not a Breezify workspace export (expected format="${EXPORT_FORMAT}")`,
    );
  }
  if (value.format_version !== EXPORT_FORMAT_VERSION) {
    throw new Error(
      `Unsupported export format_version ${String(value.format_version)} — expected ${EXPORT_FORMAT_VERSION}`,
    );
  }
  if (!isRecord(value.source)) {
    throw new Error("Export is missing `source`");
  }
  if (!isRecord(value.workspace)) {
    throw new Error("Export is missing `workspace`");
  }
  if (!Array.isArray(value.folders)) {
    throw new Error("Export `folders` must be an array");
  }
  if (!Array.isArray(value.documents)) {
    throw new Error("Export `documents` must be an array");
  }

  const folders = value.folders.map(validateFolder);
  const documents = value.documents.map(validateDocument);
  const scope: ExportScope = value.scope === "folder" ? "folder" : "workspace";

  return {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    exported_at:
      typeof value.exported_at === "string"
        ? value.exported_at
        : new Date().toISOString(),
    source: {
      workspace_id: isNonEmptyString(value.source.workspace_id)
        ? value.source.workspace_id
        : "",
      workspace_slug:
        typeof value.source.workspace_slug === "string"
          ? value.source.workspace_slug
          : null,
      workspace_name: isNonEmptyString(value.source.workspace_name)
        ? value.source.workspace_name
        : "Unknown",
    },
    scope,
    scope_folder_id:
      typeof value.scope_folder_id === "string" ? value.scope_folder_id : null,
    workspace: {
      name: isNonEmptyString(value.workspace.name)
        ? value.workspace.name
        : "Imported Workspace",
      settings: isRecord(value.workspace.settings)
        ? (value.workspace.settings as WorkspaceSettings)
        : {},
    },
    folders,
    documents,
    counts: {
      folders: folders.length,
      documents: documents.length,
    },
  };
}
