import { supabase } from "./supabaseClient";
import type { Faction } from "../session";
import type { QuestEngineState } from "../questEngine";
import type { AcademyEngineState } from "../academy";
import { logPersistence } from "./log";
import { persistenceStatus } from "./persistenceStatus";
import { withTimeout, HYDRATE_TIMEOUT_MS } from "./withTimeout";

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
 * of their own. Persistence problems must never block play. Reads
 * (fetchProfile/fetchProgress) are additionally raced against a 3s
 * timeout (see withTimeout.ts) — these run on the hydrate-on-load path
 * (Title.ts's boot()), before the player has even entered the village,
 * so a stalled request there must degrade to "proceed as a guest for
 * now" rather than leave the title screen hung indefinitely. */

export async function fetchProfile(userId: string): Promise<ProfileRow | null> {
  if (!supabase) return null;
  let timedOut = false;
  try {
    const { data, error } = await withTimeout<{ data: ProfileRow | null; error: unknown }>(
      Promise.resolve(supabase.from("profiles").select("*").eq("id", userId).maybeSingle()),
      HYDRATE_TIMEOUT_MS,
      { data: null, error: null },
      () => (timedOut = true),
    );
    if (timedOut) {
      logPersistence({ action: "fetchProfile", table: "profiles", status: "timeout" });
      persistenceStatus.reportError("fetchProfile timed out");
      return null;
    }
    if (error) {
      logPersistence({ action: "fetchProfile", table: "profiles", status: "error", error });
      persistenceStatus.reportError(error);
      return null;
    }
    logPersistence({ action: "fetchProfile", table: "profiles", payload: { userId }, status: "ok" });
    persistenceStatus.reportOk();
    return data as ProfileRow | null;
  } catch (err) {
    logPersistence({ action: "fetchProfile", table: "profiles", status: "error", error: err });
    persistenceStatus.reportError(err);
    return null;
  }
}

export async function fetchProgress(userId: string): Promise<ProgressRow | null> {
  if (!supabase) return null;
  let timedOut = false;
  try {
    const { data, error } = await withTimeout<{ data: ProgressRow | null; error: unknown }>(
      Promise.resolve(supabase.from("progress").select("*").eq("player_id", userId).maybeSingle()),
      HYDRATE_TIMEOUT_MS,
      { data: null, error: null },
      () => (timedOut = true),
    );
    if (timedOut) {
      logPersistence({ action: "fetchProgress", table: "progress", status: "timeout" });
      persistenceStatus.reportError("fetchProgress timed out");
      return null;
    }
    if (error) {
      logPersistence({ action: "fetchProgress", table: "progress", status: "error", error });
      persistenceStatus.reportError(error);
      return null;
    }
    logPersistence({ action: "fetchProgress", table: "progress", payload: { userId }, status: "ok" });
    persistenceStatus.reportOk();
    return data as ProgressRow | null;
  } catch (err) {
    logPersistence({ action: "fetchProgress", table: "progress", status: "error", error: err });
    persistenceStatus.reportError(err);
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

  let timedOut = false;
  try {
    const { error: profileError } = await withTimeout<{ error: unknown }>(
      Promise.resolve(
        supabase.from("profiles").insert({
          id: userId,
          agent_name: data.agentName,
          sprite_id: data.spriteId,
          faction: data.faction,
        }),
      ),
      HYDRATE_TIMEOUT_MS,
      { error: null },
      () => (timedOut = true),
    );
    if (timedOut) {
      logPersistence({ action: "createProfile", table: "profiles", payload: { id: userId }, status: "timeout" });
      persistenceStatus.reportError("createProfile timed out");
      return false;
    }
    if (profileError) {
      logPersistence({ action: "createProfile", table: "profiles", payload: { id: userId }, status: "error", error: profileError });
      persistenceStatus.reportError(profileError);
      return false;
    }
    logPersistence({ action: "createProfile", table: "profiles", payload: { id: userId, agentName: data.agentName }, status: "ok" });

    const { error: progressError } = await withTimeout<{ error: unknown }>(
      Promise.resolve(
        supabase.from("progress").insert({
          player_id: userId,
          clearance: data.clearance,
          xp: data.xp,
          quest_state: data.questState,
          module_state: data.moduleState,
          updated_at: new Date().toISOString(),
        }),
      ),
      HYDRATE_TIMEOUT_MS,
      { error: null },
      () => (timedOut = true),
    );
    if (timedOut) {
      logPersistence({ action: "createProgress", table: "progress", payload: { player_id: userId }, status: "timeout" });
      persistenceStatus.reportError("createProgress timed out");
      return false;
    }
    if (progressError) {
      logPersistence({ action: "createProgress", table: "progress", payload: { player_id: userId }, status: "error", error: progressError });
      persistenceStatus.reportError(progressError);
      return false;
    }
    logPersistence({ action: "createProgress", table: "progress", payload: { player_id: userId, clearance: data.clearance, xp: data.xp }, status: "ok" });

    persistenceStatus.reportOk();
    return true;
  } catch (err) {
    logPersistence({ action: "createProfileAndProgress", status: "error", error: err });
    persistenceStatus.reportError(err);
    return false;
  }
}
