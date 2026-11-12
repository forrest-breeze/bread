-- Baseline for the Breeze build (Bread). Generated with pg_dump from the
-- live Bread project (jzpefsnshwsvxveavviz) on 2026-11-12 and replaces the
-- old Sophic migration chain, which could not rebuild an empty database.
-- New schema changes go in new migrations after this one.

create extension if not exists ltree with schema public;
create extension if not exists pg_trgm with schema public;
create extension if not exists vector with schema extensions;
create extension if not exists pg_cron;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11
-- Dumped by pg_dump version 18.7

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

-- COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: github_hosted_docs_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_hosted_docs_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    installation_id bigint NOT NULL,
    repo_full_name text NOT NULL,
    repo_id bigint NOT NULL,
    paths text[] DEFAULT '{}'::text[] NOT NULL,
    root_folder_id uuid,
    sync_status text DEFAULT 'pending'::text NOT NULL,
    document_count integer DEFAULT 0 NOT NULL,
    conflict_count integer DEFAULT 0 NOT NULL,
    last_sync_commit_sha text,
    last_sync_at timestamp with time zone,
    last_sync_error text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pending_sync_mode text DEFAULT 'merge'::text NOT NULL,
    pending_pull_request_number integer,
    pending_pull_request_url text,
    pending_pull_request_head text,
    publish_pull_request_number integer,
    publish_pull_request_url text,
    publish_pull_request_head text,
    publish_last_commit_sha text,
    publish_operation_id uuid,
    publish_operation_started_at timestamp with time zone,
    CONSTRAINT github_hosted_docs_sources_conflict_count_check CHECK ((conflict_count >= 0)),
    CONSTRAINT github_hosted_docs_sources_document_count_check CHECK ((document_count >= 0)),
    CONSTRAINT github_hosted_docs_sources_pending_pull_request_number_check CHECK ((pending_pull_request_number > 0)),
    CONSTRAINT github_hosted_docs_sources_pending_sync_mode_check CHECK ((pending_sync_mode = ANY (ARRAY['merge'::text, 'replace_sophic'::text]))),
    CONSTRAINT github_hosted_docs_sources_publish_pull_request_number_check CHECK ((publish_pull_request_number > 0)),
    CONSTRAINT github_hosted_docs_sources_sync_status_check CHECK ((sync_status = ANY (ARRAY['disabled'::text, 'pending'::text, 'syncing'::text, 'synced'::text, 'error'::text])))
);


--
-- Name: COLUMN github_hosted_docs_sources.pending_pull_request_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.github_hosted_docs_sources.pending_pull_request_number IS 'Activation PR whose merge enables the hosted-docs root.';


--
-- Name: COLUMN github_hosted_docs_sources.publish_pull_request_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.github_hosted_docs_sources.publish_pull_request_number IS 'Open ongoing workspace-publish PR; independent from activation and sync cleanup.';


--
-- Name: COLUMN github_hosted_docs_sources.publish_pull_request_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.github_hosted_docs_sources.publish_pull_request_url IS 'Browser URL for the open ongoing workspace-publish PR.';


--
-- Name: COLUMN github_hosted_docs_sources.publish_pull_request_head; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.github_hosted_docs_sources.publish_pull_request_head IS 'Sophic-owned branch for the open ongoing workspace-publish PR.';


--
-- Name: COLUMN github_hosted_docs_sources.publish_last_commit_sha; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.github_hosted_docs_sources.publish_last_commit_sha IS 'Last commit Sophic wrote to the workspace-publish branch; guards reviewer edits.';


--
-- Name: COLUMN github_hosted_docs_sources.publish_operation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.github_hosted_docs_sources.publish_operation_id IS 'Short-lived server lease serializing workspace publish requests.';


--
-- Name: COLUMN github_hosted_docs_sources.publish_operation_started_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.github_hosted_docs_sources.publish_operation_started_at IS 'Lease start time; abandoned operations become recoverable after ten minutes.';


