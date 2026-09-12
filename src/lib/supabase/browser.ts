"use client";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | undefined;

function configuration(): { url: string; key: string } | undefined {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  return url && key ? { url, key } : undefined;
}

export function isSupabaseMemoryConfigured(): boolean {
  return Boolean(configuration());
}

export function getSupabaseBrowserClient(): SupabaseClient | undefined {
  const config = configuration();
  if (!config) return undefined;
  browserClient ??= createClient(config.url, config.key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return browserClient;
}

export async function getSupabaseMemorySession(): Promise<Session | undefined> {
  const client = getSupabaseBrowserClient();
  if (!client) return undefined;
  const current = await client.auth.getSession();
  if (current.error) throw current.error;
  return current.data.session ?? undefined;
}

export async function ensureSupabaseMemorySession(): Promise<Session | undefined> {
  const client = getSupabaseBrowserClient();
  if (!client) return undefined;
  const current = await getSupabaseMemorySession();
  if (current) return current;

  const created = await client.auth.signInAnonymously({
    options: { data: { application: "sightloop", purpose: "visual_memory" } },
  });
  if (created.error) throw created.error;
  if (!created.data.session) throw new Error("Supabase did not create a memory session.");
  return created.data.session;
}

export async function signOutSupabaseMemorySession(): Promise<void> {
  const client = getSupabaseBrowserClient();
  if (!client) return;
  const { error } = await client.auth.signOut();
  if (error) throw error;
}
