import type { PortalScopeEntry } from "@/lib/public-kb"

// ---------------------------------------------------------------------------
// Portal scope tree — the pure model behind the builder's "Project content"
// picker. The picker renders folders (and the documents inside them) as an
// expandable tree with tri-state checkboxes; this module owns the mapping
// between that tree and the stored PortalScopeEntry[] shape:
//
//   • string entry               → folder fully included (all descendants, all
//                                  docs, including future content)
//   • { id, rootOnly }           → structural folder: visible, own direct docs
//                                  included, descendants only when separately
//                                  listed
//   • { id, rootOnly,
//       explicitDocs }           → structural folder whose direct docs are
//                                  individually picked via { doc } entries
//   • { doc }                    → one document
//   • { workspaceDocs: true }    → workspace-level (folderless) documents
//   • { id, promote, rootOnly }  → the project ROOT (children surface as the
//                                  portal's top-level sections)
//
// Every mutation goes decode → edit → normalize → encode, so stored scopes stay
// canonical: a folder whose children are all fully included collapses back to a
// plain string entry, and a folder whose docs are all picked drops explicitDocs.
// ---------------------------------------------------------------------------

export interface ScopeTreeFolder {
  id: string
  parent_folder_id: string | null
}

export interface ScopeTreeDoc {
  id: string
  folder_id: string | null
}

export interface ScopeTreeContext {
  /** Portal-eligible folders (workspace-visible, user-kind), any order. */
  folders: ScopeTreeFolder[]
  /** Public-eligible documents (source/page, not trashed), any order. */
  docs: ScopeTreeDoc[]
  /** The project root folder id, or null for "entire workspace". */
  rootId: string | null
}

export type FolderCheckState = "full" | "partial" | "none"

interface ScopeModel {
  /** scope === null: everything, including future content. */
  all: boolean
  fullFolders: Set<string>
  /** Structural (rootOnly) folders, excluding the root itself. */
  partialFolders: Set<string>
  /** Folders (⊆ partialFolders) whose direct docs are picked individually. */
  explicitDocFolders: Set<string>
  /** Whether the ROOT's own direct docs are picked individually. */
  rootExplicitDocs: boolean
  docIds: Set<string>
  /** Workspace-level (folderless) docs fully included. */
  workspaceDocs: boolean
  /** Picked doc ids whose document is unknown to the context (kept verbatim). */
  unknownDocIds: Set<string>
}

interface TreeIndex {
  folderById: Map<string, ScopeTreeFolder>
  /** Children keyed by parent id; top-level (no eligible parent) under null. */
  childrenByParent: Map<string | null, string[]>
  docsByFolder: Map<string | null, string[]>
  docById: Map<string, ScopeTreeDoc>
}

function buildIndex(ctx: ScopeTreeContext): TreeIndex {
  const folderById = new Map(ctx.folders.map((folder) => [folder.id, folder]))
  const childrenByParent = new Map<string | null, string[]>()
  for (const folder of ctx.folders) {
    const parentKey =
      folder.parent_folder_id && folderById.has(folder.parent_folder_id)
        ? folder.parent_folder_id
        : null
    const list = childrenByParent.get(parentKey)
    if (list) list.push(folder.id)
    else childrenByParent.set(parentKey, [folder.id])
  }
  const docsByFolder = new Map<string | null, string[]>()
  const docById = new Map<string, ScopeTreeDoc>()
  for (const doc of ctx.docs) {
    docById.set(doc.id, doc)
    // Docs keep their raw folder key: a doc in an ineligible folder must NOT
    // fall back to the loose (null) group — it simply never renders.
    const key = doc.folder_id ?? null
    const list = docsByFolder.get(key)
    if (list) list.push(doc.id)
    else docsByFolder.set(key, [doc.id])
  }
  return { folderById, childrenByParent, docsByFolder, docById }
}

/** Every folder id in F's subtree, excluding F itself. */
function descendantsOf(index: TreeIndex, folderId: string): string[] {
  const out: string[] = []
  const queue = [...(index.childrenByParent.get(folderId) ?? [])]
  while (queue.length > 0) {
    const id = queue.shift() as string
    out.push(id)
    queue.push(...(index.childrenByParent.get(id) ?? []))
  }
  return out
}