--
-- Name: acquire_github_hosted_docs_publish_lease(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.acquire_github_hosted_docs_publish_lease(p_source_id uuid, p_workspace_id uuid, p_operation_id uuid) RETURNS SETOF public.github_hosted_docs_sources
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
  update public.github_hosted_docs_sources
  set
    publish_operation_id = p_operation_id,
    publish_operation_started_at = now()
  where id = p_source_id
    and workspace_id = p_workspace_id
    and (
      publish_operation_id is null
      or publish_operation_started_at is null
      or publish_operation_started_at < now() - interval '10 minutes'
    )
  returning *;
$$;


--
-- Name: apply_github_hosted_document_update(uuid, uuid, text, text, text, text, jsonb, timestamp with time zone, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_github_hosted_document_update(p_document_id uuid, p_workspace_id uuid, p_expected_title text, p_expected_content text, p_title text, p_content text, p_source_metadata_patch jsonb, p_updated_at timestamp with time zone, p_require_conflict boolean DEFAULT false) RETURNS TABLE(applied boolean, snapshot_created boolean, head_changed boolean, stale boolean)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  v_document public.documents%rowtype;
  v_snapshot_id uuid;
begin
  if p_title is null or p_content is null then
    raise exception 'GitHub-hosted document title and content must not be null'
      using errcode = '22004';
  end if;

  if p_source_metadata_patch is not null
     and jsonb_typeof(p_source_metadata_patch) <> 'object' then
    raise exception 'GitHub-hosted document metadata patch must be a JSON object'
      using errcode = '22023';
  end if;

  select d.*
    into v_document
    from public.documents as d
   where d.id = p_document_id
     and d.workspace_id = p_workspace_id
   for update;

  if not found then
    applied := false;
    snapshot_created := false;
    head_changed := false;
    stale := true;
    return next;
    return;
  end if;

  -- Conflict resolution is a compare-and-set operation. Even an already
  -- matching head must not turn a second resolver into a fresh success after
  -- another request has cleared the conflict marker.
  if coalesce(p_require_conflict, false)
     and not coalesce(
       v_document.source_metadata @> '{"github_hosted_conflict": true}'::jsonb,
       false
     ) then
    applied := false;
    snapshot_created := false;
    head_changed := false;
    stale := true;
    return next;
    return;
  end if;

  -- A completed call may be delivered again with the old expected head. Treat
  -- the already-applied head as success and refresh only sync bookkeeping.
  if v_document.title is not distinct from p_title
     and v_document.content is not distinct from p_content then
    update public.documents
       set source_metadata = coalesce(v_document.source_metadata, '{}'::jsonb)
                             || coalesce(p_source_metadata_patch, '{}'::jsonb),
           status = 'Published',
           deleted_at = null,
           updated_at = coalesce(p_updated_at, now())
     where id = v_document.id
       and workspace_id = v_document.workspace_id;

    applied := true;
    snapshot_created := false;
    head_changed := false;
    stale := false;
    return next;
    return;
  end if;

  if v_document.title is distinct from p_expected_title
     or v_document.content is distinct from p_expected_content then
    applied := false;
    snapshot_created := false;
    head_changed := false;
    stale := true;
    return next;
    return;
  end if;

  -- Store the state the user could see immediately before GitHub replaced it.
  -- On unpaid workspaces document_versions_skip_free suppresses this insert;
  -- RETURNING then leaves v_snapshot_id null and the document update proceeds.
  insert into public.document_versions (
    document_id,
    workspace_id,
    title,
    content,
    edited_by,
    source
  ) values (
    v_document.id,
    v_document.workspace_id,
    v_document.title,
    v_document.content,
    null,
    'github'
  )
  returning id into v_snapshot_id;

  update public.documents
     set title = p_title,
         content = p_content,
         source_metadata = coalesce(v_document.source_metadata, '{}'::jsonb)
                           || coalesce(p_source_metadata_patch, '{}'::jsonb),
         status = 'Published',
         deleted_at = null,
         updated_at = coalesce(p_updated_at, now())
   where id = v_document.id
     and workspace_id = v_document.workspace_id;

  applied := true;
  snapshot_created := v_snapshot_id is not null;
  head_changed := true;
  stale := false;
  return next;
end;
$$;


--
-- Name: FUNCTION apply_github_hosted_document_update(p_document_id uuid, p_workspace_id uuid, p_expected_title text, p_expected_content text, p_title text, p_content text, p_source_metadata_patch jsonb, p_updated_at timestamp with time zone, p_require_conflict boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.apply_github_hosted_document_update(p_document_id uuid, p_workspace_id uuid, p_expected_title text, p_expected_content text, p_title text, p_content text, p_source_metadata_patch jsonb, p_updated_at timestamp with time zone, p_require_conflict boolean) IS 'Atomically snapshots and applies a GitHub-hosted curated document update, with expected-head drift protection and idempotent retry behavior.';


--
-- Name: before_user_created_breeze_only(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.before_user_created_breeze_only(event jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if public.is_breeze_email(event -> 'user' ->> 'email') then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'Only Breeze accounts (@breeze.com or @breeze.cash) can sign in.'));
end;
$$;


--
-- Name: can_access_folder(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_access_folder(f_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1
    from public.folders f
    where f.id = f_id
      and (
        ((select auth.role()) = 'service_role' and f.visibility = 'workspace')
        or (
          f.workspace_id in (select public.get_user_workspace_ids())
          and (
            f.visibility = 'workspace'
            or (
              f.visibility = 'role'
              and exists (
                select 1
                from public.workspace_members wm
                where wm.workspace_id = f.workspace_id
                  and wm.user_id = (select auth.uid())
                  and public.role_rank(wm.role) >= public.role_rank(f.required_role)
              )
            )
          )
        )
      )
  );
$$;


--
-- Name: check_folder_parent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_folder_parent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  parent_kind text;
  parent_ws uuid;
begin
  if new.parent_folder_id is null then
    return new;
  end if;

  if new.kind <> 'user' then
    raise exception 'Only user folders can be nested (kind=%)', new.kind;
  end if;

  select kind, workspace_id
    into parent_kind, parent_ws
    from public.folders
   where id = new.parent_folder_id;

  if parent_kind is null then
    raise exception 'Parent folder % not found', new.parent_folder_id;
  end if;

  if parent_kind <> 'user' then
    raise exception 'Parent folder must be a user folder (got kind=%)', parent_kind;
  end if;

  if parent_ws <> new.workspace_id then
    raise exception 'Parent folder must be in the same workspace';
  end if;

  -- Cycle prevention: walk up the ancestor chain and abort on a hit.
  declare
    cursor_id uuid := new.parent_folder_id;
    depth int := 0;
  begin
    while cursor_id is not null and depth < 64 loop
      if cursor_id = new.id then
        raise exception 'Folder hierarchy would form a cycle';
      end if;
      select parent_folder_id into cursor_id
        from public.folders where id = cursor_id;
      depth := depth + 1;
    end loop;
    if depth >= 64 then
      raise exception 'Folder hierarchy exceeds maximum depth';
    end if;
  end;

  return new;
end;
$$;


--
-- Name: chunk_tsv_refresh(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.chunk_tsv_refresh() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  h text;
begin
  select coalesce(ds.heading_title, '')
    into h
  from public.document_section ds
  where ds.id = new.section_id;

  new.tsv :=
    setweight(to_tsvector('english', coalesce(h, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.content, '')), 'B');

  return new;
end;
$$;


--
-- Name: cleanup_stale_conversations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_stale_conversations() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  deleted_count integer;
begin
  delete from public.conversations
  where updated_at < now() - interval '90 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;


--
-- Name: cleanup_webhook_deliveries(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_webhook_deliveries(retention_days integer DEFAULT 30) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  deleted_count integer;
begin
  if retention_days is null or retention_days <= 0 then
    raise exception
      'cleanup_webhook_deliveries: retention_days must be > 0 (got %)',
      retention_days;
  end if;

  delete from public.webhook_deliveries
  where received_at < now() - make_interval(days => retention_days);

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;


--
-- Name: FUNCTION cleanup_webhook_deliveries(retention_days integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cleanup_webhook_deliveries(retention_days integer) IS 'Deletes webhook deliveries older than retention_days (default 30). Scheduled nightly by pg_cron and restricted to service_role.';


--
-- Name: consume_media_upload_slot(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.consume_media_upload_slot(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_now timestamptz := clock_timestamp();
  v_rows integer;
begin
  insert into public.media_upload_rate_limits (
    user_id, window_started_at, request_count, updated_at
  ) values (
    p_user_id, v_now, 1, v_now
  )
  on conflict (user_id) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    return true;
  end if;

  update public.media_upload_rate_limits
     set window_started_at = case
           when window_started_at <= v_now - interval '1 hour' then v_now
           else window_started_at
         end,
         request_count = case
           when window_started_at <= v_now - interval '1 hour' then 1
           else request_count + 1
         end,
         updated_at = v_now
   where user_id = p_user_id
     and (
       window_started_at <= v_now - interval '1 hour'
       or request_count < 30
     );

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;


--
-- Name: FUNCTION consume_media_upload_slot(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.consume_media_upload_slot(p_user_id uuid) IS 'Atomically allows at most 30 new signed media upload URLs per user per fixed one-hour window.';


--
-- Name: delete_orphaned_workspaces(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_orphaned_workspaces(p_workspace_ids uuid[]) RETURNS SETOF uuid
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  delete from public.workspaces w
  where w.id = any(p_workspace_ids)
    and not exists (
      select 1
      from public.workspace_members m
      where m.workspace_id = w.id
        and m.status = 'active'
    )
  returning w.id;
$$;


--
-- Name: delete_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_user() RETURNS void
    LANGUAGE plpgsql
    AS $$DECLARE
    current_user_id UUID;
BEGIN
    -- Get the current user's ID
    current_user_id := auth.uid();
    DELETE FROM auth.users WHERE id = current_user_id;
END;$$;


--
-- Name: delete_workspace_if_no_active_members(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_workspace_if_no_active_members() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if exists (select 1 from public.workspaces where id = old.workspace_id)
     and not exists (select 1 from public.workspace_members where workspace_id = old.workspace_id and status = 'active')
  then delete from public.workspaces where id = old.workspace_id; end if;
  return old;
end; $$;


--
-- Name: enforce_breeze_auth_email(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_breeze_auth_email() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.is_breeze_email(new.email) then
    raise exception 'Only Breeze accounts (@breeze.com or @breeze.cash) can sign in.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;


--
-- Name: enforce_free_document_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_free_document_limit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_document_count int;
begin
  if coalesce(new.document_type, 'source') not in ('source', 'page') then
    return new;
  end if;

  if new.deleted_at is not null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.workspace_id = new.workspace_id
     and old.deleted_at is null
     and coalesce(old.document_type, 'source') in ('source', 'page') then
    return new;
  end if;

  if public.workspace_has_paid_subscription(new.workspace_id) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.workspace_id::text));

  select count(*)
    into v_document_count
    from public.documents d
   where d.workspace_id = new.workspace_id
     and d.deleted_at is null
     and d.document_type in ('source', 'page');

  if v_document_count >= 50 then
    raise exception 'Free plan document limit reached (50 documents). Upgrade to add more documents.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;


--
-- Name: FUNCTION enforce_free_document_limit(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.enforce_free_document_limit() IS 'Before-insert/update trigger for documents: unpaid workspaces are capped at 50 active source/page documents.';


--
-- Name: enforce_kb_capacity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_kb_capacity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_tier text;
  v_plan_id text;
  v_status text;
  v_doc_limit int := 25;            -- free
  v_byte_limit bigint := 5242880;   -- free: 5 MB
  v_count int;
  v_existing_bytes bigint;
  v_new_bytes bigint;
begin
  select s.tier, s.plan_id, s.status
    into v_tier, v_plan_id, v_status
    from public.subscriptions s
   where s.workspace_id = NEW.workspace_id;

  if found and v_status in ('active', 'trialing') then
    if v_tier = 'enterprise' or v_plan_id in ('business', 'enterprise') then
      v_doc_limit := null;
      v_byte_limit := null;
    elsif v_plan_id = 'basic' then
      v_doc_limit := 1000;
      v_byte_limit := 262144000;    -- 250 MB
    end if;
  end if;

  -- Unlimited plan — nothing to check.
  if v_doc_limit is null and v_byte_limit is null then
    return NEW;
  end if;

  if v_doc_limit is not null then
    select count(*) into v_count
      from public.documents
     where workspace_id = NEW.workspace_id
       and deleted_at is null;
    if v_count >= v_doc_limit then
      raise exception 'KB_CAPACITY:document_limit:%', v_doc_limit
        using errcode = 'check_violation';
    end if;
  end if;

  if v_byte_limit is not null then
    v_new_bytes := coalesce(octet_length(NEW.content), 0)
                 + coalesce(octet_length(NEW.title), 0)
                 + coalesce(pg_column_size(NEW.embedding), 0);
    select
      coalesce((
        select sum(
          coalesce(octet_length(d.content), 0)
          + coalesce(pg_column_size(d.embedding), 0)
          + coalesce(octet_length(d.title), 0)
        )
        from public.documents d
        where d.workspace_id = NEW.workspace_id and d.deleted_at is null
      ), 0)
      + coalesce((
        select sum(
          coalesce(octet_length(v.content), 0)
          + coalesce(octet_length(v.title), 0)
        )
        from public.document_versions v
        where v.workspace_id = NEW.workspace_id
      ), 0)
      into v_existing_bytes;
    if v_existing_bytes + v_new_bytes > v_byte_limit then
      raise exception 'KB_CAPACITY:storage_limit:%', v_byte_limit
        using errcode = 'check_violation';
    end if;
  end if;

  return NEW;
end;
$$;


--
-- Name: enforce_workspace_media_storage_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_workspace_media_storage_limit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_delta bigint;
  v_limit bigint;
  v_used bigint;
begin
  if tg_op = 'DELETE' then
    update public.workspace_media_usage
       set bytes_used = greatest(0, bytes_used - old.byte_size),
           updated_at = now()
     where workspace_id = old.workspace_id;
    return old;
  end if;

  if new.byte_size <= 0 then
    raise exception 'Media byte size must be positive.' using errcode = '22003';
  end if;

  if tg_op = 'INSERT' then
    insert into public.workspace_media_usage (workspace_id, bytes_used)
    values (new.workspace_id, 0)
    on conflict (workspace_id) do nothing;

    v_limit := public.media_storage_limit_bytes(new.workspace_id);
    update public.workspace_media_usage
       set bytes_used = bytes_used + new.byte_size,
           updated_at = now()
     where workspace_id = new.workspace_id
       and bytes_used <= v_limit - new.byte_size
     returning bytes_used into v_used;

    if v_used is null then
      raise exception 'Workspace media storage limit reached (% bytes). Delete media or upgrade before uploading more.', v_limit
        using errcode = 'P0001', hint = 'MEDIA_STORAGE_LIMIT';
    end if;
    return new;
  end if;

  if old.workspace_id = new.workspace_id then
    v_delta := new.byte_size - old.byte_size;
    if v_delta <= 0 then
      update public.workspace_media_usage
         set bytes_used = greatest(0, bytes_used + v_delta),
             updated_at = now()
       where workspace_id = new.workspace_id;
      return new;
    end if;

    v_limit := public.media_storage_limit_bytes(new.workspace_id);
    update public.workspace_media_usage
       set bytes_used = bytes_used + v_delta,
           updated_at = now()
     where workspace_id = new.workspace_id
       and bytes_used <= v_limit - v_delta
     returning bytes_used into v_used;

    if v_used is null then
      raise exception 'Workspace media storage limit reached (% bytes). Delete media or upgrade before uploading more.', v_limit
        using errcode = 'P0001', hint = 'MEDIA_STORAGE_LIMIT';
    end if;
    return new;
  end if;

  -- Moving a row across workspaces is unusual, but keep both counters exact.
  update public.workspace_media_usage
     set bytes_used = greatest(0, bytes_used - old.byte_size),
         updated_at = now()
   where workspace_id = old.workspace_id;

  insert into public.workspace_media_usage (workspace_id, bytes_used)
  values (new.workspace_id, 0)
  on conflict (workspace_id) do nothing;

  v_limit := public.media_storage_limit_bytes(new.workspace_id);
  update public.workspace_media_usage
     set bytes_used = bytes_used + new.byte_size,
         updated_at = now()
   where workspace_id = new.workspace_id
     and bytes_used <= v_limit - new.byte_size
   returning bytes_used into v_used;

  if v_used is null then
    raise exception 'Workspace media storage limit reached (% bytes). Delete media or upgrade before uploading more.', v_limit
      using errcode = 'P0001', hint = 'MEDIA_STORAGE_LIMIT';
  end if;
  return new;
end;
$$;


--
-- Name: FUNCTION enforce_workspace_media_storage_limit(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.enforce_workspace_media_storage_limit() IS 'Atomically maintains workspace_media_usage and rejects media_objects writes above the plan cap.';


--
-- Name: ensure_workspace_org(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_workspace_org() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org_id uuid;
begin
  if new.org_id is null then
    insert into public.orgs (name, owner_user_id)
      values (coalesce(new.name, 'Org'), null)
      returning id into v_org_id;
    new.org_id := v_org_id;
  end if;
  return new;
end $$;


--
-- Name: FUNCTION ensure_workspace_org(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ensure_workspace_org() IS 'Before-insert trigger: assigns workspaces.org_id by creating a fresh org if the caller did not provide one. Removable once the workspace-create flow surfaces an org picker.';


--
-- Name: folder_visible_to_role(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.folder_visible_to_role(p_folder_id uuid, p_caller_role text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select
    p_caller_role is null
    or p_folder_id is null
    or exists (
      select 1
      from public.folders f
      where f.id = p_folder_id
        and (
          f.visibility = 'workspace'
          or (
            f.visibility = 'role'
            and public.role_rank(f.required_role) <= public.role_rank(p_caller_role)
          )
        )
    );
$$;


--
-- Name: get_user_workspace_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_workspace_ids() RETURNS SETOF uuid
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select workspace_id from public.workspace_members
  where user_id = (select auth.uid());
$$;


--
-- Name: grep_documents(uuid, text, boolean, integer, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.grep_documents(p_workspace_id uuid, p_pattern text, p_is_regex boolean DEFAULT false, p_max_results integer DEFAULT 50, p_max_per_doc integer DEFAULT 5, p_caller_role text DEFAULT NULL::text) RETURNS TABLE(document_id uuid, title text, line_number integer, line_text text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_pattern text;
begin
  if p_pattern is null or length(trim(p_pattern)) = 0 then
    return;
  end if;

  if p_is_regex then
    v_pattern := p_pattern;
  else
    v_pattern := '%' || p_pattern || '%';
  end if;

  return query
  with candidates as (
    select d.id, d.title as doc_title, d.content
    from public.documents d
    where d.workspace_id = p_workspace_id
      and d.deleted_at is null
      and public.folder_visible_to_role(d.folder_id, p_caller_role)
      and (
        case
          when p_is_regex then (d.title ~* v_pattern or d.content ~* v_pattern)
          else (d.title ilike v_pattern or d.content ilike v_pattern)
        end
      )
    limit greatest(p_max_results, 1) * 4
  ),
  exploded as (
    select
      c.id            as document_id,
      c.doc_title     as title,
      lines.line_no::int as line_number,
      lines.line_body as line_text,
      row_number() over (
        partition by c.id
        order by lines.line_no
      ) as per_doc_rank
    from candidates c,
      lateral unnest(string_to_array(c.content, E'\n'))
        with ordinality as lines(line_body, line_no)
    where
      case
        when p_is_regex then lines.line_body ~* v_pattern
        else lines.line_body ilike v_pattern
      end
  )
  select e.document_id, e.title, e.line_number, e.line_text
  from exploded e
  where e.per_doc_rank <= greatest(p_max_per_doc, 1)
  order by e.document_id, e.line_number
  limit greatest(p_max_results, 1);
end;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  insert into public.profiles (user_id, display_name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (user_id) do nothing;

  -- Attach any pending invites addressed to this email so they surface in
  -- the onboarding flow and the Join Workspace dialog.
  update public.workspace_members
     set user_id = new.id
   where invited_email = new.email and user_id is null;

  return new;
end;
$$;


--
-- Name: increment_import_job_progress(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_import_job_progress(p_job_id uuid, p_status text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
begin
  update public.import_jobs set
    processed_items = processed_items + 1,
    succeeded_items = succeeded_items + (case when p_status = 'succeeded' then 1 else 0 end),
    failed_items    = failed_items + (case when p_status = 'failed'    then 1 else 0 end),
    skipped_items   = skipped_items + (case when p_status = 'skipped'   then 1 else 0 end)
  where id = p_job_id;
end;
$$;


--
-- Name: is_breeze_email(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_breeze_email(p_email text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select p_email is not null
     and lower(btrim(p_email)) ~ '^[^@[:space:]]+@(breeze\.com|breeze\.cash)$';
$_$;


--
-- Name: is_workspace_admin(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_workspace_admin(ws_id uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws_id
      and user_id = (select auth.uid())
      and role in ('admin', 'owner')
  );
$$;


--
-- Name: match_document_section_chunks(extensions.vector, uuid, uuid, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_document_section_chunks(query_embedding extensions.vector, p_workspace_id uuid, p_document_id uuid DEFAULT NULL::uuid, p_match_count integer DEFAULT 8, p_caller_role text DEFAULT NULL::text) RETURNS TABLE(chunk_id uuid, section_id uuid, document_id uuid, chunk_index integer, content text, distance double precision, heading_title text, heading_depth integer, path text, ancestors jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $$
  with ranked as (
    select
      c.id            as chunk_id,
      c.section_id    as section_id,
      s.document_id   as document_id,
      c.chunk_index   as chunk_index,
      c.content       as content,
      (c.embedding <=> query_embedding)::float as distance,
      s.heading_title as heading_title,
      s.heading_depth as heading_depth,
      s.path          as path
    from public.document_section_chunk c
    join public.document_section s on s.id = c.section_id
    join public.documents d        on d.id = s.document_id
    where d.workspace_id = p_workspace_id
      and (p_document_id is null or s.document_id = p_document_id)
      and public.folder_visible_to_role(d.folder_id, p_caller_role)
    order by c.embedding <=> query_embedding
    limit p_match_count
  )
  select
    r.chunk_id,
    r.section_id,
    r.document_id,
    r.chunk_index,
    r.content,
    r.distance,
    r.heading_title,
    r.heading_depth,
    r.path::text as path,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'id',            a.id,
                   'node_id',       a.node_id,
                   'heading_title', a.heading_title,
                   'heading_depth', a.heading_depth
                 )
                 order by a.heading_depth
               )
        from public.document_section a
        where a.document_id = r.document_id
          and a.path @> r.path
          and a.path != r.path
      ),
      '[]'::jsonb
    ) as ancestors
  from ranked r
  order by r.distance;
$$;


--
-- Name: match_document_section_chunks_hybrid(text, extensions.vector, uuid, uuid, integer, integer, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_document_section_chunks_hybrid(query_text text, query_embedding extensions.vector, p_workspace_id uuid, p_document_id uuid DEFAULT NULL::uuid, p_match_count integer DEFAULT 8, p_lane_count integer DEFAULT 20, p_rrf_k integer DEFAULT 60, p_caller_role text DEFAULT NULL::text) RETURNS TABLE(chunk_id uuid, section_id uuid, document_id uuid, chunk_index integer, content text, distance double precision, heading_title text, heading_depth integer, path text, ancestors jsonb, rrf_score double precision)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $$
  with vec_lane as (
    select
      c.id                                           as chunk_id,
      (c.embedding <=> query_embedding)::float       as distance,
      row_number() over (order by c.embedding <=> query_embedding) as rnk_v
    from public.document_section_chunk c
    join public.document_section       s on s.id = c.section_id
    join public.documents              d on d.id = s.document_id
    where d.workspace_id = p_workspace_id
      and (p_document_id is null or s.document_id = p_document_id)
      and public.folder_visible_to_role(d.folder_id, p_caller_role)
      -- Breeze internal build: embeddings are disabled, so the query vector is
      -- null. Skip this lane entirely instead of ranking every chunk by null.
      and query_embedding is not null
      and c.embedding is not null
    order by c.embedding <=> query_embedding
    limit p_lane_count
  ),
  lex_lane as (
    select
      c.id                                           as chunk_id,
      row_number() over (
        order by ts_rank_cd(c.tsv, websearch_to_tsquery('english', query_text)) desc
      ) as rnk_l
    from public.document_section_chunk c
    join public.document_section       s on s.id = c.section_id
    join public.documents              d on d.id = s.document_id
    where d.workspace_id = p_workspace_id
      and (p_document_id is null or s.document_id = p_document_id)
      and c.tsv @@ websearch_to_tsquery('english', query_text)
      and public.folder_visible_to_role(d.folder_id, p_caller_role)
    order by ts_rank_cd(c.tsv, websearch_to_tsquery('english', query_text)) desc
    limit p_lane_count
  ),
  fused as (
    select
      coalesce(v.chunk_id, l.chunk_id)                          as chunk_id,
      v.distance                                                as distance,
      coalesce(1.0 / (p_rrf_k + v.rnk_v), 0)
        + coalesce(1.0 / (p_rrf_k + l.rnk_l), 0)                as rrf_score
    from vec_lane v
    full outer join lex_lane l using (chunk_id)
  )
  select
    c.id                                                        as chunk_id,
    c.section_id                                                as section_id,
    s.document_id                                               as document_id,
    c.chunk_index                                               as chunk_index,
    c.content                                                   as content,
    f.distance                                                  as distance,
    s.heading_title                                             as heading_title,
    s.heading_depth                                             as heading_depth,
    s.path::text                                                as path,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'id',            a.id,
                   'node_id',       a.node_id,
                   'heading_title', a.heading_title,
                   'heading_depth', a.heading_depth
                 )
                 order by a.heading_depth
               )
        from public.document_section a
        where a.path @> s.path
          and a.id <> s.id
      ),
      '[]'::jsonb
    )                                                           as ancestors,
    f.rrf_score                                                 as rrf_score
  from fused f
  join public.document_section_chunk c on c.id = f.chunk_id
  join public.document_section       s on s.id = c.section_id
  order by f.rrf_score desc
  limit p_match_count;
$$;


--
-- Name: match_documents(extensions.vector, double precision, integer, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_documents(query_embedding extensions.vector, match_threshold double precision DEFAULT 0.5, match_count integer DEFAULT 5, workspace_id uuid DEFAULT NULL::uuid, caller_role text DEFAULT NULL::text) RETURNS TABLE(id uuid, title text, content text, source text, author text, updated_at timestamp with time zone, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  select
    d.id, d.title, d.content, d.source, d.author, d.updated_at,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where
    d.embedding is not null
    and d.deleted_at is null
    and (match_documents.workspace_id is null or d.workspace_id = match_documents.workspace_id)
    and public.folder_visible_to_role(d.folder_id, match_documents.caller_role)
    and 1 - (d.embedding <=> query_embedding) > match_threshold
  order by d.embedding <=> query_embedding
  limit match_count;
$$;


--
-- Name: match_folder_by_embedding(extensions.vector, uuid, double precision, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_folder_by_embedding(query_embedding extensions.vector, target_workspace_id uuid, similarity_threshold double precision DEFAULT 0.85, folder_kind text DEFAULT 'topic'::text) RETURNS TABLE(id uuid, name text, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  select
    f.id, f.name,
    1 - (f.embedding <=> query_embedding) as similarity
  from public.folders f
  where f.workspace_id = target_workspace_id
    and f.kind = folder_kind
    and f.embedding is not null
    and 1 - (f.embedding <=> query_embedding) > similarity_threshold
  order by f.embedding <=> query_embedding
  limit 1;
$$;


--
-- Name: mcp_access_token_hook(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mcp_access_token_hook(event jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
declare
  claims jsonb := coalesce(event->'claims', '{}'::jsonb);
begin
  -- Only OAuth-server-issued tokens carry client_id. Leave everything else alone.
  if claims ? 'client_id' then
    claims := jsonb_set(claims, '{aud}', to_jsonb('https://app.sophic.so/api/mcp'::text), true);
    event := jsonb_set(event, '{claims}', claims, true);
  end if;
  return event;
end;
$$;


--
-- Name: mcp_oauth_grants_fill_client_name(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mcp_oauth_grants_fill_client_name() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if new.client_name is null then
    select c.client_name
      into new.client_name
      from auth.oauth_clients as c
     where c.id::text = new.client_id;
  end if;
  return new;
end;
$$;


--
-- Name: FUNCTION mcp_oauth_grants_fill_client_name(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.mcp_oauth_grants_fill_client_name() IS 'Derives mcp_oauth_grants.client_name from auth.oauth_clients when the caller did not supply it. Keeps the Settings connection list correct regardless of which app build wrote the grant.';


--
-- Name: media_storage_limit_bytes(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_storage_limit_bytes(p_workspace_id uuid) RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce((
    select case
      when s.status not in ('active', 'trialing') then 536870912::bigint
      when s.tier = 'enterprise' or s.plan_id = 'enterprise' then 107374182400::bigint
      when s.plan_id = 'business' then 26843545600::bigint
      when s.plan_id = 'basic' or s.tier <> 'free' then 5368709120::bigint
      else 536870912::bigint
    end
    from public.subscriptions s
    where s.workspace_id = p_workspace_id
    limit 1
  ), 536870912::bigint);
$$;


--
-- Name: FUNCTION media_storage_limit_bytes(p_workspace_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.media_storage_limit_bytes(p_workspace_id uuid) IS 'Hard media byte ceiling: Free 512 MiB, Basic 5 GiB, Business 25 GiB, Enterprise 100 GiB.';


--
-- Name: merge_topic_folders(uuid, uuid[], uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.merge_topic_folders(p_workspace_id uuid, p_source_ids uuid[], p_target_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_target_name           text;
  v_source_count          int;
  v_memberships_repointed int := 0;
  v_pins_repointed        int := 0;
  v_pages_deleted         int := 0;
  v_aliases_written       int := 0;
begin
  if p_source_ids is null or array_length(p_source_ids, 1) is null then
    raise exception 'merge_topic_folders: no source folders provided';
  end if;
  -- Normalize to distinct ids so a benign duplicate can't make the validity
  -- count below diverge from the supplied length and falsely roll the merge back.
  select array_agg(distinct e) into p_source_ids from unnest(p_source_ids) e;
  if p_target_id = any(p_source_ids) then
    raise exception 'merge_topic_folders: target % cannot also be a source', p_target_id;
  end if;

  -- Target must be a topic folder in this workspace.
  select name into v_target_name
  from public.folders
  where id = p_target_id
    and workspace_id = p_workspace_id
    and kind = 'topic';
  if not found then
    raise exception 'merge_topic_folders: target % is not a topic folder in workspace %',
      p_target_id, p_workspace_id;
  end if;

  -- Every source must be a topic folder in this workspace.
  select count(*) into v_source_count
  from public.folders
  where id = any(p_source_ids)
    and workspace_id = p_workspace_id
    and kind = 'topic';
  if v_source_count <> array_length(p_source_ids, 1) then
    raise exception 'merge_topic_folders: one or more sources are not topic folders in workspace %',
      p_workspace_id;
  end if;

  -- 1. Re-point document_topics memberships from sources -> target, skipping
  --    docs already linked to the target (the unique (document_id, folder_id)
  --    would otherwise conflict). Leftover source rows are removed by the
  --    folder-delete cascade in step 5.
  with moved as (
    update public.document_topics df
       set folder_id = p_target_id
     where df.folder_id = any(p_source_ids)
       and not exists (
         select 1 from public.document_topics existing
         where existing.folder_id = p_target_id
           and existing.document_id = df.document_id
       )
    returning 1
  )
  select count(*) into v_memberships_repointed from moved;

  -- 2. Delete the sources' pinned topic_page documents — they regenerate on
  --    the target. Done before re-pointing pins so a source topic_page is not
  --    re-pointed onto the target.
  with del as (
    delete from public.documents
     where folder_id = any(p_source_ids)
       and workspace_id = p_workspace_id
       and document_type = 'topic_page'
    returning 1
  )
  select count(*) into v_pages_deleted from del;

  -- 3. Re-point remaining documents.folder_id pins from sources -> target so
  --    they are not orphaned (folders FK is ON DELETE SET NULL) when the source
  --    folder is deleted in step 5.
  with repinned as (
    update public.documents
       set folder_id = p_target_id
     where folder_id = any(p_source_ids)
       and workspace_id = p_workspace_id
    returning 1
  )
  select count(*) into v_pins_repointed from repinned;

  -- 4. Record every source name as an alias -> target, and follow any existing
  --    aliases that pointed at a source over to the target. Must run before the
  --    source folders are deleted (the canonical_folder_id FK cascades).
  with ins as (
    insert into public.topic_aliases (workspace_id, alias_name, canonical_folder_id)
    select f.workspace_id, f.name, p_target_id
    from public.folders f
    where f.id = any(p_source_ids)
      and f.workspace_id = p_workspace_id
    on conflict (workspace_id, alias_name)
      do update set canonical_folder_id = excluded.canonical_folder_id
    returning 1
  )
  select count(*) into v_aliases_written from ins;

  update public.topic_aliases
     set canonical_folder_id = p_target_id
   where workspace_id = p_workspace_id
     and canonical_folder_id = any(p_source_ids);

  -- 5. Delete the source folders. The document_topics FK cascade removes their
  --    leftover membership rows (docs already linked to the target).
  delete from public.folders
   where id = any(p_source_ids)
     and workspace_id = p_workspace_id
     and kind = 'topic';

  return jsonb_build_object(
    'target_id',             p_target_id,
    'sources_merged',        array_length(p_source_ids, 1),
    'memberships_repointed', v_memberships_repointed,
    'pins_repointed',        v_pins_repointed,
    'topic_pages_deleted',   v_pages_deleted,
    'aliases_written',       v_aliases_written
  );
end;
$$;


--
-- Name: prune_deleted_folder_from_portal_scopes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prune_deleted_folder_from_portal_scopes() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
begin
  update public.workspace_experiences as experience
     set scope = (
       select coalesce(
         jsonb_agg(entry.value order by entry.ordinal),
         '[]'::jsonb
       )
       from jsonb_array_elements(
         case
           when jsonb_typeof(experience.scope) = 'array' then experience.scope
           else '[]'::jsonb
         end
       )
         with ordinality as entry(value, ordinal)
       where not coalesce(
         (
           jsonb_typeof(entry.value) = 'string'
           and entry.value = to_jsonb(old.id::text)
         )
         or (
           jsonb_typeof(entry.value) = 'object'
           and entry.value ->> 'id' = old.id::text
         ),
         false
       )
     ),
     updated_at = now()
   where experience.workspace_id = old.workspace_id
     and experience.kind = 'kb'
     and experience.audience = 'public'
     and jsonb_typeof(experience.scope) = 'array'
     and exists (
       select 1
       from jsonb_array_elements(
         case
           when jsonb_typeof(experience.scope) = 'array' then experience.scope
           else '[]'::jsonb
         end
       ) as candidate(value)
       where coalesce(
         (
           jsonb_typeof(candidate.value) = 'string'
           and candidate.value = to_jsonb(old.id::text)
         )
         or (
           jsonb_typeof(candidate.value) = 'object'
           and candidate.value ->> 'id' = old.id::text
         ),
         false
       )
     );

  return old;
end;
$$;


--
-- Name: prune_portal_events(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prune_portal_events(retention_days integer DEFAULT 180) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
  v_deleted int;
begin
  if retention_days is null or retention_days <= 0 then
    raise exception 'retention_days must be > 0, got %', retention_days;
  end if;
  delete from public.portal_events
    where created_at < now() - make_interval(days => retention_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;


--
-- Name: FUNCTION prune_portal_events(retention_days integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.prune_portal_events(retention_days integer) IS 'Deletes portal_events rows older than retention_days (default 180). Intended to be scheduled via pg_cron in production. Returns count of deleted rows. Raises on retention_days <= 0.';


--
-- Name: prune_search_events(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prune_search_events(retention_days integer DEFAULT 180) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
  v_deleted int;
begin
  if retention_days is null or retention_days <= 0 then
    raise exception 'retention_days must be > 0, got %', retention_days;
  end if;
  delete from public.search_events
    where created_at < now() - make_interval(days => retention_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;


--
-- Name: FUNCTION prune_search_events(retention_days integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.prune_search_events(retention_days integer) IS 'Deletes search_events rows older than retention_days (default 180). Intended to be scheduled via pg_cron in production. Returns count of deleted rows. Raises on retention_days <= 0.';


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: role_rank(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.role_rank(role text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case role
    when 'owner' then 4
    when 'admin' then 3
    when 'editor' then 2
    when 'viewer' then 1
    when 'agent-only' then 0
    else -1
  end;
$$;


--
-- Name: workspace_experiences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_experiences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    version integer NOT NULL,
    name text,
    description text,
    audience text NOT NULL,
    spec jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    published_by uuid,
    source_conversation_id uuid,
    prompt_summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    archived_at timestamp with time zone,
    slug text,
    template text DEFAULT 'docs'::text NOT NULL,
    scope jsonb,
    visibility text DEFAULT 'public'::text NOT NULL,
    required_role text,
    is_save_snapshot boolean DEFAULT false NOT NULL,
    CONSTRAINT workspace_experiences_audience_check CHECK ((audience = ANY (ARRAY['internal'::text, 'public'::text]))),
    CONSTRAINT workspace_experiences_kind_check CHECK ((kind = ANY (ARRAY['dashboard'::text, 'kb'::text]))),
    CONSTRAINT workspace_experiences_required_role_check CHECK ((required_role = ANY (ARRAY['owner'::text, 'admin'::text, 'editor'::text, 'viewer'::text, 'agent-only'::text]))),
    CONSTRAINT workspace_experiences_role_requires_private CHECK (((required_role IS NULL) OR (visibility = 'private'::text))),
    CONSTRAINT workspace_experiences_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text]))),
    CONSTRAINT workspace_experiences_template_check CHECK ((template = 'docs'::text)),
    CONSTRAINT workspace_experiences_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
);


--
-- Name: save_portal_edit(uuid, text, jsonb, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_portal_edit(p_workspace_id uuid, p_slug text, p_spec jsonb, p_editor_id uuid, p_source_version integer DEFAULT NULL::integer) RETURNS SETOF public.workspace_experiences
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
  working public.workspace_experiences;
  source_edit public.workspace_experiences;
  next_version integer;
  saved_at timestamptz := clock_timestamp();
begin
  select * into working from public.workspace_experiences
    where workspace_id = p_workspace_id and kind = 'kb'
      and slug = p_slug and audience = 'public' and status = 'draft'
    order by version desc limit 1 for update;
  if not found then raise exception 'No portal to save'; end if;

  if p_source_version is not null then
    select * into source_edit from public.workspace_experiences
      where workspace_id = p_workspace_id and kind = 'kb' and slug = p_slug
        and audience = 'public' and version = p_source_version and is_save_snapshot;
    if not found then raise exception 'Saved edit not found'; end if;
    p_spec := source_edit.spec;
    working.scope := source_edit.scope;
  end if;

  select coalesce(max(version), 0) + 1 into next_version
    from public.workspace_experiences
    where workspace_id = p_workspace_id and kind = 'kb' and slug = p_slug;

  insert into public.workspace_experiences
    (workspace_id, kind, slug, scope, status, audience, version, name,
     visibility, required_role, spec, created_by, created_at, updated_at, is_save_snapshot)
    values (p_workspace_id, 'kb', p_slug, working.scope, 'archived', 'public',
      next_version, working.name, working.visibility, working.required_role,
      p_spec, p_editor_id, saved_at, saved_at, true);

  return query update public.workspace_experiences
    set spec = p_spec, scope = working.scope, updated_at = saved_at
    where id = working.id returning *;
end;
$$;


--
-- Name: section_tsv_cascade(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.section_tsv_cascade() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update public.document_section_chunk
     set content = content
   where section_id = new.id;
  return new;
end;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


--
-- Name: skip_free_document_versions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.skip_free_document_versions() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if public.workspace_has_paid_subscription(new.workspace_id) then
    return new;
  end if;

  return null;
end;
$$;


--
-- Name: FUNCTION skip_free_document_versions(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.skip_free_document_versions() IS 'Before-insert trigger for document_versions: unpaid workspaces do not retain document history.';


--
-- Name: sync_portal_domain_route_project(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_portal_domain_route_project() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if old.kind <> 'kb' or old.audience <> 'public' or old.slug is null then
    if tg_op = 'UPDATE' then return new; end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    update public.portal_domain_routes
    set
      project_slug = new.slug,
      path_prefix = case
        when path_prefix = '/' || old.slug then '/' || new.slug
        else path_prefix
      end,
      updated_at = now()
    where workspace_id = old.workspace_id
      and project_slug = old.slug;
    return new;
  end if;

  if not exists (
    select 1
    from public.workspace_experiences
    where workspace_id = old.workspace_id
      and kind = old.kind
      and audience = old.audience
      and slug = old.slug
  ) then
    delete from public.portal_domain_routes
    where workspace_id = old.workspace_id
      and project_slug = old.slug;
  end if;
  return old;
end;
$$;


--
-- Name: workspace_has_paid_subscription(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workspace_has_paid_subscription(p_workspace_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1
      from public.subscriptions s
     where s.workspace_id = p_workspace_id
       and s.status in ('active', 'trialing')
       and s.tier <> 'free'
       and coalesce(s.plan_id, 'paid') <> 'free'
  );
$$;


--
-- Name: FUNCTION workspace_has_paid_subscription(p_workspace_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.workspace_has_paid_subscription(p_workspace_id uuid) IS 'Returns true when a workspace has an active or trialing non-free subscription. Used by plan-enforcement triggers.';


--
-- Name: workspace_storage_bytes(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workspace_storage_bytes(target_workspace_id uuid) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
  select (
    coalesce((
      select sum(
        coalesce(octet_length(d.content), 0)
        + coalesce(pg_column_size(d.embedding), 0)
        + coalesce(octet_length(d.title), 0)
      )
      from public.documents d
      where d.workspace_id = target_workspace_id
    ), 0)
    + coalesce((
      select sum(
        coalesce(octet_length(v.content), 0)
        + coalesce(octet_length(v.title), 0)
      )
      from public.document_versions v
      where v.workspace_id = target_workspace_id
    ), 0)
  )::bigint;
$$;


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text DEFAULT 'API Key'::text NOT NULL,
    key_hash text NOT NULL,
    created_by uuid,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    role text DEFAULT 'viewer'::text NOT NULL,
    scopes text[] DEFAULT ARRAY['read'::text] NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    key_encrypted text,
    CONSTRAINT api_keys_role_valid CHECK ((role = ANY (ARRAY['admin'::text, 'editor'::text, 'viewer'::text, 'agent-only'::text]))),
    CONSTRAINT api_keys_scopes_valid CHECK ((scopes <@ ARRAY['capture'::text, 'read'::text, 'admin'::text]))
);


--
-- Name: COLUMN api_keys.key_encrypted; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_keys.key_encrypted IS 'AES-256-GCM ciphertext of the raw key, base64(iv||tag||ciphertext). Null for keys created before retrievable secrets shipped. Never expose except via the admin-gated reveal endpoint.';


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    role text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    parts jsonb,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT chat_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))
);


--
-- Name: cloudflare_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloudflare_connections (
    workspace_id uuid NOT NULL,
    access_token_encrypted text NOT NULL,
    refresh_token_encrypted text,
    access_token_expires_at timestamp with time zone,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    connected_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloudflare_oauth_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloudflare_oauth_states (
    state_hash text NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    target_domain text NOT NULL,
    return_path text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloudflare_oauth_states_hash_check CHECK ((state_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT cloudflare_oauth_states_return_path_check CHECK ((return_path ~~ '/%'::text))
);


--
-- Name: cloudflare_portal_deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloudflare_portal_deployments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    domain text NOT NULL,
    account_id text,
    zone_id text,
    zone_name text,
    script_name text,
    routes jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    last_error text,
    deployed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloudflare_portal_deployments_domain_check CHECK (((domain = lower(domain)) AND (char_length(domain) <= 253) AND (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$'::text))),
    CONSTRAINT cloudflare_portal_deployments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'deploying'::text, 'connected'::text, 'error'::text])))
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    title text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    surface text DEFAULT 'agent'::text NOT NULL,
    project_slug text,
    CONSTRAINT conversations_surface_check CHECK ((surface = ANY (ARRAY['agent'::text, 'portal_builder'::text])))
);


--
-- Name: document_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_document_id uuid NOT NULL,
    target_document_id uuid NOT NULL,
    strength text DEFAULT 'related'::text NOT NULL,
    created_by_proposal_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_links_check CHECK ((source_document_id <> target_document_id))
);


--
-- Name: document_retrieval_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_retrieval_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    document_id uuid NOT NULL,
    search_event_id uuid,
    "position" integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE document_retrieval_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.document_retrieval_events IS 'POST /api/search/click → one row per document opened from a search result. Drives CTR and dead-doc analysis.';


--
-- Name: document_section; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_section (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    node_id text NOT NULL,
    heading_title text DEFAULT ''::text NOT NULL,
    heading_depth integer DEFAULT 0 NOT NULL,
    sequence_number integer DEFAULT 0 NOT NULL,
    path public.ltree NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_section_heading_depth_check CHECK (((heading_depth >= 0) AND (heading_depth <= 6)))
);


--
-- Name: document_section_chunk; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_section_chunk (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    content text NOT NULL,
    content_hash text NOT NULL,
    embedding extensions.vector(768),
    token_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tsv tsvector
);


--
-- Name: COLUMN document_section_chunk.tsv; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document_section_chunk.tsv IS 'Full-text search vector. Maintained by chunk_tsv_refresh() trigger; do not write directly. Composes weight-A from the parent section''s heading_title with weight-B from this chunk''s content, so heading matches outrank body matches. Heading renames cascade via section_tsv_cascade() on document_section. Backed by document_section_chunk_tsv_gin (created in 20260425090100).';


--
-- Name: document_topics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_topics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    folder_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: TABLE document_topics; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.document_topics IS 'Many-to-many membership between a document and the topic folders (folders.kind = ''topic'') it is tagged with. Distinct from documents.folder_id, which is the single folder a document lives in. Written add-only by the sweep commit path.';


--
-- Name: document_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    edited_by uuid,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    source text DEFAULT 'CLI'::text NOT NULL,
    status text DEFAULT 'Draft'::text NOT NULL,
    author text DEFAULT 'Unknown'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding extensions.vector(768),
    user_id uuid,
    workspace_id uuid NOT NULL,
    team_id uuid,
    folder_id uuid,
    document_type text DEFAULT 'source'::text NOT NULL,
    synthesized_at timestamp with time zone,
    content_bytes integer GENERATED ALWAYS AS (octet_length(content)) STORED,
    source_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    deleted_at timestamp with time zone,
    public_slug text,
    sort_order integer,
    CONSTRAINT documents_document_type_check CHECK ((document_type = ANY (ARRAY['source'::text, 'topic_page'::text, 'page'::text])))
);


--
-- Name: COLUMN documents.content_bytes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documents.content_bytes IS 'Stored generated column equal to octet_length(content). Used by ops dashboard for storage rollups. Cheap at current scale; revisit (trigger-maintained) past ~50k rows.';


--
-- Name: COLUMN documents.public_slug; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documents.public_slug IS 'Human-readable per-workspace slug for public KB doc URLs (/p/<ws>/doc/<slug>). Null = UUID-only addressing. Unique per workspace among non-null values.';


--
-- Name: folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    kind text DEFAULT 'user'::text NOT NULL,
    display_name text,
    embedding extensions.vector(768),
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_folder_id uuid,
    visibility text DEFAULT 'workspace'::text NOT NULL,
    required_role text,
    content text,
    sort_order integer,
    icon text,
    CONSTRAINT folders_icon_length_check CHECK (((icon IS NULL) OR ((char_length(icon) >= 1) AND (char_length(icon) <= 60)))),
    CONSTRAINT folders_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'topic'::text, 'system'::text]))),
    CONSTRAINT folders_parent_not_self_check CHECK (((parent_folder_id IS NULL) OR (parent_folder_id <> id))),
    CONSTRAINT folders_visibility_check CHECK ((visibility = ANY (ARRAY['workspace'::text, 'role'::text])))
);


--
-- Name: folder_stats; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.folder_stats WITH (security_invoker='true') AS
 SELECT id AS folder_id,
    workspace_id,
    kind,
    name,
    display_name,
    parent_folder_id,
    visibility,
    required_role,
    sort_order,
    first_seen_at,
    last_seen_at,
    created_at,
    updated_at,
    (( SELECT count(DISTINCT d.id) AS count
           FROM public.documents d
          WHERE ((d.folder_id = f.id) AND (d.document_type = ANY (ARRAY['source'::text, 'page'::text])))) + ( SELECT count(DISTINCT df.document_id) AS count
           FROM (public.document_topics df
             JOIN public.documents d2 ON ((d2.id = df.document_id)))
          WHERE ((df.folder_id = f.id) AND (d2.document_type = ANY (ARRAY['source'::text, 'page'::text])) AND ((d2.folder_id IS NULL) OR (d2.folder_id <> f.id))))) AS document_count,
    icon
   FROM public.folders f;


--
-- Name: github_document_edit_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_document_edit_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    document_id uuid NOT NULL,
    installation_id bigint NOT NULL,
    repo_id bigint NOT NULL,
    repo_full_name text NOT NULL,
    file_path text NOT NULL,
    deploy_branch text NOT NULL,
    branch_name text NOT NULL,
    deploy_commit_sha text NOT NULL,
    deploy_blob_sha text NOT NULL,
    deploy_base_content text NOT NULL,
    base_commit_sha text NOT NULL,
    base_blob_sha text NOT NULL,
    base_content text NOT NULL,
    draft_content text NOT NULL,
    draft_revision bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    last_commit_sha text,
    last_saved_blob_sha text,
    pr_number integer,
    pr_url text,
    created_by uuid,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT github_document_edit_sessions_revision_positive CHECK ((draft_revision > 0)),
    CONSTRAINT github_document_edit_sessions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'publishing'::text, 'open'::text, 'conflict'::text, 'merged'::text, 'discarded'::text, 'error'::text])))
);


--
-- Name: TABLE github_document_edit_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.github_document_edit_sessions IS 'Shared editor/MCP drafts for GitHub-backed documents. Git is mutated only by an explicit branch save or pull-request publish.';


--
-- Name: github_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    github_account_login text NOT NULL,
    github_account_type text NOT NULL,
    installation_id bigint NOT NULL,
    installed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT github_integrations_github_account_type_check CHECK ((github_account_type = ANY (ARRAY['Organization'::text, 'User'::text])))
);


--
-- Name: github_repo_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_repo_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    repo_id bigint NOT NULL,
    repo_full_name text NOT NULL,
    path text NOT NULL,
    blob_sha text,
    document_id uuid,
    last_seen_commit_sha text,
    removed_at timestamp with time zone,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: github_user_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_user_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    github_login text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: google_drive_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_drive_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    google_user_id text,
    google_email text,
    refresh_token_encrypted text,
    access_token_encrypted text,
    access_token_expires_at timestamp with time zone,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    root_folder_id text,
    root_folder_name text,
    connected_by uuid,
    last_synced_at timestamp with time zone,
    last_sync_modified_after timestamp with time zone,
    last_sync_attempt_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_ingest_enabled boolean DEFAULT false NOT NULL,
    auto_ingest_period_seconds integer DEFAULT 86400 NOT NULL,
    CONSTRAINT google_drive_integrations_auto_ingest_period_check CHECK (((auto_ingest_period_seconds >= 3600) AND (auto_ingest_period_seconds <= 2592000)))
);


--
-- Name: google_drive_synced_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_drive_synced_files (
    workspace_id uuid NOT NULL,
    drive_file_id text NOT NULL,
    document_id uuid,
    drive_mime_type text,
    file_modified_at timestamp with time zone,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    capture_id uuid
);


--
-- Name: granola_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.granola_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    api_key_encrypted text,
    api_key_last_four text NOT NULL,
    connected_by uuid,
    last_synced_at timestamp with time zone,
    last_sync_created_after timestamp with time zone,
    last_sync_attempt_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_ingest_enabled boolean DEFAULT false NOT NULL,
    auto_ingest_period_seconds integer DEFAULT 86400 NOT NULL,
    CONSTRAINT granola_integrations_auto_ingest_period_check CHECK (((auto_ingest_period_seconds >= 3600) AND (auto_ingest_period_seconds <= 2592000)))
);


--
-- Name: granola_synced_meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.granola_synced_meetings (
    workspace_id uuid NOT NULL,
    granola_meeting_id text NOT NULL,
    document_id uuid,
    meeting_started_at timestamp with time zone,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    capture_id uuid
);


--
-- Name: import_job_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_job_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    source_ref text NOT NULL,
    title text,
    status text DEFAULT 'pending'::text NOT NULL,
    document_id uuid,
    error_message text,
    processed_at timestamp with time zone,
    CONSTRAINT import_job_items_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: import_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    total_items integer DEFAULT 0 NOT NULL,
    processed_items integer DEFAULT 0 NOT NULL,
    succeeded_items integer DEFAULT 0 NOT NULL,
    failed_items integer DEFAULT 0 NOT NULL,
    skipped_items integer DEFAULT 0 NOT NULL,
    error_message text,
    started_by uuid,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT import_jobs_source_check CHECK ((source = ANY (ARRAY['notion'::text, 'confluence'::text, 'obsidian'::text, 'website'::text]))),
    CONSTRAINT import_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: invite_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invite_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    code text NOT NULL,
    created_by uuid NOT NULL,
    expires_at timestamp with time zone,
    max_uses integer,
    use_count integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    role text DEFAULT 'viewer'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT invite_links_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'editor'::text, 'viewer'::text, 'agent-only'::text])))
);


--
-- Name: linear_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.linear_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    api_key_encrypted text,
    api_key_last_four text NOT NULL,
    linear_org_id text,
    linear_org_name text,
    connected_by uuid,
    last_synced_at timestamp with time zone,
    last_sync_updated_after timestamp with time zone,
    last_sync_attempt_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_ingest_enabled boolean DEFAULT false NOT NULL,
    auto_ingest_period_seconds integer DEFAULT 86400 NOT NULL,
    CONSTRAINT linear_integrations_auto_ingest_period_check CHECK (((auto_ingest_period_seconds >= 3600) AND (auto_ingest_period_seconds <= 2592000)))
);


--
-- Name: linear_synced_issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.linear_synced_issues (
    workspace_id uuid NOT NULL,
    linear_issue_id text NOT NULL,
    document_id uuid,
    issue_updated_at timestamp with time zone,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    capture_id uuid
);


--
-- Name: llm_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_metrics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    stage text NOT NULL,
    operation text NOT NULL,
    model text,
    tokens_input integer,
    tokens_output integer,
    duration_ms integer NOT NULL,
    outcome text NOT NULL,
    skip_reason text,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT llm_metrics_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'error'::text, 'skip'::text])))
);


--
-- Name: TABLE llm_metrics; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.llm_metrics IS 'One row per LLM/embedding call made on a workspace''s behalf: ingestion pipeline stages (ingest, topic_link, synthesis) and interactive product surfaces (stage=interactive; operation names the feature). Written fire-and-forget via the service-role admin client (lib/pipeline/metrics.ts withMetrics, lib/ai/usage.ts recordAiUsage). Priced at read time by lib/ops/model-pricing.ts for /ops/cost and the monthly AI budget gate.';


--
-- Name: mcp_oauth_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_oauth_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id text NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    client_name text
);


--
-- Name: TABLE mcp_oauth_grants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.mcp_oauth_grants IS 'Binds an OAuth client + user to the single workspace they consented to for MCP access. Role is read live from workspace_members, never stored here.';


--
-- Name: COLUMN mcp_oauth_grants.client_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mcp_oauth_grants.client_name IS 'Registered OAuth client_name at consent time (e.g. "Codex"). Stable across the per-login client_id churn of dynamic registration; used to label and revoke connections in Settings.';


--
-- Name: media_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    capture_id uuid,
    storage_key text NOT NULL,
    kind text NOT NULL,
    mime text NOT NULL,
    byte_size bigint NOT NULL,
    width integer,
    height integer,
    content_hash text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    CONSTRAINT media_objects_byte_size_check CHECK ((byte_size >= 0)),
    CONSTRAINT media_objects_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'video'::text, 'audio'::text, 'file'::text])))
);


--
-- Name: media_upload_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_upload_rate_limits (
    user_id uuid NOT NULL,
    window_started_at timestamp with time zone DEFAULT now() NOT NULL,
    request_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_upload_rate_limits_request_count_check CHECK ((request_count >= 0))
);


--
-- Name: message_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    rating text NOT NULL,
    reason text,
    comment text,
    context jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_feedback_rating_check CHECK ((rating = ANY (ARRAY['up'::text, 'down'::text]))),
    CONSTRAINT message_feedback_reason_check CHECK ((reason = ANY (ARRAY['inaccurate'::text, 'not_from_sources'::text, 'incomplete'::text, 'wrong_tone'::text, 'other'::text])))
);


--
-- Name: monitored_repos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitored_repos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    installation_id bigint NOT NULL,
    repo_full_name text NOT NULL,
    repo_id bigint NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    file_sync_status text DEFAULT 'pending'::text NOT NULL,
    indexed_file_count integer DEFAULT 0 NOT NULL,
    pending_file_count integer DEFAULT 0 NOT NULL,
    skipped_file_count integer DEFAULT 0 NOT NULL,
    failed_file_count integer DEFAULT 0 NOT NULL,
    last_file_sync_commit_sha text,
    last_file_sync_at timestamp with time zone,
    last_file_sync_error text,
    file_tree_truncated boolean DEFAULT false NOT NULL,
    sync_path text DEFAULT ''::text NOT NULL,
    hosted_docs_paths text[] DEFAULT '{}'::text[] NOT NULL,
    hosted_docs_root_folder_id uuid,
    hosted_docs_sync_status text DEFAULT 'disabled'::text NOT NULL,
    hosted_docs_document_count integer DEFAULT 0 NOT NULL,
    hosted_docs_last_sync_commit_sha text,
    hosted_docs_last_sync_at timestamp with time zone,
    hosted_docs_last_sync_error text,
    hosted_docs_last_sync_mode text DEFAULT 'merge'::text NOT NULL,
    hosted_docs_conflict_count integer DEFAULT 0 NOT NULL,
    hosted_docs_sync_mode text DEFAULT 'merge'::text NOT NULL,
    file_indexing_enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT monitored_repos_file_sync_status_check CHECK ((file_sync_status = ANY (ARRAY['pending'::text, 'syncing'::text, 'partial'::text, 'synced'::text, 'cancelled'::text, 'error'::text]))),
    CONSTRAINT monitored_repos_file_synccounts_nonnegative CHECK (((indexed_file_count >= 0) AND (pending_file_count >= 0) AND (skipped_file_count >= 0) AND (failed_file_count >= 0))),
    CONSTRAINT monitored_repos_hosted_docs_conflict_count_nonnegative CHECK ((hosted_docs_conflict_count >= 0)),
    CONSTRAINT monitored_repos_hosted_docs_document_count_nonnegative CHECK ((hosted_docs_document_count >= 0)),
    CONSTRAINT monitored_repos_hosted_docs_last_sync_mode_check CHECK ((hosted_docs_last_sync_mode = ANY (ARRAY['merge'::text, 'replace_sophic'::text]))),
    CONSTRAINT monitored_repos_hosted_docs_sync_mode_check CHECK ((hosted_docs_sync_mode = ANY (ARRAY['merge'::text, 'replace_sophic'::text]))),
    CONSTRAINT monitored_repos_hosted_docs_sync_status_check CHECK ((hosted_docs_sync_status = ANY (ARRAY['disabled'::text, 'pending'::text, 'syncing'::text, 'synced'::text, 'error'::text]))),
    CONSTRAINT monitored_repos_sync_path_check CHECK (((char_length(sync_path) <= 500) AND (sync_path !~ '(^/|/$|//)'::text) AND (sync_path !~ '(^|/)[.]{1,2}(/|$)'::text) AND (sync_path !~ '[[:cntrl:]]'::text) AND (POSITION(('\'::text) IN (sync_path)) = 0)))
);


--
-- Name: COLUMN monitored_repos.sync_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.monitored_repos.sync_path IS 'Repository-relative folder indexed by Sophic. Empty string means the repository root.';


--
-- Name: orgs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orgs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text DEFAULT substr((gen_random_uuid())::text, 1, 8) NOT NULL,
    owner_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: personal_access_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personal_access_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text DEFAULT 'CLI Session'::text NOT NULL,
    token_hash text NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + '90 days'::interval) NOT NULL,
    scopes text[] DEFAULT ARRAY['capture'::text, 'read'::text] NOT NULL,
    revoked_at timestamp with time zone,
    role text,
    CONSTRAINT personal_access_tokens_role_valid CHECK (((role IS NULL) OR (role = ANY (ARRAY['admin'::text, 'editor'::text, 'viewer'::text, 'agent-only'::text])))),
    CONSTRAINT personal_access_tokens_scopes_valid CHECK ((scopes <@ ARRAY['capture'::text, 'read'::text, 'admin'::text]))
);


--
-- Name: portal_domain_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_domain_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_slug text NOT NULL,
    domain text NOT NULL,
    path_prefix text DEFAULT '/'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT portal_domain_routes_domain_check CHECK (((domain = lower(domain)) AND (char_length(domain) <= 253) AND (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$'::text))),
    CONSTRAINT portal_domain_routes_path_prefix_check CHECK (((path_prefix = '/'::text) OR (path_prefix ~ '^/([a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?)(/[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?)*$'::text))),
    CONSTRAINT portal_domain_routes_project_slug_check CHECK ((project_slug ~ '^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$'::text))
);


--
-- Name: portal_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    experience_id uuid,
    event_type text NOT NULL,
    visitor_id text NOT NULL,
    document_id uuid,
    path text,
    query_text text,
    query_hash text,
    result_count integer,
    referrer_host text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT portal_events_type_chk CHECK ((event_type = ANY (ARRAY['pageview'::text, 'doc_view'::text, 'search'::text, 'search_click'::text, 'ask'::text, 'helpful'::text, 'not_helpful'::text])))
);


--
-- Name: TABLE portal_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_events IS 'Anonymous public-KB portal traffic (pageviews, doc views, searches, search clicks). Written fire-and-forget via the service-role admin client. visitor_id is a cookieless one-way hash; query_text retained 180 days (see prune_portal_events).';


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    display_name text,
    email text,
    avatar_url text,
    status text DEFAULT 'active'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    onboarding_completed_at timestamp with time zone,
    CONSTRAINT profiles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'vacation'::text, 'departed'::text])))
);


--
-- Name: search_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    query_text text NOT NULL,
    query_hash text NOT NULL,
    result_count integer NOT NULL,
    latency_ms integer NOT NULL,
    search_mode text NOT NULL,
    top_doc_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE search_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.search_events IS 'Every /api/search call; fire-and-forget logged via admin client. Raw query_text retained 180 days (see prune_search_events).';


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    tier text DEFAULT 'free'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    plan_id text DEFAULT 'free'::text,
    billing_interval text,
    CONSTRAINT subscriptions_billing_interval_check CHECK (((billing_interval = ANY (ARRAY['monthly'::text, 'annual'::text])) OR (billing_interval IS NULL))),
    CONSTRAINT subscriptions_plan_id_check CHECK (((plan_id = ANY (ARRAY['free'::text, 'basic'::text, 'business'::text, 'enterprise'::text])) OR (plan_id IS NULL))),
    CONSTRAINT subscriptions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text, 'canceled'::text, 'incomplete'::text]))),
    CONSTRAINT subscriptions_stripe_sub_requires_paid CHECK (((stripe_subscription_id IS NULL) OR ((tier <> 'free'::text) AND (plan_id IS DISTINCT FROM 'free'::text)))),
    CONSTRAINT subscriptions_tier_check CHECK ((tier = ANY (ARRAY['free'::text, 'pro'::text, 'enterprise'::text])))
);


