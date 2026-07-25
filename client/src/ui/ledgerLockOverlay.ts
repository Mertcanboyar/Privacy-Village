import { el } from "./dom";
import { playSound } from "../audio";
import { questEngine } from "../questEngine";
import { healersLedgerState } from "../healersLedgerState";

// "The Healer's Ledger" Mission 2 — a proportional-security ceremony,
// not a real puzzle (see the spec: "~20 seconds, rotation only, no
// logic trap"). Only the SENSITIVE chest can be locked; the whole point
// is that ordinary records don't get the same treatment. Same #ui-root
// overlay pattern as ledgerSortOverlay.ts.

const RING_COUNT = 4;
const RING_SYMBOL_SET = ["△", "◇", "☾", "✦"];

interface RingState {
  symbols: string[]; // this ring's own shuffled order of the 4 runes
  rotation: number; // index into symbols currently facing up
  target: string;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function makeRings(): RingState[] {
  return Array.from({ length: RING_COUNT }, () => {
    const symbols = shuffled(RING_SYMBOL_SET);
    const target = symbols[Math.floor(Math.random() * symbols.length)];
    return { symbols, rotation: 0, target };
  });
}

let openCount = 0;

export function isLedgerLockOverlayOpen(): boolean {
  return openCount > 0;
}

/** Opens Mission 2. `onClose(completed)` fires exactly once, whenever
 * the overlay goes away — `true` once the sensitive chest is sealed AND
 * the correct access-control option is chosen, `false` if the player
 * backed out early (Escape) — so the caller (npc.ts) can reliably
 * restore NPCController's mode either way. */
export function openHealersLedgerLock(onClose: (completed: boolean) => void) {
  openCount++;
  let view: "choose" | "puzzle" | "access" = "choose";
  let rings: RingState[] = [];

  const bodyEl = el("div", {});
  const panelEl = el(
    "div",
    {
      className: "panel panel--glow ds-root",
      style: {
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: "720px",
        pointerEvents: "auto",
      },
    },
    [
      el("div", { className: "briefing__header" }, [
        el("span", { className: "briefing__case", text: "MISSION 2" }),
        el("h2", { className: "briefing__title", text: "The Cryptographic Lock" }),
      ]),
      el("hr", { className: "briefing__divider" }),
      bodyEl,
    ],
  );

  const wrapper = el("div", {
    className: "ui-backdrop ds-root",
    style: { position: "absolute", inset: "0", pointerEvents: "auto", zIndex: "1000" },
  });
  wrapper.append(panelEl);
  document.getElementById("ui-root")!.appendChild(wrapper);

  function render() {
    bodyEl.innerHTML = "";
    if (view === "choose") bodyEl.append(...renderChoose());
    else if (view === "puzzle") bodyEl.append(...renderPuzzle());
    else bodyEl.append(...renderAccess());
  }

  function renderChoose(): HTMLElement[] {
    const chestBtn = (label: string, sensitive: boolean) =>
      el("button", {
        className: "btn btn--ghost",
        text: label,
        style: { flex: "1", height: "110px", fontSize: "15px", flexDirection: "column" },
        on: {
          click: () => {
            if (!sensitive) {
              questEngine.toast("Standard records are already behind a chest lid — that's protection enough. Save the extra lock for what actually needs it.");
              return;
            }
            playSound("select");
            rings = makeRings();
            view = "puzzle";
            render();
          },
        },
      });
    return [
      el("p", { className: "briefing__body", text: "Which chest needs an additional lock?" }),
      el("div", { style: { display: "flex", gap: "16px", marginTop: "var(--space-2)" } }, [
        chestBtn("🧺 STANDARD RECORDS", false),
        chestBtn("🔒 SENSITIVE RECORDS", true),
      ]),
    ];
  }

  function renderPuzzle(): HTMLElement[] {
    const cipherRowEl = el(
      "div",
      { style: { display: "flex", gap: "12px", justifyContent: "center", marginTop: "var(--space-1)" } },
      rings.map((r) =>
        el("div", {
          text: r.target,
          style: {
            width: "40px",
            height: "40px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "20px",
            border: "2px solid var(--accent-gold)",
            borderRadius: "8px",
            color: "var(--accent-gold)",
          },
        }),
      ),
    );

    const ringEls: HTMLElement[] = [];
    const ringsRowEl = el(
      "div",
      { style: { display: "flex", gap: "16px", justifyContent: "center", marginTop: "var(--space-3)" } },
      rings.map((r, i) => {
        const ringEl = el("button", {
          className: "btn btn--ghost",
          text: r.symbols[r.rotation],
          style: { width: "90px", height: "90px", borderRadius: "50%", fontSize: "30px" },
          on: {
            click: () => {
              r.rotation = (r.rotation + 1) % r.symbols.length;
              ringEl.textContent = r.symbols[r.rotation];
              const matched = r.symbols[r.rotation] === r.target;
              ringEl.style.borderColor = matched ? "var(--accent-green)" : "";
              ringEl.style.color = matched ? "var(--accent-green)" : "";
              checkSolved();
            },
          },
        });
        ringEls[i] = ringEl;
        return ringEl;
      }),
    );

    function checkSolved() {
      if (!rings.every((r) => r.symbols[r.rotation] === r.target)) return;
      playSound("chime");
      questEngine.toast("SEALED — RESTRICTED ACCESS");
      view = "access";
      render();
    }

    return [
      el("p", { className: "briefing__body", text: "Rotate each ring (click) until it shows its cipher-key symbol. All four must match at once." }),
      el("div", { style: { textAlign: "center", fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.1em", color: "var(--text-muted)", marginTop: "var(--space-2)" }, text: "CIPHER KEY" }),
      cipherRowEl,
      ringsRowEl,
    ];
  }

  function renderAccess(): HTMLElement[] {
    const optionBtn = (label: string, kind: "correct" | "aloneOnly" | "anyVillager") =>
      el("button", {
        className: "btn btn--ghost",
        text: label,
        style: { width: "100%", marginTop: "var(--space-1)" },
        on: { click: () => pickAccess(kind) },
      });

    return [
      el("p", { className: "briefing__body", text: "🔵 SEALED — RESTRICTED ACCESS. Who may open this chest?" }),
      optionBtn("Maren alone", "aloneOnly"),
      optionBtn("Maren and her two apprentices", "correct"),
      optionBtn("Any villager who asks", "anyVillager"),
    ];
  }

  function pickAccess(kind: "correct" | "aloneOnly" | "anyVillager") {
    healersLedgerState.accessChoiceAttempts++;
    if (kind === "correct") {
      questEngine.toast("HERALD — Least privilege, Ranger — not the fewest hands possible, the fewest hands NECESSARY. She cannot heal alone.");
      teardown();
      onClose(true);
      return;
    }
    if (kind === "aloneOnly") {
      questEngine.toast("Admirable, and unworkable. When she sleeps, the apprentices treat the sick with no records. Security that stops the work gets bypassed by the workers.");
    } else {
      questEngine.toast("That is not a lock. That is a doorway with a ceremony.");
    }
    render();
  }

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
