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

type Stage = "hook" | "trial1_query" | "trial1_noise" | "trial1_debrief";

interface Query {
  id: string;
  label: string;
  answer: number;
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
      isoldeLine('"The Scribe publishes only totals. No names, ever. Perfectly safe, she says. Ask her two questions."'),
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
        "Exact and ruinous, or nonsensical and useless — you found neither. The subtraction no longer proves anything: the difference could be noise. Useful for the Council, useless for the spy.";
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
        // Trial 2 (Synthetic Data) lands in the next section — placeholder
        // exit for now so this stage is independently testable.
        teardown();
        onClose(true);
      }),
    );
    setInstructions("");
  }

  // --- Render dispatch ------------------------------------------------------
  function render() {
    if (stage === "hook") return renderHook();
    if (stage === "trial1_query") return renderTrial1Query();
    if (stage === "trial1_noise") return renderTrial1Noise();
    return renderTrial1Debrief();
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