--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    workspace_member_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: topic_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.topic_aliases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    alias_name text NOT NULL,
    canonical_folder_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE topic_aliases; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.topic_aliases IS 'Retired/merged topic names -> canonical topic folder. Consulted by the sweep''s resolveTopicFolders() so human renames/merges survive future sweeps. Service-role writes only.';


--
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_deliveries (
    source text NOT NULL,
    event_id text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_media_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_media_usage (
    workspace_id uuid NOT NULL,
    bytes_used bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_media_usage_bytes_used_check CHECK ((bytes_used >= 0))
);


--
-- Name: workspace_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    role text DEFAULT 'viewer'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    profile_role text,
    invited_email text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT workspace_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'editor'::text, 'viewer'::text, 'agent-only'::text]))),
    CONSTRAINT workspace_members_status_check CHECK ((status = ANY (ARRAY['active'::text, 'invited'::text])))
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text DEFAULT 'My Workspace'::text NOT NULL,
    slug text DEFAULT substr((gen_random_uuid())::text, 1, 8) NOT NULL,
    icon_url text,
    settings jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    org_id uuid
);


--
-- Name: workspace_usage_current_period; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.workspace_usage_current_period WITH (security_invoker='true') AS
 WITH period AS (
         SELECT w.id AS workspace_id,
            COALESCE(s.current_period_start, date_trunc('month'::text, now())) AS period_start,
            COALESCE(s.current_period_end, (date_trunc('month'::text, now()) + '1 mon'::interval)) AS period_end
           FROM (public.workspaces w
             LEFT JOIN public.subscriptions s ON ((s.workspace_id = w.id)))
        )
 SELECT p.workspace_id,
    p.period_start,
    p.period_end,
    m.stage,
    m.model,
    count(*) FILTER (WHERE (m.outcome = 'success'::text)) AS ops_success,
    count(*) FILTER (WHERE (m.outcome = 'error'::text)) AS ops_error,
    count(*) FILTER (WHERE (m.outcome = 'skip'::text)) AS ops_skip,
    COALESCE(sum(m.tokens_input), (0)::bigint) AS tokens_input,
    COALESCE(sum(m.tokens_output), (0)::bigint) AS tokens_output,
    COALESCE(sum(m.duration_ms), (0)::bigint) AS duration_ms
   FROM (period p
     LEFT JOIN public.llm_metrics m ON (((m.workspace_id = p.workspace_id) AND (m.created_at >= p.period_start) AND (m.created_at < p.period_end))))
  GROUP BY p.workspace_id, p.period_start, p.period_end, m.stage, m.model;


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: cloudflare_connections cloudflare_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_connections
    ADD CONSTRAINT cloudflare_connections_pkey PRIMARY KEY (workspace_id);