/** Whether `folderId` is inside the tree spanned by ctx.rootId (root excluded). */
function isInTree(index: TreeIndex, rootId: string | null, folderId: string): boolean {
  if (folderId === rootId) return false
  if (rootId === null) return index.folderById.has(folderId)
  let cursor = index.folderById.get(folderId)
  let hops = 0
  while (cursor && hops < 64) {
    if (cursor.parent_folder_id === rootId) return true
    cursor = cursor.parent_folder_id ? index.folderById.get(cursor.parent_folder_id) : undefined
    hops += 1
  }
  return false
}

/** Ancestor folder ids of F strictly inside the tree (never the root itself). */
function ancestorsInTree(
  index: TreeIndex,
  rootId: string | null,
  folderId: string,
): string[] {
  const out: string[] = []
  let cursor = index.folderById.get(folderId)
  let hops = 0
  while (cursor && cursor.parent_folder_id && hops < 64) {
    if (cursor.parent_folder_id === rootId) break
    const parent = index.folderById.get(cursor.parent_folder_id)
    if (!parent) break
    out.push(parent.id)
    cursor = parent
    hops += 1
  }
  return out
}

function decode(scope: PortalScopeEntry[] | null, ctx: ScopeTreeContext, index: TreeIndex): ScopeModel {
  const model: ScopeModel = {
    all: scope === null,
    fullFolders: new Set(),
    partialFolders: new Set(),
    explicitDocFolders: new Set(),
    rootExplicitDocs: false,
    docIds: new Set(),
    workspaceDocs: scope === null,
    unknownDocIds: new Set(),
  }
  if (scope === null) return model

  let rootRecursive = false
  for (const entry of scope) {
    if (typeof entry === "object" && "doc" in entry) {
      if (index.docById.has(entry.doc)) model.docIds.add(entry.doc)
      else model.unknownDocIds.add(entry.doc)
      continue
    }
    if (typeof entry === "object" && "workspaceDocs" in entry) {
      model.workspaceDocs = true
      continue
    }
    const id = typeof entry === "string" ? entry : entry.id
    const rootOnly = typeof entry === "object" && entry.rootOnly === true
    const explicitDocs = typeof entry === "object" && entry.explicitDocs === true
    if (id === ctx.rootId) {
      if (explicitDocs) model.rootExplicitDocs = true
      // A plain (recursive) root entry is the legacy "whole folder" shape:
      // expand it to "all children fully included" so the tree can edit it.
      if (!rootOnly && !explicitDocs) rootRecursive = true
      continue
    }
    if (!isInTree(index, ctx.rootId, id)) continue
    if (rootOnly || explicitDocs) {
      model.partialFolders.add(id)
      if (explicitDocs) model.explicitDocFolders.add(id)
    } else {
      model.fullFolders.add(id)
    }
  }
  if (rootRecursive && ctx.rootId !== null) {
    for (const child of index.childrenByParent.get(ctx.rootId) ?? []) {
      model.fullFolders.add(child)
    }
  }
  return model
}

/** Whether F or any ancestor inside the tree is fully included. */
function isFullThroughAncestors(
  model: ScopeModel,
  index: TreeIndex,
  rootId: string | null,
  folderId: string,
): boolean {
  if (model.all) return true
  let cursor: string | undefined = folderId
  let hops = 0
  while (cursor && hops < 64) {
    if (model.fullFolders.has(cursor)) return true
    if (cursor === rootId) return false
    const folder = index.folderById.get(cursor)
    cursor = folder?.parent_folder_id ?? undefined
    hops += 1
  }
  return false
}

/** Whether F's subtree (folders below it, docs at or below it) has any picked content. */
function subtreeHasContent(model: ScopeModel, index: TreeIndex, folderId: string): boolean {
  const stack = [folderId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (id !== folderId && (model.fullFolders.has(id) || model.partialFolders.has(id))) {
      return true
    }
    for (const docId of index.docsByFolder.get(id) ?? []) {
      if (model.docIds.has(docId)) return true
    }
    stack.push(...(index.childrenByParent.get(id) ?? []))
  }
  return false
}

function folderStateOf(
  model: ScopeModel,
  index: TreeIndex,
  rootId: string | null,
  folderId: string,
): FolderCheckState {
  if (isFullThroughAncestors(model, index, rootId, folderId)) return "full"
  if (model.partialFolders.has(folderId)) return "partial"
  return subtreeHasContent(model, index, folderId) ? "partial" : "none"
}

