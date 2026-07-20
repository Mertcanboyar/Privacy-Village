import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Persistent accounts are entirely optional infrastructure — same
// resilience philosophy as net/NetClient.ts's multiplayer: if the env
// vars aren't set (local dev without a Supabase project, or a deploy
// that never configured one), this exports null and every module in
// client/src/cloud/ built on top of it no-ops silently. Guests remain
// fully functional either way; nothing here is load-bearing for the
// game itself.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null;
