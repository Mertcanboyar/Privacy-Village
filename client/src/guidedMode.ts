import Phaser from "phaser";
import { academy } from "./academy";
import { questEngine } from "./questEngine";
import { logGuidedStepStarted, logGuidedStepCompleted } from "./instrumentation";

// Guided Sequence (playtest fix: new players wandered without ever
// seeing the intended first step, and could accept quests out of order
// — Odile's/the Mayor's field quests are reachable the moment a player
// happens to complete THEIR track's first Academy module, since
// academy.ts's isTheoryUnlocked() only sequences modules within a
// track, not across tracks). This engine hard-gates everything outside
// data/sequence.json's current step and drives the unmissable waypoint
// navigation (npc.ts/scenes/Room.ts/hud.ts).
//
// Deliberately has almost no state of its own: `getCurrentStep()` is
// derived live from academy.ts/questEngine.ts's own (already-persisted)
// progress every time it's called, rather than storing a separate
// currentStepIndex that could drift out of sync with real progress on
// reload. The only genuinely new persisted bit is the manual on/off
// toggle (hud.ts's MENU dropdown) — a UX preference, not progress, so
// it follows academy.ts's pv_academy_opened localStorage idiom.

export interface SequenceStep {
  id: string;
  type: "academy_module" | "quest";
  target: string;
  label: string;
}

const DISABLED_STORAGE_KEY = "pv_guided_mode_disabled";

function readDisabledFromStorage(): boolean {
  try {
    return localStorage.getItem(DISABLED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDisabledToStorage(disabled: boolean) {
  try {
    if (disabled) localStorage.setItem(DISABLED_STORAGE_KEY, "1");
    else localStorage.removeItem(DISABLED_STORAGE_KEY);
  } catch {
    // Nothing to do — worst case the toggle doesn't survive reload.
  }
}

class GuidedModeManager extends Phaser.Events.EventEmitter {
  private steps: SequenceStep[] = [];
  private manuallyDisabled = readDisabledFromStorage();

  // Diffed against getCurrentStep() on every progress-shaped event this
  // class subscribes to, purely to know when to fire
  // stepStarted/stepCompleted (and their instrumentation) — NOT the
  // source of truth for "what's the current step" (see class doc
  // comment above), just a memo of the last-seen id so a transition is
  // detectable.
  private lastSeenStepId: string | null = null;
  private lastSeenStepStartedAt = 0;
  // Preload.create() (where loadData() runs) is too early to log a
  // "step started" for step 1 — an authenticated returning player's
  // real progress hydrates later, in Title.ts, only once Supabase auth
  // resolves. Logging here would wrongly fire "s1 started" on every
  // boot for a player who finished the sequence sessions ago. Instead
  // this stays unset until primeAfterHydration() (called once from
  // Room.ts's first create(), by which point Title.ts's hydration --
  // if any -- has already settled, same reasoning as its own
  // isFirstSpawn comment) takes a silent first snapshot; only real
  // transitions AFTER that get logged.
  private primed = false;

  loadData(steps: SequenceStep[]) {
    this.steps = steps;
    questEngine.on("questUpdated", () => this.checkStepTransition());
    questEngine.on("questCompleted", (questId: string) => this.onQuestCompleted(questId));
    academy.on("progressChanged", () => this.checkStepTransition());
  }

  /** Idempotent — safe to call from every Room.ts create() (every door
   * transition), only the first call actually does anything. */
  primeAfterHydration() {
    if (this.primed) return;
    this.primed = true;
    const current = this.getCurrentStep();
    this.lastSeenStepId = current?.id ?? null;
    this.lastSeenStepStartedAt = performance.now();
    if (current) logGuidedStepStarted(current.id);
  }

  isManuallyDisabled(): boolean {
    return this.manuallyDisabled;
  }

  setManuallyDisabled(disabled: boolean) {
    this.manuallyDisabled = disabled;
    writeDisabledToStorage(disabled);
    this.emit("changed");
  }

  private isStepComplete(step: SequenceStep): boolean {
    if (step.type === "academy_module") return academy.getProgress(step.target).theoryDone;
    return questEngine.isComplete(step.target);
  }

  /** The first not-yet-complete step in sequence order, or null once
   * every step is done — the whole sequence's "are we guiding at all"
   * question collapses to this being non-null (see isActive()). */
  getCurrentStep(): SequenceStep | null {
    for (const step of this.steps) {
      if (!this.isStepComplete(step)) return step;
    }
    return null;
  }

  isActive(): boolean {
    return !this.manuallyDisabled && this.getCurrentStep() !== null;
  }

  private checkStepTransition() {
    if (!this.primed) return;
    const current = this.getCurrentStep();
    const currentId = current?.id ?? null;
    if (currentId === this.lastSeenStepId) return;

    if (this.lastSeenStepId) {
      const seconds = Math.round((performance.now() - this.lastSeenStepStartedAt) / 1000);
      logGuidedStepCompleted(this.lastSeenStepId, seconds);
    }
    this.lastSeenStepId = currentId;
    this.lastSeenStepStartedAt = performance.now();
    if (currentId) logGuidedStepStarted(currentId);

    // "arrival" (the HQ onboarding quest — greet Bram, then Odile) has
    // nothing to do with the guided sequence and isn't gated by it, so
    // a player who beelines straight for the Academy — exactly what
    // this feature asks them to do — can seal step 1's theory before
    // ever greeting Bram/Odile. That leaves "arrival" sitting active,
    // which silently blocks Herald's real offer: the engine only ever
    // runs one active quest at a time (see npc.ts's open() doc comment
    // on availableGiverQuestId), so breach_in_the_wall being merely
    // `available` isn't enough. Clear "arrival" out of the way the
    // instant a `quest`-typed step becomes current, so the banner's
    // next instruction is always actually actionable.
    if (current?.type === "quest") questEngine.completeQuestIfActive("arrival");

    this.emit("changed");
  }

  private onQuestCompleted(questId: string) {
    const lastStep = this.steps[this.steps.length - 1];
    if (lastStep?.type === "quest" && lastStep.target === questId && this.isStepComplete(lastStep)) {
      // The sequence just finished — one short handoff beat from the
      // Herald, reusing hud.ts's existing showReveal() (see
      // QuestDef.clockDebrief's identical "reveal" usage), then guided
      // mode naturally goes inactive on its own (getCurrentStep() now
      // returns null) — nothing else to tear down.
      questEngine.emit("reveal", {
        text: "You know the rhythm now, Ranger: study, then act. The village is yours to walk.",
        speaker: "HERALD",
      });
    }
    this.checkStepTransition();
  }
}

export const guidedMode = new GuidedModeManager();
