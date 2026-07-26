import { el } from "./dom";
import { playSound } from "../audio";
import { questEngine } from "../questEngine";
import { archivistsDeskState, resetArchivistsDeskState } from "../archivistsDeskState";

// "The Archivist's Desk" — a sequential ticket-queue judgment flow, same
// render-dispatcher shell as ui/sealedLetterOverlay.ts (a handful of
// stages, click-to-choose, wrong-answer-explains-and-retries) rather than
// blueprintOverlay.ts's canvas/node/drag system — this quest has no
// diagram, just a queue of six requests to rule on.
//
// The core lesson: purpose limitation is a COMPATIBILITY judgment, not a
// wall. Three verdicts exist on purpose: GRANT (same/compatible purpose),
// CONDITIONAL (compatible only with a safeguard — anonymize or fresh
// consent), and SEAL (incompatible — needs a new lawful basis entirely).
// Ticket 4 is a deliberate trap: it SOUNDS invasive but is compatible —
// sealing it wrongly costs integrity, the same "over-caution has a cost
// too" lesson as the over-classification/over-strip beats elsewhere.
//
// Concept mapping (not shown in-game):
//   Original gathering purpose = purpose specified at collection (Art. 5(1)(b))
//   GRANT (same/compatible)    = compatible further processing (Art. 6(4) factors)
//   CONDITIONAL/anonymize      = safeguard enabling compatibility (aggregation)
//   CONDITIONAL/re-consent     = new purpose requiring fresh lawful basis/consent
//   SEAL                       = incompatible reuse — the core purpose-limitation violation
//   Trap ticket (4)            = over-restriction error (refusing lawful, compatible use)

type Verdict = "grant" | "conditional" | "seal";
type Faction = "merchants" | "tinkers" | "bards";

interface SafeguardOption {
  value: string;
  label: string;
  outcome: "correct" | "accepted" | "wrong";
  feedback: string;
}

interface Ticket {
  faction: Faction;
  factionLabel: string;
  crest: string;
  artifact: string;
  intent: string;
  ledgerPurpose: string;
  correctVerdict: Verdict;
  correctFeedback: string;
  wrongFeedback: string;
  safeguardOptions?: SafeguardOption[];
}

const FACTION_CRESTS: Record<Faction, string> = { merchants: "🪙", tinkers: "⚙️", bards: "🎻" };

