"use client";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | undefined;
let browserClientStorageKey: string | undefined;
let volatileEpoch = 0;
const AUTH_STORAGE_PREFIX = "sightloop:supabase-memory:auth:v1";
const AUTH_EPOCH_KEY = `${AUTH_STORAGE_PREFIX}:epoch`;

function readAuthEpoch(): number {
  if (typeof window === "undefined") return volatileEpoch;
  try {
    const value = Number.parseInt(localStorage.getItem(AUTH_EPOCH_KEY) ?? "0", 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return volatileEpoch;
  }
}

function currentAuthStorageKey(): string {
  return `${AUTH_STORAGE_PREFIX}:${readAuthEpoch()}`;
}

function advanceAuthEpoch(): void {
  const next = (readAuthEpoch() + 1) % Number.MAX_SAFE_INTEGER;
  volatileEpoch = next;
  try { localStorage.setItem(AUTH_EPOCH_KEY, String(next)); } catch { /* Use the in-memory epoch. */ }
}

function clearAuthStorage(storageKey: string): void {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key === storageKey || key?.startsWith(`${storageKey}-`)) localStorage.removeItem(key);
    }
  } catch { /* A rotated storage key still isolates the next session. */ }
}

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
  const storageKey = currentAuthStorageKey();
  if (browserClient && browserClientStorageKey !== storageKey) {
    void browserClient.auth.dispose();
    browserClient = undefined;
  }
  browserClient ??= createClient(config.url, config.key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey,
    },
  });
  browserClientStorageKey = storageKey;
  return browserClient;
}

export async function getSupabaseMemorySession(): Promise<Session | undefined> {
  const client = getSupabaseBrowserClient();
  if (!client) return undefined;
  const storageKey = browserClientStorageKey;
  const current = await client.auth.getSession();
  if (current.error) throw current.error;
  if (client !== browserClient || storageKey !== currentAuthStorageKey()) return undefined;
  return current.data.session ?? undefined;
}

export async function ensureSupabaseMemorySession(): Promise<Session | undefined> {
  const client = getSupabaseBrowserClient();
  if (!client) return undefined;
  const storageKey = browserClientStorageKey;
  const current = await client.auth.getSession();
  if (current.error) throw current.error;
  if (client !== browserClient || storageKey !== currentAuthStorageKey()) return undefined;
  if (current.data.session) return current.data.session;

  const created = await client.auth.signInAnonymously({
    options: { data: { application: "sightloop", purpose: "visual_memory" } },
  });
  if (client !== browserClient || storageKey !== currentAuthStorageKey()) {
    if (storageKey) clearAuthStorage(storageKey);
    await client.auth.dispose();
    return undefined;
  }
  if (created.error) throw created.error;
  if (!created.data.session) throw new Error("Supabase did not create a memory session.");
  return created.data.session;
}

export async function signOutSupabaseMemorySession(): Promise<void> {
  const client = browserClient;
  const staleStorageKey = browserClientStorageKey ?? currentAuthStorageKey();
  advanceAuthEpoch();
  browserClient = undefined;
  browserClientStorageKey = undefined;
  clearAuthStorage(staleStorageKey);
  if (client) await client.auth.dispose();
  clearAuthStorage(staleStorageKey);
}
