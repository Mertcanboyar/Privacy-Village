import { el } from "./dom";
import { playSound } from "../audio";
import { alchemistsTrialsState, resetAlchemistsTrialsState } from "../alchemistsTrialsState";

// "The Alchemist's Trials" — three short trials, each teaching a frontier
// PET by first letting the player break the ordinary approach, then
// handing them the real tool. Same render-dispatcher shell as
// ui/archivistsDeskOverlay.ts (a `stage` variable + one render() that
// dispatches on it, resolvedText/continueButton for "feedback never
// auto-advances," flashRed/flashCorrect helpers, no partial resume).
//
// Concept mapping (not shown in-game):
//   Trial 1 = differencing attack on published aggregates → differential
//             privacy (calibrated noise; privacy/utility trade-off)
//   Trial 2 = synthetic data generation for test/dev use; outlier
//             memorisation risk (purpose limitation applied to environments)
//   Trial 3 = homomorphic encryption / secure multiparty computation;
//             removing the trusted third party; minimal disclosure

type Stage =
  | "hook"
  | "trial1_query"
  | "trial1_noise"
  | "trial1_debrief"
  | "trial2_demand"
  | "trial2_loom"
  | "trial2_outlier"
  | "trial2_remedy"
  | "trial2_debrief"
  | "trial3_impasse"
  | "trial3_casket"
  | "trial3_check"
  | "complete";

interface Query {
  id: string;
  label: string;
  answer: number;
}

interface CensusRow {
  name: string;
  age: number;
  district: string;
  trade: string;
}

// REAL: five named villagers, including the village's only centenarian
// herbalist (Hazel) — the outlier the loom below ends up memorising.
const REAL_CENSUS: CensusRow[] = [
  { name: "Rowan", age: 34, district: "Lantern Row", trade: "Miller" },
  { name: "Bettina", age: 28, district: "Orchard District", trade: "Weaver" },
  { name: "Ansel", age: 45, district: "East Gate", trade: "Guard" },
  { name: "Corin", age: 19, district: "Market Square", trade: "Apprentice" },
  { name: "Hazel", age: 103, district: "Cinder Row", trade: "Herbalist" },
];

// SYNTHETIC: plausible invented rows matching the real distribution —
// except the last, which the loom reproduced almost exactly from Hazel
// (same name, one year off, same district and trade). That row is the
// one the player must click to flag in Phase C.
const SYNTHETIC_CENSUS: CensusRow[] = [
  { name: "Elowen", age: 32, district: "Lantern Row", trade: "Miller" },
  { name: "Sable", age: 25, district: "Orchard District", trade: "Weaver" },
  { name: "Bran", age: 47, district: "East Gate", trade: "Guard" },
  { name: "Fenn", age: 20, district: "Market Square", trade: "Apprentice" },
  { name: "Hazel", age: 102, district: "Cinder Row", trade: "Herbalist" },
];
const OUTLIER_ROW_INDEX = 4;

type DemandChoice = "handover" | "refuse" | "synthetic";
type RemedyChoice = "suppress" | "publish" | "discard";
type ImpasseChoice = "third_party" | "publish_own" | "sealed";
type CouncilAnswer = "individual" | "combined" | "nothing";

const MERCHANTS_TOTAL = 2400;
const TINKERS_TOTAL = 1850;
const COMBINED_TOTAL = MERCHANTS_TOTAL + TINKERS_TOTAL;

function ciphertextGibberish(): string {
  const chars = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s.match(/.{1,4}/g)!.join(" ");
}

// The one discoverable differencing pair: two totals that differ by
// exactly one villager (the miller). The other four are decoys with no
// pairing question — asking any of them teaches nothing by itself.
const QUERIES: Query[] = [
  { id: "lantern_all", label: "How many villagers on Lantern Row carry debt?", answer: 7 },
  { id: "lantern_excl_miller", label: "How many villagers on Lantern Row, EXCLUDING the miller, carry debt?", answer: 6 },
  { id: "orchard_bees", label: "How many households keep bees in the Orchard District?", answer: 12 },
  { id: "east_gate_carts", label: "How many carts passed the East Gate yesterday?", answer: 41 },
  { id: "festival_roster", label: "How many villagers signed the harvest festival roster?", answer: 58 },
  { id: "wells", label: "How many wells are registered in the village?", answer: 4 },
];

