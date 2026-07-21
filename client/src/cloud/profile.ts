import { supabase } from "./supabaseClient";
import type { Faction } from "../session";
import type { QuestEngineState } from "../questEngine";
import type { AcademyEngineState } from "../academy";

export interface ProfileRow {
  id: string;
  agent_name: string;
  sprite_id: string;
  faction: Faction | null;
  created_at: string;
}

export interface ProgressRow {
  player_id: string;
  clearance: number;
  xp: number;
  quest_state: QuestEngineState;
  module_state: AcademyEngineState;
  updated_at: string;
}

/** Null-safe: every function here resolves to null/false rather than
 * throwing when supabase isn't configured, or logs and resolves to
 * null/false on a real Supabase error — callers never need a try/catch
 * of their own. Persistence problems must never block play. */

export async function fetchProfile(userId: string): Promise<ProfileRow | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) {
      console.error("[cloud] fetchProfile failed", error);
      return null;
    }
    return data as ProfileRow | null;
  } catch (err) {
    console.error("[cloud] fetchProfile threw", err);
    return null;
  }
}

export async function fetchProgress(userId: string): Promise<ProgressRow | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from("progress").select("*").eq("player_id", userId).maybeSingle();
    if (error) {
      console.error("[cloud] fetchProgress failed", error);
      return null;
    }
    return data as ProgressRow | null;
  } catch (err) {
    console.error("[cloud] fetchProgress threw", err);
    return null;
  }
}

export interface InitialProfileData {
  agentName: string;
  spriteId: string;
  faction: Faction | null;
  questState: QuestEngineState;
  moduleState: AcademyEngineState;
  clearance: number;
  xp: number;
}

/** Creates the profile + progress rows for a brand-new player — either
 * a first-time authenticated signup finishing CharacterCreate (fresh
 * default state), or a guest's mid-session upgrade (see hud.ts's "SAVE
 * YOUR RECORD" / cloud/pendingUpgrade.ts), where questState/moduleState/
 * clearance/xp already reflect whatever they'd built up as a guest.
 * No-ops (returns false) if supabase isn't configured. */
export async function createProfileAndProgress(userId: string, data: InitialProfileData): Promise<boolean> {
  if (!supabase) return false;

  try {
    const { error: profileError } = await supabase.from("profiles").insert({
      id: userId,
      agent_name: data.agentName,
      sprite_id: data.spriteId,
      faction: data.faction,
    });
    if (profileError) {
      console.error("[cloud] createProfile failed", profileError);
      return false;
    }

    const { error: progressError } = await supabase.from("progress").insert({
      player_id: userId,
      clearance: data.clearance,
      xp: data.xp,
      quest_state: data.questState,
      module_state: data.moduleState,
      updated_at: new Date().toISOString(),
    });
    if (progressError) {
      console.error("[cloud] createProgress failed", progressError);
      return false;
    }

    return true;
  } catch (err) {
    console.error("[cloud] createProfileAndProgress threw", err);
    return false;
  }
}
