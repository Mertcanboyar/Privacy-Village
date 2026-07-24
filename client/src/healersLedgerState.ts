// Transient run counters for "The Healer's Ledger" quest — how many
// breaches/over-classifications/access-choice attempts happened this
// attempt. Not part of QuestEngineState (flags there are boolean-only,
// and these numbers aren't needed to resume a saved game mid-quest,
// only to shape the debrief/commendation/decision-log at the end) but
// still a module-level singleton, same lifetime as questEngine/session,
// so it survives a scene restart if the player leaves the Tavern
// between Mission 1 (sorting) and Mission 2 (the lock) and comes back.
export const healersLedgerState = {
  breachCount: 0,
  overClassifyCount: 0,
  accessChoiceAttempts: 0,
};

/** Called once, right when Mission 1's board opens for a fresh attempt
 * (see ledgerSortOverlay.ts) — closing the board early without
 * finishing and reopening it counts as a new attempt. */
export function resetHealersLedgerState() {
  healersLedgerState.breachCount = 0;
  healersLedgerState.overClassifyCount = 0;
  healersLedgerState.accessChoiceAttempts = 0;
}
