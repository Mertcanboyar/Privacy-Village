// Transient run counters for "The Blueprint of the Post Road"'s
// Phase 2-4 builder — how many slot/arrow mistakes happened, how long
// the rogue arrow took to find, how many cipher-toggle attempts it took
// — shaping the decisions-log row and the completion commendation check
// (see ui/blueprintOverlay.ts). Module-level singleton, same pattern as
// healersLedgerState.ts.
export const postRoadBuilderState = {
  slotErrors: 0,
  arrowErrors: 0,
  rogueArrowFoundSeconds: 0,
  cipherToggleAttempts: 0,
};

/** Called once, right when the builder overlay opens for a fresh
 * attempt — closing it early without finishing and reopening it counts
 * as a new attempt (mirrors resetHealersLedgerState()). */
export function resetPostRoadBuilderState() {
  postRoadBuilderState.slotErrors = 0;
  postRoadBuilderState.arrowErrors = 0;
  postRoadBuilderState.rogueArrowFoundSeconds = 0;
  postRoadBuilderState.cipherToggleAttempts = 0;
}