--
-- Name: cloudflare_oauth_states cloudflare_oauth_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_oauth_states
    ADD CONSTRAINT cloudflare_oauth_states_pkey PRIMARY KEY (state_hash);


--
-- Name: cloudflare_portal_deployments cloudflare_portal_deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_portal_deployments
    ADD CONSTRAINT cloudflare_portal_deployments_pkey PRIMARY KEY (id);


--
-- Name: cloudflare_portal_deployments cloudflare_portal_deployments_workspace_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_portal_deployments
    ADD CONSTRAINT cloudflare_portal_deployments_workspace_domain_key UNIQUE (workspace_id, domain);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: document_links document_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_links
    ADD CONSTRAINT document_links_pkey PRIMARY KEY (id);


--
-- Name: document_links document_links_source_document_id_target_document_id_streng_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_links
    ADD CONSTRAINT document_links_source_document_id_target_document_id_streng_key UNIQUE (source_document_id, target_document_id, strength);


--
-- Name: document_retrieval_events document_retrieval_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_retrieval_events
    ADD CONSTRAINT document_retrieval_events_pkey PRIMARY KEY (id);


--
-- Name: document_section_chunk document_section_chunk_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_section_chunk
    ADD CONSTRAINT document_section_chunk_pkey PRIMARY KEY (id);


--
-- Name: document_section_chunk document_section_chunk_section_id_chunk_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_section_chunk
    ADD CONSTRAINT document_section_chunk_section_id_chunk_index_key UNIQUE (section_id, chunk_index);


--
-- Name: document_section document_section_document_id_node_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_section
    ADD CONSTRAINT document_section_document_id_node_id_key UNIQUE (document_id, node_id);


--
-- Name: document_section document_section_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_section
    ADD CONSTRAINT document_section_pkey PRIMARY KEY (id);


--
-- Name: document_topics document_topics_document_id_folder_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_topics
    ADD CONSTRAINT document_topics_document_id_folder_id_key UNIQUE (document_id, folder_id);


--
-- Name: document_topics document_topics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_topics
    ADD CONSTRAINT document_topics_pkey PRIMARY KEY (id);


--
-- Name: document_versions document_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: folders folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folders
    ADD CONSTRAINT folders_pkey PRIMARY KEY (id);


--
-- Name: folders folders_workspace_kind_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folders
    ADD CONSTRAINT folders_workspace_kind_name_key UNIQUE (workspace_id, kind, name);


--
-- Name: github_document_edit_sessions github_document_edit_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_document_edit_sessions
    ADD CONSTRAINT github_document_edit_sessions_pkey PRIMARY KEY (id);


--
-- Name: github_hosted_docs_sources github_hosted_docs_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_hosted_docs_sources
    ADD CONSTRAINT github_hosted_docs_sources_pkey PRIMARY KEY (id);


--
-- Name: github_hosted_docs_sources github_hosted_docs_sources_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_hosted_docs_sources
    ADD CONSTRAINT github_hosted_docs_sources_workspace_id_key UNIQUE (workspace_id);


--
-- Name: github_hosted_docs_sources github_hosted_docs_sources_workspace_id_repo_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_hosted_docs_sources
    ADD CONSTRAINT github_hosted_docs_sources_workspace_id_repo_id_key UNIQUE (workspace_id, repo_id);


--
-- Name: github_integrations github_integrations_installation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_integrations
    ADD CONSTRAINT github_integrations_installation_id_key UNIQUE (installation_id);


--
-- Name: github_integrations github_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_integrations
    ADD CONSTRAINT github_integrations_pkey PRIMARY KEY (id);


--
-- Name: github_repo_files github_repo_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_repo_files
    ADD CONSTRAINT github_repo_files_pkey PRIMARY KEY (id);


--
-- Name: github_repo_files github_repo_files_workspace_id_repo_id_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_repo_files
    ADD CONSTRAINT github_repo_files_workspace_id_repo_id_path_key UNIQUE (workspace_id, repo_id, path);


--
-- Name: github_user_links github_user_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_user_links
    ADD CONSTRAINT github_user_links_pkey PRIMARY KEY (id);


--
-- Name: github_user_links github_user_links_workspace_id_github_login_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_user_links
    ADD CONSTRAINT github_user_links_workspace_id_github_login_key UNIQUE (workspace_id, github_login);


--
-- Name: github_user_links github_user_links_workspace_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_user_links
    ADD CONSTRAINT github_user_links_workspace_id_user_id_key UNIQUE (workspace_id, user_id);


--
-- Name: google_drive_integrations google_drive_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_drive_integrations
    ADD CONSTRAINT google_drive_integrations_pkey PRIMARY KEY (id);


--
-- Name: google_drive_integrations google_drive_integrations_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_drive_integrations
    ADD CONSTRAINT google_drive_integrations_workspace_id_key UNIQUE (workspace_id);


--
-- Name: google_drive_synced_files google_drive_synced_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_drive_synced_files
    ADD CONSTRAINT google_drive_synced_files_pkey PRIMARY KEY (workspace_id, drive_file_id);


--
-- Name: granola_integrations granola_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.granola_integrations
    ADD CONSTRAINT granola_integrations_pkey PRIMARY KEY (id);


--
-- Name: granola_integrations granola_integrations_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.granola_integrations
    ADD CONSTRAINT granola_integrations_workspace_id_key UNIQUE (workspace_id);


--
-- Name: granola_synced_meetings granola_synced_meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.granola_synced_meetings
    ADD CONSTRAINT granola_synced_meetings_pkey PRIMARY KEY (workspace_id, granola_meeting_id);


--
-- Name: import_job_items import_job_items_job_id_source_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_job_items
    ADD CONSTRAINT import_job_items_job_id_source_ref_key UNIQUE (job_id, source_ref);


--
-- Name: import_job_items import_job_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_job_items
    ADD CONSTRAINT import_job_items_pkey PRIMARY KEY (id);


--
-- Name: import_jobs import_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_pkey PRIMARY KEY (id);


--
-- Name: invite_links invite_links_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_links
    ADD CONSTRAINT invite_links_code_key UNIQUE (code);


--
-- Name: invite_links invite_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_links
    ADD CONSTRAINT invite_links_pkey PRIMARY KEY (id);