const TICKETS: Ticket[] = [
  {
    faction: "bards",
    factionLabel: "THE BARDS",
    crest: FACTION_CRESTS.bards,
    artifact: "Festival Roster",
    intent: "Announce tonight's tavern music schedule.",
    ledgerPurpose: "Roster collected for official festival announcements and scheduling.",
    correctVerdict: "grant",
    correctFeedback: "Same purpose, near enough to touch. Announcing music IS scheduling. Granted.",
    wrongFeedback: "You sealed a use identical to the original purpose. Purpose limitation is not 'refuse everything' — it's 'match the purpose.'",
  },
  {
    faction: "merchants",
    factionLabel: "THE MERCHANTS",
    crest: FACTION_CRESTS.merchants,
    artifact: "Tavern Tab Records (who bought which drinks)",
    intent: "Send couriers pushing our new hangover potions to heavy drinkers.",
    ledgerPurpose: "Tavern tabs collected strictly to resolve billing disputes at festival's end.",
    correctVerdict: "seal",
    correctFeedback: "Billing became marketing. That is the oldest trick in the guild — collect for one reason, exploit for another. Sealed.",
    wrongFeedback: "You just let the Merchants profile drinkers from billing data. That is exactly the harm the principle exists to stop.",
  },
  {
    faction: "tinkers",
    factionLabel: "THE TINKERS",
    crest: FACTION_CRESTS.tinkers,
    artifact: "Village Map Coordinates (where attendees gather)",
    intent: "Plan next year's permanent road network.",
    ledgerPurpose: "Coordinates collected for EMERGENCY crowd control during THIS festival.",
    correctVerdict: "seal",
    correctFeedback:
      "The Tinkers mean well — good roads help everyone. But safety-in-the-moment and civic-planning-for-next-year are different purposes, and one does not license the other. They must ask the villagers afresh. Sealed, pending re-consent.",
    wrongFeedback: "Well-meant is not the test. Compatible is the test.",
  },
  {
    faction: "bards",
    factionLabel: "THE BARDS",
    crest: FACTION_CRESTS.bards,
    artifact: "List of villagers who attended each performance",
    intent: "Decide which musicians to invite back based on attendance.",
    ledgerPurpose: "Attendance recorded to program and improve festival performances.",
    correctVerdict: "grant",
    correctFeedback:
      "Sounds like surveillance, doesn't it? But read the ledger — attendance was gathered precisely to shape the programme. Improving next act's line-up IS that purpose. Do not seal what merely SOUNDS sinister, Agent. Read the purpose, not your suspicion.",
    wrongFeedback: "You sealed a compatible use out of reflex. Over-caution refuses legitimate work — the same error as over-collecting.",
  },
  {
    faction: "tinkers",
    factionLabel: "THE TINKERS",
    crest: FACTION_CRESTS.tinkers,
    artifact: "Healer's visit counts by district",
    intent: "Decide where to build next year's second well (illness clustered near the old well).",
    ledgerPurpose: "Health visits recorded for treating patients this season.",
    correctVerdict: "conditional",
    correctFeedback:
      "A new purpose — but a worthy and compatible one, IF no villager is named. Grant them district COUNTS, never patients. Aggregate, and the good deed harms no one.",
    wrongFeedback: "Compatible purpose, yes — but raw health data by name? Condition it first.",
    safeguardOptions: [
      { value: "anonymize", label: "Anonymize / aggregate", outcome: "correct", feedback: "A worthy and compatible purpose, IF no villager is named. Grant them district COUNTS, never patients. Aggregate, and the good deed harms no one." },
      { value: "reconsent", label: "Require re-consent", outcome: "accepted", feedback: "Also lawful, but you'd delay a well over data that could simply be counted. Aggregation serves both." },
      { value: "timelimit", label: "Time-limit the access", outcome: "wrong", feedback: "Time limits don't cure the identifiability problem." },
    ],
  },
  {
    faction: "merchants",
    factionLabel: "THE MERCHANTS",
    crest: FACTION_CRESTS.merchants,
    artifact: "Villager contact addresses",
    intent: "Invite villagers to a NEW year-round market the Merchants are opening.",
    ledgerPurpose: "Addresses collected to deliver festival mail this season.",
    correctVerdict: "conditional",
    correctFeedback:
      "Not a scam this time — a genuine new service. But festival-mail addresses were never given for year-round marketing. Let them ASK: villagers who say yes may be invited, the rest left in peace. Fresh purpose, fresh consent.",
    wrongFeedback: "Not everything is grant-or-seal, Agent. A genuine new purpose sometimes just needs to ask first.",
    safeguardOptions: [
      { value: "reconsent", label: "Require re-consent / opt-in", outcome: "correct", feedback: "Not a scam this time — a genuine new service. But festival-mail addresses were never given for year-round marketing. Let them ASK: villagers who say yes may be invited, the rest left in peace. Fresh purpose, fresh consent." },
      { value: "anonymize", label: "Anonymize", outcome: "wrong", feedback: "You can't send a personal invitation to an anonymized address. Anonymization defeats the purpose here." },
      { value: "grant_raw", label: "Grant outright", outcome: "wrong", feedback: "Festival-mail consent doesn't cover marketing outreach. That's exactly the scope creep this principle stops." },
    ],
  },
];

const INTEGRITY_STEP = 15;
const FACTION_XP_PER_TICKET = 40;

let openCount = 0;

export function isArchivistsDeskOverlayOpen(): boolean {
  return openCount > 0;
}

/** Opens "The Archivist's Desk." `onClose(completed)` fires exactly once
 * — `true` only once all six tickets are resolved, `false` on an early
 * Escape. Every open starts a fresh attempt, same "no partial resume"
 * simplification as this project's other full-screen minigames. */