const DIFFERENCING_PAIR: [string, string] = ["lantern_all", "lantern_excl_miller"];
const HINT_AFTER_ASKS = 5;

type NoiseSetting = "none" | "calibrated" | "extreme";

let openCount = 0;

export function isAlchemistsTrialsOverlayOpen(): boolean {
  return openCount > 0;
}

/** Opens "The Alchemist's Trials." `onClose(completed)` fires exactly
 * once — `true` only once all three trials are finished, `false` on an
 * early Escape. Every open starts a fresh attempt, same "no partial
 * resume" simplification as this project's other full-screen minigames. */
export function openAlchemistsTrialsOverlay(onClose: (completed: boolean) => void) {
  openCount++;
  resetAlchemistsTrialsState();

  let stage: Stage = "hook";
  let hookLineIndex = 0;
  let resolvedText: string | null = null;
  let askedQueries = new Set<string>();
  let pairFound = false;
  let noiseSetting: NoiseSetting | null = null;
  let noisePassed = false;

  const bodyEl = el("div", {});
  const instructionsEl = el("div", {
    style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", textAlign: "center", marginTop: "var(--space-3)", minHeight: "16px" },
  });
  const trialCounterEl = el("div", { className: "briefing__case" });

  const panelEl = el(
    "div",
    { className: "panel panel--glow ds-root", style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "860px", pointerEvents: "auto" } },
    [
      el("div", { className: "briefing__header" }, [
        trialCounterEl,
        el("h2", { className: "briefing__title", text: "The Alchemist's Trials" }),
      ]),
      el("hr", { className: "briefing__divider" }),
      bodyEl,
      instructionsEl,
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

  function setInstructions(text: string) {
    instructionsEl.textContent = text;
  }

  function continueButton(label: string, onClick: () => void): HTMLElement {
    return el("button", { className: "btn btn--gold", text: label, style: { marginTop: "var(--space-3)" }, on: { click: onClick } });
  }

  function isoldeLine(text: string): HTMLElement {
    return el(
      "div",
      { className: "dialogue", style: { position: "relative" } },
      [el("div", { className: "dialogue__name", text: "Isolde" }), el("div", { className: "dialogue__body", text: text })],
    );
  }

  // --- Stage: hook --------------------------------------------------------
  const HOOK_LINES = [
    "You have used the cabinet's common shelves, Agent. The locked drawer holds three instruments the village barely believes in.",
    "Each solves a problem the ordinary tools cannot. Fail my trials honestly, and you will understand why they exist.",
  ];

  function renderHook() {
    trialCounterEl.textContent = "THE LOCKED DRAWER";
    bodyEl.innerHTML = "";
    bodyEl.append(isoldeLine(HOOK_LINES[hookLineIndex]), continueButton(hookLineIndex + 1 >= HOOK_LINES.length ? "BEGIN TRIAL ONE" : "CONTINUE", onHookContinue));
    setInstructions("");
  }

  function onHookContinue() {
    hookLineIndex++;
    if (hookLineIndex >= HOOK_LINES.length) {
      stage = "trial1_query";
      render();
      return;
    }
    render();
  }

  // --- Stage: trial1_query (the differencing attack) -----------------------
  function renderTrial1Query() {
    trialCounterEl.textContent = "TRIAL 1 OF 3 — THE TWO QUESTIONS";
    bodyEl.innerHTML = "";

    bodyEl.append(
      isoldeLine('"The Scribe publishes only totals, no names, ever — perfectly safe, she says. Ask her two questions."'),
      el("div", { className: "panel", style: { marginTop: "var(--space-2)" } }, [
        el("div", { className: "briefing__case", text: "THE SCRIBE'S STATISTICS BOARD" }),
        el(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "var(--space-2)" } },
          QUERIES.map((q) => renderQueryRow(q)),
        ),
      ]),
    );

    if (pairFound) {
      bodyEl.append(renderRevealCard());
    }

    setInstructions(
      pairFound
        ? ""
        : askedQueries.size >= HINT_AFTER_ASKS
          ? "HINT — Two questions that differ by exactly one villager will tell you about that villager."
          : "Ask any of the Scribe's published totals. Nothing here is named — or so she claims.",
    );
  }

  function renderQueryRow(q: Query): HTMLElement {
    const asked = askedQueries.has(q.id);
    return el(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "12px" } },
      [
        el("button", {
          className: "btn btn--ghost",
          text: asked ? q.label : `ASK — ${q.label}`,
          style: { flex: "1", textAlign: "left", fontSize: "12px", opacity: pairFound ? "0.6" : "1" },
          attrs: pairFound ? { disabled: "true" } : {},
          on: { click: () => askQuery(q) },
        }),
        el("div", {
          style: { width: "48px", textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: "700", color: "var(--accent-gold)" },
          text: asked ? String(q.answer) : "—",
        }),
      ],
    );
  }

  function askQuery(q: Query) {
    if (pairFound || askedQueries.has(q.id)) return;
    askedQueries.add(q.id);
    alchemistsTrialsState.trial1Attempts++;
    playSound("select");
    if (askedQueries.has(DIFFERENCING_PAIR[0]) && askedQueries.has(DIFFERENCING_PAIR[1])) {
      pairFound = true;
      alchemistsTrialsState.trial1BrokeAggregate = true;
      playSound("alarm-bell");
    }
    render();
  }

  function renderRevealCard(): HTMLElement {
    const card = el(
      "div",
      { className: "panel", style: { marginTop: "var(--space-2)", borderColor: "var(--accent-red)" } },
      [
        el("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", gap: "16px", fontFamily: "var(--font-mono)", fontSize: "22px", fontWeight: "700" } }, [
          el("span", { text: "7" }),
          el("span", { text: "−", style: { color: "var(--text-muted)" } }),
          el("span", { text: "6" }),
          el("span", { text: "=", style: { color: "var(--text-muted)" } }),
          el("span", { text: "1", style: { color: "var(--accent-red)" } }),
        ]),
        el("div", { style: { textAlign: "center", marginTop: "8px", fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "16px", color: "var(--accent-red)" }, text: "THE MILLER CARRIES DEBT." }),
        isoldeLine("Two totals, no names, and you have exposed one man's finances. That is a DIFFERENCING ATTACK — the flaw hiding inside every 'safe' aggregate."),
        continueButton("APPLY THE COUNTERMEASURE", () => {
          stage = "trial1_noise";
          render();
        }),
      ],
    );
    window.setTimeout(() => flashRed(card), 0);
    return card;
  }

  // --- Stage: trial1_noise (the noise dial) --------------------------------
  function jitteredAnswer(base: number, setting: NoiseSetting): number {
    if (setting === "none") return base;
    if (setting === "calibrated") return Math.round((base + (Math.random() * 1.0 - 0.5)) * 10) / 10;
    return Math.round(base + (Math.random() * 24 - 12));
  }

  function renderTrial1Noise() {
    trialCounterEl.textContent = "TRIAL 1 OF 3 — THE NOISE DIAL";
    bodyEl.innerHTML = "";

    const a = noiseSetting ? jitteredAnswer(7, noiseSetting) : null;
    const b = noiseSetting ? jitteredAnswer(6, noiseSetting) : null;
    const districtTotal = noiseSetting ? jitteredAnswer(340, noiseSetting) : null;

    const resultsPanel = el("div", { className: "panel", style: { marginTop: "var(--space-2)" } }, [
      el("div", { className: "briefing__case", text: "LIVE RE-RUN — SAME TWO QUESTIONS" }),
      el("div", { style: { display: "flex", justifyContent: "space-around", marginTop: "var(--space-2)", fontFamily: "var(--font-mono)" } }, [
        el("div", { style: { textAlign: "center" } }, [el("div", { text: "Lantern Row, all debt", style: { fontSize: "11px", color: "var(--text-muted)" } }), el("div", { text: a === null ? "—" : String(a), style: { fontSize: "20px", fontWeight: "700" } })]),
        el("div", { style: { textAlign: "center" } }, [el("div", { text: "excluding the miller", style: { fontSize: "11px", color: "var(--text-muted)" } }), el("div", { text: b === null ? "—" : String(b), style: { fontSize: "20px", fontWeight: "700" } })]),
      ]),
      el("div", {
        style: { textAlign: "center", marginTop: "8px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)" },
        text: districtTotal === null ? "" : `District-level total: ${districtTotal} (Council's real question)`,
      }),
    ]);

    const dialRow = el(
      "div",
      { style: { display: "flex", gap: "12px", marginTop: "var(--space-3)", justifyContent: "center" } },
      [
        el("button", { className: "btn btn--ghost", text: "NONE", on: { click: () => pickNoise("none") } }),
        el("button", { className: "btn btn--gold", text: "CALIBRATED", on: { click: () => pickNoise("calibrated") } }),
        el("button", { className: "btn btn--danger", text: "EXTREME", on: { click: () => pickNoise("extreme") } }),
      ],
    );

    bodyEl.append(isoldeLine("A noise dial sits beside the board. Try each setting — watch what happens to both the spy's subtraction and the Council's real question."), resultsPanel, dialRow);

    if (resolvedText !== null) {
      bodyEl.append(el("p", { className: "briefing__body", text: `ISOLDE — ${resolvedText}`, style: { marginTop: "var(--space-2)" } }));
      if (noisePassed) bodyEl.append(continueButton("CONTINUE", () => finishTrial1()));
      setInstructions("");
    } else {
      setInstructions("Pick a setting to re-run both questions live and see what it costs — or protects.");
    }
  }

  function pickNoise(setting: NoiseSetting) {
    noiseSetting = setting;
    playSound("select");
    if (setting === "calibrated") {
      noisePassed = true;
      resolvedText =
        "The subtraction no longer proves anything — the difference could be noise. Useful for the Council, useless for the spy.";
      flashCorrectSoon();
    } else {
      alchemistsTrialsState.trial1NoiseFirstTry = false;
      noisePassed = false;
      resolvedText =
        setting === "none"
          ? "Exact and ruinous. You've changed nothing — the miller is exposed again."
          : "Privacy bought by destroying truth is not a bargain. The Council complains: these numbers are nonsense; they cannot plan on them.";
    }
    render();
    if (setting !== "calibrated") flashRedSoon();
  }

  function flashRedSoon() {
    window.setTimeout(() => {
      const panel = bodyEl.querySelector(".panel") as HTMLElement | null;
      if (panel) flashRed(panel);
    }, 0);
  }

  function flashCorrectSoon() {
    window.setTimeout(() => {
      const panel = bodyEl.querySelector(".panel") as HTMLElement | null;
      if (panel) flashCorrect(panel);
    }, 0);
  }

  function finishTrial1() {
    stage = "trial1_debrief";
    render();
  }

  // --- Stage: trial1_debrief -----------------------------------------------
  function renderTrial1Debrief() {
    trialCounterEl.textContent = "TRIAL 1 OF 3 — COMPLETE";
    bodyEl.innerHTML = "";
    bodyEl.append(
      isoldeLine(
        "DIFFERENTIAL PRIVACY: add just enough uncertainty that no single villager's presence can be detected — even by someone who knows all the others — while the picture of the whole stays true.",
      ),
      continueButton("BEGIN TRIAL TWO", () => {
        stage = "trial2_demand";
        render();
      }),
    );
    setInstructions("");
  }

  // --- Stage: trial2_demand (the apprentice's demand) -----------------------
  let demandResolved: DemandChoice | null = null;
  let demandAttempted = false;

  function renderTrial2Demand() {
    trialCounterEl.textContent = "TRIAL 2 OF 3 — THE CARTOGRAPHER'S APPRENTICE";
    bodyEl.innerHTML = "";

    bodyEl.append(
      isoldeLine(
        "A visiting apprentice engineer needs the full census to test his new tally-machine before the harvest. He needs data that BEHAVES like the census — not the villagers themselves.",
      ),
      el(
        "div",
        { style: { display: "flex", gap: "12px", marginTop: "var(--space-3)", justifyContent: "center" } },
        [
          el("button", { className: "btn btn--ghost", text: "HAND OVER THE REAL CENSUS", on: { click: () => pickDemand("handover") } }),
          el("button", { className: "btn btn--ghost", text: "REFUSE — NO DATA", on: { click: () => pickDemand("refuse") } }),
          el("button", { className: "btn btn--gold", text: "GENERATE A SYNTHETIC CENSUS", on: { click: () => pickDemand("synthetic") } }),
        ],
      ),
    );

    if (demandResolved) {
      const text =
        demandResolved === "handover"
          ? "He needs data that BEHAVES like the census. You gave him the villagers themselves."
          : "The apprentice's machine ships untested and miscounts at harvest. Privacy that halts the work invites its own disaster.";
      bodyEl.append(el("p", { className: "briefing__body", text: `ISOLDE — ${text}`, style: { marginTop: "var(--space-2)" } }));
      setInstructions("");
      flashRedSoon();
    } else {
      setInstructions("The apprentice needs the census's patterns, not its people. Choose how to answer him.");
    }
  }

  function pickDemand(choice: DemandChoice) {
    playSound("select");
    if (choice === "synthetic") {
      alchemistsTrialsState.trial2ApproachFirstTry = !demandAttempted;
      stage = "trial2_loom";
      render();
      return;
    }
    demandAttempted = true;
    demandResolved = choice;
    render();
  }

  // --- Stage: trial2_loom (real vs synthetic side-by-side) ------------------
  function censusTable(label: string, rows: CensusRow[], onRowClick?: (i: number) => void): HTMLElement {
    return el("div", { style: { flex: "1" } }, [
      el("div", { className: "briefing__case", text: label }),
      el("div", { className: "evidence-table", style: { marginTop: "8px" } }, [
        el("table", {}, [
          el("thead", {}, [el("tr", {}, [el("th", { text: "Name" }), el("th", { text: "Age" }), el("th", { text: "District" }), el("th", { text: "Trade" })])]),
          el(
            "tbody",
            {},
            rows.map((r, i) =>
              el(
                "tr",
                {
                  style: onRowClick ? { cursor: "pointer" } : {},
                  on: onRowClick ? { click: () => onRowClick(i) } : {},
                },
                [el("td", { text: r.name }), el("td", { text: String(r.age) }), el("td", { text: r.district }), el("td", { text: r.trade })],
              ),
            ),
          ),
        ]),
      ]),
    ]);
  }

  function renderTrial2Loom() {
    trialCounterEl.textContent = "TRIAL 2 OF 3 — THE LOOM";
    bodyEl.innerHTML = "";
    bodyEl.append(
      isoldeLine("It behaves like the census in every pattern that matters. Not one of these people exists."),
      el("div", { style: { display: "flex", gap: "16px", marginTop: "var(--space-2)" } }, [censusTable("REAL CENSUS", REAL_CENSUS), censusTable("SYNTHETIC CENSUS", SYNTHETIC_CENSUS)]),
      continueButton("INSPECT THE WEAVE", () => {
        stage = "trial2_outlier";
        render();
      }),
    );
    setInstructions("The loom wove a fresh dataset from the real one, matching its ages, districts, and trades.");
  }

  // --- Stage: trial2_outlier (find + remedy the memorised row) --------------
  let outlierFound = false;
  let remedyResolved: RemedyChoice | null = null;
  let remedyWrongCount = 0;

  function renderTrial2Outlier() {
    trialCounterEl.textContent = "TRIAL 2 OF 3 — THE TRAP";
    bodyEl.innerHTML = "";

    const syntheticTable = censusTable("SYNTHETIC CENSUS", SYNTHETIC_CENSUS, outlierFound ? undefined : (i) => flagOutlier(i));

    bodyEl.append(
      isoldeLine(outlierFound ? "Synthetic data learns from real data — and rare souls are learned too well. Always audit the outliers before you release the cloth." : "One of these rows is unmistakably a real villager, memorised almost exactly. Click it."),
      el("div", { style: { display: "flex", gap: "16px", marginTop: "var(--space-2)" } }, [censusTable("REAL CENSUS", REAL_CENSUS), syntheticTable]),
    );

    if (!outlierFound) {
      setInstructions("Compare every synthetic row against the real census — one of them is too close to be an invention.");
      return;
    }

    bodyEl.append(
      el(
        "div",
        { style: { display: "flex", gap: "12px", marginTop: "var(--space-3)", justifyContent: "center" } },
        [
          el("button", { className: "btn btn--gold", text: "SUPPRESS THE OUTLIER ROW", on: { click: () => pickRemedy("suppress") } }),
          el("button", { className: "btn btn--ghost", text: "PUBLISH ANYWAY, IT'S SYNTHETIC", on: { click: () => pickRemedy("publish") } }),
          el("button", { className: "btn btn--danger", text: "DISCARD THE WHOLE DATASET", on: { click: () => pickRemedy("discard") } }),
        ],
      ),
    );

    if (remedyResolved === "suppress") {
      bodyEl.append(
        el("p", { className: "briefing__body", text: "ISOLDE — Correct. Suppress her row, and the rest of the cloth remains sound.", style: { marginTop: "var(--space-2)" } }),
        continueButton("CONTINUE", () => {
          stage = "trial2_debrief";
          render();
        }),
      );
      setInstructions("");
    } else if (remedyResolved) {
      const text = remedyResolved === "publish" ? "Synthetic in name only, if she is recognisable." : "Over-reaction, Agent — the rest of the dataset is sound.";
      bodyEl.append(el("p", { className: "briefing__body", text: `ISOLDE — ${text}`, style: { marginTop: "var(--space-2)" } }));
      setInstructions(remedyWrongCount >= 2 ? "HINT — Only one option removes the risk without losing the rest of the dataset." : "");
      flashRedSoon();
    } else {
      setInstructions("Flagging her is not enough — decide what to do with the row.");
    }
  }

  function flagOutlier(i: number) {
    if (outlierFound) return;
    if (i !== OUTLIER_ROW_INDEX) {
      flashRedSoon();
      return;
    }
    outlierFound = true;
    playSound("alarm-bell");
    render();
  }

  function pickRemedy(choice: RemedyChoice) {
    if (remedyResolved === "suppress") return;
    playSound("select");
    if (choice !== "suppress") {
      remedyWrongCount++;
      if (remedyWrongCount >= 2) alchemistsTrialsState.hintsUsed++;
    }
    remedyResolved = choice;
    if (choice === "suppress") alchemistsTrialsState.trial2Choice = "suppress";
    render();
  }

  // --- Stage: trial2_debrief -------------------------------------------------
  function renderTrial2Debrief() {
    trialCounterEl.textContent = "TRIAL 2 OF 3 — COMPLETE";
    bodyEl.innerHTML = "";
    bodyEl.append(
      isoldeLine(
        "SYNTHETIC DATA: hand over cloth that behaves like the census for those who only need to build or test — never the villagers themselves, and never an unaudited outlier.",
      ),
      continueButton("BEGIN TRIAL THREE", () => {
        stage = "trial3_impasse";
        render();
      }),
    );
    setInstructions("");
  }

  // --- Stage: trial3_impasse (the two guilds) --------------------------------
  let impasseResolved: ImpasseChoice | null = null;
  let impasseAttempted = false;

  function renderTrial3Impasse() {
    trialCounterEl.textContent = "TRIAL 3 OF 3 — THE TWO GUILDS";
    bodyEl.innerHTML = "";

    bodyEl.append(
      isoldeLine(
        "The Merchants and the Tinkers must learn their COMBINED winter earnings to set a fair tax. Neither will show its books to the other, nor to the Council.",
      ),
      el(
        "div",
        { style: { display: "flex", gap: "12px", marginTop: "var(--space-3)", justifyContent: "center" } },
        [
          el("button", { className: "btn btn--ghost", text: "GIVE BOTH LEDGERS TO A TRUSTED THIRD PARTY", style: { fontSize: "12px" }, on: { click: () => pickImpasse("third_party") } }),
          el("button", { className: "btn btn--ghost", text: "HAVE EACH GUILD PUBLISH ITS OWN TOTAL", style: { fontSize: "12px" }, on: { click: () => pickImpasse("publish_own") } }),
          el("button", { className: "btn btn--gold", text: "USE THE SEALED CALCULATION", style: { fontSize: "12px" }, on: { click: () => pickImpasse("sealed") } }),
        ],
      ),
    );

    if (impasseResolved) {
      const text =
        impasseResolved === "third_party"
          ? "You did not remove the risk, Agent — you moved it, and gave it a single address. The scribe is later bribed; both guilds' books leak."
          : "Refusal is also an outcome. Both guilds refuse; the tax goes unset.";
      bodyEl.append(el("p", { className: "briefing__body", text: `ISOLDE — ${text}`, style: { marginTop: "var(--space-2)" } }));
      setInstructions("");
      flashRedSoon();
    } else {
      setInstructions("Neither guild will show its books — to the other, or to the Council. Choose an approach.");
    }
  }

  function pickImpasse(choice: ImpasseChoice) {
    playSound("select");
    if (choice === "sealed") {
      alchemistsTrialsState.trial3ApproachFirstTry = !impasseAttempted;
      alchemistsTrialsState.trial3Choice = "sealed_calculation";
      stage = "trial3_casket";
      render();
      return;
    }
    impasseAttempted = true;
    impasseResolved = choice;
    render();
  }

  // --- Stage: trial3_casket (the sealed calculation, animated) --------------
  let casketsSealed = false;
  let scaleComputed = false;
  let resultOpened = false;
  let hoverCaption = "";
  const merchantsCipher = ciphertextGibberish();
  const tinkersCipher = ciphertextGibberish();

  function sealedCasket(label: string, cipher: string, opts: { hoverable?: boolean; opened?: boolean; revealValue?: string } = {}): HTMLElement {
    const box = el(
      "div",
      {
        className: "panel",
        style: {
          width: "180px",
          textAlign: "center",
          borderColor: opts.opened ? "var(--accent-gold)" : "var(--border-strong)",
          cursor: opts.hoverable ? "help" : "default",
        },
        on: opts.hoverable
          ? {
              mouseenter: () => {
                hoverCaption = "CONTENTS NEVER OPENED";
                const capEl = bodyEl.querySelector("[data-casket-caption]");
                if (capEl) capEl.textContent = hoverCaption;
              },
              mouseleave: () => {
                hoverCaption = "";
                const capEl = bodyEl.querySelector("[data-casket-caption]");
                if (capEl) capEl.textContent = "";
              },
            }
          : {},
      },
      [
        el("div", { className: "briefing__case", text: label }),
        el("div", {
          style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: opts.opened ? "var(--accent-gold)" : "var(--text-muted)", marginTop: "8px", wordBreak: "break-all" },
          text: opts.opened ? opts.revealValue ?? "" : cipher,
        }),
      ],
    );
    return box;
  }

  function renderTrial3Casket() {
    trialCounterEl.textContent = "TRIAL 3 OF 3 — THE SEALED CALCULATION";
    bodyEl.innerHTML = "";

    const line = !casketsSealed
      ? "Each guild's number goes into its own sealed casket — locked, contents shown only as ciphertext. Watch closely."
      : !scaleComputed
        ? "The scale performs the addition upon the sealed caskets themselves. A third casket emerges — still sealed."
        : !resultOpened
          ? "Only the Council's key opens the result casket."
          : "The sum was computed without a single ledger being read. That is HOMOMORPHIC ENCRYPTION — arithmetic performed upon locked boxes.";

    bodyEl.append(
      isoldeLine(line),
      el(
        "div",
        { style: { display: "flex", gap: "20px", marginTop: "var(--space-3)", justifyContent: "center", alignItems: "center" } },
        [
          sealedCasket("MERCHANTS' LEDGER", merchantsCipher, { hoverable: true }),
          el("div", { style: { fontFamily: "var(--font-mono)", fontSize: "20px", color: "var(--text-muted)" }, text: "+" }),
          sealedCasket("TINKERS' LEDGER", tinkersCipher, { hoverable: true }),
          el("div", { style: { fontFamily: "var(--font-mono)", fontSize: "20px", color: "var(--text-muted)" }, text: "=" }),
          scaleComputed
            ? sealedCasket("RESULT", ciphertextGibberish(), { opened: resultOpened, revealValue: `${COMBINED_TOTAL} GOLD (COMBINED)` })
            : el("div", { style: { width: "180px", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)" }, text: "— not yet computed —" }),
        ],
      ),
      el("div", { attrs: { "data-casket-caption": "true" }, style: { textAlign: "center", marginTop: "8px", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--accent-blue)", minHeight: "14px" } }),
    );

    if (!casketsSealed) {
      bodyEl.append(continueButton("SEAL BOTH LEDGERS", () => {
        casketsSealed = true;
        playSound("select");
        render();
      }));
      setInstructions("Hover either ledger once sealed — its contents are never opened, even by the scale.");
    } else if (!scaleComputed) {
      bodyEl.append(continueButton("SLIDE ONTO THE ALCHEMIST'S SCALE", () => {
        scaleComputed = true;
        playSound("select");
        render();
      }));
      setInstructions("");
    } else if (!resultOpened) {
      bodyEl.append(continueButton("OPEN WITH THE COUNCIL'S KEY", () => {
        resultOpened = true;
        playSound("chime");
        render();
      }));
      setInstructions("");
    } else {
      bodyEl.append(continueButton("CONTINUE", () => {
        stage = "trial3_check";
        render();
      }));
      setInstructions("");
    }
  }

  // --- Stage: trial3_check (comprehension check) -----------------------------
  let checkAnswer: CouncilAnswer | null = null;
  let checkWrongCount = 0;

  function renderTrial3Check() {
    trialCounterEl.textContent = "TRIAL 3 OF 3 — ONE QUESTION";
    bodyEl.innerHTML = "";

    bodyEl.append(
      isoldeLine("One question, Agent. What did the Council learn?"),
      el(
        "div",
        { style: { display: "flex", gap: "12px", marginTop: "var(--space-3)", justifyContent: "center" } },
        [
          el("button", { className: "btn btn--ghost", text: "BOTH GUILDS' INDIVIDUAL EARNINGS", style: { fontSize: "12px" }, on: { click: () => pickCheck("individual") } }),
          el("button", { className: "btn btn--gold", text: "ONLY THE COMBINED TOTAL", style: { fontSize: "12px" }, on: { click: () => pickCheck("combined") } }),
          el("button", { className: "btn btn--ghost", text: "NOTHING AT ALL", style: { fontSize: "12px" }, on: { click: () => pickCheck("nothing") } }),
        ],
      ),
    );

    if (checkAnswer === "combined") {
      bodyEl.append(
        el("p", { className: "briefing__body", text: "ISOLDE — Exactly the answer that was needed, and nothing else. That is the ideal every PET aims at.", style: { marginTop: "var(--space-2)" } }),
        continueButton("CONTINUE", () => {
          stage = "complete";
          render();
        }),
      );
      setInstructions("");
    } else if (checkAnswer) {
      const text =
        checkAnswer === "individual"
          ? "The Council's key opens only the result casket. The input caskets were never touched."
          : "The Council did learn something — the combined total, exactly what the tax requires.";
      bodyEl.append(el("p", { className: "briefing__body", text: `ISOLDE — ${text}`, style: { marginTop: "var(--space-2)" } }));
      setInstructions(checkWrongCount >= 2 ? "HINT — Which casket was opened, and which never were?" : "");
      flashRedSoon();
    } else {
      setInstructions("Think back to the sealed calculation — what did the Council's key actually open?");
    }
  }

  function pickCheck(answer: CouncilAnswer) {
    if (checkAnswer === "combined") return;
    playSound("select");
    if (answer !== "combined") {
      checkWrongCount++;
      if (checkWrongCount >= 2) alchemistsTrialsState.hintsUsed++;
    }
    checkAnswer = answer;
    render();
  }

  // --- Stage: complete --------------------------------------------------------
  let completeLineIndex = 0;
  const COMPLETE_LINES = [
    "Three instruments, three impossibilities made ordinary: publish truthfully without exposing anyone; hand over data that resembles life without being it; and compute upon what you cannot read.",
    "The cabinet is open to you, Agent. Use it before you invent a reason not to.",
  ];

  function renderComplete() {
    trialCounterEl.textContent = "THE LOCKED DRAWER — OPEN";
    bodyEl.innerHTML = "";
    bodyEl.append(
      isoldeLine(COMPLETE_LINES[completeLineIndex]),
      continueButton(completeLineIndex + 1 >= COMPLETE_LINES.length ? "CLOSE THE CABINET" : "CONTINUE", onCompleteContinue),
    );
    setInstructions("");
  }

  function onCompleteContinue() {
    completeLineIndex++;
    if (completeLineIndex >= COMPLETE_LINES.length) {
      teardown();
      onClose(true);
      return;
    }
    render();
  }

  // --- Render dispatch ------------------------------------------------------
  function render() {
    if (stage === "hook") return renderHook();
    if (stage === "trial1_query") return renderTrial1Query();
    if (stage === "trial1_noise") return renderTrial1Noise();
    if (stage === "trial1_debrief") return renderTrial1Debrief();
    if (stage === "trial2_demand") return renderTrial2Demand();
    if (stage === "trial2_loom") return renderTrial2Loom();
    if (stage === "trial2_outlier") return renderTrial2Outlier();
    if (stage === "trial2_debrief") return renderTrial2Debrief();
    if (stage === "trial3_impasse") return renderTrial3Impasse();
    if (stage === "trial3_casket") return renderTrial3Casket();
    if (stage === "trial3_check") return renderTrial3Check();
    return renderComplete();
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

  render();
}
