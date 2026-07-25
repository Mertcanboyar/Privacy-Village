import { el } from "./dom";
import { playSound } from "../audio";
import { questEngine } from "../questEngine";
import { sealedLetterState, resetSealedLetterState } from "../sealedLetterState";

// "The Sealed Letter" — one continuous full-screen overlay walking four
// measures of secure communication, each defeating one property of a
// forged Council letter. Same #ui-root/ui-backdrop + view-state-machine
// pattern as ui/ledgerLockOverlay.ts (a handful of sequential narrative
// stages with click-to-choose beats), not the canvas-layer/drag system
// blueprintOverlay.ts needed — this quest has no drag/drop or continuous
// animation, just stages.
//
// Concept-to-crypto mapping (for a future theory module — NOT shown
// in-game, this is dev-only context):
//   Seal ring          -> asymmetric key pair (private key signs, public
//                          seal verifies)
//   Watchword           -> shared secret / symmetric password (weak for
//                          authentication)
//   Tamper seal across
//   the fold             -> hash / MAC (integrity)
//   Locked box           -> encryption (confidentiality)
//   Personal seal you
//   can't disown          -> digital signature (non-repudiation)

type Stage = "letterIntro" | "watchword" | "seal" | "integrity" | "confidentiality" | "nonrepudiation" | "completion";

const FORGED_LETTER_TEXT =
  'BY ORDER OF THE COUNCIL — To all villagers: open the EAST GATE at dusk this day, to receive a grain delivery of importance to the whole village. Delay serves no one. — The Council.\n\nGREENHOLLOW';

let openCount = 0;

export function isSealedLetterOverlayOpen(): boolean {
  return openCount > 0;
}

/** Opens "The Sealed Letter." `onClose(completed)` fires exactly once —
 * `true` only once all four measures are resolved, `false` on an early
 * Escape. Every open starts a fresh attempt, same "no partial resume"
 * simplification as this project's other full-screen minigames. */
