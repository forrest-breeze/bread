import { z } from "zod"
import { dslNodeStructuralSchema } from "@/lib/portal/dsl/node"
import { portalLayoutSchema, PORTAL_ICONS } from "@/lib/portal/schema"

const generatedReplyShape = {
  sidebarIcon: z.enum(PORTAL_ICONS).optional(),
  // The layout is the durable result. Accept a verbose provider summary and
  // bound it after validation so excess prose cannot discard a valid portal.
  reply: z.string().optional(),
}

/**
 * AI-generated portals must use the open component-tree format. Requiring the
 * tree at the model boundary prevents generation from silently degrading to
 * the fixed hero/category/list docs default.
 */
export const generatedPortalSchema = z.object({
  layout: portalLayoutSchema.omit({ sidebar: true }).extend({
    schemaVersion: z.literal(2),
    tree: dslNodeStructuralSchema,
  }),
  ...generatedReplyShape,
})
