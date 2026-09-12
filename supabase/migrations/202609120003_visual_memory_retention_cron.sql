-- Enable the Supabase Cron integration before applying this optional migration.
-- Keeping it separate lets the core tables/RPCs deploy on branch environments
-- where pg_cron has not been enabled yet.
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'sightloop-visual-memory-retention',
  '17 * * * *',
  $cron$
    delete from public.recent_object_memories where expires_at <= now();
    delete from public.episodic_memory_events where captured_at < now() - interval '30 days';
  $cron$
);
