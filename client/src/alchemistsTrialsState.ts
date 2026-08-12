// Transient run counters for "The Alchemist's Trials" — logged to the
// decisions table on completion (see npc.ts's openAlchemistsTrials()) and
// checked for the commendation. Module-level singleton, same pattern as
// treasuryKeysState.ts/archivistsDeskState.ts/marenWinterReportState.ts.
//
// trial1Attempts counts every differencing-pair CHECK the player makes in
// Trial 1's query panel (not every query button click) — the pair is
// found the moment one of those checks matches the one discoverable
// pair. trial1NoiseFirstTry/trial2ApproachFirstTry/trial3ApproachFirstTry
// are the three "which approach" decisions the commendation's "all three
// correct choices first try" refers to (the noise-dial setting, the
// synthetic-data demand response, and the sealed-calculation choice) —
// deliberately distinct from the extra graded sub-steps each trial also
// has (Trial 2's outlier remedy, Trial 3's comprehension check), which
// only feed hintsUsed, not this clause. trial2Choice/trial3Choice record
// the FINAL correct top-level choice reached in each trial, for the
// decisions log's exact shape (see the ticket's specified detail keys).
export const alchemistsTrialsState: {
  trial1Attempts: number;
  trial1BrokeAggregate: boolean;
  trial1NoiseFirstTry: boolean;
  trial2Choice: string;
  trial2ApproachFirstTry: boolean;
  trial3Choice: string;
  trial3ApproachFirstTry: boolean;
  hintsUsed: number;
} = {
  trial1Attempts: 0,
  trial1BrokeAggregate: false,
  trial1NoiseFirstTry: true,
  trial2Choice: "",
  trial2ApproachFirstTry: true,
  trial3Choice: "",
  trial3ApproachFirstTry: true,
  hintsUsed: 0,
};

/** Called once, right when the overlay opens for a fresh attempt —
 * closing it early without finishing and reopening it counts as a new
 * attempt (mirrors resetTreasuryKeysState()/resetArchivistsDeskState()). */
export function resetAlchemistsTrialsState() {
  alchemistsTrialsState.trial1Attempts = 0;
  alchemistsTrialsState.trial1BrokeAggregate = false;
  alchemistsTrialsState.trial1NoiseFirstTry = true;
  alchemistsTrialsState.trial2Choice = "";
  alchemistsTrialsState.trial2ApproachFirstTry = true;
  alchemistsTrialsState.trial3Choice = "";
  alchemistsTrialsState.trial3ApproachFirstTry = true;
  alchemistsTrialsState.hintsUsed = 0;
}