export function openSealedLetterOverlay(onClose: (completed: boolean) => void) {
  openCount++;
  resetSealedLetterState();

  let stage: Stage = "letterIntro";
  let sealStageEnteredAt = 0;

  const bodyEl = el("div", {});
  const panelEl = el(
    "div",
    {
      className: "panel panel--glow ds-root",
      style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "720px", pointerEvents: "auto" },
    },
    [
      el("div", { className: "briefing__header" }, [
        el("span", { className: "briefing__case", text: "FIELD WORK" }),
        el("h2", { className: "briefing__title", text: "The Sealed Letter" }),
      ]),
      el("hr", { className: "briefing__divider" }),
      bodyEl,
    ],
  );

  const wrapper = el("div", { className: "ui-backdrop ds-root", style: { position: "absolute", inset: "0", pointerEvents: "auto", zIndex: "1000" } });
  wrapper.append(panelEl);
  document.getElementById("ui-root")!.appendChild(wrapper);

  function render() {
    bodyEl.innerHTML = "";
    if (stage === "letterIntro") bodyEl.append(...renderLetterIntro());
    else if (stage === "watchword") bodyEl.append(...renderWatchword());
    else if (stage === "seal") bodyEl.append(...renderSeal());
    else if (stage === "integrity") bodyEl.append(...renderIntegrity());
    else if (stage === "confidentiality") bodyEl.append(...renderConfidentiality());
    else if (stage === "nonrepudiation") bodyEl.append(...renderNonRepudiation());
    else bodyEl.append(...renderCompletion());
  }

  function flashShake(target: HTMLElement) {
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

  // --- A small reusable wax-seal glyph — a curling flourish, mirrored
  // for the "forged" variant so its tail literally curls the wrong way
  // (matching Bram's own explanation line). ---
  function sealGlyph(variant: "authentic" | "forged"): HTMLElement {
    const svgWrap = el("div", {
      style: { width: "48px", height: "48px", transform: variant === "forged" ? "scaleX(-1)" : "none" },
    });
    svgWrap.innerHTML =
      '<svg viewBox="0 0 100 100" width="48" height="48"><circle cx="50" cy="50" r="46" fill="#8a2b2b" stroke="#5c1c1c" stroke-width="3"/><path d="M42 28 C 62 28, 72 42, 62 56 C 52 70, 32 65, 32 50 C 32 40, 42 35, 48 40" stroke="#f0d9a8" stroke-width="6" fill="none" stroke-linecap="round"/></svg>';
    return svgWrap;
  }

  function sealCard(label: string, variant: "authentic" | "forged", opts: { clickable: boolean; onClick?: () => void }): HTMLElement {
    const cardEl = el(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "8px",
          padding: "var(--space-2)",
          border: "1.5px solid var(--border-strong)",
          borderRadius: "var(--radius)",
          background: "rgba(255,255,255,0.03)",
          cursor: opts.clickable ? "pointer" : "default",
          flex: "1",
        },
        on: opts.clickable ? { click: () => opts.onClick?.() } : {},
      },
      [sealGlyph(variant), el("span", { text: label, style: { fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)", textAlign: "center" } })],
    );
    return cardEl;
  }

  // --- Letter prop, reused by the intro + integrity stages. `fold`
  // draws a horizontal seam through the letter body; `sealVariant` picks
  // which wax seal renders where the seam meets the edge. `broken`
  // visibly cracks/offsets that seal. ---
  function letterProp(opts: { fold?: boolean; sealVariant?: "authentic" | "forged"; broken?: boolean }): HTMLElement {
    const children: (Node | string)[] = [
      el("p", { text: FORGED_LETTER_TEXT, style: { whiteSpace: "pre-line", fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-primary)", margin: "0" } }),
    ];
    const letterEl = el(
      "div",
      {
        style: {
          position: "relative",
          padding: "var(--space-3)",
          background: "#e8dcc0",
          color: "#2a2013",
          borderRadius: "4px",
          border: "1px solid #3d2b1f",
        },
      },
      children.map((c) => (typeof c === "string" ? c : c)) as Node[],
    );
    // Force dark ink color regardless of the ds-root theme vars, since
    // this prop is meant to read as physical parchment, not UI chrome.
    (letterEl.firstElementChild as HTMLElement | null)?.style.setProperty("color", "#2a2013");

    if (opts.fold) {
      letterEl.appendChild(
        el("div", { style: { position: "absolute", left: "0", right: "0", top: "50%", height: "1px", background: "rgba(61,43,31,0.35)" } }),
      );
    }
    if (opts.sealVariant) {
      const sealWrap = el("div", {
        style: {
          position: "absolute",
          left: "50%",
          top: opts.fold ? "50%" : "100%",
          transform: opts.broken ? "translate(-58%, -50%) rotate(-6deg)" : "translate(-50%, -50%)",
        },
      });
      sealWrap.appendChild(sealGlyph(opts.sealVariant));
      letterEl.appendChild(sealWrap);
      if (opts.broken) {
        const crackWrap = el("div", {
          style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-38%, -50%) rotate(8deg)" },
        });
        crackWrap.appendChild(sealGlyph(opts.sealVariant));
        crackWrap.style.opacity = "0.55";
        letterEl.appendChild(crackWrap);
      }
    }
    return letterEl;
  }

  function continueButton(label: string, onClick: () => void): HTMLElement {
    return el("button", { className: "btn btn--gold", text: label, style: { marginTop: "var(--space-3)" }, on: { click: onClick } });
  }

  // --- Stage: letter intro --------------------------------------------
  function renderLetterIntro(): HTMLElement[] {
    return [
      el("p", {
        className: "briefing__body",
        text: 'Bram spreads the letter flat. The Council\'s crest, the East Gate, dusk. "Read it yourself, Agent. Then tell me what\'s wrong with it."',
      }),
      letterProp({ sealVariant: "forged" }),
      continueButton("EXAMINE THE LETTER", () => {
        stage = "watchword";
        render();
      }),
    ];
  }

  // --- Stage: Measure 1, Beat A — the watchword --------------------------
  function renderWatchword(): HTMLElement[] {
    const revealed = sealedLetterState.passwordChoice !== null;
    const children: HTMLElement[] = [
      el("div", { className: "briefing__case", text: "MEASURE 1 — AUTHENTICATION" }),
      el("h3", { text: "Is it really from who it claims?", style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px", margin: "6px 0 var(--space-2)" } }),
      el("p", {
        className: "briefing__body",
        text: "HERALD — The old village way: a shared watchword. The Council's letters used to end with a secret word only the Council knew — \"GREENHOLLOW\". Check this letter.",
      }),
      el("p", { className: "briefing__body", text: "The watchword is correct. Is the letter genuine?" }),
    ];

    if (!revealed) {
      children.push(
        el("div", { style: { display: "flex", gap: "var(--space-2)" } }, [
          el("button", { className: "btn btn--ghost", text: "Yes — the word proves it", style: { flex: "1" }, on: { click: () => pickPassword("yes") } }),
          el("button", { className: "btn btn--ghost", text: "No — a shared secret can leak", style: { flex: "1" }, on: { click: () => pickPassword("no") } }),
        ]),
      );
    } else {
      const correct = sealedLetterState.passwordChoice === "no";
      children.push(
        el("p", {
          className: "briefing__body",
          text: correct
            ? "HERALD — Exactly, Ranger. A watchword known to many is a watchword known to the enemy — and this one leaked months ago. Shared secrets don't prove identity. We need something that cannot be copied."
            : "HERALD — A watchword known to many is a watchword known to the enemy. The Saboteur bribed a clerk months ago. Shared secrets don't prove identity — they only prove someone LEARNED the secret. We need something that cannot be copied.",
          style: { marginTop: "var(--space-2)" },
        }),
      );
      children.push(
        continueButton("CONTINUE", () => {
          stage = "seal";
          sealStageEnteredAt = performance.now();
          render();
        }),
      );
    }
    return children;
  }

  function pickPassword(choice: "yes" | "no") {
    sealedLetterState.passwordChoice = choice;
    playSound("select");
    render();
  }

  // --- Stage: Measure 1, Beat B — the seal ---------------------------
  function renderSeal(): HTMLElement[] {
    const revealed = stageResolved.seal;
    const children: HTMLElement[] = [
      el("div", { className: "briefing__case", text: "MEASURE 1 — AUTHENTICATION" }),
      el("p", {
        className: "briefing__body",
        text: 'HERALD — Every Council member now carries a SEAL RING — a mark no other can forge, because making it requires the ring itself, which never leaves their hand.',
      }),
      el("p", { className: "briefing__body", text: "Compare the seals. Click the one that's forged." }),
      el(
        "div",
        { style: { display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" } },
        [
          sealCard("COUNCIL REFERENCE SEAL", "authentic", { clickable: !revealed, onClick: () => clickSeal(false) }),
          sealCard("THIS LETTER'S SEAL", "forged", { clickable: !revealed, onClick: () => clickSeal(true) }),
        ],
      ),
    ];
    if (revealed) {
      children.push(
        el("p", {
          className: "briefing__body",
          text: 'BRAM — The sigil\'s tail curls the wrong way. A fine forgery — but a forgery. The letter is FALSE. The gate stays shut.',
          style: { marginTop: "var(--space-2)" },
        }),
      );
      children.push(
        continueButton("CONTINUE", () => {
          stage = "integrity";
          render();
        }),
      );
    }
    return children;
  }

  const stageResolved = { seal: false, integrity: false, nonrepudiation: false };

  function clickSeal(isLetterSeal: boolean) {
    if (stageResolved.seal) return;
    if (!isLetterSeal) {
      sealedLetterState.wrongSealAttempts++;
      playSound("select");
      const cards = bodyEl.querySelectorAll("div");
      // First matching card is the reference seal (rendered first).
      const refCard = [...cards].find((c) => c.textContent?.includes("COUNCIL REFERENCE SEAL"));
      if (refCard) flashShake(refCard as HTMLElement);
      questEngine.toast("That's the true seal — compare it against the LETTER's seal instead.");
      return;
    }
    stageResolved.seal = true;
    sealedLetterState.forgeryCaughtSeconds = Math.round((performance.now() - sealStageEnteredAt) / 100) / 10;
    playSound("chime");
    render();
    const cards = bodyEl.querySelectorAll("div");
    const letterCard = [...cards].find((c) => c.textContent?.includes("THIS LETTER'S SEAL"));
    if (letterCard) flashCorrect(letterCard as HTMLElement);
  }

  // --- Stage: Measure 2 — integrity ------------------------------------
  function renderIntegrity(): HTMLElement[] {
    const revealed = stageResolved.integrity;
    const children: HTMLElement[] = [
      el("div", { className: "briefing__case", text: "MEASURE 2 — INTEGRITY" }),
      el("h3", { text: "Was it altered on the road?", style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px", margin: "6px 0 var(--space-2)" } }),
      el("p", {
        className: "briefing__body",
        text: "HERALD — Even a true letter can be changed mid-journey. How do we know the words that left the Council are the words that arrived?",
      }),
      el("p", { className: "briefing__body", text: "Which letter can you trust to be UNCHANGED?" }),
      el(
        "div",
        { style: { display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" } },
        [
          integrityCard("INTACT SEAL", false),
          integrityCard("CRACKED & RE-PRESSED", true),
        ],
      ),
    ];
    if (revealed) {
      children.push(
        el("p", {
          className: "briefing__body",
          text: 'A seal across the seam breaks if the letter is opened. Broken seal, broken trust — the contents may have been altered. This is INTEGRITY: proof the message is whole and unchanged.',
          style: { marginTop: "var(--space-2)" },
        }),
      );
      children.push(
        continueButton("CONTINUE", () => {
          stage = "confidentiality";
          render();
        }),
      );
    }
    return children;
  }

  function integrityCard(label: string, broken: boolean): HTMLElement {
    const wrap = el(
      "div",
      {
        style: { flex: "1", cursor: stageResolved.integrity ? "default" : "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" },
        on: stageResolved.integrity ? {} : { click: () => clickIntegrity(broken, wrap) },
      },
      [letterProp({ fold: true, sealVariant: broken ? "forged" : "authentic", broken }), el("span", { text: label, style: { fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)" } })],
    );
    return wrap;
  }
  function clickIntegrity(broken: boolean, cardEl: HTMLElement) {
    if (stageResolved.integrity) return;
    if (broken) {
      playSound("select");
      flashShake(cardEl);
      questEngine.toast("A cracked seal means the letter was opened and re-closed somewhere along the road. You can't trust what's inside anymore.");
      return;
    }
    stageResolved.integrity = true;
    playSound("chime");
    render();
  }

  // --- Stage: Measure 3 — confidentiality ------------------------------
  function renderConfidentiality(): HTMLElement[] {
    const revealed = sealedLetterState.encryptChoice !== null;
    const children: HTMLElement[] = [
      el("div", { className: "briefing__case", text: "MEASURE 3 — CONFIDENTIALITY" }),
      el("h3", { text: "Can a stranger read it on the road?", style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px", margin: "6px 0 var(--space-2)" } }),
      el("p", {
        className: "briefing__body",
        text: "A sensitive reply must go from the Council to Bram past hostile territory. How do you send it?",
      }),
    ];
    if (!revealed) {
      children.push(
        el("div", { style: { display: "flex", gap: "var(--space-2)" } }, [
          el("button", { className: "btn btn--ghost", text: "Plain, trusting the road", style: { flex: "1" }, on: { click: () => pickEncrypt("plain") } }),
          el("button", { className: "btn btn--ghost", text: "Sealed in a locked box only Bram's key opens", style: { flex: "1" }, on: { click: () => pickEncrypt("locked_box") } }),
        ]),
      );
    } else {
      const beatEl = el("div", { style: { marginTop: "var(--space-2)" } });
      children.push(beatEl);
      if (sealedLetterState.encryptChoice === "locked_box") {
        playInterceptorBeat(beatEl);
      } else {
        beatEl.appendChild(
          el("p", {
            className: "briefing__body",
            text: "The interceptor reads every word before it ever reaches Bram. Whatever secret was in that reply — it isn't secret anymore.",
          }),
        );
        beatEl.appendChild(continueButton("CONTINUE", () => { stage = "nonrepudiation"; render(); }));
      }
    }
    return children;
  }

  function pickEncrypt(choice: "plain" | "locked_box") {
    sealedLetterState.encryptChoice = choice;
    playSound("select");
    render();
  }

  // A short scripted beat (no logging, purely narrative) — matches the
  // "brief animation" the spec asks for without needing real sprites.
  function playInterceptorBeat(container: HTMLElement) {
    const lineEl = el("p", { className: "briefing__body", text: "An interceptor stops the courier on the road…" });
    container.appendChild(lineEl);
    window.setTimeout(() => {
      lineEl.textContent = "An interceptor stops the courier on the road… tries the box…";
    }, 900);
    window.setTimeout(() => {
      lineEl.textContent = "An interceptor stops the courier on the road… tries the box… LOCKED. He moves on empty-handed.";
      playSound("chime");
      const explainEl = el("p", {
        className: "briefing__body",
        text: "CONFIDENTIALITY — only the intended reader holds the key. The road is hostile; the message doesn't have to be readable to those who steal it.",
        style: { marginTop: "var(--space-2)" },
      });
      const nuanceEl = el("p", {
        className: "briefing__body",
        text: 'The ADDRESS on the box stays plain — the courier must still route it. Seal the contents, not the path.',
        style: { marginTop: "var(--space-2)", color: "var(--text-muted)", fontSize: "12px" },
      });
      container.append(explainEl, nuanceEl, continueButton("CONTINUE", () => { stage = "nonrepudiation"; render(); }));
    }, 1800);
  }

  // --- Stage: Measure 4 — non-repudiation ------------------------------
  const NONREPUDIATION_EXPLAIN: Record<string, string> = {
    witnessed: "Witnesses can be mistaken, bribed, or simply absent next time. That's not what makes a seal unforgeable.",
    ring: "Exactly — identity-bound, self-produced, unforgeable. The same property as authentication, pointed the other direction.",
    council: "The Council's WORD isn't proof — that's exactly the kind of claim a forger would also make. The proof has to be physical and unforgeable.",
  };

  function renderNonRepudiation(): HTMLElement[] {
    const revealed = stageResolved.nonrepudiation;
    const children: HTMLElement[] = [
      el("div", { className: "briefing__case", text: "MEASURE 4 — NON-REPUDIATION" }),
      el("h3", { text: "Can the sender later deny it?", style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px", margin: "6px 0 var(--space-2)" } }),
      el("p", {
        className: "briefing__body",
        text: 'A merchant claims he never agreed to a delivery the Council recorded — "I signed nothing!" But his letter bears his personal seal.',
      }),
      el("p", {
        className: "briefing__body",
        text: "HERALD — His own seal, which only he can make. He cannot now deny his own hand. This is NON-REPUDIATION — a signature the sender cannot later disown. It protects the village FROM the sender, as authentication protects the village from imposters.",
      }),
      el("p", { className: "briefing__body", text: "Why can't the merchant deny his seal?" }),
    ];
    if (!revealed) {
      children.push(
        el("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" } }, [
          el("button", { className: "btn btn--ghost", text: "Because Bram witnessed it", style: { width: "100%", justifyContent: "flex-start", textAlign: "left" }, on: { click: () => pickNonRepudiation("witnessed") } }),
          el("button", { className: "btn btn--ghost", text: "Because only his ring makes that mark", style: { width: "100%", justifyContent: "flex-start", textAlign: "left" }, on: { click: () => pickNonRepudiation("ring") } }),
          el("button", { className: "btn btn--ghost", text: "Because the Council says so", style: { width: "100%", justifyContent: "flex-start", textAlign: "left" }, on: { click: () => pickNonRepudiation("council") } }),
        ]),
      );
    } else {
      children.push(el("p", { className: "briefing__body", text: NONREPUDIATION_EXPLAIN.ring, style: { marginTop: "var(--space-2)" } }));
      children.push(continueButton("CONTINUE", () => { stage = "completion"; render(); playCompletionBeat(); }));
    }
    return children;
  }

  function pickNonRepudiation(choice: "witnessed" | "ring" | "council") {
    playSound("select");
    if (choice !== "ring") {
      questEngine.toast(NONREPUDIATION_EXPLAIN[choice]);
      return;
    }
    stageResolved.nonrepudiation = true;
    playSound("chime");
    render();
  }

  // --- Stage: completion ------------------------------------------------
  function renderCompletion(): HTMLElement[] {
    return [
      el("p", {
        className: "briefing__body",
        text: "BRAM — Four measures, Agent. Now a lie can't wear the Council's face, a letter can't be changed unseen, a stranger can't read what isn't his, and no man can disown his own hand. The road is hostile. Our letters are not helpless.",
      }),
      el("p", {
        className: "briefing__body",
        text: "🔔 The bell rings at dusk. The East Gate stays shut. Somewhere beyond the wall, a plan quietly fails.",
        style: { marginTop: "var(--space-2)", color: "var(--text-muted)" },
      }),
    ];
  }

  function playCompletionBeat() {
    window.setTimeout(() => finish(), 3200);
  }

  function finish() {
    teardown();
    onClose(true);
  }

  // --- Teardown -------------------------------------------------------
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