function docCheckedOf(
  model: ScopeModel,
  index: TreeIndex,
  rootId: string | null,
  docId: string,
): boolean {
  if (model.all) return true
  const doc = index.docById.get(docId)
  if (!doc) return model.docIds.has(docId) || model.unknownDocIds.has(docId)
  const folderId = doc.folder_id && index.folderById.has(doc.folder_id) ? doc.folder_id : null
  if (folderId === null) {
    // Loose (workspace-level) doc — only reachable from the workspace root.
    return rootId === null && (model.workspaceDocs || model.docIds.has(docId))
  }
  if (folderId === rootId) {
    return model.rootExplicitDocs ? model.docIds.has(docId) : true
  }
  if (isFullThroughAncestors(model, index, rootId, folderId)) return true
  if (model.partialFolders.has(folderId)) {
    return model.explicitDocFolders.has(folderId) ? model.docIds.has(docId) : true
  }
  return false
}

/**
 * When scope === null (everything) the model has no explicit entries to edit.
 * Materialize the equivalent explicit selection so a single uncheck can be
 * applied: all top-level folders fully included + workspace docs on.
 */
function materializeAll(model: ScopeModel, index: TreeIndex, rootId: string | null): void {
  if (!model.all) return
  model.all = false
  model.workspaceDocs = true
  for (const id of index.childrenByParent.get(rootId ?? null) ?? []) {
    model.fullFolders.add(id)
  }
}

/** Remove every entry at or below F: folder marks and picked docs. */
function clearSubtree(model: ScopeModel, index: TreeIndex, folderId: string): void {
  for (const id of [folderId, ...descendantsOf(index, folderId)]) {
    model.fullFolders.delete(id)
    model.partialFolders.delete(id)
    model.explicitDocFolders.delete(id)
    for (const docId of index.docsByFolder.get(id) ?? []) {
      model.docIds.delete(docId)
    }
  }
}

/**
 * F is covered by a fully-included ancestor (possibly F itself). Demote that
 * chain so everything previously included stays included EXCEPT F's subtree:
 * each chain node becomes structural with implicit docs, its off-chain children
 * become fully included, and F is left unmarked for the caller to decide.
 */
function demoteCoveringChain(
  model: ScopeModel,
  index: TreeIndex,
  rootId: string | null,
  folderId: string,
): void {
  const chain = [folderId, ...ancestorsInTree(index, rootId, folderId)]
  const coverIndex = chain.findIndex((id) => model.fullFolders.has(id))
  if (coverIndex === -1) return
  for (let i = coverIndex; i >= 0; i -= 1) {
    const id = chain[i] as string
    model.fullFolders.delete(id)
    if (id !== folderId) {
      model.partialFolders.add(id)
      const onChainChild = chain[i - 1]
      for (const child of index.childrenByParent.get(id) ?? []) {
        if (child !== onChainChild) model.fullFolders.add(child)
      }
    }
  }
}

/** Ensure F's ancestors render it reachable: mark unmarked ones structural with picked docs. */
function materializeAncestors(
  model: ScopeModel,
  index: TreeIndex,
  rootId: string | null,
  folderId: string,
): void {
  for (const ancestor of ancestorsInTree(index, rootId, folderId)) {
    if (
      model.fullFolders.has(ancestor) ||
      model.partialFolders.has(ancestor)
    ) {
      continue
    }
    model.partialFolders.add(ancestor)
    model.explicitDocFolders.add(ancestor)
  }
}

/** Drop auto-materialized ancestors that no longer contain any picked content. */
function pruneEmptyAncestors(
  model: ScopeModel,
  index: TreeIndex,
  rootId: string | null,
  folderId: string,
): void {
  for (const ancestor of ancestorsInTree(index, rootId, folderId)) {
    if (!model.partialFolders.has(ancestor)) continue
    // Implicit-doc structural folders still serve their own docs — keep them.
    if (!model.explicitDocFolders.has(ancestor)) continue
    if (subtreeHasContent(model, index, ancestor)) continue
    model.partialFolders.delete(ancestor)
    model.explicitDocFolders.delete(ancestor)
  }
}

