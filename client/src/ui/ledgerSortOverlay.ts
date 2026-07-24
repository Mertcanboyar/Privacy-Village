import { el } from "./dom";
import { GAME_WIDTH, GAME_HEIGHT } from "../config";
import { playSound } from "../audio";
import { questEngine } from "../questEngine";
import { healersLedgerState, resetHealersLedgerState } from "../healersLedgerState";

// "The Healer's Ledger" Mission 1 — drag the ledger's 10 data shards
// into the correct chest (STANDARD vs SENSITIVE/SPECIAL CATEGORY). Full-
// screen DOM overlay, same #ui-root/ui-backdrop pattern as imageOverlay.ts
// and tableOverlay.ts, but with real drag-and-drop instead of a static
// viewer — see the deleted pre-Academy client/src/quest.ts (git history,
// commit d285494) for the single-card Pointer Events technique this
// generalizes to N simultaneous tray cards.

type ShardCategory = "standard" | "sensitive";

interface Shard {
  id: string;
  label: string;
  category: ShardCategory;
}

const SHARDS: Shard[] = [
  { id: "name", label: "Villager's name", category: "standard" },
  { id: "coin", label: "Coin paid for herbs", category: "standard" },
  { id: "date", label: "Date of visit", category: "standard" },
  { id: "address", label: "Delivery address", category: "standard" },
  { id: "blend", label: "Preferred herb blend", category: "standard" },
  { id: "ailment", label: "Ailment treated (fevers, wounds, the falling sickness)", category: "sensitive" },
  { id: "heartrate", label: "Heart rate under the fever-draught", category: "sensitive" },
  { id: "guild", label: "Guild affiliation", category: "sensitive" },
  { id: "faction", label: "Faction allegiance (Fundamentalist / Apocalypse)", category: "sensitive" },
  { id: "fertility", label: "Fertility treatment received", category: "sensitive" },
];

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// #game-stage is scaled to fill the window (see scale.ts) — dividing a
// real screen-pixel pointer delta by this factor converts it into the
// same fixed 1280x720 "game space" every other #ui-root element is
// already positioned in, so a dragged card tracks the cursor exactly
// regardless of the actual window size.
function currentScale(): number {
  return Math.min(window.innerWidth / GAME_WIDTH, window.innerHeight / GAME_HEIGHT);
}

let openCount = 0;

export function isLedgerSortOverlayOpen(): boolean {
  return openCount > 0;
}

/** Opens Mission 1. `onClose(completed)` fires exactly once, whenever
 * the overlay goes away — `true` if all 10 shards were sorted, `false`
 * if the player backed out early (Escape) — so the caller (npc.ts) can
 * reliably restore NPCController's mode either way. breachCount/
 * overClassifyCount for this attempt are left in healersLedgerState for
 * the caller to read on a `true` close. */
