import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { refreshHostedDocumentIndex } from '../github-hosted-docs'
import { applyGitHubHostedDocumentUpdate } from '../github-hosted-document-update'
import { OPENAPI_OPERATION_KIND } from '../github-hosted-openapi'
import {
  deleteOpenApiSource,
  OPENAPI_UPLOAD_OPERATION_KIND,
  syncOpenApiSource,
} from '@/lib/openapi/openapi-source'
import type {
  ReadmeStore,
  ReadmeStoreDocument,
  ReadmeStoreFolder,
  ReadmeStoreSpec,
} from './readme-store'

const PAGE_SIZE = 200

/** Folders generated from an OpenAPI definition are never mirrored to GitHub. */
function isGeneratedFolderName(name: string): boolean {
  return name.startsWith('openapi-source-') || /^github-hosted-docs-\d+-openapi-/.test(name)
}

function isGeneratedDocument(row: {
  source: string
  source_metadata: Record<string, unknown> | null
}): boolean {
  const kind = row.source_metadata?.kind
  return (
    (row.source === 'GitHub' && kind === 'repository_file') ||
    kind === OPENAPI_OPERATION_KIND ||
    kind === OPENAPI_UPLOAD_OPERATION_KIND
  )
}

interface DocumentRow {
  id: string
  title: string
  content: string
  status: string | null
  source: string
  folder_id: string | null
  sort_order: number | null
  public_slug: string | null
  source_metadata: Record<string, unknown> | null
  updated_at: string | null
}