/** Folders of the tree ordered deepest-first (children before parents). */
function foldersDeepestFirst(index: TreeIndex, rootId: string | null): string[] {
  const out: string[] = []
  const visit = (id: string): void => {
    for (const child of index.childrenByParent.get(id) ?? []) visit(child)
    out.push(id)
  }
  for (const top of index.childrenByParent.get(rootId ?? null) ?? []) visit(top)
  return out
}

function normalize(model: ScopeModel, index: TreeIndex, ctx: ScopeTreeContext): void {
  if (model.all) return
  for (const id of foldersDeepestFirst(index, ctx.rootId)) {
    if (model.explicitDocFolders.has(id)) {
      const docs = index.docsByFolder.get(id) ?? []
      if (docs.length > 0 && docs.every((docId) => model.docIds.has(docId))) {
        for (const docId of docs) model.docIds.delete(docId)
        model.explicitDocFolders.delete(id)
      }
    }
    if (model.partialFolders.has(id) && !model.explicitDocFolders.has(id)) {
      const children = index.childrenByParent.get(id) ?? []
      if (children.every((child) => model.fullFolders.has(child))) {
        model.partialFolders.delete(id)
        model.fullFolders.add(id)
        for (const child of children) model.fullFolders.delete(child)
      }
    }
  }
  if (model.rootExplicitDocs) {
    const rootDocs = index.docsByFolder.get(ctx.rootId ?? null) ?? []
    const relevant = ctx.rootId === null ? [] : rootDocs
    if (relevant.length > 0 && relevant.every((docId) => model.docIds.has(docId))) {
      for (const docId of relevant) model.docIds.delete(docId)
      model.rootExplicitDocs = false
    }
  }
  if (ctx.rootId === null) {
    const looseDocs = index.docsByFolder.get(null) ?? []
    if (
      !model.workspaceDocs &&
      looseDocs.length > 0 &&
      looseDocs.every((docId) => model.docIds.has(docId))
    ) {
      for (const docId of looseDocs) model.docIds.delete(docId)
      model.workspaceDocs = true
    }
    // Everything checked at the workspace root collapses back to "entire
    // workspace" (scope null) — including future content, which is what a
    // fully-checked tree reads as.
    const topLevel = index.childrenByParent.get(null) ?? []
    if (
      topLevel.every((id) => model.fullFolders.has(id)) &&
      (model.workspaceDocs || looseDocs.length === 0) &&
      model.partialFolders.size === 0 &&
      model.docIds.size === 0 &&
      model.unknownDocIds.size === 0
    ) {
      model.all = true
    }
  }
}

