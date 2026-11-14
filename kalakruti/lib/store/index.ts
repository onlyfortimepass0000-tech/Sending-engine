import { config } from "../config";
import { LocalStore } from "./local";
import { SupabaseStore } from "./supabase";
import type { Store } from "./types";

let local: LocalStore | null = null;

export function usingSupabase() {
  return config.supabase !== null;
}

/**
 * Supabase when configured (always on Vercel), otherwise a local JSON file
 * for demos. Supabase access is scoped to the caller's token.
 */
export function getStore(token?: string): Store {
  const sb = config.supabase;
  if (sb) return new SupabaseStore(sb.url, sb.key, token);
  return (local ??= new LocalStore());
}

export function getSupabase(token?: string): SupabaseStore | null {
  const sb = config.supabase;
  return sb ? new SupabaseStore(sb.url, sb.key, token) : null;
}

export type { Store } from "./types";
