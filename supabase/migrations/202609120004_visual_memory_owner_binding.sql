-- Bind every memory request to the anonymous auth UID pinned by the browser.
-- This closes the gap where another tab could replace the client token between
-- a local getSession() check and the actual PostgREST request.
create or replace function public.read_recent_object_memories(expected_owner uuid)
returns setof public.recent_object_memories
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from expected_owner then
    raise exception 'The authenticated memory owner changed' using errcode = '42501';
  end if;
  return query
    select memory.*
    from public.recent_object_memories as memory
    where memory.owner_id = expected_owner
      and memory.expires_at > statement_timestamp()
    order by memory.last_seen_at desc
    limit 500;
end;
$$;

create or replace function public.merge_recent_object_sightings(
  expected_owner uuid,
  sightings jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from expected_owner then
    raise exception 'The authenticated memory owner changed' using errcode = '42501';
  end if;
  return public.merge_recent_object_sightings(sightings);
end;
$$;

create or replace function public.upsert_episodic_memory_events(
  expected_owner uuid,
  events jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from expected_owner then
    raise exception 'The authenticated memory owner changed' using errcode = '42501';
  end if;
  return public.upsert_episodic_memory_events(events);
end;
$$;

revoke all on function public.read_recent_object_memories() from public, anon, authenticated;
revoke all on function public.merge_recent_object_sightings(jsonb) from public, anon, authenticated;
revoke all on function public.upsert_episodic_memory_events(jsonb) from public, anon, authenticated;

revoke all on function public.read_recent_object_memories(uuid) from public, anon;
revoke all on function public.merge_recent_object_sightings(uuid, jsonb) from public, anon;
revoke all on function public.upsert_episodic_memory_events(uuid, jsonb) from public, anon;
grant execute on function public.read_recent_object_memories(uuid) to authenticated;
grant execute on function public.merge_recent_object_sightings(uuid, jsonb) to authenticated;
grant execute on function public.upsert_episodic_memory_events(uuid, jsonb) to authenticated;
