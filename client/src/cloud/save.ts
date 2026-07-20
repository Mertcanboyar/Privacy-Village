import { supabase } from "./supabaseClient";
import { getCurrentUserId } from "./authState";
import { questEngine, type QuestStepChoiceOption } from "../questEngine";
import { academy } from "../academy";

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
 * write instead of three. */
export function saveProgress() {
  const userId = getCurrentUserId();
  if (!supabase || !userId) return;

  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void flushSaveProgress(userId);
  }, SAVE_DEBOUNCE_MS);
}

async function flushSaveProgress(userId: string) {
  if (!supabase) return;
  const { error } = await supabase
    .from("progress")
    .upsert(
      {
        player_id: userId,
        clearance: questEngine.getClearance(),
        xp: questEngine.getPoints(),
        quest_state: questEngine.serializeState(),
        module_state: academy.serializeState(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "player_id" },
    );
  if (error) console.error("[cloud] saveProgress failed", error);
}

/** Fire-and-forget insert into decisions — called at every answer/choice
 * moment across the game (see npc.ts, academyOverlay.ts, questEngine.ts's
 * resolveStepChoice). detail is versioned the same way as
 * progress.quest_state/module_state. */
export function logDecision(event: string, detail: Record<string, unknown>) {
  const userId = getCurrentUserId();
  if (!supabase || !userId) return;
  void supabase
    .from("decisions")
    .insert({ player_id: userId, event, detail: { v: 1, ...detail } })
    .then(({ error }) => {
      if (error) console.error("[cloud] logDecision failed", event, error);
    });
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
