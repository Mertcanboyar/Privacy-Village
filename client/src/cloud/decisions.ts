import { supabase } from "./supabaseClient";
import { logPersistence } from "./log";
import { persistenceStatus } from "./persistenceStatus";
import { withTimeout, HYDRATE_TIMEOUT_MS } from "./withTimeout";

// Read side of the decisions log (see save.ts's logDecision() for the
// write side) — powers the Dossier's Decision Record tab and its
// retroactive title-award check (see dossier.ts's refresh()). Same
// null-safe/timeout-raced convention as profile.ts's fetches: this runs
// whenever the Dossier overlay opens, mid-play, so a stalled request
// must degrade to "show what we have locally" rather than hang the UI.

export interface DecisionRow {
  id: number;
  player_id: string;
  event: string;
  detail: Record<string, unknown>;
  created_at: string;
}

/** Ascending by created_at — callers that want "the latest row per
 * event" (see dossier.ts's primeFromDecisions()) can just iterate and
 * let the last match win, rather than needing a separate sort. */
export async function fetchDecisions(userId: string): Promise<DecisionRow[]> {
  if (!supabase) return [];
  let timedOut = false;
  try {
    const { data, error } = await withTimeout<{ data: DecisionRow[] | null; error: unknown }>(
      Promise.resolve(supabase.from("decisions").select("*").eq("player_id", userId).order("created_at", { ascending: true })),
      HYDRATE_TIMEOUT_MS,
      { data: null, error: null },
      () => (timedOut = true),
    );
    if (timedOut) {
      logPersistence({ action: "fetchDecisions", table: "decisions", status: "timeout" });
      persistenceStatus.reportError("fetchDecisions timed out");
      return [];
    }
    if (error) {
      logPersistence({ action: "fetchDecisions", table: "decisions", status: "error", error });
      persistenceStatus.reportError(error);
      return [];
    }
    logPersistence({ action: "fetchDecisions", table: "decisions", payload: { userId, count: data?.length ?? 0 }, status: "ok" });
    persistenceStatus.reportOk();
    return data ?? [];
  } catch (err) {
    logPersistence({ action: "fetchDecisions", table: "decisions", status: "error", error: err });
    persistenceStatus.reportError(err);
    return [];
  }
}