export function openHealersLedgerSort(onClose: (completed: boolean) => void) {
  openCount++;
  resetHealersLedgerState();

  const deck = shuffled(SHARDS);
  const remaining = new Set(deck.map((s) => s.id));

  const progressEl = el("div", {
    style: { fontFamily: "var(--font-mono)", fontSize: "13px", color: "var(--text-muted)", textAlign: "center", marginTop: "4px" },
  });
  const trayEl = el("div", {
    style: { display: "flex", flexWrap: "wrap", gap: "10px", justifyContent: "center", minHeight: "220px", marginTop: "var(--space-3)", position: "relative" },
  });
  const standardZoneEl = el(
    "div",
    {
      className: "drop-zone",
      text: "🧺 STANDARD RECORDS",
      style: { flex: "1", height: "120px", borderColor: "rgba(76, 201, 240, 0.55)", fontSize: "15px" },
    },
  );
  const sensitiveZoneEl = el(
    "div",
    {
      className: "drop-zone",
      text: "🔒 SENSITIVE RECORDS",
      style: { flex: "1", height: "120px", borderColor: "rgba(239, 71, 111, 0.55)", fontSize: "15px" },
    },
  );
  const zonesRowEl = el("div", { style: { display: "flex", gap: "16px", marginTop: "var(--space-3)" } }, [standardZoneEl, sensitiveZoneEl]);

  const panelEl = el(
    "div",
    {
      className: "panel panel--glow ds-root",
      style: {
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: "820px",
        pointerEvents: "auto",
      },
    },
    [
      el("div", { className: "briefing__header" }, [
        el("span", { className: "briefing__case", text: "MISSION 1" }),
        el("h2", { className: "briefing__title", text: "Sort the Ledger" }),
      ]),
      el("hr", { className: "briefing__divider" }),
      el("p", {
        className: "briefing__body",
        text: "Drag every entry from the ledger into the chest it belongs in. Ordinary details go in the open trunk — anything that could end a marriage, a guild membership, or a life goes behind the lock.",
      }),
      trayEl,
      zonesRowEl,
      progressEl,
    ],
  );

  const wrapper = el("div", {
    className: "ui-backdrop ds-root",
    style: { position: "absolute", inset: "0", pointerEvents: "auto", zIndex: "1000" },
  });
  wrapper.append(panelEl);
  document.getElementById("ui-root")!.appendChild(wrapper);

  function flashRed(target: HTMLElement) {
    target.style.animation = "none";
    void target.offsetWidth;
    target.style.animation = "ds-shake 400ms ease-in-out";
    window.setTimeout(() => (target.style.animation = ""), 400);
  }

  // Full-stage red flash for a breach — a separate, higher, briefly-
  // shown element rather than tinting the backdrop itself, so it reads
  // as an alarm strobe and not a lasting color change.
  function flashScreenRed() {
    const flash = el("div", {
      style: { position: "absolute", inset: "0", background: "var(--accent-red)", opacity: "0", pointerEvents: "none", zIndex: "1001", animation: "ds-levelup-flash 350ms ease-out" },
    });
    wrapper.appendChild(flash);
    window.setTimeout(() => flash.remove(), 350);
  }

  function renderProgress() {
    progressEl.textContent = `${SHARDS.length - remaining.size} / ${SHARDS.length} sorted`;
  }
  renderProgress();

  function zoneAt(clientX: number, clientY: number): ShardCategory | null {
    const sRect = standardZoneEl.getBoundingClientRect();
    if (clientX >= sRect.left && clientX <= sRect.right && clientY >= sRect.top && clientY <= sRect.bottom) return "standard";
    const seRect = sensitiveZoneEl.getBoundingClientRect();
    if (clientX >= seRect.left && clientX <= seRect.right && clientY >= seRect.top && clientY <= seRect.bottom) return "sensitive";
    return null;
  }

  function highlightZone(hovered: ShardCategory | null) {
    standardZoneEl.classList.toggle("drop-zone--hover", hovered === "standard");
    sensitiveZoneEl.classList.toggle("drop-zone--hover", hovered === "sensitive");
  }

  function makeCard(shard: Shard): HTMLElement {
    const cardEl = el("div", {
      className: "drag-card",
      text: shard.label,
      style: { position: "static", width: "190px", fontSize: "13px", padding: "10px" },
    });

    let dragging = false;

    const endDrag = (clientX: number, clientY: number, pointerId: number) => {
      dragging = false;
      if (cardEl.hasPointerCapture(pointerId)) cardEl.releasePointerCapture(pointerId);
      highlightZone(null);
      const zone = zoneAt(clientX, clientY);
      if (!zone) {
        resetCardPosition();
        return;
      }
      if (zone === shard.category) {
        playSound("chime");
        remaining.delete(shard.id);
        cardEl.remove();
        renderProgress();
        if (remaining.size === 0) finish();
        return;
      }
      // Wrong chest — which direction determines the lesson.
      if (shard.category === "sensitive" && zone === "standard") {
        healersLedgerState.breachCount++;
        playSound("alarm-bell");
        flashScreenRed();
        flashRed(panelEl);
        questEngine.toast(`DATA BREACH — "${shard.label}" left in the open ledger. The eastern merchant reads it and smiles.`);
      } else {
        healersLedgerState.overClassifyCount++;
        questEngine.toast(`Over-classification, Agent. Lock everything and you protect nothing well. "${shard.label}" is ordinary.`);
      }
      resetCardPosition();
    };

    function resetCardPosition() {
      cardEl.style.position = "static";
      cardEl.style.left = "";
      cardEl.style.top = "";
      cardEl.style.zIndex = "";
    }

    cardEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      dragging = true;
      cardEl.setPointerCapture(e.pointerId);
      cardEl.style.zIndex = "10";
    });
    cardEl.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      // Self-heal a missed pointerup (real mouse button released outside
      // the window) — same technique as imageOverlay.ts's pan drag.
      if ((e.buttons & 1) === 0) {
        endDrag(e.clientX, e.clientY, e.pointerId);
        return;
      }
      const panelRect = panelEl.getBoundingClientRect();
      const scale = currentScale();
      cardEl.style.position = "absolute";
      cardEl.style.left = `${(e.clientX - panelRect.left) / scale}px`;
      cardEl.style.top = `${(e.clientY - panelRect.top) / scale}px`;
      highlightZone(zoneAt(e.clientX, e.clientY));
    });
    cardEl.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      endDrag(e.clientX, e.clientY, e.pointerId);
    });
    cardEl.addEventListener("pointercancel", () => {
      if (!dragging) return;
      dragging = false;
      highlightZone(null);
      resetCardPosition();
    });

    return cardEl;
  }

  for (const shard of deck) trayEl.appendChild(makeCard(shard));

  function debriefLine(): string {
    const b = healersLedgerState.breachCount;
    if (b === 0) return `MAREN — Not one slip. You sorted my life better than I've lived it.`;
    if (b <= 2) return `MAREN — A stumble or two — and each one, out there, is a villager's secret in a stranger's hand.`;
    return `HERALD — You'd have breached three times before the tea cooled, Ranger. Sensitive data is not a guessing game. Learn the categories.`;
  }

  function finish() {
    questEngine.toast(debriefLine());
    teardown();
    onClose(true);
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
}
