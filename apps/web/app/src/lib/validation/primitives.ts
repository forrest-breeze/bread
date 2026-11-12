import { z } from "zod"

export const uuidParamSchema = z.object({
  id: z.string().uuid(),
})

export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export const roleEnum = z.enum(["owner", "admin", "editor", "viewer"])
export type Role = z.infer<typeof roleEnum>

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/, "Invalid slug")

export const emailSchema = z.string().trim().toLowerCase().email().max(254)

// One portal project scope entry: a root folder id, or the wrapped shape that
// marks the folder as a PROMOTED root (its children surface as the portal's
// top-level sections). `rootOnly` keeps that structural root from implicitly
// including every descendant, so projects can select individual child trees;
// `explicitDocs` additionally drops the structural folder's own direct docs
// from the implicit set (they arrive as `{ doc }` entries instead).
// `{ doc }` includes a single document; `{ workspaceDocs: true }` includes
// workspace-level (folderless) docs. Mirrors PortalScopeEntry in @/lib/public-kb.
export const portalScopeEntrySchema = z.union([
  z.string().uuid(),
  z
    .object({
      id: z.string().uuid(),
      promote: z.boolean().optional(),
      rootOnly: z.boolean().optional(),
      explicitDocs: z.boolean().optional(),
    })
    .strict(),
  z.object({ doc: z.string().uuid() }).strict(),
  z.object({ workspaceDocs: z.literal(true) }).strict(),
])

export const nonEmptyTrimmedString = (max: number): z.ZodString =>
  z.string().trim().min(1).max(max)
