# Supabase visual-memory setup

SightLoop uses Supabase only for structured visual memory. Camera frames, video, image data URLs, full provider payloads, and OCR transcripts are never written to the database.

## Project setup

The configured development project ref is `taybmqmikfmigtdbninq`.

1. In Supabase Dashboard, enable **Authentication → Providers → Anonymous Sign-Ins**. The demo UI creates an anonymous Supabase user so every browser session receives a real `auth.uid()` for row-level security. For any public deployment, also enable CAPTCHA and tighten Auth rate limits.
2. Apply `supabase/migrations/202609120002_visual_memory_hardening.sql` with the Supabase MCP `apply_migration` tool or the Supabase SQL editor. Its later version also safely upgrades the permissions and RPCs if an early prototype migration was already applied.
3. Enable the Supabase **Cron** integration, then apply `supabase/migrations/202609120003_visual_memory_retention_cron.sql`. Keep this separate from the core migration so a branch without `pg_cron` cannot roll back the tables and RPCs.
4. Copy the project URL and publishable key from **Project Settings → API**. A legacy anon key also works, but the publishable key is preferred.
5. Set these variables locally and in Vercel Production, Preview, and Development environments:

```text
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

These two values are designed for browser use. Do not add a service-role or secret key to any `NEXT_PUBLIC_` variable.

The Codex MCP OAuth connection is a development/admin connection used to apply and inspect migrations. It is not shipped to the app and is not the identity used by end users.

## What is stored

`recent_object_memories` keeps at most 500 identities from the active five-minute object window per user. Repeated sightings with the same normalized label, color, and appearance update one row. The database clamps client timestamps to server time and derives `expires_at` itself.

`episodic_memory_events` keeps at most 100 important events per user, such as a verified `PUT_DOWN`: subject, appearance, relation, anchor, location text, capture time, confidence, and non-image evidence IDs. Demo events have a 30-day database retention period.

The browser merges observations immediately for responsive recall. Cloud writes are deduplicated and flushed about every five seconds or at 20 pending object identities; important episodic events flush immediately.

## Security model

Both tables have RLS enabled. The `authenticated` role has owner-scoped `SELECT` only; it has no direct table mutation permission. Anonymous Supabase users still use the authenticated Postgres role and receive a unique UUID. Both write RPCs derive their owner from `auth.uid()`, strictly validate and bound their JSON input, and enforce the 500/100 per-owner caps in the same transaction.

The migration enables an hourly `pg_cron` job that globally deletes expired recent objects and events older than 30 days. Supabase does not automatically delete abandoned anonymous Auth users; periodically remove old anonymous users in a trusted admin job if account-table growth matters.

The visible demo email/password profiles are not durable production accounts. Cloud memory belongs to the current browser's anonymous Supabase session, and signing out ends access to that identity. Replace `DemoAuthProvider` with normal Supabase email, passkey, or social Auth before treating the UI profiles as durable multi-device accounts.

## Verification

1. Sign in and open Agent View. `CLOUD MEMORY` should become `Supabase synced`.
2. Start the camera and hold a recognizable object in view. `5-MINUTE OBJECT MEMORY` should increase without creating one row per frame.
3. Put a bottle to the right of a visible notebook. The placement memory should show `PUT DOWN`, its relation, anchor, appearance, timestamp, confidence, and evidence IDs.
4. Ask “Where did I put my bottle?” SightLoop should recall the notebook-relative location and enter a continuing find flow.
5. Verify with a second demo/browser session that RLS does not return the first session's rows.
