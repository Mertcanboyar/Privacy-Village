// Transient run counters for "The Sealed Letter" — logged to the
// decisions table on completion (see npc.ts's openSealedLetter()) and
// checked for the commendation. Module-level singleton, same pattern as
// healersLedgerState.ts/postRoadBuilderState.ts.
export const sealedLetterState: {
  forgeryCaughtSeconds: number;
  passwordChoice: "yes" | "no" | null;
  wrongSealAttempts: number;
  encryptChoice: "plain" | "locked_box" | null;
} = {
  forgeryCaughtSeconds: 0,
  passwordChoice: null,
  wrongSealAttempts: 0,
  encryptChoice: null,
};

/** Called once, right when the overlay opens for a fresh attempt —
 * closing it early without finishing and reopening it counts as a new
 * attempt (mirrors resetHealersLedgerState()/resetPostRoadBuilderState()). */
export function resetSealedLetterState() {
  sealedLetterState.forgeryCaughtSeconds = 0;
  sealedLetterState.passwordChoice = null;
  sealedLetterState.wrongSealAttempts = 0;
  sealedLetterState.encryptChoice = null;
}