--
-- Name: linear_integrations linear_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_integrations
    ADD CONSTRAINT linear_integrations_pkey PRIMARY KEY (id);


--
-- Name: linear_integrations linear_integrations_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_integrations
    ADD CONSTRAINT linear_integrations_workspace_id_key UNIQUE (workspace_id);


--
-- Name: linear_synced_issues linear_synced_issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_synced_issues
    ADD CONSTRAINT linear_synced_issues_pkey PRIMARY KEY (workspace_id, linear_issue_id);


--
-- Name: llm_metrics llm_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_metrics
    ADD CONSTRAINT llm_metrics_pkey PRIMARY KEY (id);


--
-- Name: mcp_oauth_grants mcp_oauth_grants_client_user_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_grants
    ADD CONSTRAINT mcp_oauth_grants_client_user_unique UNIQUE (client_id, user_id);


--
-- Name: mcp_oauth_grants mcp_oauth_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_grants
    ADD CONSTRAINT mcp_oauth_grants_pkey PRIMARY KEY (id);


--
-- Name: media_objects media_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_objects
    ADD CONSTRAINT media_objects_pkey PRIMARY KEY (id);


--
-- Name: media_objects media_objects_upload_size_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.media_objects
    ADD CONSTRAINT media_objects_upload_size_check CHECK (((byte_size > 0) AND
CASE kind
    WHEN 'image'::text THEN (byte_size <= 20971520)
    WHEN 'video'::text THEN (byte_size <= 262144000)
    ELSE (byte_size <= 262144000)
END)) NOT VALID;


--
-- Name: media_objects media_objects_workspace_id_content_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_objects
    ADD CONSTRAINT media_objects_workspace_id_content_hash_key UNIQUE (workspace_id, content_hash);


--
-- Name: media_upload_rate_limits media_upload_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_rate_limits
    ADD CONSTRAINT media_upload_rate_limits_pkey PRIMARY KEY (user_id);


--
-- Name: message_feedback message_feedback_message_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_feedback
    ADD CONSTRAINT message_feedback_message_id_user_id_key UNIQUE (message_id, user_id);


--
-- Name: message_feedback message_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_feedback
    ADD CONSTRAINT message_feedback_pkey PRIMARY KEY (id);


--
-- Name: monitored_repos monitored_repos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitored_repos
    ADD CONSTRAINT monitored_repos_pkey PRIMARY KEY (id);


--
-- Name: monitored_repos monitored_repos_workspace_id_repo_full_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitored_repos
    ADD CONSTRAINT monitored_repos_workspace_id_repo_full_name_key UNIQUE (workspace_id, repo_full_name);


--
-- Name: orgs orgs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_pkey PRIMARY KEY (id);


--
-- Name: orgs orgs_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_slug_key UNIQUE (slug);


--
-- Name: personal_access_tokens personal_access_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_pkey PRIMARY KEY (id);


--
-- Name: personal_access_tokens personal_access_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: portal_domain_routes portal_domain_routes_domain_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_domain_routes
    ADD CONSTRAINT portal_domain_routes_domain_path_key UNIQUE (domain, path_prefix);


--
-- Name: portal_domain_routes portal_domain_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_domain_routes
    ADD CONSTRAINT portal_domain_routes_pkey PRIMARY KEY (id);


--
-- Name: portal_domain_routes portal_domain_routes_workspace_project_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_domain_routes
    ADD CONSTRAINT portal_domain_routes_workspace_project_key UNIQUE (workspace_id, project_slug);


--
-- Name: portal_events portal_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_events
    ADD CONSTRAINT portal_events_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_user_id_key UNIQUE (user_id);