export function createSupabaseReadmeStore(
  admin: SupabaseClient,
  scope: { workspaceId: string; sourceId: string; repoId: number },
): ReadmeStore {
  const { workspaceId, sourceId, repoId } = scope

  async function loadFolders(): Promise<ReadmeStoreFolder[]> {
    const { data, error } = await admin
      .from('folders')
      .select(
        'id, name, display_name, parent_folder_id, sort_order, content, source_metadata, visibility, required_role',
      )
      .eq('workspace_id', workspaceId)
      .eq('kind', 'user')
    if (error) throw new Error(`readme folder list: ${error.message}`)
    const rows = (data ?? []) as Array<{
      id: string
      name: string
      display_name: string | null
      parent_folder_id: string | null
      sort_order: number | null
      content: string | null
      source_metadata: Record<string, unknown> | null
      visibility: string | null
      required_role: string | null
    }>
    // A restriction applies to everything below the folder that carries it.
    const restricted = new Set(
      rows
        .filter((row) => (row.visibility && row.visibility !== 'workspace') || row.required_role)
        .map((row) => row.id),
    )
    for (let pass = 0; pass < 64; pass++) {
      let grew = false
      for (const row of rows) {
        if (!restricted.has(row.id) && row.parent_folder_id && restricted.has(row.parent_folder_id)) {
          restricted.add(row.id)
          grew = true
        }
      }
      if (!grew) break
    }
    // A generated folder hides its whole subtree (the per-tag folders).
    const generated = new Set(
      rows.filter((row) => isGeneratedFolderName(row.name)).map((row) => row.id),
    )
    for (let pass = 0; pass < 8; pass++) {
      let grew = false
      for (const row of rows) {
        if (!generated.has(row.id) && row.parent_folder_id && generated.has(row.parent_folder_id)) {
          generated.add(row.id)
          grew = true
        }
      }
      if (!grew) break
    }
    return rows
      .filter((row) => !generated.has(row.id))
      .map((row) => ({
        id: row.id,
        name: row.name,
        displayName: row.display_name?.trim() || row.name,
        parentId: row.parent_folder_id,
        sortOrder: row.sort_order,
        content: row.content,
        metadata: row.source_metadata,
        restricted: restricted.has(row.id),
      }))
  }

  return {
    listFolders: loadFolders,

    async listDocuments(): Promise<ReadmeStoreDocument[]> {
      const folderIds = new Set((await loadFolders()).map((folder) => folder.id))
      const documents: ReadmeStoreDocument[] = []
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error } = await admin
          .from('documents')
          .select(
            'id, title, content, status, source, folder_id, sort_order, public_slug, source_metadata, updated_at',
          )
          .eq('workspace_id', workspaceId)
          .is('deleted_at', null)
          .in('document_type', ['source', 'page'])
          .order('id', { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1)
        if (error) throw new Error(`readme document list: ${error.message}`)
        const rows = (data ?? []) as DocumentRow[]
        for (const row of rows) {
          if (isGeneratedDocument(row)) continue
          if (row.folder_id !== null && !folderIds.has(row.folder_id)) continue
          documents.push({
            id: row.id,
            title: row.title,
            content: row.content,
            status: row.status,
            folderId: row.folder_id,
            sortOrder: row.sort_order,
            publicSlug: row.public_slug,
            metadata: row.source_metadata,
            updatedAt: row.updated_at,
          })
        }
        if (rows.length < PAGE_SIZE) break
      }
      return documents
    },

    async listPublicSlugs(): Promise<string[]> {
      const slugs: string[] = []
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await admin
          .from('documents')
          .select('public_slug')
          .eq('workspace_id', workspaceId)
          .not('public_slug', 'is', null)
          .order('id', { ascending: true })
          .range(offset, offset + 999)
        if (error) throw new Error(`readme slug list: ${error.message}`)
        const rows = (data ?? []) as Array<{ public_slug: string }>
        slugs.push(...rows.map((row) => row.public_slug))
        if (rows.length < 1000) break
      }
      return slugs
    },

    async listDeletedLinks() {
      const { data, error } = await admin
        .from('documents')
        .select('source_metadata')
        .eq('workspace_id', workspaceId)
        .not('deleted_at', 'is', null)
        .contains('source_metadata', {
          repo_id: repoId,
          repo_format: 'readme',
          github_hosted_sync: true,
        })
        .limit(1000)
      if (error) throw new Error(`readme deleted link list: ${error.message}`)
      return ((data ?? []) as Array<{ source_metadata: Record<string, unknown> | null }>).flatMap(
        (row) => {
          const path = row.source_metadata?.canonical_repo_path
          const blobSha = row.source_metadata?.github_hosted_checkpoint_blob_sha
          return typeof path === 'string'
            ? [{ path, blobSha: typeof blobSha === 'string' ? blobSha : null }]
            : []
        },
      )
    },

    async clearDeletedLinks(paths: string[]): Promise<void> {
      if (paths.length === 0) return
      const wanted = new Set(paths)
      const { data, error } = await admin
        .from('documents')
        .select('id, source_metadata')
        .eq('workspace_id', workspaceId)
        .not('deleted_at', 'is', null)
        .contains('source_metadata', {
          repo_id: repoId,
          repo_format: 'readme',
          github_hosted_sync: true,
        })
        .limit(1000)
      if (error) throw new Error(`readme deleted link lookup: ${error.message}`)
      for (const row of (data ?? []) as Array<{
        id: string
        source_metadata: Record<string, unknown> | null
      }>) {
        const path = row.source_metadata?.canonical_repo_path
        if (typeof path !== 'string' || !wanted.has(path)) continue
        const { error: updateError } = await admin
          .from('documents')
          .update({ source_metadata: { ...row.source_metadata, github_hosted_sync: false } })
          .eq('id', row.id)
          .eq('workspace_id', workspaceId)
        if (updateError) throw new Error(`readme deleted link clear: ${updateError.message}`)
      }
    },

    async createFolder(input): Promise<string> {
      const values = {
        display_name: input.displayName,
        parent_folder_id: input.parentId,
        sort_order: input.sortOrder,
        content: input.content,
        source_metadata: input.metadata,
      }
      const { data: existing, error: lookupError } = await admin
        .from('folders')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('kind', 'user')
        .eq('name', input.name)
        .maybeSingle()
      if (lookupError) throw new Error(`readme folder lookup: ${lookupError.message}`)
      if (existing) {
        const id = (existing as { id: string }).id
        const { error } = await admin
          .from('folders')
          .update(values)
          .eq('id', id)
          .eq('workspace_id', workspaceId)
        if (error) throw new Error(`readme folder update: ${error.message}`)
        return id
      }

      // A new directory takes the access policy of the folder it sits in.
      let visibility = 'workspace'
      let requiredRole: string | null = null
      if (input.parentId) {
        const { data: parent, error: parentError } = await admin
          .from('folders')
          .select('visibility, required_role')
          .eq('id', input.parentId)
          .eq('workspace_id', workspaceId)
          .maybeSingle()
        if (parentError) throw new Error(`readme folder parent lookup: ${parentError.message}`)
        const access = parent as { visibility?: unknown; required_role?: unknown } | null
        if (typeof access?.visibility === 'string') visibility = access.visibility
        if (typeof access?.required_role === 'string') requiredRole = access.required_role
      }
      const { data, error } = await admin
        .from('folders')
        .insert({
          workspace_id: workspaceId,
          kind: 'user',
          name: input.name,
          visibility,
          required_role: requiredRole,
          ...values,
        })
        .select('id')
        .single()
      if (error || !data) {
        throw new Error(`readme folder insert: ${error?.message ?? 'no row returned'}`)
      }
      return (data as { id: string }).id
    },

    async updateFolder(id, patch): Promise<void> {
      const values: Record<string, unknown> = {}
      if (patch.displayName !== undefined) values.display_name = patch.displayName
      if (patch.parentId !== undefined) values.parent_folder_id = patch.parentId
      if (patch.sortOrder !== undefined) values.sort_order = patch.sortOrder
      if (patch.content !== undefined) values.content = patch.content
      if (patch.metadata !== undefined) values.source_metadata = patch.metadata
      if (Object.keys(values).length === 0) return
      const { error } = await admin
        .from('folders')
        .update(values)
        .eq('id', id)
        .eq('workspace_id', workspaceId)
      if (error) throw new Error(`readme folder update: ${error.message}`)
    },

    async deleteFolder(id): Promise<void> {
      const { error } = await admin
        .from('folders')
        .delete()
        .eq('id', id)
        .eq('workspace_id', workspaceId)
      if (error) throw new Error(`readme folder delete: ${error.message}`)
    },

    async insertDocument(input): Promise<string> {
      const { data, error } = await admin
        .from('documents')
        .insert({
          workspace_id: workspaceId,
          title: input.title,
          content: input.content,
          document_type: 'page',
          public_slug: input.publicSlug,
          folder_id: input.folderId,
          sort_order: input.sortOrder,
          source: 'docs',
          status: input.status,
          author: 'GitHub',
          source_metadata: input.metadata,
        })
        .select('id')
        .single()
      if (error || !data) {
        throw new Error(`readme document insert: ${error?.message ?? 'no row returned'}`)
      }
      return (data as { id: string }).id
    },

    async updateDocument(id, patch): Promise<void> {
      const values: Record<string, unknown> = {}
      if (patch.status !== undefined) values.status = patch.status
      if (patch.folderId !== undefined) values.folder_id = patch.folderId
      if (patch.sortOrder !== undefined) values.sort_order = patch.sortOrder
      if (patch.metadata !== undefined) values.source_metadata = patch.metadata
      if (Object.keys(values).length === 0) return
      const { error } = await admin
        .from('documents')
        .update(values)
        .eq('id', id)
        .eq('workspace_id', workspaceId)
      if (error) throw new Error(`readme document update: ${error.message}`)
    },

    async applyDocumentContent(input): Promise<void> {
      await applyGitHubHostedDocumentUpdate(admin, {
        documentId: input.id,
        workspaceId,
        expectedTitle: input.expectedTitle,
        expectedContent: input.expectedContent,
        title: input.title,
        content: input.content,
        sourceMetadataPatch: input.metadataPatch,
        updatedAt: new Date().toISOString(),
      })
    },

    async softDeleteDocuments(ids): Promise<void> {
      if (ids.length === 0) return
      const now = new Date().toISOString()
      const { error } = await admin
        .from('documents')
        .update({ deleted_at: now, updated_at: now })
        .eq('workspace_id', workspaceId)
        .in('id', ids)
      if (error) throw new Error(`readme document removal: ${error.message}`)
    },

    refreshIndex(id, content): Promise<void> {
      return refreshHostedDocumentIndex(id, workspaceId, content)
    },

    async listSpecs(): Promise<ReadmeStoreSpec[]> {
      const { data, error } = await admin
        .from('openapi_sources')
        .select('slug, title, spec_raw, repo_path, repo_blob_sha, operation_count')
        .eq('workspace_id', workspaceId)
      if (error) throw new Error(`readme OpenAPI source list: ${error.message}`)
      return ((data ?? []) as Array<{
        slug: string
        title: string | null
        spec_raw: string | null
        repo_path: string | null
        repo_blob_sha: string | null
        operation_count: number | null
      }>).map((row) => ({
        slug: row.slug,
        title: row.title ?? '',
        specRaw: row.spec_raw,
        repoPath: row.repo_path,
        repoBlobSha: row.repo_blob_sha,
        operationCount: row.operation_count ?? 0,
      }))
    },

    async syncSpec(input) {
      const outcome = await syncOpenApiSource(admin, {
        workspaceId,
        slug: input.slug,
        raw: input.raw,
        syncedBy: input.syncedBy,
        repository: { path: input.repoPath, blobSha: input.repoBlobSha },
      })
      if (!outcome.ok) {
        const issue = outcome.issues[0]
        return {
          ok: false,
          issue: issue?.message,
          operationCount: 0,
          created: 0,
          updated: 0,
          removed: 0,
        }
      }
      return {
        ok: true,
        operationCount: outcome.result.operationCount,
        created: outcome.result.created,
        updated: outcome.result.updated,
        removed: outcome.result.removed,
      }
    },

    async setSpecRepository(slug, repository): Promise<void> {
      const { error } = await admin
        .from('openapi_sources')
        .update({ repo_path: repository.repoPath, repo_blob_sha: repository.repoBlobSha })
        .eq('workspace_id', workspaceId)
        .eq('slug', slug)
      if (error) throw new Error(`readme OpenAPI source link: ${error.message}`)
    },

    removeSpec(slug) {
      return deleteOpenApiSource(admin, { workspaceId, slug })
    },

    async updateSource(patch): Promise<void> {
      const { error } = await admin
        .from('github_hosted_docs_sources')
        .update(patch)
        .eq('id', sourceId)
        .eq('workspace_id', workspaceId)
      if (error) throw new Error(`readme source update: ${error.message}`)
    },
  }
}
