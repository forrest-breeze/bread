-- Rebrand legacy column comments and drop the old hardcoded MCP audience.

COMMENT ON COLUMN public.github_hosted_docs_sources.publish_pull_request_head IS 'Bread-owned branch for the open ongoing workspace-publish PR.';
COMMENT ON COLUMN public.github_hosted_docs_sources.publish_last_commit_sha IS 'Last commit Bread wrote to the workspace-publish branch; guards reviewer edits.';
COMMENT ON COLUMN public.monitored_repos.sync_path IS 'Repository-relative folder indexed by Bread. Empty string means the repository root.';

-- The MCP access-token hook stamped OAuth tokens with a hardcoded
-- legacy-domain /api/mcp audience. This app no longer serves an MCP
-- endpoint, so pass tokens through unchanged. Signature and grants are kept,
-- so an Auth hook still pointing at it keeps working.
CREATE OR REPLACE FUNCTION public.mcp_access_token_hook(event jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
begin
  return event;
end;
$$;