--
-- Name: search_events search_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_events
    ADD CONSTRAINT search_events_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_workspace_id_key UNIQUE (workspace_id);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: team_members team_members_team_id_workspace_member_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_workspace_member_id_key UNIQUE (team_id, workspace_member_id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: teams teams_workspace_id_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_workspace_id_slug_key UNIQUE (workspace_id, slug);


--
-- Name: topic_aliases topic_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic_aliases
    ADD CONSTRAINT topic_aliases_pkey PRIMARY KEY (id);


--
-- Name: topic_aliases topic_aliases_workspace_id_alias_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic_aliases
    ADD CONSTRAINT topic_aliases_workspace_id_alias_name_key UNIQUE (workspace_id, alias_name);


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (source, event_id);


--
-- Name: workspace_experiences workspace_experiences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_experiences
    ADD CONSTRAINT workspace_experiences_pkey PRIMARY KEY (id);


--
-- Name: workspace_experiences workspace_experiences_workspace_id_kind_slug_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_experiences
    ADD CONSTRAINT workspace_experiences_workspace_id_kind_slug_version_key UNIQUE (workspace_id, kind, slug, version);


--
-- Name: workspace_media_usage workspace_media_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_media_usage
    ADD CONSTRAINT workspace_media_usage_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_members workspace_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (id);


--
-- Name: workspace_members workspace_members_workspace_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_user_id_key UNIQUE (workspace_id, user_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_slug_key UNIQUE (slug);


--
-- Name: chat_messages_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_conversation_idx ON public.chat_messages USING btree (conversation_id, created_at);


--
-- Name: cloudflare_oauth_states_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloudflare_oauth_states_expires_idx ON public.cloudflare_oauth_states USING btree (expires_at);


--
-- Name: cloudflare_portal_deployments_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloudflare_portal_deployments_workspace_idx ON public.cloudflare_portal_deployments USING btree (workspace_id);


--
-- Name: conversations_portal_builder_thread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX conversations_portal_builder_thread_idx ON public.conversations USING btree (workspace_id, user_id, project_slug) WHERE (surface = 'portal_builder'::text);


--
-- Name: conversations_workspace_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_workspace_user_idx ON public.conversations USING btree (workspace_id, user_id, updated_at DESC);


--
-- Name: document_links_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_links_source_idx ON public.document_links USING btree (source_document_id);


--
-- Name: document_links_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_links_target_idx ON public.document_links USING btree (target_document_id);


--
-- Name: document_links_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_links_workspace_idx ON public.document_links USING btree (workspace_id);


--
-- Name: document_retrieval_events_doc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_retrieval_events_doc_idx ON public.document_retrieval_events USING btree (document_id, created_at DESC);


--
-- Name: document_retrieval_events_search_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_retrieval_events_search_event_idx ON public.document_retrieval_events USING btree (search_event_id) WHERE (search_event_id IS NOT NULL);


--
-- Name: document_retrieval_events_ws_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_retrieval_events_ws_created_idx ON public.document_retrieval_events USING btree (workspace_id, created_at DESC);


--
-- Name: document_section_chunk_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_section_chunk_embedding_idx ON public.document_section_chunk USING ivfflat (embedding extensions.vector_cosine_ops) WITH (lists='100');


--
-- Name: document_section_chunk_section_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_section_chunk_section_idx ON public.document_section_chunk USING btree (section_id);


--
-- Name: document_section_chunk_tsv_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_section_chunk_tsv_gin ON public.document_section_chunk USING gin (tsv);


--
-- Name: document_section_document_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_section_document_id_idx ON public.document_section USING btree (document_id);


--
-- Name: document_section_path_gist; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_section_path_gist ON public.document_section USING gist (path);


--
-- Name: documents_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_embedding_idx ON public.documents USING hnsw (embedding extensions.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: documents_unique_github_hosted_source_path; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX documents_unique_github_hosted_source_path ON public.documents USING btree (workspace_id, ((source_metadata ->> 'repo_id'::text)), ((source_metadata ->> 'path'::text))) WHERE ((source_metadata ->> 'kind'::text) = 'github_hosted_document'::text);


--
-- Name: documents_workspace_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_workspace_updated_idx ON public.documents USING btree (workspace_id, updated_at DESC);


--
-- Name: folders_workspace_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX folders_workspace_updated_idx ON public.folders USING btree (workspace_id, updated_at DESC);


--
-- Name: github_hosted_docs_sources_installation_repo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX github_hosted_docs_sources_installation_repo_idx ON public.github_hosted_docs_sources USING btree (installation_id, repo_id);


--
-- Name: github_hosted_docs_sources_pending_pr_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX github_hosted_docs_sources_pending_pr_idx ON public.github_hosted_docs_sources USING btree (installation_id, repo_id, pending_pull_request_number) WHERE (pending_pull_request_number IS NOT NULL);


--
-- Name: github_hosted_docs_sources_publish_pr_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX github_hosted_docs_sources_publish_pr_idx ON public.github_hosted_docs_sources USING btree (installation_id, repo_id, publish_pull_request_number) WHERE (publish_pull_request_number IS NOT NULL);


--
-- Name: github_user_links_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX github_user_links_lookup_idx ON public.github_user_links USING btree (workspace_id, github_login);


--
-- Name: google_drive_synced_files_capture_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX google_drive_synced_files_capture_idx ON public.google_drive_synced_files USING btree (capture_id);


--
-- Name: granola_synced_meetings_capture_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX granola_synced_meetings_capture_idx ON public.granola_synced_meetings USING btree (capture_id);


--
-- Name: idx_api_keys_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_created_by ON public.api_keys USING btree (created_by);


--
-- Name: idx_api_keys_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_workspace_id ON public.api_keys USING btree (workspace_id);


--
-- Name: idx_conversations_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_user_id ON public.conversations USING btree (user_id);


--
-- Name: idx_document_links_created_by_proposal_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_links_created_by_proposal_id ON public.document_links USING btree (created_by_proposal_id);


--
-- Name: idx_document_retrieval_events_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_retrieval_events_user_id ON public.document_retrieval_events USING btree (user_id);


--
-- Name: idx_document_topics_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_topics_doc ON public.document_topics USING btree (document_id);


--
-- Name: idx_document_topics_folder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_topics_folder ON public.document_topics USING btree (folder_id);


--
-- Name: idx_document_topics_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_topics_workspace ON public.document_topics USING btree (workspace_id);


--
-- Name: idx_document_versions_doc_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_versions_doc_id ON public.document_versions USING btree (document_id, created_at DESC);


--
-- Name: idx_document_versions_edited_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_versions_edited_by ON public.document_versions USING btree (edited_by);


--
-- Name: idx_document_versions_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_versions_workspace_id ON public.document_versions USING btree (workspace_id);


--
-- Name: idx_documents_content_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_content_trgm ON public.documents USING gin (content public.gin_trgm_ops);


--
-- Name: idx_documents_folder_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_folder_id ON public.documents USING btree (folder_id);


--
-- Name: idx_documents_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_source ON public.documents USING btree (workspace_id, source) WHERE (source IS NOT NULL);


--
-- Name: idx_documents_team_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_team_id ON public.documents USING btree (team_id);


--
-- Name: idx_documents_title_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_title_trgm ON public.documents USING gin (title public.gin_trgm_ops);


--
-- Name: idx_documents_unique_live_github_repo_file; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_documents_unique_live_github_repo_file ON public.documents USING btree (workspace_id, ((source_metadata ->> 'repo_id'::text)), ((source_metadata ->> 'path'::text))) WHERE ((source = 'GitHub'::text) AND (deleted_at IS NULL) AND ((source_metadata ->> 'kind'::text) = 'repository_file'::text));


--
-- Name: idx_documents_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_user_id ON public.documents USING btree (user_id);


--
-- Name: idx_documents_workspace_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_workspace_deleted_at ON public.documents USING btree (workspace_id, deleted_at DESC) WHERE (deleted_at IS NOT NULL);


--
-- Name: idx_documents_workspace_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_workspace_live ON public.documents USING btree (workspace_id, updated_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_documents_workspace_public_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_documents_workspace_public_slug ON public.documents USING btree (workspace_id, public_slug) WHERE (public_slug IS NOT NULL);


--
-- Name: idx_folders_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_folders_parent ON public.folders USING btree (parent_folder_id) WHERE (parent_folder_id IS NOT NULL);


--
-- Name: idx_folders_ws_kind_lastseen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_folders_ws_kind_lastseen ON public.folders USING btree (workspace_id, kind, last_seen_at DESC);


--
-- Name: idx_folders_ws_kind_sort_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_folders_ws_kind_sort_order ON public.folders USING btree (workspace_id, kind, sort_order, display_name);


--
-- Name: idx_github_document_edit_sessions_active_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_github_document_edit_sessions_active_doc ON public.github_document_edit_sessions USING btree (workspace_id, document_id) WHERE (status = ANY (ARRAY['draft'::text, 'publishing'::text, 'open'::text, 'conflict'::text, 'error'::text]));


--
-- Name: idx_github_document_edit_sessions_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_github_document_edit_sessions_branch ON public.github_document_edit_sessions USING btree (workspace_id, repo_id, branch_name) WHERE (status <> ALL (ARRAY['merged'::text, 'discarded'::text]));


--
-- Name: idx_github_document_edit_sessions_pr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_github_document_edit_sessions_pr ON public.github_document_edit_sessions USING btree (installation_id, repo_id, pr_number) WHERE (pr_number IS NOT NULL);


--
-- Name: idx_github_document_edit_sessions_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_github_document_edit_sessions_updated ON public.github_document_edit_sessions USING btree (workspace_id, updated_at DESC);


--
-- Name: idx_github_integrations_installed_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_github_integrations_installed_by ON public.github_integrations USING btree (installed_by);


--
-- Name: idx_github_integrations_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_github_integrations_workspace_id ON public.github_integrations USING btree (workspace_id);


--
-- Name: idx_github_repo_files_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_github_repo_files_document ON public.github_repo_files USING btree (document_id) WHERE (document_id IS NOT NULL);


--
-- Name: idx_github_repo_files_repo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_github_repo_files_repo ON public.github_repo_files USING btree (workspace_id, repo_id, removed_at);


--
-- Name: idx_github_user_links_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_github_user_links_user_id ON public.github_user_links USING btree (user_id);


--
-- Name: idx_google_drive_integrations_connected_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_drive_integrations_connected_by ON public.google_drive_integrations USING btree (connected_by);


--
-- Name: idx_google_drive_synced_files_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_drive_synced_files_document_id ON public.google_drive_synced_files USING btree (document_id);


--
-- Name: idx_granola_integrations_connected_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_granola_integrations_connected_by ON public.granola_integrations USING btree (connected_by);


--
-- Name: idx_granola_synced_meetings_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_granola_synced_meetings_document_id ON public.granola_synced_meetings USING btree (document_id);


--
-- Name: idx_import_job_items_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_job_items_document_id ON public.import_job_items USING btree (document_id);


--
-- Name: idx_import_job_items_job_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_job_items_job_status ON public.import_job_items USING btree (job_id, status);


--
-- Name: idx_import_jobs_started_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_jobs_started_by ON public.import_jobs USING btree (started_by);


--
-- Name: idx_import_jobs_workspace_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_jobs_workspace_status ON public.import_jobs USING btree (workspace_id, status, created_at DESC);


--
-- Name: idx_invite_links_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invite_links_created_by ON public.invite_links USING btree (created_by);


--
-- Name: idx_invite_links_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invite_links_workspace_id ON public.invite_links USING btree (workspace_id);


--
-- Name: idx_linear_integrations_connected_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_linear_integrations_connected_by ON public.linear_integrations USING btree (connected_by);


--
-- Name: idx_linear_synced_issues_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_linear_synced_issues_document_id ON public.linear_synced_issues USING btree (document_id);


--
-- Name: idx_llm_metrics_stage_outcome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_llm_metrics_stage_outcome ON public.llm_metrics USING btree (stage, outcome, created_at DESC);


--
-- Name: idx_llm_metrics_ws_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_llm_metrics_ws_created ON public.llm_metrics USING btree (workspace_id, created_at DESC);


--
-- Name: idx_mcp_oauth_grants_client_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_oauth_grants_client_user ON public.mcp_oauth_grants USING btree (client_id, user_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_mcp_oauth_grants_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_oauth_grants_user_id ON public.mcp_oauth_grants USING btree (user_id);


--
-- Name: idx_mcp_oauth_grants_user_workspace_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_oauth_grants_user_workspace_active ON public.mcp_oauth_grants USING btree (user_id, workspace_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_mcp_oauth_grants_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_oauth_grants_workspace_id ON public.mcp_oauth_grants USING btree (workspace_id);


--
-- Name: idx_monitored_repos_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_monitored_repos_created_by ON public.monitored_repos USING btree (created_by);


--
-- Name: idx_pat_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pat_expires_at ON public.personal_access_tokens USING btree (expires_at) WHERE (revoked_at IS NULL);


--
-- Name: idx_personal_access_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_personal_access_tokens_user_id ON public.personal_access_tokens USING btree (user_id);


--
-- Name: idx_team_members_workspace_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_members_workspace_member_id ON public.team_members USING btree (workspace_member_id);


--
-- Name: idx_topic_aliases_canonical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_topic_aliases_canonical ON public.topic_aliases USING btree (canonical_folder_id);


--
-- Name: idx_webhook_deliveries_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_received ON public.webhook_deliveries USING btree (received_at DESC);


--
-- Name: idx_workspace_members_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_members_user_id ON public.workspace_members USING btree (user_id);


--
-- Name: linear_synced_issues_capture_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX linear_synced_issues_capture_idx ON public.linear_synced_issues USING btree (capture_id);


--
-- Name: media_objects_capture_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_objects_capture_idx ON public.media_objects USING btree (capture_id);


--
-- Name: media_objects_workspace_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_objects_workspace_created_idx ON public.media_objects USING btree (workspace_id, created_at DESC);


--
-- Name: message_feedback_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_feedback_message_idx ON public.message_feedback USING btree (message_id);


--
-- Name: message_feedback_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_feedback_workspace_idx ON public.message_feedback USING btree (workspace_id, created_at DESC);


--
-- Name: monitored_repos_installation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX monitored_repos_installation_idx ON public.monitored_repos USING btree (installation_id);


--
-- Name: monitored_repos_one_hosted_docs_source_per_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX monitored_repos_one_hosted_docs_source_per_workspace ON public.monitored_repos USING btree (workspace_id) WHERE (cardinality(hosted_docs_paths) > 0);


--
-- Name: monitored_repos_repo_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX monitored_repos_repo_id_idx ON public.monitored_repos USING btree (repo_id);


--
-- Name: orgs_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orgs_owner_idx ON public.orgs USING btree (owner_user_id) WHERE (owner_user_id IS NOT NULL);


--
-- Name: portal_domain_routes_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_domain_routes_workspace_idx ON public.portal_domain_routes USING btree (workspace_id);


--
-- Name: portal_events_document_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_events_document_idx ON public.portal_events USING btree (workspace_id, document_id, created_at DESC) WHERE (document_id IS NOT NULL);


--
-- Name: portal_events_experience_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_events_experience_created_idx ON public.portal_events USING btree (experience_id, created_at DESC) WHERE (experience_id IS NOT NULL);


--
-- Name: portal_events_workspace_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_events_workspace_created_idx ON public.portal_events USING btree (workspace_id, created_at DESC);


--
-- Name: portal_events_ws_type_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_events_ws_type_created_idx ON public.portal_events USING btree (workspace_id, event_type, created_at DESC);


--
-- Name: search_events_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_events_user_idx ON public.search_events USING btree (user_id, created_at DESC) WHERE (user_id IS NOT NULL);


--
-- Name: search_events_workspace_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_events_workspace_created_idx ON public.search_events USING btree (workspace_id, created_at DESC);


--
-- Name: search_events_zero_result_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_events_zero_result_hash_idx ON public.search_events USING btree (query_hash, workspace_id) WHERE (result_count = 0);


--
-- Name: workspace_experiences_one_draft_per_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_experiences_one_draft_per_slug_idx ON public.workspace_experiences USING btree (workspace_id, slug) WHERE ((status = 'draft'::text) AND (slug IS NOT NULL));


--
-- Name: workspace_experiences_one_published_per_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_experiences_one_published_per_slug_idx ON public.workspace_experiences USING btree (workspace_id, slug) WHERE ((status = 'published'::text) AND (slug IS NOT NULL));


--
-- Name: workspace_experiences_workspace_kind_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_experiences_workspace_kind_status_idx ON public.workspace_experiences USING btree (workspace_id, kind, status);


--
-- Name: workspaces_kb_custom_domain_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspaces_kb_custom_domain_key ON public.workspaces USING btree (((settings ->> 'kb_custom_domain'::text))) WHERE ((settings ->> 'kb_custom_domain'::text) IS NOT NULL);


--
-- Name: workspaces_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspaces_org_id_idx ON public.workspaces USING btree (org_id);


--
-- Name: workspaces_settings_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspaces_settings_gin_idx ON public.workspaces USING gin (settings jsonb_path_ops);


--
-- Name: cloudflare_connections cloudflare_connections_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cloudflare_connections_set_updated_at BEFORE UPDATE ON public.cloudflare_connections FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: cloudflare_portal_deployments cloudflare_portal_deployments_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cloudflare_portal_deployments_set_updated_at BEFORE UPDATE ON public.cloudflare_portal_deployments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: document_section_chunk document_section_chunk_tsv_bi; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER document_section_chunk_tsv_bi BEFORE INSERT OR UPDATE OF content, section_id ON public.document_section_chunk FOR EACH ROW EXECUTE FUNCTION public.chunk_tsv_refresh();


--
-- Name: document_section document_section_tsv_au; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER document_section_tsv_au AFTER UPDATE OF heading_title ON public.document_section FOR EACH ROW WHEN ((old.heading_title IS DISTINCT FROM new.heading_title)) EXECUTE FUNCTION public.section_tsv_cascade();


--
-- Name: document_versions document_versions_skip_free; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER document_versions_skip_free BEFORE INSERT ON public.document_versions FOR EACH ROW EXECUTE FUNCTION public.skip_free_document_versions();


--
-- Name: documents documents_enforce_free_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER documents_enforce_free_limit BEFORE INSERT OR UPDATE OF workspace_id, document_type, deleted_at ON public.documents FOR EACH ROW EXECUTE FUNCTION public.enforce_free_document_limit();


--
-- Name: mcp_oauth_grants mcp_oauth_grants_fill_client_name; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER mcp_oauth_grants_fill_client_name BEFORE INSERT OR UPDATE OF client_id, client_name ON public.mcp_oauth_grants FOR EACH ROW EXECUTE FUNCTION public.mcp_oauth_grants_fill_client_name();


--
-- Name: mcp_oauth_grants mcp_oauth_grants_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER mcp_oauth_grants_set_updated_at BEFORE UPDATE ON public.mcp_oauth_grants FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: media_objects media_objects_enforce_storage_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_objects_enforce_storage_limit BEFORE INSERT OR DELETE OR UPDATE OF workspace_id, byte_size ON public.media_objects FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_media_storage_limit();


--
-- Name: workspace_experiences portal_domain_routes_project_delete_ad; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portal_domain_routes_project_delete_ad AFTER DELETE ON public.workspace_experiences FOR EACH ROW EXECUTE FUNCTION public.sync_portal_domain_route_project();


--
-- Name: workspace_experiences portal_domain_routes_project_slug_au; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portal_domain_routes_project_slug_au AFTER UPDATE OF slug ON public.workspace_experiences FOR EACH ROW WHEN ((old.slug IS DISTINCT FROM new.slug)) EXECUTE FUNCTION public.sync_portal_domain_route_project();


--
-- Name: portal_domain_routes portal_domain_routes_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portal_domain_routes_set_updated_at BEFORE UPDATE ON public.portal_domain_routes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: github_document_edit_sessions set_github_document_edit_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_github_document_edit_sessions_updated_at BEFORE UPDATE ON public.github_document_edit_sessions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: github_hosted_docs_sources set_github_hosted_docs_sources_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_github_hosted_docs_sources_updated_at BEFORE UPDATE ON public.github_hosted_docs_sources FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: github_repo_files set_github_repo_files_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_github_repo_files_updated_at BEFORE UPDATE ON public.github_repo_files FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: folders trg_check_folder_parent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_check_folder_parent BEFORE INSERT OR UPDATE OF parent_folder_id, kind ON public.folders FOR EACH ROW EXECUTE FUNCTION public.check_folder_parent();


--
-- Name: workspace_members trg_delete_orphan_workspace; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_delete_orphan_workspace AFTER DELETE ON public.workspace_members FOR EACH ROW EXECUTE FUNCTION public.delete_workspace_if_no_active_members();


--
-- Name: documents trg_enforce_kb_capacity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_enforce_kb_capacity BEFORE INSERT ON public.documents FOR EACH ROW EXECUTE FUNCTION public.enforce_kb_capacity();


--
-- Name: folders trg_prune_deleted_folder_from_portal_scopes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prune_deleted_folder_from_portal_scopes AFTER DELETE ON public.folders FOR EACH ROW EXECUTE FUNCTION public.prune_deleted_folder_from_portal_scopes();


--
-- Name: workspaces workspaces_ensure_org; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspaces_ensure_org BEFORE INSERT ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.ensure_workspace_org();


--
-- Name: api_keys api_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: api_keys api_keys_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: cloudflare_connections cloudflare_connections_connected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_connections
    ADD CONSTRAINT cloudflare_connections_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: cloudflare_connections cloudflare_connections_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_connections
    ADD CONSTRAINT cloudflare_connections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: cloudflare_oauth_states cloudflare_oauth_states_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_oauth_states
    ADD CONSTRAINT cloudflare_oauth_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: cloudflare_oauth_states cloudflare_oauth_states_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_oauth_states
    ADD CONSTRAINT cloudflare_oauth_states_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: cloudflare_portal_deployments cloudflare_portal_deployments_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloudflare_portal_deployments
    ADD CONSTRAINT cloudflare_portal_deployments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: document_links document_links_source_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_links
    ADD CONSTRAINT document_links_source_document_id_fkey FOREIGN KEY (source_document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_links document_links_target_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_links
    ADD CONSTRAINT document_links_target_document_id_fkey FOREIGN KEY (target_document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_links document_links_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_links
    ADD CONSTRAINT document_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: document_retrieval_events document_retrieval_events_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_retrieval_events
    ADD CONSTRAINT document_retrieval_events_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_retrieval_events document_retrieval_events_search_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_retrieval_events
    ADD CONSTRAINT document_retrieval_events_search_event_id_fkey FOREIGN KEY (search_event_id) REFERENCES public.search_events(id) ON DELETE SET NULL;


--
-- Name: document_retrieval_events document_retrieval_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_retrieval_events
    ADD CONSTRAINT document_retrieval_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: document_retrieval_events document_retrieval_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_retrieval_events
    ADD CONSTRAINT document_retrieval_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: document_section_chunk document_section_chunk_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_section_chunk
    ADD CONSTRAINT document_section_chunk_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.document_section(id) ON DELETE CASCADE;


--
-- Name: document_section document_section_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_section
    ADD CONSTRAINT document_section_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_topics document_topics_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_topics
    ADD CONSTRAINT document_topics_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_topics document_topics_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_topics
    ADD CONSTRAINT document_topics_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(id) ON DELETE CASCADE;


--
-- Name: document_topics document_topics_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_topics
    ADD CONSTRAINT document_topics_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: document_versions document_versions_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_versions document_versions_edited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_edited_by_fkey FOREIGN KEY (edited_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: document_versions document_versions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: documents documents_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: documents documents_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE SET DEFAULT;


--
-- Name: documents documents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: documents documents_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: folders folders_parent_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folders
    ADD CONSTRAINT folders_parent_folder_id_fkey FOREIGN KEY (parent_folder_id) REFERENCES public.folders(id) ON DELETE SET NULL;


--
-- Name: folders folders_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folders
    ADD CONSTRAINT folders_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: github_document_edit_sessions github_document_edit_sessions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_document_edit_sessions
    ADD CONSTRAINT github_document_edit_sessions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: github_document_edit_sessions github_document_edit_sessions_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_document_edit_sessions
    ADD CONSTRAINT github_document_edit_sessions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: github_document_edit_sessions github_document_edit_sessions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_document_edit_sessions
    ADD CONSTRAINT github_document_edit_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: github_hosted_docs_sources github_hosted_docs_sources_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_hosted_docs_sources
    ADD CONSTRAINT github_hosted_docs_sources_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: github_hosted_docs_sources github_hosted_docs_sources_root_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_hosted_docs_sources
    ADD CONSTRAINT github_hosted_docs_sources_root_folder_id_fkey FOREIGN KEY (root_folder_id) REFERENCES public.folders(id) ON DELETE SET NULL;


--
-- Name: github_hosted_docs_sources github_hosted_docs_sources_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_hosted_docs_sources
    ADD CONSTRAINT github_hosted_docs_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: github_integrations github_integrations_installed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_integrations
    ADD CONSTRAINT github_integrations_installed_by_fkey FOREIGN KEY (installed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: github_integrations github_integrations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_integrations
    ADD CONSTRAINT github_integrations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: github_repo_files github_repo_files_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_repo_files
    ADD CONSTRAINT github_repo_files_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;


--
-- Name: github_repo_files github_repo_files_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_repo_files
    ADD CONSTRAINT github_repo_files_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: github_user_links github_user_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_user_links
    ADD CONSTRAINT github_user_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: github_user_links github_user_links_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_user_links
    ADD CONSTRAINT github_user_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: google_drive_integrations google_drive_integrations_connected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_drive_integrations
    ADD CONSTRAINT google_drive_integrations_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: google_drive_integrations google_drive_integrations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_drive_integrations
    ADD CONSTRAINT google_drive_integrations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: google_drive_synced_files google_drive_synced_files_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_drive_synced_files
    ADD CONSTRAINT google_drive_synced_files_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: google_drive_synced_files google_drive_synced_files_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_drive_synced_files
    ADD CONSTRAINT google_drive_synced_files_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: granola_integrations granola_integrations_connected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.granola_integrations
    ADD CONSTRAINT granola_integrations_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: granola_integrations granola_integrations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.granola_integrations
    ADD CONSTRAINT granola_integrations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: granola_synced_meetings granola_synced_meetings_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.granola_synced_meetings
    ADD CONSTRAINT granola_synced_meetings_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: granola_synced_meetings granola_synced_meetings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.granola_synced_meetings
    ADD CONSTRAINT granola_synced_meetings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: import_job_items import_job_items_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_job_items
    ADD CONSTRAINT import_job_items_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;


--
-- Name: import_job_items import_job_items_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_job_items
    ADD CONSTRAINT import_job_items_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.import_jobs(id) ON DELETE CASCADE;


--
-- Name: import_jobs import_jobs_started_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_started_by_fkey FOREIGN KEY (started_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: import_jobs import_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: invite_links invite_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_links
    ADD CONSTRAINT invite_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: invite_links invite_links_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_links
    ADD CONSTRAINT invite_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: linear_integrations linear_integrations_connected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_integrations
    ADD CONSTRAINT linear_integrations_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: linear_integrations linear_integrations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_integrations
    ADD CONSTRAINT linear_integrations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: linear_synced_issues linear_synced_issues_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_synced_issues
    ADD CONSTRAINT linear_synced_issues_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: linear_synced_issues linear_synced_issues_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linear_synced_issues
    ADD CONSTRAINT linear_synced_issues_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: llm_metrics llm_metrics_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_metrics
    ADD CONSTRAINT llm_metrics_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: mcp_oauth_grants mcp_oauth_grants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_grants
    ADD CONSTRAINT mcp_oauth_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: mcp_oauth_grants mcp_oauth_grants_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_grants
    ADD CONSTRAINT mcp_oauth_grants_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: media_objects media_objects_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_objects
    ADD CONSTRAINT media_objects_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: media_objects media_objects_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_objects
    ADD CONSTRAINT media_objects_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: media_upload_rate_limits media_upload_rate_limits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_rate_limits
    ADD CONSTRAINT media_upload_rate_limits_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: message_feedback message_feedback_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_feedback
    ADD CONSTRAINT message_feedback_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: message_feedback message_feedback_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_feedback
    ADD CONSTRAINT message_feedback_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.chat_messages(id) ON DELETE CASCADE;


--
-- Name: message_feedback message_feedback_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_feedback
    ADD CONSTRAINT message_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: message_feedback message_feedback_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_feedback
    ADD CONSTRAINT message_feedback_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: monitored_repos monitored_repos_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitored_repos
    ADD CONSTRAINT monitored_repos_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: monitored_repos monitored_repos_hosted_docs_root_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitored_repos
    ADD CONSTRAINT monitored_repos_hosted_docs_root_folder_id_fkey FOREIGN KEY (hosted_docs_root_folder_id) REFERENCES public.folders(id) ON DELETE SET NULL;


--
-- Name: monitored_repos monitored_repos_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitored_repos
    ADD CONSTRAINT monitored_repos_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: orgs orgs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: personal_access_tokens personal_access_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: portal_domain_routes portal_domain_routes_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_domain_routes
    ADD CONSTRAINT portal_domain_routes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: portal_events portal_events_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_events
    ADD CONSTRAINT portal_events_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;


--
-- Name: portal_events portal_events_experience_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_events
    ADD CONSTRAINT portal_events_experience_id_fkey FOREIGN KEY (experience_id) REFERENCES public.workspace_experiences(id) ON DELETE SET NULL;


--
-- Name: portal_events portal_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_events
    ADD CONSTRAINT portal_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: search_events search_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_events
    ADD CONSTRAINT search_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: search_events search_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_events
    ADD CONSTRAINT search_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_workspace_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_workspace_member_id_fkey FOREIGN KEY (workspace_member_id) REFERENCES public.workspace_members(id) ON DELETE CASCADE;


--
-- Name: teams teams_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: topic_aliases topic_aliases_canonical_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic_aliases
    ADD CONSTRAINT topic_aliases_canonical_folder_id_fkey FOREIGN KEY (canonical_folder_id) REFERENCES public.folders(id) ON DELETE CASCADE;


--
-- Name: topic_aliases topic_aliases_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topic_aliases
    ADD CONSTRAINT topic_aliases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_experiences workspace_experiences_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_experiences
    ADD CONSTRAINT workspace_experiences_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: workspace_experiences workspace_experiences_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_experiences
    ADD CONSTRAINT workspace_experiences_published_by_fkey FOREIGN KEY (published_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: workspace_experiences workspace_experiences_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_experiences
    ADD CONSTRAINT workspace_experiences_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_media_usage workspace_media_usage_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_media_usage
    ADD CONSTRAINT workspace_media_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspaces workspaces_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE RESTRICT;


--
-- Name: api_keys Admins can create workspace API keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can create workspace API keys" ON public.api_keys FOR INSERT WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: workspace_members Admins can delete members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete members" ON public.workspace_members FOR DELETE USING (public.is_workspace_admin(workspace_id));


--
-- Name: api_keys Admins can delete workspace API keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete workspace API keys" ON public.api_keys FOR DELETE USING (public.is_workspace_admin(workspace_id));


--
-- Name: workspace_members Admins can insert members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert members" ON public.workspace_members FOR INSERT WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: documents Admins can manage accessible documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage accessible documents" ON public.documents USING ((public.is_workspace_admin(workspace_id) AND ((folder_id IS NULL) OR public.can_access_folder(folder_id))));


--
-- Name: github_integrations Admins can manage github integrations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage github integrations" ON public.github_integrations USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: monitored_repos Admins can manage monitored repos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage monitored repos" ON public.monitored_repos USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: portal_domain_routes Admins can manage portal domain routes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage portal domain routes" ON public.portal_domain_routes USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: team_members Admins can manage team members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage team members" ON public.team_members USING ((team_id IN ( SELECT t.id
   FROM public.teams t
  WHERE public.is_workspace_admin(t.workspace_id)))) WITH CHECK ((team_id IN ( SELECT t.id
   FROM public.teams t
  WHERE public.is_workspace_admin(t.workspace_id))));


--
-- Name: teams Admins can manage teams; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage teams" ON public.teams USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: subscriptions Admins can manage workspace subscription; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage workspace subscription" ON public.subscriptions USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: api_keys Admins can read workspace API keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read workspace API keys" ON public.api_keys FOR SELECT USING (public.is_workspace_admin(workspace_id));


--
-- Name: workspace_members Admins can update members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update members" ON public.workspace_members FOR UPDATE USING (public.is_workspace_admin(workspace_id));


--
-- Name: workspaces Admins can update workspace; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update workspace" ON public.workspaces FOR UPDATE USING (public.is_workspace_admin(id)) WITH CHECK (public.is_workspace_admin(id));


--
-- Name: github_repo_files Admins manage github repo files; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage github repo files" ON public.github_repo_files USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: google_drive_integrations Admins manage google drive integrations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage google drive integrations" ON public.google_drive_integrations USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: granola_integrations Admins manage granola integrations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage granola integrations" ON public.granola_integrations USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: import_jobs Admins manage import jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage import jobs" ON public.import_jobs USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: linear_integrations Admins manage linear integrations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage linear integrations" ON public.linear_integrations USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: workspace_experiences Admins manage workspace experiences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage workspace experiences" ON public.workspace_experiences USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));


--
-- Name: documents Authenticated users can read documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read documents" ON public.documents FOR SELECT TO authenticated USING (true);


--
-- Name: folders Members can delete accessible folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can delete accessible folders" ON public.folders FOR DELETE USING (((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)) AND ((visibility = 'workspace'::text) OR ((visibility = 'role'::text) AND (EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = folders.workspace_id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (public.role_rank(wm.role) >= public.role_rank(folders.required_role)))))))));


--
-- Name: message_feedback Members can delete their own message feedback; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can delete their own message feedback" ON public.message_feedback FOR DELETE USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: documents Members can insert accessible documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can insert accessible documents" ON public.documents FOR INSERT WITH CHECK (((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)) AND ((folder_id IS NULL) OR public.can_access_folder(folder_id))));


--
-- Name: folders Members can insert accessible folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can insert accessible folders" ON public.folders FOR INSERT WITH CHECK (((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)) AND ((visibility = 'workspace'::text) OR ((visibility = 'role'::text) AND (EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = folders.workspace_id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (public.role_rank(wm.role) >= public.role_rank(folders.required_role)))))))));


--
-- Name: message_feedback Members can insert their own message feedback; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can insert their own message feedback" ON public.message_feedback FOR INSERT WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)) AND (EXISTS ( SELECT 1
   FROM (public.chat_messages cm
     JOIN public.conversations c ON ((c.id = cm.conversation_id)))
  WHERE ((cm.id = message_feedback.message_id) AND (cm.conversation_id = message_feedback.conversation_id) AND (c.workspace_id = message_feedback.workspace_id) AND (cm.role = 'assistant'::text))))));


--
-- Name: github_user_links Members can manage own github user link; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can manage own github user link" ON public.github_user_links USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids))));


--
-- Name: github_hosted_docs_sources Members can read GitHub hosted docs sources; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read GitHub hosted docs sources" ON public.github_hosted_docs_sources FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: llm_metrics Members can read LLM metrics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read LLM metrics" ON public.llm_metrics FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: documents Members can read accessible documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read accessible documents" ON public.documents FOR SELECT USING (((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)) AND ((folder_id IS NULL) OR public.can_access_folder(folder_id))));


--
-- Name: folders Members can read accessible folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read accessible folders" ON public.folders FOR SELECT USING (((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)) AND ((visibility = 'workspace'::text) OR ((visibility = 'role'::text) AND (EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = folders.workspace_id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (public.role_rank(wm.role) >= public.role_rank(folders.required_role)))))))));


--
-- Name: document_topics Members can read document topics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read document topics" ON public.document_topics FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: document_links Members can read document_links; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read document_links" ON public.document_links FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: google_drive_synced_files Members can read drive synced files; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read drive synced files" ON public.google_drive_synced_files FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: github_document_edit_sessions Members can read github document edit sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read github document edit sessions" ON public.github_document_edit_sessions FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: github_integrations Members can read github integrations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read github integrations" ON public.github_integrations FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: github_repo_files Members can read github repo files; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read github repo files" ON public.github_repo_files FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: github_user_links Members can read github user links; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read github user links" ON public.github_user_links FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: google_drive_integrations Members can read google drive integrations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read google drive integrations" ON public.google_drive_integrations FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: granola_integrations Members can read granola integrations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read granola integrations" ON public.granola_integrations FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: granola_synced_meetings Members can read granola synced meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read granola synced meetings" ON public.granola_synced_meetings FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: import_job_items Members can read import job items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read import job items" ON public.import_job_items FOR SELECT USING ((job_id IN ( SELECT import_jobs.id
   FROM public.import_jobs
  WHERE (import_jobs.workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)))));


--
-- Name: import_jobs Members can read import jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read import jobs" ON public.import_jobs FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: linear_integrations Members can read linear integrations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read linear integrations" ON public.linear_integrations FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: linear_synced_issues Members can read linear synced issues; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read linear synced issues" ON public.linear_synced_issues FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: media_objects Members can read media_objects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read media_objects" ON public.media_objects FOR SELECT USING (((verified_at IS NOT NULL) AND (workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids))));


