import { supabase } from "./supabaseClient";
import { getCurrentUserId, hasPendingOtpRequest } from "./authState";
import { questEngine, type QuestStepChoiceOption } from "../questEngine";
import { academy } from "../academy";
import { logPersistence } from "./log";
import { persistenceStatus } from "./persistenceStatus";
import { getSession } from "../session";
import { savePendingUpgrade } from "./pendingUpgrade";

// The ongoing save loop — as opposed to cloud/profile.ts's one-shot
// row creation at signup/upgrade time. Both saveProgress() and
// logDecision() are safe to call unconditionally from anywhere in the
// game: they no-op silently whenever supabase isn't configured or
// there's no authenticated player (guests never write), so call sites
// never need to check either condition themselves.

const SAVE_DEBOUNCE_MS = 2000;
let saveTimer: number | undefined;

/** Upserts the progress row from current game state. Debounced 2s so a
 * burst of near-simultaneous triggers (a milestone that also raises
 * Clearance and awards XP in the same tick, say) collapses into one
 * write instead of three. A guest with a magic link already in flight
 * (see cloud/authState.ts's hasPendingOtpRequest()) gets the same
 * triggers routed to refreshGuestPendingUpgrade() below instead — see
 * its doc comment for why that's what actually makes the magic link
 * populate profiles/progress at all. */
export function saveProgress() {
  const userId = getCurrentUserId();
  if (!supabase) return;

  if (!userId) {
    refreshGuestPendingUpgrade();
    return;
  }

  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void flushSaveProgress(userId);
  }, SAVE_DEBOUNCE_MS);
}

/** Keeps a guest's pendingUpgrade snapshot (localStorage, see
 * cloud/pendingUpgrade.ts) fresh while a magic link is in flight for
 * them — Title.ts's low-friction gate fires signInWithOtp() but never
 * waits to authenticate before letting the player in (see
 * cloud/emailCapturePanel.ts's blockOnAuth option), so isAuthenticated()
 * stays false for the rest of that guest session even after a
 * successful signup. Without a snapshot to claim, Title.ts's boot()
 * has nothing to restore when the player eventually clicks the link —
 * it would only ever create profiles/progress rows if they redid
 * character creation from scratch on that second visit, and any
 * progress made as a guest in between would be silently lost. No
 * debounce: this is a synchronous localStorage write, not a network
 * call, so there's no cost to keeping it current on every trigger. */
function refreshGuestPendingUpgrade() {
  if (!hasPendingOtpRequest()) return;
  const session = getSession();
  savePendingUpgrade({
    v: 1,
    name: session.name,
    spriteId: session.avatarId,
    faction: session.faction,
    questState: questEngine.serializeState(),
    moduleState: academy.serializeState(),
  });
}

async function flushSaveProgress(userId: string) {
  if (!supabase) return;
  const row = {
    player_id: userId,
    clearance: questEngine.getClearance(),
    xp: questEngine.getPoints(),
    quest_state: questEngine.serializeState(),
    module_state: academy.serializeState(),
    updated_at: new Date().toISOString(),
  };
  try {
    const { error } = await supabase.from("progress").upsert(row, { onConflict: "player_id" });
    if (error) {
      logPersistence({ action: "saveProgress", table: "progress", payload: { player_id: userId, clearance: row.clearance, xp: row.xp }, status: "error", error });
      persistenceStatus.reportError(error);
      return;
    }
    logPersistence({ action: "saveProgress", table: "progress", payload: { player_id: userId, clearance: row.clearance, xp: row.xp }, status: "ok" });
    persistenceStatus.reportOk();
  } catch (err) {
    logPersistence({ action: "saveProgress", table: "progress", status: "error", error: err });
    persistenceStatus.reportError(err);
  }
}

/** Fire-and-forget insert into decisions — called at every answer/choice
 * moment across the game (see npc.ts, academyOverlay.ts, questEngine.ts's
 * resolveStepChoice), synchronously, from the middle of UI state
 * mutation (e.g. npc.ts's pickChoice() closes the choice buttons right
 * after this call). This must never throw: a real Supabase client can
 * throw synchronously (a malformed URL, for one) rather than only
 * rejecting its promise, and an uncaught throw here would abort
 * whichever caller invoked it mid-execution — for pickChoice()
 * specifically, that leaves NPCController.mode stuck open forever,
 * which also blocks player movement (Room.ts's uiOpen reads
 * dialogueOpen from that same stuck state). Hence the try/catch,
 * despite `supabase.from(...).insert(...)` itself already being wrapped
 * in a `void` fire-and-forget. */
export function logDecision(event: string, detail: Record<string, unknown>) {
  const userId = getCurrentUserId();
  if (!supabase || !userId) return;
  try {
    void Promise.resolve(supabase.from("decisions").insert({ player_id: userId, event, detail: { v: 1, ...detail } }))
      .then(({ error }) => {
        if (error) {
          logPersistence({ action: "logDecision", table: "decisions", payload: { event, detail }, status: "error", error });
          persistenceStatus.reportError(error);
          return;
        }
        logPersistence({ action: "logDecision", table: "decisions", payload: { event, detail }, status: "ok" });
        persistenceStatus.reportOk();
      })
      .catch((err: unknown) => {
        logPersistence({ action: "logDecision", table: "decisions", payload: { event }, status: "error", error: err });
        persistenceStatus.reportError(err);
      });
  } catch (err) {
    logPersistence({ action: "logDecision", table: "decisions", payload: { event }, status: "error", error: err });
    persistenceStatus.reportError(err);
  }
}

/** Subscribes saveProgress() to every trigger the spec calls out: quest
 * step completion, quest completion, module pip completion, clearance
 * raise, XP award. Call once at boot (main.ts) — safe to do
 * unconditionally, same reasoning as saveProgress()/logDecision()
 * themselves. Deliberately event-subscription-based rather than calls
 * threaded into questEngine.ts/academy.ts's own methods, so those stay
 * free of any cloud/ dependency — this file reaches into them, not the
 * other way around. */
export function initAutoSave() {
  questEngine.on("questUpdated", saveProgress); // step advance + quest completion both fire this
  questEngine.on("levelUp", saveProgress); // clearance raise
  questEngine.on("pointsChanged", saveProgress); // XP award
  academy.on("progressChanged", saveProgress); // theory/field pip completion
  academy.on("moduleCompleted", saveProgress);

  // "The Night the Wall Fell"'s fountain-crier beat — the only
  // QuestStepChoice in the game today, hence the fixed event name
  // rather than deriving one from quest id, matching the spec's own
  // "wallfell_clock_choice" example. A future quest reusing this
  // mechanism would want this generalized.
  questEngine.on("stepChoiceResolved", (payload: { quest: string; step: number; option: QuestStepChoiceOption }) => {
    logDecision("wallfell_clock_choice", {
      quest: payload.quest,
      step: payload.step,
      label: payload.option.label,
      clockPenalty: payload.option.clockPenalty ?? 0,
      totalClockHours: questEngine.getClockHours(),
    });
  });
}
