import { logDecision } from "./cloud/save";

// Sec7 instrumentation for PLAN's "Academy first, then field work"
// inversion — five events answering "is the new signposting actually
// working, or are players still guessing?" markSpawn() is called once,
// the moment Room.ts spawns a genuinely first-time player into the
// village; every "first_*" event below reports seconds since then and
// only ever fires once per session (module-level guards — a timing
// metric, not persisted UX state, so no localStorage like tutorial.ts's
// flag). logDecision() itself already no-ops for guests, so these are
// safe to call unconditionally from anywhere in the onboarding path.

let spawnAt: number | null = null;

export function markSpawn() {
  if (spawnAt === null) spawnAt = performance.now();
}

function secondsSinceSpawn(): number {
  return spawnAt === null ? 0 : Math.round((performance.now() - spawnAt) / 1000);
}

let orientationLogged = false;
export function logOnboardingOrientationShown() {
  if (orientationLogged) return;
  orientationLogged = true;
  logDecision("onboarding_orientation_shown", { timestamp: new Date().toISOString() });
}

let academyOpenLogged = false;
export function logFirstAcademyOpen() {
  if (academyOpenLogged) return;
  academyOpenLogged = true;
  logDecision("first_academy_open", { seconds: secondsSinceSpawn() });
}

let theoryCompleteLogged = false;
export function logFirstTheoryComplete() {
  if (theoryCompleteLogged) return;
  theoryCompleteLogged = true;
  logDecision("first_theory_complete", { seconds: secondsSinceSpawn() });
}

let questAcceptLogged = false;
export function logFirstQuestAccept() {
  if (questAcceptLogged) return;
  questAcceptLogged = true;
  logDecision("first_quest_accept", { seconds: secondsSinceSpawn() });
}

// Not one-shot, unlike the four above — repeated firing is the whole
// point (see PLAN: "If this fires a lot, the signposting still isn't
// working").
export function logLockedQuestBounce(questId: string, moduleId: string) {
  logDecision("locked_quest_bounce", { questId, moduleId });
}

// Guided Sequence instrumentation (see guidedMode.ts) — same "repeated
// firing is expected, not a bug" reasoning as logLockedQuestBounce
// above. Step start/complete are logged from guidedMode.ts itself
// (the one place that already tracks step transitions), not from every
// call site that might cause one.
export function logGuidedStepStarted(stepId: string) {
  logDecision("guided_step_started", { stepId });
}

export function logGuidedStepCompleted(stepId: string, seconds: number) {
  logDecision("guided_step_completed", { stepId, seconds });
}

// Fired every time a player tries to start something outside the
// current guided-mode step (an off-path NPC's quest offer, a locked
// Academy module card) — repeated firing here is the actual signal the
// spec asks for ("if this fires a lot, the navigation is still
// failing — gating alone is not success"), not a bug to guard against.
export function logOffpathAttempt(kind: "quest" | "academy_module", targetId: string, currentStepId: string | null) {
  logDecision("offpath_attempt", { kind, targetId, currentStepId });
}

// One-shot, same shape as logFirstQuestAccept() above — the ticket's
// "time to first objective action" success metric (<45s), not full
// completion. Fired from academyOverlay.ts's goToTheory() the first
// time the player opens step 1's target module while guided mode is
// active, i.e. the first real step taken toward the objective rather
// than just standing near the marker.
let firstObjectiveActionLogged = false;
export function logTimeToFirstObjectiveAction() {
  if (firstObjectiveActionLogged) return;
  firstObjectiveActionLogged = true;
  logDecision("time_to_first_objective_action", { seconds: secondsSinceSpawn() });
}

// "The Gathering" (see PLAN.md's live-event build) — repeatable, same
// shape as logLockedQuestBounce()/logGuidedStepStarted() above; these
// are the metrics answering "is the social-hub thesis real."
export function logChatMessageSent() {
  logDecision("chat_message_sent", {});
}

export function logEmoteSent(emoteId: string) {
  logDecision("emote_sent", { emoteId });
}

export function logEventBoardOpened() {
  logDecision("event_board_opened", {});
}