function encode(model: ScopeModel, ctx: ScopeTreeContext): PortalScopeEntry[] | null {
  if (model.all) return null
  const folderEntries: PortalScopeEntry[] = []
  if (ctx.rootId !== null) {
    folderEntries.push({
      id: ctx.rootId,
      promote: true,
      rootOnly: true,
      ...(model.rootExplicitDocs ? { explicitDocs: true } : {}),
    })
  }
  for (const id of Array.from(model.fullFolders).sort()) folderEntries.push(id)
  for (const id of Array.from(model.partialFolders).sort()) {
    folderEntries.push({
      id,
      rootOnly: true,
      ...(model.explicitDocFolders.has(id) ? { explicitDocs: true } : {}),
    })
  }
  const docEntries: PortalScopeEntry[] = Array.from(
    new Set([...model.docIds, ...model.unknownDocIds]),
  )
    .sort()
    .map((doc) => ({ doc }))
  return [
    ...folderEntries,
    ...docEntries,
    ...(model.workspaceDocs && ctx.rootId === null
      ? [{ workspaceDocs: true } as PortalScopeEntry]
      : []),
  ]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScopeTreeView {
  /** Tri-state of a folder row in the picker tree. */
  folderState: (folderId: string) => FolderCheckState
  /** Whether a document row is checked. */
  docChecked: (docId: string) => boolean
  /** Tri-state of the "documents without a folder" group (workspace root only). */
  workspaceDocsState: () => FolderCheckState
}

/** Stable client-side equality key for draft scope reconciliation. */
export function scopeKey(scope: PortalScopeEntry[] | null | undefined): string {
  if (scope == null) return "all"
  if (scope.length === 0) return "empty"
  return scope
    .map((entry) => {
      if (typeof entry === "string") return entry
      if ("id" in entry) {
        return `${entry.id}${entry.promote ? "!" : ""}${entry.rootOnly ? "~" : ""}${entry.explicitDocs ? "^" : ""}`
      }
      if ("doc" in entry) return `doc:${entry.doc}`
      return "workspace-docs"
    })
    .sort()
    .join(",")
}

/**
 * Read-only view over one (scope, ctx) pair. Builds the tree index and decodes
 * the scope once, so per-row state reads are cheap — memoize it in the UI.
 */
export function createScopeTreeView(
  scope: PortalScopeEntry[] | null,
  ctx: ScopeTreeContext,
): ScopeTreeView {
  const index = buildIndex(ctx)
  const model = decode(scope, ctx, index)
  return {
    folderState: (folderId) => folderStateOf(model, index, ctx.rootId, folderId),
    docChecked: (docId) => docCheckedOf(model, index, ctx.rootId, docId),
    workspaceDocsState: () => {
      if (model.all || model.workspaceDocs) return "full"
      const looseDocs = index.docsByFolder.get(null) ?? []
      return looseDocs.some((docId) => model.docIds.has(docId)) ? "partial" : "none"
    },
  }
}

/** Tri-state of a folder row in the picker tree. */
export function folderCheckState(
  scope: PortalScopeEntry[] | null,
  ctx: ScopeTreeContext,
  folderId: string,
): FolderCheckState {
  return createScopeTreeView(scope, ctx).folderState(folderId)
}

/** Whether a document row is checked. */
export function docChecked(
  scope: PortalScopeEntry[] | null,
  ctx: ScopeTreeContext,
  docId: string,
): boolean {
  return createScopeTreeView(scope, ctx).docChecked(docId)
}

export function toggleFolder(
  scope: PortalScopeEntry[] | null,
  ctx: ScopeTreeContext,
  folderId: string,
): PortalScopeEntry[] | null {
  const index = buildIndex(ctx)
  const model = decode(scope, ctx, index)
  materializeAll(model, index, ctx.rootId)
  const state = folderStateOf(model, index, ctx.rootId, folderId)
  if (state === "none") {
    clearSubtree(model, index, folderId)
    model.fullFolders.add(folderId)
    materializeAncestors(model, index, ctx.rootId, folderId)
  } else {
    demoteCoveringChain(model, index, ctx.rootId, folderId)
    clearSubtree(model, index, folderId)
    pruneEmptyAncestors(model, index, ctx.rootId, folderId)
  }
  normalize(model, index, ctx)
  return encode(model, ctx)
}

export function toggleDoc(
  scope: PortalScopeEntry[] | null,
  ctx: ScopeTreeContext,
  docId: string,
): PortalScopeEntry[] | null {
  const index = buildIndex(ctx)
  const doc = index.docById.get(docId)
  if (!doc) return scope
  const model = decode(scope, ctx, index)
  materializeAll(model, index, ctx.rootId)
  const folderId = doc.folder_id && index.folderById.has(doc.folder_id) ? doc.folder_id : null
  const checked = docCheckedOf(model, index, ctx.rootId, docId)

  if (checked) {
    if (model.docIds.has(docId)) {
      model.docIds.delete(docId)
      if (folderId) pruneEmptyAncestors(model, index, ctx.rootId, folderId)
      // An explicitDocs folder that just lost its last picked doc may itself be
      // prunable — pruneEmptyAncestors only walks ancestors, so check F here.
      if (
        folderId &&
        model.explicitDocFolders.has(folderId) &&
        !subtreeHasContent(model, index, folderId)
      ) {
        model.partialFolders.delete(folderId)
        model.explicitDocFolders.delete(folderId)
        pruneEmptyAncestors(model, index, ctx.rootId, folderId)
      }
    } else if (folderId === null) {
      // Implicitly checked via the workspace-docs group: materialize the rest.
      model.workspaceDocs = false
      for (const other of index.docsByFolder.get(null) ?? []) {
        if (other !== docId) model.docIds.add(other)
      }
    } else if (folderId === ctx.rootId) {
      model.rootExplicitDocs = true
      for (const other of index.docsByFolder.get(folderId) ?? []) {
        if (other !== docId) model.docIds.add(other)
      }
    } else if (
      model.partialFolders.has(folderId) &&
      !model.explicitDocFolders.has(folderId)
    ) {
      model.explicitDocFolders.add(folderId)
      for (const other of index.docsByFolder.get(folderId) ?? []) {
        if (other !== docId) model.docIds.add(other)
      }
    } else {
      // Implicitly checked via a fully-included folder (possibly an ancestor).
      demoteCoveringChain(model, index, ctx.rootId, folderId)
      model.partialFolders.add(folderId)
      model.explicitDocFolders.add(folderId)
      for (const child of index.childrenByParent.get(folderId) ?? []) {
        model.fullFolders.add(child)
      }
      for (const other of index.docsByFolder.get(folderId) ?? []) {
        if (other !== docId) model.docIds.add(other)
      }
    }
  } else {
    model.docIds.add(docId)
    if (folderId && folderId !== ctx.rootId) {
      // The doc was unchecked, so its folder can't be fully included — make it
      // structural with picked docs if it isn't already marked.
      if (!model.partialFolders.has(folderId)) {
        model.partialFolders.add(folderId)
        model.explicitDocFolders.add(folderId)
      }
      materializeAncestors(model, index, ctx.rootId, folderId)
    }
  }
  normalize(model, index, ctx)
  return encode(model, ctx)
}

/** Toggle the whole "documents without a folder" group (workspace root only). */
export function toggleWorkspaceDocs(
  scope: PortalScopeEntry[] | null,
  ctx: ScopeTreeContext,
): PortalScopeEntry[] | null {
  const index = buildIndex(ctx)
  const model = decode(scope, ctx, index)
  materializeAll(model, index, ctx.rootId)
  const looseDocs = index.docsByFolder.get(null) ?? []
  // Checked → clear the group; partial or none → check the whole group. Either
  // way individual loose picks dissolve into the group state.
  model.workspaceDocs = !model.workspaceDocs
  for (const docId of looseDocs) model.docIds.delete(docId)
  normalize(model, index, ctx)
  return encode(model, ctx)
}

/** Default scope when the user picks a project root: everything inside it. */
export function scopeForRoot(
  ctx: Pick<ScopeTreeContext, "folders">,
  rootId: string | null,
): PortalScopeEntry[] | null {
  if (rootId === null) return null
  const index = buildIndex({ folders: ctx.folders, docs: [], rootId })
  const children = (index.childrenByParent.get(rootId) ?? []).sort()
  return [{ id: rootId, promote: true, rootOnly: true }, ...children]
}

/**
 * The root folder a stored scope is anchored to — the folder the builder's
 * pickers open at, and the boundary a page's own scope is chosen within.
 *
 * An explicit `{ promote, rootOnly }` entry (what scopeForRoot writes) is the
 * answer whenever there is one. Scopes stored before roots existed carry no
 * such marker, so two legacy shapes are recognized rather than dropping the
 * user into "entire workspace": several folders that all share one parent
 * (that parent is the root), and a single included folder (it is the root).
 */
export function resolveScopeRootId(
  scope: PortalScopeEntry[] | null | undefined,
  folders: ScopeTreeFolder[],
): string | null {
  if (!Array.isArray(scope)) return null
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const folderIds: string[] = []
  let explicitRootId: string | null = null
  let promotedId: string | null = null
  let promotedCount = 0

  for (const entry of scope) {
    if (typeof entry === "object" && !("id" in entry)) continue
    const id = typeof entry === "string" ? entry : entry.id
    if (!byId.has(id)) continue
    folderIds.push(id)
    if (typeof entry === "string") continue
    if (entry.rootOnly === true && explicitRootId === null) explicitRootId = id
    if (entry.promote === true) {
      promotedId = id
      promotedCount += 1
    }
  }
  if (explicitRootId) return explicitRootId
  if (promotedCount === 1 && promotedId) return promotedId
  if (folderIds.length === 1) return folderIds[0] ?? null

  const sharedParent = folderIds[0]
    ? byId.get(folderIds[0])?.parent_folder_id ?? null
    : null
  if (
    sharedParent !== null &&
    folderIds.length > 1 &&
    folderIds.every((id) => byId.get(id)?.parent_folder_id === sharedParent)
  ) {
    return sharedParent
  }
  return null
}
