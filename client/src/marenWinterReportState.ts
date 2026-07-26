// Transient run counters for "Maren's Winter Report" — logged to the
// decisions table on completion (see npc.ts's openMarenWinterReport())
// and checked for the commendation. Module-level singleton, same
// pattern as healersLedgerState.ts/postRoadBuilderState.ts/
// sealedLetterState.ts/treasuryKeysState.ts.
//
// chosenConfig records the per-attribute rules at the moment the
// pipeline finally SUCCEEDS (e.g. "drop_drop_count"). resetCount counts
// FAIL-A executes (identifiers still kept — the desk is there but
// unconfigured or misconfigured); overStripAttempts counts FAIL-B
// executes (over-stripped — private but useless to the Council).
// riskMeterPeak is the highest value the Council Vault's storage-risk
// meter reached, captured once at the baseline breach (before any fix).
export const marenWinterReportState: {
  chosenConfig: string | null;
  overStripAttempts: number;
  riskMeterPeak: number;
  resetCount: number;
} = {
  chosenConfig: null,
  overStripAttempts: 0,
  riskMeterPeak: 0,
  resetCount: 0,
};

/** Called once, right when the overlay opens for a fresh attempt —
 * closing it early without finishing and reopening it counts as a new
 * attempt (mirrors resetTreasuryKeysState() and its predecessors). */
export function resetMarenWinterReportState() {
  marenWinterReportState.chosenConfig = null;
  marenWinterReportState.overStripAttempts = 0;
  marenWinterReportState.riskMeterPeak = 0;
  marenWinterReportState.resetCount = 0;
}