--
-- Name: monitored_repos Members can read monitored repos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read monitored repos" ON public.monitored_repos FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: orgs Members can read orgs through their workspaces; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read orgs through their workspaces" ON public.orgs FOR SELECT USING ((id IN ( SELECT w.org_id
   FROM public.workspaces w
  WHERE (w.id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)))));


--
-- Name: portal_domain_routes Members can read portal domain routes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read portal domain routes" ON public.portal_domain_routes FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: portal_events Members can read portal events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read portal events" ON public.portal_events FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: document_retrieval_events Members can read retrieval events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read retrieval events" ON public.document_retrieval_events FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: search_events Members can read search events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read search events" ON public.search_events FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: team_members Members can read team members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read team members" ON public.team_members FOR SELECT USING ((team_id IN ( SELECT t.id
   FROM public.teams t
  WHERE (t.workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)))));


--
-- Name: topic_aliases Members can read topic aliases; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read topic aliases" ON public.topic_aliases FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: workspaces Members can read workspace; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read workspace" ON public.workspaces FOR SELECT USING ((id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: profiles Members can read workspace colleague profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read workspace colleague profiles" ON public.profiles FOR SELECT USING ((user_id IN ( SELECT wm.user_id
   FROM public.workspace_members wm
  WHERE (wm.workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)))));


--
-- Name: workspace_experiences Members can read workspace experiences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read workspace experiences" ON public.workspace_experiences FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: workspace_members Members can read workspace members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read workspace members" ON public.workspace_members FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: message_feedback Members can read workspace message feedback; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read workspace message feedback" ON public.message_feedback FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: subscriptions Members can read workspace subscription; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read workspace subscription" ON public.subscriptions FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: teams Members can read workspace teams; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read workspace teams" ON public.teams FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: documents Members can update accessible documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can update accessible documents" ON public.documents FOR UPDATE USING (((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)) AND ((folder_id IS NULL) OR public.can_access_folder(folder_id)))) WITH CHECK (((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)) AND ((folder_id IS NULL) OR public.can_access_folder(folder_id))));


--
-- Name: folders Members can update accessible folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can update accessible folders" ON public.folders FOR UPDATE USING (((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)) AND ((visibility = 'workspace'::text) OR ((visibility = 'role'::text) AND (EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = folders.workspace_id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (public.role_rank(wm.role) >= public.role_rank(folders.required_role)))))))));


--
-- Name: message_feedback Members can update their own message feedback; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can update their own message feedback" ON public.message_feedback FOR UPDATE USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM (public.chat_messages cm
     JOIN public.conversations c ON ((c.id = cm.conversation_id)))
  WHERE ((cm.id = message_feedback.message_id) AND (cm.conversation_id = message_feedback.conversation_id) AND (c.workspace_id = message_feedback.workspace_id) AND (cm.role = 'assistant'::text))))));


--
-- Name: documents Service role can insert documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can insert documents" ON public.documents FOR INSERT TO service_role WITH CHECK (true);


