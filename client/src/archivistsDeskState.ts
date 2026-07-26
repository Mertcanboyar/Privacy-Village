// Transient run counters for "The Archivist's Desk" — logged to the
// decisions table on completion (see npc.ts's openArchivistsDesk()) and
// checked for the commendation. Module-level singleton, same pattern as
// healersLedgerState.ts/treasuryKeysState.ts/marenWinterReportState.ts.
//
// perTicketVerdicts records the FINAL correct verdict reached for each of
// the 6 tickets, in order (e.g. "grant", "seal", "conditional:anonymize"),
// once resolved — not every attempt. safeguardChoices records which
// safeguard button was picked, for the two CONDITIONAL tickets, at the
// moment each was finally resolved. integrityLost counts every wrong pick
// across the whole run (top-level verdict AND safeguard sub-choice) —
// the commendation requires this to be exactly 0.
export const archivistsDeskState: {
  perTicketVerdicts: string[];
  integrityLost: number;
  safeguardChoices: string[];
} = {
  perTicketVerdicts: [],
  integrityLost: 0,
  safeguardChoices: [],
};

/** Called once, right when the overlay opens for a fresh attempt —
 * closing it early without finishing and reopening it counts as a new
 * attempt (mirrors resetTreasuryKeysState() and its successors). */
export function resetArchivistsDeskState() {
  archivistsDeskState.perTicketVerdicts = [];
  archivistsDeskState.integrityLost = 0;
  archivistsDeskState.safeguardChoices = [];
}
