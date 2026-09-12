create table if not exists public.recent_object_memories (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  identity_key text not null check (char_length(identity_key) between 1 and 512),
  label text not null check (char_length(label) between 1 and 100),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 8),
  color text check (color is null or char_length(color) between 1 and 40),
  appearance text check (appearance is null or char_length(appearance) between 1 and 240),
  attributes text[] not null default '{}' check (cardinality(attributes) <= 8),
  spatial_relations text[] not null default '{}' check (cardinality(spatial_relations) <= 8),
  confidence real not null check (confidence between 0 and 1),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz not null,
  seen_count bigint not null default 1 check (seen_count between 1 and 1000000),
  evidence_frame_ids text[] not null default '{}' check (cardinality(evidence_frame_ids) <= 8),
  evidence_observation_ids text[] not null default '{}' check (cardinality(evidence_observation_ids) <= 8),
  updated_at timestamptz not null default now(),
  primary key (owner_id, identity_key),
  check (first_seen_at <= last_seen_at),
  check (expires_at = last_seen_at + interval '5 minutes')
);

create table if not exists public.episodic_memory_events (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_event_id text not null check (char_length(client_event_id) between 1 and 240),
  event_type text not null check (event_type in ('PUT_DOWN', 'LAST_SEEN')),
  subject_label text not null check (char_length(subject_label) between 1 and 100),
  location_text text check (location_text is null or char_length(location_text) between 1 and 240),
  relation text check (relation is null or char_length(relation) between 1 and 80),
  anchor_label text check (anchor_label is null or char_length(anchor_label) between 1 and 100),
  appearance text check (appearance is null or char_length(appearance) between 1 and 240),
  attributes jsonb not null default '{}'::jsonb
    check (jsonb_typeof(attributes) = 'object' and pg_column_size(attributes) <= 4096),
  confidence real not null check (confidence between 0 and 1),
  evidence_frame_ids text[] not null default '{}' check (cardinality(evidence_frame_ids) <= 8),
  evidence_observation_ids text[] not null default '{}' check (cardinality(evidence_observation_ids) <= 8),
  captured_at timestamptz not null,
  last_confirmed_at timestamptz,
  epistemic_state text not null check (epistemic_state in ('LAST_SEEN', 'INFERRED', 'UNKNOWN')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, client_event_id)
);

-- This file intentionally has a later version than the first prototype. If an
-- earlier draft already ran, replace its silent 240-character key truncation
-- boundary before installing the hardened write RPCs.
alter table public.recent_object_memories
  drop constraint if exists recent_object_memories_identity_key_check;
alter table public.recent_object_memories
  drop constraint if exists recent_identity_key_length_check;
alter table public.recent_object_memories
  add constraint recent_identity_key_length_check
  check (char_length(identity_key) between 1 and 512);

create index if not exists recent_owner_expiry_idx
  on public.recent_object_memories (owner_id, expires_at desc);
create index if not exists recent_owner_seen_idx
  on public.recent_object_memories (owner_id, last_seen_at desc);
create index if not exists recent_expiry_cleanup_idx
  on public.recent_object_memories (expires_at);
create index if not exists events_owner_subject_time_idx
  on public.episodic_memory_events (owner_id, subject_label, captured_at desc);
create index if not exists events_owner_time_idx
  on public.episodic_memory_events (owner_id, captured_at desc);
create index if not exists events_retention_cleanup_idx
  on public.episodic_memory_events (captured_at);

alter table public.recent_object_memories enable row level security;
alter table public.episodic_memory_events enable row level security;

drop policy if exists "owners manage recent visual memory" on public.recent_object_memories;
drop policy if exists "owners read recent visual memory" on public.recent_object_memories;
create policy "owners read recent visual memory"
  on public.recent_object_memories
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "owners manage episodic visual memory" on public.episodic_memory_events;
drop policy if exists "owners read episodic visual memory" on public.episodic_memory_events;
create policy "owners read episodic visual memory"
  on public.episodic_memory_events
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

revoke all on table public.recent_object_memories from anon, authenticated;
revoke all on table public.episodic_memory_events from anon, authenticated;
grant select on table public.recent_object_memories to authenticated;
grant select on table public.episodic_memory_events to authenticated;