--
-- Name: conversations Users can delete own conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own conversations" ON public.conversations FOR DELETE USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: personal_access_tokens Users can delete own personal access tokens; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own personal access tokens" ON public.personal_access_tokens FOR DELETE USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: chat_messages Users can insert messages in own conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert messages in own conversations" ON public.chat_messages FOR INSERT WITH CHECK ((conversation_id IN ( SELECT c.id
   FROM public.conversations c
  WHERE (c.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: conversations Users can insert own conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own conversations" ON public.conversations FOR INSERT WITH CHECK (((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)) AND (user_id = ( SELECT auth.uid() AS uid))));


--
-- Name: chat_messages Users can read messages in own conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read messages in own conversations" ON public.chat_messages FOR SELECT USING ((conversation_id IN ( SELECT c.id
   FROM public.conversations c
  WHERE (c.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: conversations Users can read own conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own conversations" ON public.conversations FOR SELECT USING (((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)) AND (user_id = ( SELECT auth.uid() AS uid))));


--
-- Name: personal_access_tokens Users can read own personal access tokens; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own personal access tokens" ON public.personal_access_tokens FOR SELECT USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: profiles Users can read own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own profile" ON public.profiles FOR SELECT USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: conversations Users can update own conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own conversations" ON public.conversations FOR UPDATE USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: profiles Users can update own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: cloudflare_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cloudflare_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: cloudflare_oauth_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cloudflare_oauth_states ENABLE ROW LEVEL SECURITY;

--
-- Name: cloudflare_portal_deployments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cloudflare_portal_deployments ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: document_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_links ENABLE ROW LEVEL SECURITY;

--
-- Name: document_retrieval_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_retrieval_events ENABLE ROW LEVEL SECURITY;

--
-- Name: document_section; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_section ENABLE ROW LEVEL SECURITY;

--
-- Name: document_section_chunk; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_section_chunk ENABLE ROW LEVEL SECURITY;

--
-- Name: document_topics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_topics ENABLE ROW LEVEL SECURITY;

--
-- Name: document_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

--
-- Name: folders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;

--
-- Name: github_document_edit_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.github_document_edit_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: github_hosted_docs_sources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.github_hosted_docs_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: github_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.github_integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: github_repo_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.github_repo_files ENABLE ROW LEVEL SECURITY;

--
-- Name: github_user_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.github_user_links ENABLE ROW LEVEL SECURITY;

--
-- Name: google_drive_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.google_drive_integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: google_drive_synced_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.google_drive_synced_files ENABLE ROW LEVEL SECURITY;

--
-- Name: granola_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.granola_integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: granola_synced_meetings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.granola_synced_meetings ENABLE ROW LEVEL SECURITY;

--
-- Name: import_job_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_job_items ENABLE ROW LEVEL SECURITY;

--
-- Name: import_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: invite_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invite_links ENABLE ROW LEVEL SECURITY;

--
-- Name: linear_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.linear_integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: linear_synced_issues; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.linear_synced_issues ENABLE ROW LEVEL SECURITY;

--
-- Name: llm_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.llm_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_oauth_grants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mcp_oauth_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_oauth_grants mcp_oauth_grants_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY mcp_oauth_grants_select_own ON public.mcp_oauth_grants FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: mcp_oauth_grants mcp_oauth_grants_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY mcp_oauth_grants_update_own ON public.mcp_oauth_grants FOR UPDATE USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: media_objects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_objects ENABLE ROW LEVEL SECURITY;

--
-- Name: media_upload_rate_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_upload_rate_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: message_feedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_feedback ENABLE ROW LEVEL SECURITY;

--
-- Name: monitored_repos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.monitored_repos ENABLE ROW LEVEL SECURITY;

--
-- Name: orgs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orgs ENABLE ROW LEVEL SECURITY;

--
-- Name: personal_access_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.personal_access_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_domain_routes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portal_domain_routes ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portal_events ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: search_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.search_events ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: team_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

--
-- Name: teams; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

--
-- Name: topic_aliases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.topic_aliases ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

--
-- Name: document_versions workspace admins can delete versions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "workspace admins can delete versions" ON public.document_versions FOR DELETE USING (public.is_workspace_admin(workspace_id));


--
-- Name: document_versions workspace members can read versions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "workspace members can read versions" ON public.document_versions FOR SELECT USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: workspace_experiences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_experiences ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_media_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_media_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

--
-- Name: workspaces; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;


--
-- Name: TABLE github_hosted_docs_sources; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.github_hosted_docs_sources TO anon;
GRANT ALL ON TABLE public.github_hosted_docs_sources TO authenticated;
GRANT ALL ON TABLE public.github_hosted_docs_sources TO service_role;


--
-- Name: FUNCTION acquire_github_hosted_docs_publish_lease(p_source_id uuid, p_workspace_id uuid, p_operation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.acquire_github_hosted_docs_publish_lease(p_source_id uuid, p_workspace_id uuid, p_operation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.acquire_github_hosted_docs_publish_lease(p_source_id uuid, p_workspace_id uuid, p_operation_id uuid) TO anon;
GRANT ALL ON FUNCTION public.acquire_github_hosted_docs_publish_lease(p_source_id uuid, p_workspace_id uuid, p_operation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.acquire_github_hosted_docs_publish_lease(p_source_id uuid, p_workspace_id uuid, p_operation_id uuid) TO service_role;


--
-- Name: FUNCTION apply_github_hosted_document_update(p_document_id uuid, p_workspace_id uuid, p_expected_title text, p_expected_content text, p_title text, p_content text, p_source_metadata_patch jsonb, p_updated_at timestamp with time zone, p_require_conflict boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_github_hosted_document_update(p_document_id uuid, p_workspace_id uuid, p_expected_title text, p_expected_content text, p_title text, p_content text, p_source_metadata_patch jsonb, p_updated_at timestamp with time zone, p_require_conflict boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_github_hosted_document_update(p_document_id uuid, p_workspace_id uuid, p_expected_title text, p_expected_content text, p_title text, p_content text, p_source_metadata_patch jsonb, p_updated_at timestamp with time zone, p_require_conflict boolean) TO anon;
GRANT ALL ON FUNCTION public.apply_github_hosted_document_update(p_document_id uuid, p_workspace_id uuid, p_expected_title text, p_expected_content text, p_title text, p_content text, p_source_metadata_patch jsonb, p_updated_at timestamp with time zone, p_require_conflict boolean) TO authenticated;
GRANT ALL ON FUNCTION public.apply_github_hosted_document_update(p_document_id uuid, p_workspace_id uuid, p_expected_title text, p_expected_content text, p_title text, p_content text, p_source_metadata_patch jsonb, p_updated_at timestamp with time zone, p_require_conflict boolean) TO service_role;


--
-- Name: FUNCTION before_user_created_breeze_only(event jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.before_user_created_breeze_only(event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.before_user_created_breeze_only(event jsonb) TO service_role;
GRANT ALL ON FUNCTION public.before_user_created_breeze_only(event jsonb) TO supabase_auth_admin;


--
-- Name: FUNCTION can_access_folder(f_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.can_access_folder(f_id uuid) TO anon;
GRANT ALL ON FUNCTION public.can_access_folder(f_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.can_access_folder(f_id uuid) TO service_role;


--
-- Name: FUNCTION check_folder_parent(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.check_folder_parent() TO anon;
GRANT ALL ON FUNCTION public.check_folder_parent() TO authenticated;
GRANT ALL ON FUNCTION public.check_folder_parent() TO service_role;


--
-- Name: FUNCTION chunk_tsv_refresh(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.chunk_tsv_refresh() TO anon;
GRANT ALL ON FUNCTION public.chunk_tsv_refresh() TO authenticated;
GRANT ALL ON FUNCTION public.chunk_tsv_refresh() TO service_role;


--
-- Name: FUNCTION cleanup_stale_conversations(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cleanup_stale_conversations() TO anon;
GRANT ALL ON FUNCTION public.cleanup_stale_conversations() TO authenticated;
GRANT ALL ON FUNCTION public.cleanup_stale_conversations() TO service_role;


--
-- Name: FUNCTION cleanup_webhook_deliveries(retention_days integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cleanup_webhook_deliveries(retention_days integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cleanup_webhook_deliveries(retention_days integer) TO anon;
GRANT ALL ON FUNCTION public.cleanup_webhook_deliveries(retention_days integer) TO authenticated;
GRANT ALL ON FUNCTION public.cleanup_webhook_deliveries(retention_days integer) TO service_role;


--
-- Name: FUNCTION consume_media_upload_slot(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.consume_media_upload_slot(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.consume_media_upload_slot(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.consume_media_upload_slot(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.consume_media_upload_slot(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION delete_orphaned_workspaces(p_workspace_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delete_orphaned_workspaces(p_workspace_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_orphaned_workspaces(p_workspace_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.delete_orphaned_workspaces(p_workspace_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.delete_orphaned_workspaces(p_workspace_ids uuid[]) TO service_role;


--
-- Name: FUNCTION delete_user(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.delete_user() TO anon;
GRANT ALL ON FUNCTION public.delete_user() TO authenticated;
GRANT ALL ON FUNCTION public.delete_user() TO service_role;


--
-- Name: FUNCTION delete_workspace_if_no_active_members(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.delete_workspace_if_no_active_members() TO anon;
GRANT ALL ON FUNCTION public.delete_workspace_if_no_active_members() TO authenticated;
GRANT ALL ON FUNCTION public.delete_workspace_if_no_active_members() TO service_role;


--
-- Name: FUNCTION enforce_breeze_auth_email(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_breeze_auth_email() TO anon;
GRANT ALL ON FUNCTION public.enforce_breeze_auth_email() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_breeze_auth_email() TO service_role;


--
-- Name: FUNCTION enforce_free_document_limit(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_free_document_limit() TO anon;
GRANT ALL ON FUNCTION public.enforce_free_document_limit() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_free_document_limit() TO service_role;


--
-- Name: FUNCTION enforce_kb_capacity(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_kb_capacity() TO anon;
GRANT ALL ON FUNCTION public.enforce_kb_capacity() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_kb_capacity() TO service_role;


--
-- Name: FUNCTION enforce_workspace_media_storage_limit(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_workspace_media_storage_limit() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_workspace_media_storage_limit() TO anon;
GRANT ALL ON FUNCTION public.enforce_workspace_media_storage_limit() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_workspace_media_storage_limit() TO service_role;


--
-- Name: FUNCTION ensure_workspace_org(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ensure_workspace_org() TO anon;
GRANT ALL ON FUNCTION public.ensure_workspace_org() TO authenticated;
GRANT ALL ON FUNCTION public.ensure_workspace_org() TO service_role;


--
-- Name: FUNCTION folder_visible_to_role(p_folder_id uuid, p_caller_role text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.folder_visible_to_role(p_folder_id uuid, p_caller_role text) TO anon;
GRANT ALL ON FUNCTION public.folder_visible_to_role(p_folder_id uuid, p_caller_role text) TO authenticated;
GRANT ALL ON FUNCTION public.folder_visible_to_role(p_folder_id uuid, p_caller_role text) TO service_role;


--
-- Name: FUNCTION get_user_workspace_ids(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_user_workspace_ids() TO anon;
GRANT ALL ON FUNCTION public.get_user_workspace_ids() TO authenticated;
GRANT ALL ON FUNCTION public.get_user_workspace_ids() TO service_role;


--
-- Name: FUNCTION grep_documents(p_workspace_id uuid, p_pattern text, p_is_regex boolean, p_max_results integer, p_max_per_doc integer, p_caller_role text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.grep_documents(p_workspace_id uuid, p_pattern text, p_is_regex boolean, p_max_results integer, p_max_per_doc integer, p_caller_role text) TO anon;
GRANT ALL ON FUNCTION public.grep_documents(p_workspace_id uuid, p_pattern text, p_is_regex boolean, p_max_results integer, p_max_per_doc integer, p_caller_role text) TO authenticated;
GRANT ALL ON FUNCTION public.grep_documents(p_workspace_id uuid, p_pattern text, p_is_regex boolean, p_max_results integer, p_max_per_doc integer, p_caller_role text) TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.handle_new_user() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: FUNCTION increment_import_job_progress(p_job_id uuid, p_status text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.increment_import_job_progress(p_job_id uuid, p_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.increment_import_job_progress(p_job_id uuid, p_status text) TO anon;
GRANT ALL ON FUNCTION public.increment_import_job_progress(p_job_id uuid, p_status text) TO authenticated;
GRANT ALL ON FUNCTION public.increment_import_job_progress(p_job_id uuid, p_status text) TO service_role;


--
-- Name: FUNCTION is_breeze_email(p_email text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_breeze_email(p_email text) TO anon;
GRANT ALL ON FUNCTION public.is_breeze_email(p_email text) TO authenticated;
GRANT ALL ON FUNCTION public.is_breeze_email(p_email text) TO service_role;
GRANT ALL ON FUNCTION public.is_breeze_email(p_email text) TO supabase_auth_admin;


--
-- Name: FUNCTION is_workspace_admin(ws_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_workspace_admin(ws_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_workspace_admin(ws_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_workspace_admin(ws_id uuid) TO service_role;


--
-- Name: FUNCTION match_document_section_chunks(query_embedding extensions.vector, p_workspace_id uuid, p_document_id uuid, p_match_count integer, p_caller_role text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.match_document_section_chunks(query_embedding extensions.vector, p_workspace_id uuid, p_document_id uuid, p_match_count integer, p_caller_role text) TO anon;
GRANT ALL ON FUNCTION public.match_document_section_chunks(query_embedding extensions.vector, p_workspace_id uuid, p_document_id uuid, p_match_count integer, p_caller_role text) TO authenticated;
GRANT ALL ON FUNCTION public.match_document_section_chunks(query_embedding extensions.vector, p_workspace_id uuid, p_document_id uuid, p_match_count integer, p_caller_role text) TO service_role;


--
-- Name: FUNCTION match_document_section_chunks_hybrid(query_text text, query_embedding extensions.vector, p_workspace_id uuid, p_document_id uuid, p_match_count integer, p_lane_count integer, p_rrf_k integer, p_caller_role text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.match_document_section_chunks_hybrid(query_text text, query_embedding extensions.vector, p_workspace_id uuid, p_document_id uuid, p_match_count integer, p_lane_count integer, p_rrf_k integer, p_caller_role text) TO anon;
GRANT ALL ON FUNCTION public.match_document_section_chunks_hybrid(query_text text, query_embedding extensions.vector, p_workspace_id uuid, p_document_id uuid, p_match_count integer, p_lane_count integer, p_rrf_k integer, p_caller_role text) TO authenticated;
GRANT ALL ON FUNCTION public.match_document_section_chunks_hybrid(query_text text, query_embedding extensions.vector, p_workspace_id uuid, p_document_id uuid, p_match_count integer, p_lane_count integer, p_rrf_k integer, p_caller_role text) TO service_role;


--
-- Name: FUNCTION match_documents(query_embedding extensions.vector, match_threshold double precision, match_count integer, workspace_id uuid, caller_role text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.match_documents(query_embedding extensions.vector, match_threshold double precision, match_count integer, workspace_id uuid, caller_role text) TO anon;
GRANT ALL ON FUNCTION public.match_documents(query_embedding extensions.vector, match_threshold double precision, match_count integer, workspace_id uuid, caller_role text) TO authenticated;
GRANT ALL ON FUNCTION public.match_documents(query_embedding extensions.vector, match_threshold double precision, match_count integer, workspace_id uuid, caller_role text) TO service_role;


--
-- Name: FUNCTION match_folder_by_embedding(query_embedding extensions.vector, target_workspace_id uuid, similarity_threshold double precision, folder_kind text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.match_folder_by_embedding(query_embedding extensions.vector, target_workspace_id uuid, similarity_threshold double precision, folder_kind text) TO anon;
GRANT ALL ON FUNCTION public.match_folder_by_embedding(query_embedding extensions.vector, target_workspace_id uuid, similarity_threshold double precision, folder_kind text) TO authenticated;
GRANT ALL ON FUNCTION public.match_folder_by_embedding(query_embedding extensions.vector, target_workspace_id uuid, similarity_threshold double precision, folder_kind text) TO service_role;


--
-- Name: FUNCTION mcp_access_token_hook(event jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mcp_access_token_hook(event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mcp_access_token_hook(event jsonb) TO anon;
GRANT ALL ON FUNCTION public.mcp_access_token_hook(event jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.mcp_access_token_hook(event jsonb) TO service_role;
GRANT ALL ON FUNCTION public.mcp_access_token_hook(event jsonb) TO supabase_auth_admin;


--
-- Name: FUNCTION mcp_oauth_grants_fill_client_name(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.mcp_oauth_grants_fill_client_name() TO anon;
GRANT ALL ON FUNCTION public.mcp_oauth_grants_fill_client_name() TO authenticated;
GRANT ALL ON FUNCTION public.mcp_oauth_grants_fill_client_name() TO service_role;


--
-- Name: FUNCTION media_storage_limit_bytes(p_workspace_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.media_storage_limit_bytes(p_workspace_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.media_storage_limit_bytes(p_workspace_id uuid) TO anon;
GRANT ALL ON FUNCTION public.media_storage_limit_bytes(p_workspace_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.media_storage_limit_bytes(p_workspace_id uuid) TO service_role;


--
-- Name: FUNCTION merge_topic_folders(p_workspace_id uuid, p_source_ids uuid[], p_target_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.merge_topic_folders(p_workspace_id uuid, p_source_ids uuid[], p_target_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.merge_topic_folders(p_workspace_id uuid, p_source_ids uuid[], p_target_id uuid) TO anon;
GRANT ALL ON FUNCTION public.merge_topic_folders(p_workspace_id uuid, p_source_ids uuid[], p_target_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.merge_topic_folders(p_workspace_id uuid, p_source_ids uuid[], p_target_id uuid) TO service_role;


--
-- Name: FUNCTION prune_deleted_folder_from_portal_scopes(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.prune_deleted_folder_from_portal_scopes() FROM PUBLIC;
GRANT ALL ON FUNCTION public.prune_deleted_folder_from_portal_scopes() TO anon;
GRANT ALL ON FUNCTION public.prune_deleted_folder_from_portal_scopes() TO authenticated;
GRANT ALL ON FUNCTION public.prune_deleted_folder_from_portal_scopes() TO service_role;


--
-- Name: FUNCTION prune_portal_events(retention_days integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.prune_portal_events(retention_days integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.prune_portal_events(retention_days integer) TO anon;
GRANT ALL ON FUNCTION public.prune_portal_events(retention_days integer) TO authenticated;
GRANT ALL ON FUNCTION public.prune_portal_events(retention_days integer) TO service_role;


--
-- Name: FUNCTION prune_search_events(retention_days integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.prune_search_events(retention_days integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.prune_search_events(retention_days integer) TO anon;
GRANT ALL ON FUNCTION public.prune_search_events(retention_days integer) TO authenticated;
GRANT ALL ON FUNCTION public.prune_search_events(retention_days integer) TO service_role;


--
-- Name: FUNCTION rls_auto_enable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.rls_auto_enable() TO anon;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO authenticated;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO service_role;


--
-- Name: FUNCTION role_rank(role text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.role_rank(role text) TO anon;
GRANT ALL ON FUNCTION public.role_rank(role text) TO authenticated;
GRANT ALL ON FUNCTION public.role_rank(role text) TO service_role;


--
-- Name: TABLE workspace_experiences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workspace_experiences TO anon;
GRANT ALL ON TABLE public.workspace_experiences TO authenticated;
GRANT ALL ON TABLE public.workspace_experiences TO service_role;


--
-- Name: FUNCTION save_portal_edit(p_workspace_id uuid, p_slug text, p_spec jsonb, p_editor_id uuid, p_source_version integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.save_portal_edit(p_workspace_id uuid, p_slug text, p_spec jsonb, p_editor_id uuid, p_source_version integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.save_portal_edit(p_workspace_id uuid, p_slug text, p_spec jsonb, p_editor_id uuid, p_source_version integer) TO anon;
GRANT ALL ON FUNCTION public.save_portal_edit(p_workspace_id uuid, p_slug text, p_spec jsonb, p_editor_id uuid, p_source_version integer) TO authenticated;
GRANT ALL ON FUNCTION public.save_portal_edit(p_workspace_id uuid, p_slug text, p_spec jsonb, p_editor_id uuid, p_source_version integer) TO service_role;


--
-- Name: FUNCTION section_tsv_cascade(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.section_tsv_cascade() TO anon;
GRANT ALL ON FUNCTION public.section_tsv_cascade() TO authenticated;
GRANT ALL ON FUNCTION public.section_tsv_cascade() TO service_role;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;


--
-- Name: FUNCTION skip_free_document_versions(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.skip_free_document_versions() TO anon;
GRANT ALL ON FUNCTION public.skip_free_document_versions() TO authenticated;
GRANT ALL ON FUNCTION public.skip_free_document_versions() TO service_role;


--
-- Name: FUNCTION sync_portal_domain_route_project(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_portal_domain_route_project() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sync_portal_domain_route_project() TO anon;
GRANT ALL ON FUNCTION public.sync_portal_domain_route_project() TO authenticated;
GRANT ALL ON FUNCTION public.sync_portal_domain_route_project() TO service_role;


--
-- Name: FUNCTION workspace_has_paid_subscription(p_workspace_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.workspace_has_paid_subscription(p_workspace_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.workspace_has_paid_subscription(p_workspace_id uuid) TO anon;
GRANT ALL ON FUNCTION public.workspace_has_paid_subscription(p_workspace_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.workspace_has_paid_subscription(p_workspace_id uuid) TO service_role;


--
-- Name: FUNCTION workspace_storage_bytes(target_workspace_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.workspace_storage_bytes(target_workspace_id uuid) TO anon;
GRANT ALL ON FUNCTION public.workspace_storage_bytes(target_workspace_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.workspace_storage_bytes(target_workspace_id uuid) TO service_role;


--
-- Name: TABLE api_keys; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.api_keys TO anon;
GRANT ALL ON TABLE public.api_keys TO authenticated;
GRANT ALL ON TABLE public.api_keys TO service_role;


--
-- Name: TABLE chat_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chat_messages TO anon;
GRANT ALL ON TABLE public.chat_messages TO authenticated;
GRANT ALL ON TABLE public.chat_messages TO service_role;


--
-- Name: TABLE cloudflare_connections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cloudflare_connections TO anon;
GRANT ALL ON TABLE public.cloudflare_connections TO authenticated;
GRANT ALL ON TABLE public.cloudflare_connections TO service_role;


--
-- Name: TABLE cloudflare_oauth_states; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cloudflare_oauth_states TO anon;
GRANT ALL ON TABLE public.cloudflare_oauth_states TO authenticated;
GRANT ALL ON TABLE public.cloudflare_oauth_states TO service_role;


--
-- Name: TABLE cloudflare_portal_deployments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cloudflare_portal_deployments TO anon;
GRANT ALL ON TABLE public.cloudflare_portal_deployments TO authenticated;
GRANT ALL ON TABLE public.cloudflare_portal_deployments TO service_role;


--
-- Name: TABLE conversations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.conversations TO anon;
GRANT ALL ON TABLE public.conversations TO authenticated;
GRANT ALL ON TABLE public.conversations TO service_role;


--
-- Name: TABLE document_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.document_links TO anon;
GRANT ALL ON TABLE public.document_links TO authenticated;
GRANT ALL ON TABLE public.document_links TO service_role;


--
-- Name: TABLE document_retrieval_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.document_retrieval_events TO anon;
GRANT ALL ON TABLE public.document_retrieval_events TO authenticated;
GRANT ALL ON TABLE public.document_retrieval_events TO service_role;


--
-- Name: TABLE document_section; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.document_section TO anon;
GRANT ALL ON TABLE public.document_section TO authenticated;
GRANT ALL ON TABLE public.document_section TO service_role;


--
-- Name: TABLE document_section_chunk; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.document_section_chunk TO anon;
GRANT ALL ON TABLE public.document_section_chunk TO authenticated;
GRANT ALL ON TABLE public.document_section_chunk TO service_role;


--
-- Name: TABLE document_topics; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.document_topics TO anon;
GRANT ALL ON TABLE public.document_topics TO authenticated;
GRANT ALL ON TABLE public.document_topics TO service_role;


--
-- Name: TABLE document_versions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.document_versions TO anon;
GRANT ALL ON TABLE public.document_versions TO authenticated;
GRANT ALL ON TABLE public.document_versions TO service_role;


--
-- Name: TABLE documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.documents TO anon;
GRANT ALL ON TABLE public.documents TO authenticated;
GRANT ALL ON TABLE public.documents TO service_role;


--
-- Name: TABLE folders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.folders TO anon;
GRANT ALL ON TABLE public.folders TO authenticated;
GRANT ALL ON TABLE public.folders TO service_role;


--
-- Name: TABLE folder_stats; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.folder_stats TO anon;
GRANT ALL ON TABLE public.folder_stats TO authenticated;
GRANT ALL ON TABLE public.folder_stats TO service_role;


--
-- Name: TABLE github_document_edit_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.github_document_edit_sessions TO anon;
GRANT ALL ON TABLE public.github_document_edit_sessions TO authenticated;
GRANT ALL ON TABLE public.github_document_edit_sessions TO service_role;


--
-- Name: TABLE github_integrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.github_integrations TO anon;
GRANT ALL ON TABLE public.github_integrations TO authenticated;
GRANT ALL ON TABLE public.github_integrations TO service_role;


--
-- Name: TABLE github_repo_files; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.github_repo_files TO anon;
GRANT ALL ON TABLE public.github_repo_files TO authenticated;
GRANT ALL ON TABLE public.github_repo_files TO service_role;


--
-- Name: TABLE github_user_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.github_user_links TO anon;
GRANT ALL ON TABLE public.github_user_links TO authenticated;
GRANT ALL ON TABLE public.github_user_links TO service_role;


--
-- Name: TABLE google_drive_integrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.google_drive_integrations TO anon;
GRANT ALL ON TABLE public.google_drive_integrations TO authenticated;
GRANT ALL ON TABLE public.google_drive_integrations TO service_role;


--
-- Name: TABLE google_drive_synced_files; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.google_drive_synced_files TO anon;
GRANT ALL ON TABLE public.google_drive_synced_files TO authenticated;
GRANT ALL ON TABLE public.google_drive_synced_files TO service_role;


--
-- Name: TABLE granola_integrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.granola_integrations TO anon;
GRANT ALL ON TABLE public.granola_integrations TO authenticated;
GRANT ALL ON TABLE public.granola_integrations TO service_role;


--
-- Name: TABLE granola_synced_meetings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.granola_synced_meetings TO anon;
GRANT ALL ON TABLE public.granola_synced_meetings TO authenticated;
GRANT ALL ON TABLE public.granola_synced_meetings TO service_role;


--
-- Name: TABLE import_job_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.import_job_items TO anon;
GRANT ALL ON TABLE public.import_job_items TO authenticated;
GRANT ALL ON TABLE public.import_job_items TO service_role;


--
-- Name: TABLE import_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.import_jobs TO anon;
GRANT ALL ON TABLE public.import_jobs TO authenticated;
GRANT ALL ON TABLE public.import_jobs TO service_role;


--
-- Name: TABLE invite_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.invite_links TO anon;
GRANT ALL ON TABLE public.invite_links TO authenticated;
GRANT ALL ON TABLE public.invite_links TO service_role;


--
-- Name: TABLE linear_integrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.linear_integrations TO anon;
GRANT ALL ON TABLE public.linear_integrations TO authenticated;
GRANT ALL ON TABLE public.linear_integrations TO service_role;


--
-- Name: TABLE linear_synced_issues; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.linear_synced_issues TO anon;
GRANT ALL ON TABLE public.linear_synced_issues TO authenticated;
GRANT ALL ON TABLE public.linear_synced_issues TO service_role;


--
-- Name: TABLE llm_metrics; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.llm_metrics TO anon;
GRANT ALL ON TABLE public.llm_metrics TO authenticated;
GRANT ALL ON TABLE public.llm_metrics TO service_role;


--
-- Name: TABLE mcp_oauth_grants; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.mcp_oauth_grants TO anon;
GRANT ALL ON TABLE public.mcp_oauth_grants TO authenticated;
GRANT ALL ON TABLE public.mcp_oauth_grants TO service_role;


--
-- Name: TABLE media_objects; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.media_objects TO anon;
GRANT ALL ON TABLE public.media_objects TO authenticated;
GRANT ALL ON TABLE public.media_objects TO service_role;


--
-- Name: TABLE media_upload_rate_limits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.media_upload_rate_limits TO anon;
GRANT ALL ON TABLE public.media_upload_rate_limits TO authenticated;
GRANT ALL ON TABLE public.media_upload_rate_limits TO service_role;


--
-- Name: TABLE message_feedback; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.message_feedback TO anon;
GRANT ALL ON TABLE public.message_feedback TO authenticated;
GRANT ALL ON TABLE public.message_feedback TO service_role;


--
-- Name: TABLE monitored_repos; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.monitored_repos TO anon;
GRANT ALL ON TABLE public.monitored_repos TO authenticated;
GRANT ALL ON TABLE public.monitored_repos TO service_role;


--
-- Name: TABLE orgs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.orgs TO anon;
GRANT ALL ON TABLE public.orgs TO authenticated;
GRANT ALL ON TABLE public.orgs TO service_role;


--
-- Name: TABLE personal_access_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.personal_access_tokens TO anon;
GRANT ALL ON TABLE public.personal_access_tokens TO authenticated;
GRANT ALL ON TABLE public.personal_access_tokens TO service_role;


--
-- Name: TABLE portal_domain_routes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.portal_domain_routes TO anon;
GRANT ALL ON TABLE public.portal_domain_routes TO authenticated;
GRANT ALL ON TABLE public.portal_domain_routes TO service_role;


--
-- Name: TABLE portal_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.portal_events TO anon;
GRANT ALL ON TABLE public.portal_events TO authenticated;
GRANT ALL ON TABLE public.portal_events TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: TABLE search_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.search_events TO anon;
GRANT ALL ON TABLE public.search_events TO authenticated;
GRANT ALL ON TABLE public.search_events TO service_role;


--
-- Name: TABLE subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.subscriptions TO anon;
GRANT ALL ON TABLE public.subscriptions TO authenticated;
GRANT ALL ON TABLE public.subscriptions TO service_role;


--
-- Name: TABLE team_members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.team_members TO anon;
GRANT ALL ON TABLE public.team_members TO authenticated;
GRANT ALL ON TABLE public.team_members TO service_role;


--
-- Name: TABLE teams; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.teams TO anon;
GRANT ALL ON TABLE public.teams TO authenticated;
GRANT ALL ON TABLE public.teams TO service_role;


--
-- Name: TABLE topic_aliases; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.topic_aliases TO anon;
GRANT ALL ON TABLE public.topic_aliases TO authenticated;
GRANT ALL ON TABLE public.topic_aliases TO service_role;


--
-- Name: TABLE webhook_deliveries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.webhook_deliveries TO anon;
GRANT ALL ON TABLE public.webhook_deliveries TO authenticated;
GRANT ALL ON TABLE public.webhook_deliveries TO service_role;


--
-- Name: TABLE workspace_media_usage; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workspace_media_usage TO anon;
GRANT ALL ON TABLE public.workspace_media_usage TO authenticated;
GRANT ALL ON TABLE public.workspace_media_usage TO service_role;


--
-- Name: TABLE workspace_members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workspace_members TO anon;
GRANT ALL ON TABLE public.workspace_members TO authenticated;
GRANT ALL ON TABLE public.workspace_members TO service_role;


--
-- Name: TABLE workspaces; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workspaces TO anon;
GRANT ALL ON TABLE public.workspaces TO authenticated;
GRANT ALL ON TABLE public.workspaces TO service_role;


--
-- Name: TABLE workspace_usage_current_period; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workspace_usage_current_period TO anon;
GRANT ALL ON TABLE public.workspace_usage_current_period TO authenticated;
GRANT ALL ON TABLE public.workspace_usage_current_period TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--



-- Objects outside the public schema --------------------------------------

-- Profile row + pending-invite attach on signup.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only @breeze.com / @breeze.cash accounts may exist. The matching
-- before_user_created hook (public.before_user_created_breeze_only) must also
-- be enabled in Dashboard -> Authentication -> Hooks on hosted projects.
drop trigger if exists enforce_breeze_auth_email on auth.users;
create trigger enforce_breeze_auth_email
  before insert or update of email on auth.users
  for each row execute function public.enforce_breeze_auth_email();

alter publication supabase_realtime ADD TABLE ONLY public.document_versions, public.documents, public.folders, public.github_document_edit_sessions, public.subscriptions, public.team_members, public.teams, public.workspace_members, public.workspaces;

insert into storage.buckets (id, name, public)
values ('assets', 'assets', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('import-uploads', 'import-uploads', false, 104857600,
        '{application/zip,application/x-zip-compressed,application/octet-stream}')
on conflict (id) do nothing;

select cron.schedule('cleanup-webhook-deliveries', '17 3 * * *',
                     'select public.cleanup_webhook_deliveries();');