export function openArchivistsDeskOverlay(onClose: (completed: boolean) => void) {
  openCount++;
  resetArchivistsDeskState();

  let ticketIndex = 0;
  let stage: "verdict" | "safeguard" = "verdict";
  let resolvedText: string | null = null;
  let integrityValue = 100;
  let factionXp = 0;
  let currentTicketCardEl: HTMLElement | null = null;

  const bodyEl = el("div", {});
  const ticketCounterEl = el("div", { className: "briefing__case" });
  const factionXpEl = el("div", { style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)" } });
  const integrityMeterEl = el(
    "div",
    { className: "meter", style: { width: "260px" } },
    [
      el("div", { className: "meter__label", text: "VILLAGE INTEGRITY" }),
      el("div", { className: "meter__track" }, [el("div", { className: "meter__fill", style: { width: "100%" } })]),
      el("div", { className: "meter__delta", text: "" }),
    ],
  );
  const statusRowEl = el(
    "div",
    { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "var(--space-2)" } },
    [ticketCounterEl, integrityMeterEl, factionXpEl],
  );

  const panelEl = el(
    "div",
    { className: "panel panel--glow ds-root", style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "820px", pointerEvents: "auto" } },
    [
      el("div", { className: "briefing__header" }, [
        el("span", { className: "briefing__case", text: "FIELD WORK" }),
        el("h2", { className: "briefing__title", text: "The Archivist's Desk" }),
      ]),
      el("hr", { className: "briefing__divider" }),
      statusRowEl,
      bodyEl,
    ],
  );

  const wrapper = el("div", { className: "ui-backdrop ds-root", style: { position: "absolute", inset: "0", pointerEvents: "auto", zIndex: "1000" } });
  wrapper.append(panelEl);
  document.getElementById("ui-root")!.appendChild(wrapper);

  function flashRed(target: HTMLElement) {
    target.style.animation = "none";
    void target.offsetWidth;
    target.style.animation = "ds-shake 400ms ease-in-out";
    window.setTimeout(() => (target.style.animation = ""), 400);
  }

  function flashCorrect(target: HTMLElement) {
    target.style.animation = "none";
    void target.offsetWidth;
    target.style.animation = "ds-quiz-correct 500ms ease-out";
    window.setTimeout(() => (target.style.animation = ""), 500);
  }

  function updateIntegrityMeter() {
    const fillEl = integrityMeterEl.querySelector(".meter__fill") as HTMLElement;
    fillEl.style.width = `${integrityValue}%`;
  }

  function updateFactionXp() {
    factionXpEl.textContent = `FACTION XP: ${factionXp}`;
  }

  function continueButton(label: string, onClick: () => void): HTMLElement {
    return el("button", { className: "btn btn--gold", text: label, style: { marginTop: "var(--space-3)" }, on: { click: onClick } });
  }

  // --- Ticket card (left: request, right: ledger) --------------------------
  function renderTicketCard(ticket: Ticket): HTMLElement {
    const cardEl = el(
      "div",
      { style: { display: "flex", gap: "16px", marginTop: "var(--space-2)" } },
      [
        el(
          "div",
          { className: "panel", style: { flex: "1", pointerEvents: "auto" } },
          [
            el("div", { style: { fontSize: "32px" }, text: ticket.crest }),
            el("div", { className: "chip", text: ticket.factionLabel, style: { marginTop: "4px" } }),
            el("h3", { text: ticket.artifact, style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "16px", margin: "10px 0 4px" } }),
            el("div", { text: `"${ticket.intent}"`, style: { fontStyle: "italic", color: "var(--text-muted)", fontSize: "13px" } }),
          ],
        ),
        el(
          "div",
          { className: "panel", style: { flex: "1" } },
          [
            el("div", { className: "briefing__case", text: "VILLAGE LEDGER — ORIGINAL PURPOSE" }),
            el("div", { text: ticket.ledgerPurpose, style: { fontSize: "13px", marginTop: "8px" } }),
          ],
        ),
      ],
    );
    currentTicketCardEl = cardEl;
    return cardEl;
  }

  function verdictButtonsRow(): HTMLElement {
    return el(
      "div",
      { style: { display: "flex", gap: "12px", marginTop: "var(--space-3)", justifyContent: "center" } },
      [
        el("button", { className: "btn btn--gold", text: "GRANT", on: { click: () => pickVerdict("grant") } }),
        el("button", {
          className: "btn btn--ghost",
          text: "CONDITIONAL",
          style: { borderColor: "var(--accent-blue)", color: "var(--accent-blue)" },
          on: { click: () => pickVerdict("conditional") },
        }),
        el("button", { className: "btn btn--danger", text: "SEAL", on: { click: () => pickVerdict("seal") } }),
      ],
    );
  }

  function safeguardButtonsRow(ticket: Ticket): HTMLElement {
    return el(
      "div",
      { style: { display: "flex", gap: "12px", marginTop: "var(--space-3)", justifyContent: "center" } },
      (ticket.safeguardOptions ?? []).map((opt) => el("button", { className: "btn btn--ghost", text: opt.label, on: { click: () => pickSafeguard(opt) } })),
    );
  }

  function render() {
    const ticket = TICKETS[ticketIndex];
    ticketCounterEl.textContent = `TICKET ${ticketIndex + 1} OF ${TICKETS.length}`;
    bodyEl.innerHTML = "";
    const cardEl = renderTicketCard(ticket);
    bodyEl.append(cardEl);
    if (resolvedText !== null) {
      bodyEl.append(
        el("p", { className: "briefing__body", text: `QUILL — ${resolvedText}`, style: { marginTop: "var(--space-3)" } }),
        continueButton(ticketIndex + 1 >= TICKETS.length ? "FILE THE LAST RECORD" : "NEXT TICKET", onContinue),
      );
      flashCorrect(cardEl);
      return;
    }
    if (stage === "safeguard") bodyEl.append(safeguardButtonsRow(ticket));
    else bodyEl.append(verdictButtonsRow());
  }

  function registerWrong(message: string) {
    archivistsDeskState.integrityLost++;
    integrityValue = Math.max(0, integrityValue - INTEGRITY_STEP);
    updateIntegrityMeter();
    playSound("select");
    if (currentTicketCardEl) flashRed(currentTicketCardEl);
    questEngine.toast(`QUILL — ${message}`);
  }

  function resolveTicket(verdictRecord: string, explanation: string) {
    archivistsDeskState.perTicketVerdicts.push(verdictRecord);
    factionXp += FACTION_XP_PER_TICKET;
    updateFactionXp();
    playSound("chime");
    resolvedText = explanation;
    render();
  }

  function pickVerdict(v: Verdict) {
    if (resolvedText !== null) return;
    const ticket = TICKETS[ticketIndex];
    if (v === "conditional" && ticket.correctVerdict === "conditional") {
      stage = "safeguard";
      playSound("select");
      render();
      return;
    }
    if (v === ticket.correctVerdict) {
      resolveTicket(v, ticket.correctFeedback);
      return;
    }
    registerWrong(ticket.wrongFeedback);
  }

  function pickSafeguard(opt: SafeguardOption) {
    if (resolvedText !== null) return;
    if (opt.outcome === "wrong") {
      registerWrong(opt.feedback);
      return;
    }
    archivistsDeskState.safeguardChoices.push(opt.value);
    resolveTicket(`conditional:${opt.value}`, opt.feedback);
  }

  function onContinue() {
    ticketIndex++;
    stage = "verdict";
    resolvedText = null;
    if (ticketIndex >= TICKETS.length) {
      finishSequence();
      return;
    }
    render();
  }

  // --- Completion -------------------------------------------------------
  function finishSequence() {
    bodyEl.innerHTML = "";
    bodyEl.append(
      el("p", {
        className: "briefing__body",
        text:
          "QUILL — Six requests. Three refused or conditioned, three honored. And not from suspicion or from trust — from the LEDGER. That is the whole of it, Agent: data may serve only the purpose it was given for, or a purpose compatible with it. Everything else must ask again.",
        style: { marginTop: "var(--space-2)" },
      }),
    );
    window.setTimeout(() => finish(), 3200);
  }

  function finish() {
    teardown();
    onClose(true);
  }

  // --- Teardown -----------------------------------------------------------
  function teardown() {
    openCount--;
    document.removeEventListener("keydown", onKeydown);
    wrapper.remove();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      teardown();
      onClose(false);
    }
  }
  document.addEventListener("keydown", onKeydown);

  updateIntegrityMeter();
  updateFactionXp();
  render();
}
