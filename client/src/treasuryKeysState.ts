// Transient run counters for "The Treasury's Two Keys" — logged to the
// decisions table on completion (see npc.ts's openTreasuryOverlay()) and
// checked for the commendation. Module-level singleton, same pattern as
// healersLedgerState.ts/postRoadBuilderState.ts/sealedLetterState.ts.
//
// resetCount counts every "failure event" the player had to recover
// from in a single attempt: a wrong-target modifier drop, the night
// theft actually landing (roster wasn't in place before night hit), or
// the day snooper going unlogged (logbook wasn't in place before the
// snoop). It is NOT about re-opening the overlay (that has no partial
// resume at all, same as the other full-screen minigames — an Escape
// just restarts the whole board from scratch). "Built it interlocked on
// the first true try" (see the commendation copy) means the player
// placed each measure ahead of the test it defends, not that they
// eventually got there after watching every failure play out.
export const treasuryKeysState: {
  banditStopped: boolean;
  nightClerkStopped: boolean;
  dayClerkAudited: boolean;
  separationUsed: boolean;
  resetCount: number;
  brokeDefenseInDepth: boolean;
} = {
  banditStopped: false,
  nightClerkStopped: false,
  dayClerkAudited: false,
  separationUsed: false,
  resetCount: 0,
  brokeDefenseInDepth: false,
};

/** Called once, right when the overlay opens for a fresh attempt —
 * closing it early without finishing and reopening it counts as a new
 * attempt (mirrors resetHealersLedgerState()/resetPostRoadBuilderState()/
 * resetSealedLetterState()). */
export function resetTreasuryKeysState() {
  treasuryKeysState.banditStopped = false;
  treasuryKeysState.nightClerkStopped = false;
  treasuryKeysState.dayClerkAudited = false;
  treasuryKeysState.separationUsed = false;
  treasuryKeysState.resetCount = 0;
  treasuryKeysState.brokeDefenseInDepth = false;
}
