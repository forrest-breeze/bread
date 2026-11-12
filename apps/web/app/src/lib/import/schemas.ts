import { z } from "zod";

// ---------------------------------------------------------------------------
// Per-source schemas for import_jobs.source_config.
// JSONB is unvalidated at the DB layer; every importer Zod-parses here.
// ---------------------------------------------------------------------------

export const NotionConfigSchema = z.object({
  access_token: z.string().min(8),
  database_ids: z.array(z.string()).optional(),
  page_ids: z.array(z.string()).optional(),
  include_subpages: z.boolean().default(true),
});

export const ConfluenceConfigSchema = z.object({
  base_url: z.string().url(),
  email: z.string().email(),
  api_token: z.string().min(8),
  space_keys: z.array(z.string()).optional(),
});

export const ObsidianConfigSchema = z.object({
  upload_id: z.string().min(1),
});

// Website crawl + LLM synthesis. The crawler fetches a capped set of pages
// from the workspace's site and Gemini synthesizes starter docs from them.
// company_name tailors the generated content; it's optional so the importer
// degrades gracefully when onboarding skipped it.
export const WebsiteConfigSchema = z.object({
  url: z.string().url(),
  company_name: z.string().max(120).optional(),
});

export type NotionConfig = z.infer<typeof NotionConfigSchema>;
export type ConfluenceConfig = z.infer<typeof ConfluenceConfigSchema>;
export type ObsidianConfig = z.infer<typeof ObsidianConfigSchema>;
export type WebsiteConfig = z.infer<typeof WebsiteConfigSchema>;

export const CreateJobSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("notion"), source_config: NotionConfigSchema }),
  z.object({
    source: z.literal("confluence"),
    source_config: ConfluenceConfigSchema,
  }),
  z.object({
    source: z.literal("obsidian"),
    source_config: ObsidianConfigSchema,
  }),
  z.object({
    source: z.literal("website"),
    source_config: WebsiteConfigSchema,
  }),
]);

export type CreateJobInput = z.infer<typeof CreateJobSchema>;