create or replace function public.visual_memory_text_array(
  payload jsonb,
  field_name text,
  max_items integer,
  max_item_length integer
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  raw_value jsonb := coalesce(payload -> field_name, '[]'::jsonb);
begin
  if max_items < 0 or max_item_length < 1 or jsonb_typeof(raw_value) <> 'array' then
    raise exception 'Invalid % array', field_name using errcode = '22023';
  end if;
  if jsonb_array_length(raw_value) > max_items then
    raise exception '% contains too many items', field_name using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(raw_value) as entry(value)
    where jsonb_typeof(entry.value) <> 'string'
      or char_length(btrim(entry.value #>> '{}')) not between 1 and max_item_length
  ) then
    raise exception '% contains an invalid string', field_name using errcode = '22023';
  end if;
  return array(
    select btrim(entry.value #>> '{}')
    from jsonb_array_elements(raw_value) as entry(value)
  );
end;
$$;

revoke all on function public.visual_memory_text_array(jsonb, text, integer, integer) from public, anon, authenticated;

create or replace function public.read_recent_object_memories()
returns setof public.recent_object_memories
language sql
stable
security invoker
set search_path = ''
as $$
  select memory.*
  from public.recent_object_memories as memory
  where memory.owner_id = auth.uid()
    and memory.expires_at > statement_timestamp()
  order by memory.last_seen_at desc
  limit 500
$$;

revoke all on function public.read_recent_object_memories() from public, anon;
grant execute on function public.read_recent_object_memories() to authenticated;

create or replace function public.merge_recent_object_sightings(sightings jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_owner uuid := auth.uid();
  server_now timestamptz := statement_timestamp();
  item jsonb;
  merged_count integer := 0;
  item_identity text;
  item_label text;
  item_color text;
  item_appearance text;
  item_confidence real;
  item_seen_count bigint;
  item_first_seen timestamptz;
  item_last_seen timestamptz;
begin
  if current_owner is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if sightings is null or jsonb_typeof(sightings) <> 'array' then
    raise exception 'sightings must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(sightings) > 50 or pg_column_size(sightings) > 131072 then
    raise exception 'sightings exceeds the batch limit' using errcode = '22023';
  end if;

  -- Serialize every write for one auth UID so concurrent browser tabs cannot
  -- exceed the transaction-level 500/100 row caps.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(current_owner::text, 2026091200)
  );

  delete from public.recent_object_memories
  where owner_id = current_owner and expires_at <= server_now;

  for item in select value from jsonb_array_elements(sightings)
  loop
    if jsonb_typeof(item) <> 'object' then
      raise exception 'Each sighting must be an object' using errcode = '22023';
    end if;
    if jsonb_typeof(item -> 'identity_key') <> 'string'
      or jsonb_typeof(item -> 'label') <> 'string'
      or jsonb_typeof(item -> 'confidence') <> 'number'
      or jsonb_typeof(item -> 'seen_count') <> 'number'
      or jsonb_typeof(item -> 'first_seen_at') <> 'string'
      or jsonb_typeof(item -> 'last_seen_at') <> 'string' then
      raise exception 'A sighting has invalid required field types' using errcode = '22023';
    end if;
    if (item ? 'color' and jsonb_typeof(item -> 'color') not in ('string', 'null'))
      or (item ? 'appearance' and jsonb_typeof(item -> 'appearance') not in ('string', 'null')) then
      raise exception 'A sighting has invalid optional field types' using errcode = '22023';
    end if;

    item_identity := btrim(item ->> 'identity_key');
    item_label := btrim(item ->> 'label');
    item_color := nullif(btrim(item ->> 'color'), '');
    item_appearance := nullif(btrim(item ->> 'appearance'), '');
    if char_length(item_identity) not between 1 and 512
      or char_length(item_label) not between 1 and 100
      or (item_color is not null and char_length(item_color) > 40)
      or (item_appearance is not null and char_length(item_appearance) > 240) then
      raise exception 'A sighting has an invalid string length' using errcode = '22023';
    end if;

    item_confidence := (item ->> 'confidence')::real;
    item_seen_count := (item ->> 'seen_count')::bigint;
    if item_confidence not between 0 and 1 or item_seen_count not between 1 and 1000000 then
      raise exception 'A sighting has an invalid numeric value' using errcode = '22023';
    end if;

    item_first_seen := (item ->> 'first_seen_at')::timestamptz;
    item_last_seen := least((item ->> 'last_seen_at')::timestamptz, server_now);
    item_first_seen := greatest(
      least(item_first_seen, item_last_seen),
      item_last_seen - interval '5 minutes'
    );
    if item_last_seen <= server_now - interval '5 minutes' then
      continue;
    end if;

    insert into public.recent_object_memories (
      owner_id, identity_key, label, aliases, color, appearance, attributes,
      spatial_relations, confidence, first_seen_at, last_seen_at, expires_at,
      seen_count, evidence_frame_ids, evidence_observation_ids, updated_at
    ) values (
      current_owner,
      item_identity,
      item_label,
      public.visual_memory_text_array(item, 'aliases', 8, 100),
      item_color,
      item_appearance,
      public.visual_memory_text_array(item, 'attributes', 8, 100),
      public.visual_memory_text_array(item, 'spatial_relations', 8, 160),
      item_confidence,
      item_first_seen,
      item_last_seen,
      item_last_seen + interval '5 minutes',
      item_seen_count,
      public.visual_memory_text_array(item, 'evidence_frame_ids', 8, 160),
      public.visual_memory_text_array(item, 'evidence_observation_ids', 8, 160),
      server_now
    )
    on conflict (owner_id, identity_key) do update set
      label = case when excluded.last_seen_at >= public.recent_object_memories.last_seen_at then excluded.label else public.recent_object_memories.label end,
      aliases = case when excluded.last_seen_at >= public.recent_object_memories.last_seen_at then excluded.aliases else public.recent_object_memories.aliases end,
      color = case when excluded.last_seen_at >= public.recent_object_memories.last_seen_at then coalesce(excluded.color, public.recent_object_memories.color) else public.recent_object_memories.color end,
      appearance = case when excluded.last_seen_at >= public.recent_object_memories.last_seen_at then coalesce(excluded.appearance, public.recent_object_memories.appearance) else public.recent_object_memories.appearance end,
      attributes = case when excluded.last_seen_at >= public.recent_object_memories.last_seen_at then excluded.attributes else public.recent_object_memories.attributes end,
      spatial_relations = case when excluded.last_seen_at >= public.recent_object_memories.last_seen_at then excluded.spatial_relations else public.recent_object_memories.spatial_relations end,
      confidence = case when excluded.last_seen_at >= public.recent_object_memories.last_seen_at then excluded.confidence else public.recent_object_memories.confidence end,
      first_seen_at = least(public.recent_object_memories.first_seen_at, excluded.first_seen_at),
      last_seen_at = greatest(public.recent_object_memories.last_seen_at, excluded.last_seen_at),
      expires_at = greatest(public.recent_object_memories.expires_at, excluded.expires_at),
      seen_count = greatest(public.recent_object_memories.seen_count, excluded.seen_count),
      evidence_frame_ids = case when excluded.last_seen_at >= public.recent_object_memories.last_seen_at then excluded.evidence_frame_ids else public.recent_object_memories.evidence_frame_ids end,
      evidence_observation_ids = case when excluded.last_seen_at >= public.recent_object_memories.last_seen_at then excluded.evidence_observation_ids else public.recent_object_memories.evidence_observation_ids end,
      updated_at = server_now;
    merged_count := merged_count + 1;
  end loop;

  delete from public.recent_object_memories
  where owner_id = current_owner
    and identity_key in (
      select identity_key
      from public.recent_object_memories
      where owner_id = current_owner
      order by last_seen_at desc, identity_key
      offset 500
    );

  return merged_count;
end;
$$;

revoke all on function public.merge_recent_object_sightings(jsonb) from public, anon;
grant execute on function public.merge_recent_object_sightings(jsonb) to authenticated;

create or replace function public.upsert_episodic_memory_events(events jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_owner uuid := auth.uid();
  server_now timestamptz := statement_timestamp();
  item jsonb;
  stored_count integer := 0;
  item_id text;
  item_type text;
  item_subject text;
  item_location text;
  item_relation text;
  item_anchor text;
  item_appearance text;
  item_attributes jsonb;
  item_confidence real;
  item_captured_at timestamptz;
  item_last_confirmed_at timestamptz;
  item_epistemic text;
begin
  if current_owner is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if events is null or jsonb_typeof(events) <> 'array' then
    raise exception 'events must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(events) > 50 or pg_column_size(events) > 131072 then
    raise exception 'events exceeds the batch limit' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(current_owner::text, 2026091200)
  );

  -- Thirty days is ample for this demo and prevents abandoned anonymous
  -- identities from retaining placement events indefinitely once Cron runs.
  delete from public.episodic_memory_events
  where owner_id = current_owner
    and captured_at < server_now - interval '30 days';

  for item in select value from jsonb_array_elements(events)
  loop
    if jsonb_typeof(item) <> 'object' then
      raise exception 'Each event must be an object' using errcode = '22023';
    end if;
    if jsonb_typeof(item -> 'client_event_id') <> 'string'
      or jsonb_typeof(item -> 'event_type') <> 'string'
      or jsonb_typeof(item -> 'subject_label') <> 'string'
      or jsonb_typeof(item -> 'confidence') <> 'number'
      or jsonb_typeof(item -> 'captured_at') <> 'string'
      or jsonb_typeof(item -> 'epistemic_state') <> 'string' then
      raise exception 'An event has invalid required field types' using errcode = '22023';
    end if;
    if (item ? 'location_text' and jsonb_typeof(item -> 'location_text') not in ('string', 'null'))
      or (item ? 'relation' and jsonb_typeof(item -> 'relation') not in ('string', 'null'))
      or (item ? 'anchor_label' and jsonb_typeof(item -> 'anchor_label') not in ('string', 'null'))
      or (item ? 'appearance' and jsonb_typeof(item -> 'appearance') not in ('string', 'null'))
      or (item ? 'last_confirmed_at' and jsonb_typeof(item -> 'last_confirmed_at') not in ('string', 'null')) then
      raise exception 'An event has invalid optional field types' using errcode = '22023';
    end if;

    item_id := btrim(item ->> 'client_event_id');
    item_type := btrim(item ->> 'event_type');
    item_subject := btrim(item ->> 'subject_label');
    item_location := nullif(btrim(item ->> 'location_text'), '');
    item_relation := nullif(btrim(item ->> 'relation'), '');
    item_anchor := nullif(btrim(item ->> 'anchor_label'), '');
    item_appearance := nullif(btrim(item ->> 'appearance'), '');
    item_epistemic := btrim(item ->> 'epistemic_state');
    if char_length(item_id) not between 1 and 240
      or item_type not in ('PUT_DOWN', 'LAST_SEEN')
      or char_length(item_subject) not between 1 and 100
      or (item_location is not null and char_length(item_location) > 240)
      or (item_relation is not null and char_length(item_relation) > 80)
      or (item_anchor is not null and char_length(item_anchor) > 100)
      or (item_appearance is not null and char_length(item_appearance) > 240)
      or item_epistemic not in ('LAST_SEEN', 'INFERRED', 'UNKNOWN') then
      raise exception 'An event has an invalid string value' using errcode = '22023';
    end if;

    item_attributes := coalesce(item -> 'attributes', '{}'::jsonb);
    if jsonb_typeof(item_attributes) <> 'object' or pg_column_size(item_attributes) > 4096 then
      raise exception 'An event has invalid attributes' using errcode = '22023';
    end if;
    item_confidence := (item ->> 'confidence')::real;
    if item_confidence not between 0 and 1 then
      raise exception 'An event has invalid confidence' using errcode = '22023';
    end if;

    item_captured_at := least((item ->> 'captured_at')::timestamptz, server_now);
    if item_captured_at < server_now - interval '30 days' then
      continue;
    end if;
    item_last_confirmed_at := case
      when item ->> 'last_confirmed_at' is null then null
      else greatest(item_captured_at, least((item ->> 'last_confirmed_at')::timestamptz, server_now))
    end;

    insert into public.episodic_memory_events (
      owner_id, client_event_id, event_type, subject_label, location_text,
      relation, anchor_label, appearance, attributes, confidence,
      evidence_frame_ids, evidence_observation_ids, captured_at,
      last_confirmed_at, epistemic_state, updated_at
    ) values (
      current_owner,
      item_id,
      item_type,
      item_subject,
      item_location,
      item_relation,
      item_anchor,
      item_appearance,
      item_attributes,
      item_confidence,
      public.visual_memory_text_array(item, 'evidence_frame_ids', 8, 160),
      public.visual_memory_text_array(item, 'evidence_observation_ids', 8, 160),
      item_captured_at,
      item_last_confirmed_at,
      item_epistemic,
      server_now
    )
    on conflict (owner_id, client_event_id) do update set
      event_type = excluded.event_type,
      subject_label = excluded.subject_label,
      location_text = excluded.location_text,
      relation = excluded.relation,
      anchor_label = excluded.anchor_label,
      appearance = excluded.appearance,
      attributes = excluded.attributes,
      confidence = excluded.confidence,
      evidence_frame_ids = excluded.evidence_frame_ids,
      evidence_observation_ids = excluded.evidence_observation_ids,
      captured_at = excluded.captured_at,
      last_confirmed_at = excluded.last_confirmed_at,
      epistemic_state = excluded.epistemic_state,
      updated_at = server_now;
    stored_count := stored_count + 1;
  end loop;

  delete from public.episodic_memory_events
  where owner_id = current_owner
    and client_event_id in (
      select client_event_id
      from public.episodic_memory_events
      where owner_id = current_owner
      order by captured_at desc, updated_at desc, client_event_id
      offset 100
    );

  return stored_count;
end;
$$;

revoke all on function public.upsert_episodic_memory_events(jsonb) from public, anon;
grant execute on function public.upsert_episodic_memory_events(jsonb) to authenticated;
