import { el } from "./dom";
import { GAME_WIDTH, GAME_HEIGHT } from "../config";
import { playSound } from "../audio";
import { questEngine } from "../questEngine";
import { treasuryKeysState, resetTreasuryKeysState } from "../treasuryKeysState";

// "The Treasury's Two Keys" — a single continuous full-screen DOM
// overlay/state machine, same shell pattern as blueprintOverlay.ts
// (drag-to-place from a palette, click-free arrow/packet animation) but
// a different core interaction: instead of dragging NODES into fixed
// slots, the player drags MODIFIERS onto a small set of already-fixed
// nodes (the Ledger, the Clerk), and a scripted day/night state engine
// re-tests the board against whatever's currently attached. See the
// quest spec's "core improvement": three attackers, three different
// measures — a lock stops the outsider, a rule stops the off-hours
// insider, and only a log reaches the authorized insider abusing his
// own access.
//
// Concept mapping (not shown in-game):
//   Iron Vault        = encryption at rest / physical & technical control
//   Brass Key          = access control (authentication + authorization)
//   Shift Roster        = time-based access policy (organizational)
//   Mayor's Countersign = separation of duties / four-eyes principle
//   Watchman's Logbook  = audit logging & accountability (Art. 5(2))
//   Three attackers     = external threat / off-hours insider / authorized-access abuse

type NodeId = "ledger" | "clerk" | "bandit" | "megamart" | "mayor_entity";
type ModifierId = "vault" | "key" | "roster" | "logbook" | "countersign";
type DayNight = "day" | "night";

interface NodePos {
  x: number;
  y: number;
  label: string;
  glyph: string;
  color: string;
}

const NODES: Record<NodeId, NodePos> = {
  clerk: { x: 190, y: 300, label: "Junior Clerk", glyph: "▭", color: "var(--accent-blue)" },
  ledger: { x: 500, y: 300, label: "Master Tax Ledger", glyph: "═", color: "var(--accent-green)" },
  mayor_entity: { x: 810, y: 300, label: "The Mayor", glyph: "▭", color: "var(--accent-gold)" },
  bandit: { x: 500, y: 480, label: "Bandit", glyph: "▭", color: "var(--accent-red)" },
  megamart: { x: 810, y: 480, label: "Mega-Mart", glyph: "▭", color: "var(--accent-red)" },
};

// Always-present from the start (see NODES.clerk/ledger); the other
// three fade in/out as the state engine's scripted beats reveal them.
const ALWAYS_ON: NodeId[] = ["clerk", "ledger"];

interface ModifierMeta {
  label: string;
  glyph: string;
  category: "technical" | "organizational";
  target: "ledger" | "clerk";
  def: string;
}

const MODIFIER_META: Record<ModifierId, ModifierMeta> = {
  vault: { label: "IRON VAULT", glyph: "🔒", category: "technical", target: "ledger", def: "Encryption-at-rest / a physical barrier around the data store." },
  key: { label: "BRASS KEY", glyph: "🔑", category: "technical", target: "clerk", def: "An access token granted to one entity." },
  roster: { label: "SHIFT ROSTER", glyph: "🕒", category: "organizational", target: "clerk", def: "A time-based access policy — WHEN a person may act." },
  logbook: { label: "WATCHMAN'S LOGBOOK", glyph: "📖", category: "organizational", target: "ledger", def: "Audit logging — a passive record of every access." },
  countersign: { label: "MAYOR'S COUNTERSIGN", glyph: "✍️", category: "organizational", target: "ledger", def: "Separation of duties — two people required to authorize." },
};

const WRONG_TARGET_MESSAGES: Record<ModifierId, string> = {
  vault: "The Vault is where the LEDGER rests — not something you hang on a person.",
  key: "A key belongs to whoever's authorized to use it — the Clerk, not the strongbox itself.",
  roster: "The Roster governs WHEN a person may act — pin it to the Clerk, not the vault.",
  logbook: "The Logbook watches the VAULT's traffic — attach it there, not to a person.",
  countersign: "The Countersign guards the VAULT's opening — attach it there, not to a person.",
};

let openCount = 0;

export function isTreasuryOverlayOpen(): boolean {
  return openCount > 0;
}

/** Opens the full quest — hook through completion — in one continuous
 * overlay. `onClose(completed)` fires exactly once. Every open starts a
 * fresh attempt, same "no partial resume" simplification every other
 * full-screen minigame in this project already uses. */
export function openTreasuryOverlay(onClose: (completed: boolean) => void) {
  openCount++;
  resetTreasuryKeysState();

  // --- Board state -----------------------------------------------------
  let dayNight: DayNight = "day";
  let vaulted = false;
  let keyed = false;
  let rosterApplied = false;
  let logbookApplied = false;
  let countersignApplied = false;
  let nightTriggered = false;
  let dayTestTriggered = false;
  let dayTestPending = false;
  let clerkAuthorized = false;
  let mayorAuthorized = false;
  let finished = false;

  const nodeEls = new Map<NodeId, HTMLElement>();
  const badgeRows = new Map<NodeId, HTMLElement>();
  const arrows = new Map<string, { lineEl: HTMLElement; headEl: HTMLElement }>();
  const spawners = new Map<string, number>();
  let packets: { el: HTMLElement; fromX: number; fromY: number; toX: number; toY: number; startTime: number; durationMs: number; color: string; onArrive?: () => void }[] = [];
  let packetRaf: number | null = null;

  // --- Shell -------------------------------------------------------------
  const instructionsEl = el("div", {
    style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", textAlign: "center", marginTop: "8px", minHeight: "16px" },
  });
  const paletteEl = el("div", { style: { display: "flex", flexDirection: "column", gap: "8px", width: "190px", flex: "none" } });
  // Same layering discipline as blueprintOverlay.ts — every full-canvas
  // layer div defaults pointerEvents:"none" so its empty area doesn't
  // silently eat clicks meant for a layer underneath; individual
  // interactive elements opt back in explicitly.
  const arrowsLayerEl = el("div", { style: { position: "absolute", inset: "0", pointerEvents: "none" } });
  const nodesLayerEl = el("div", { style: { position: "absolute", inset: "0", pointerEvents: "none" } });
  const packetsLayerEl = el("div", { style: { position: "absolute", inset: "0", pointerEvents: "none" } });
  const badgesLayerEl = el("div", { style: { position: "absolute", inset: "0", pointerEvents: "none" } });
  const hudLayerEl = el("div", { style: { position: "absolute", inset: "0", pointerEvents: "none" } });
  const canvasEl = el(
    "div",
    { style: { position: "relative", flex: "1", height: "560px", background: "rgba(0,0,0,0.15)", borderRadius: "var(--radius)", border: "1px solid var(--border-strong)" } },
    [arrowsLayerEl, nodesLayerEl, badgesLayerEl, packetsLayerEl, hudLayerEl],
  );

  const panelEl = el(
    "div",
    { className: "panel panel--glow ds-root", style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "1180px", pointerEvents: "auto" } },
    [
      el("div", { className: "briefing__header" }, [
        el("span", { className: "briefing__case" , text: "FIELD WORK" }),
        el("h2", { className: "briefing__title", text: "The Treasury's Two Keys" }),
      ]),
      el("hr", { className: "briefing__divider" }),
      el("div", { style: { display: "flex", gap: "16px", marginTop: "var(--space-2)" } }, [paletteEl, canvasEl]),
      instructionsEl,
    ],
  );

  const wrapper = el("div", { className: "ui-backdrop ds-root", style: { position: "absolute", inset: "0", pointerEvents: "auto", zIndex: "1000" } });
  wrapper.append(panelEl);
  document.getElementById("ui-root")!.appendChild(wrapper);

  function currentScale(): number {
    return Math.min(window.innerWidth / GAME_WIDTH, window.innerHeight / GAME_HEIGHT);
  }

  function setInstructions(text: string) {
    instructionsEl.textContent = text;
  }

  // --- Day/night indicator ------------------------------------------------
  const dayNightChipEl = el("div", { className: "chip", style: { position: "absolute", left: "10px", top: "10px", pointerEvents: "none" } });
  function renderDayNight() {
    dayNightChipEl.textContent = dayNight === "day" ? "☀ DAY" : "🌙 NIGHT";
    dayNightChipEl.style.background = dayNight === "day" ? "rgba(240, 180, 41, 0.18)" : "rgba(90, 100, 200, 0.28)";
    dayNightChipEl.style.borderColor = dayNight === "day" ? "var(--accent-gold)" : "#5a64c8";
  }

  // --- Watchman's Logbook panel --------------------------------------------
  const logListEl = el("div", { style: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "6px" } });
  const logPanelEl = el(
    "div",
    { className: "panel", style: { position: "absolute", right: "10px", top: "10px", width: "230px", pointerEvents: "auto", display: "none" } },
    [el("div", { text: "WATCHMAN'S LOGBOOK", style: { fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.06em", color: "var(--text-muted)" } }), logListEl],
  );
  function addLogLine(text: string) {
    logPanelEl.style.display = "block";
    const lineEl = el("div", { text, style: { fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-primary)", animation: "ds-levelup-flash 700ms ease-out" } });
    logListEl.appendChild(lineEl);
  }

  // --- Final dual-authorization panel --------------------------------------
  const finalPanelEl = el("div", {
    className: "panel",
    style: { position: "absolute", right: "10px", top: "170px", width: "230px", pointerEvents: "auto", display: "none", flexDirection: "column", gap: "8px" },
  });
  function renderFinalPanel() {
    const ready = treasuryKeysState.nightClerkStopped && treasuryKeysState.dayClerkAudited && countersignApplied;
    if (!ready) {
      finalPanelEl.style.display = "none";
      return;
    }
    if (!clerkAuthorized && !mayorAuthorized) {
      setInstructions("STEP 6 of 6 — Toggle CLERK AUTHORIZES and MAYOR AUTHORIZES, then click EMPTY THE LEDGER.");
    }
    finalPanelEl.style.display = "flex";
    finalPanelEl.innerHTML = "";
    finalPanelEl.append(
      el("div", { text: "SEPARATION OF DUTIES", style: { fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.06em", color: "var(--text-muted)" } }),
      el("div", { text: "Both must authorize together.", style: { fontSize: "12px", color: "var(--text-muted)" } }),
      el("button", {
        className: `btn ${clerkAuthorized ? "btn--gold" : "btn--ghost"}`,
        text: clerkAuthorized ? "✓ CLERK AUTHORIZES" : "CLERK AUTHORIZES",
        style: { width: "100%" },
        on: { click: () => toggleAuth("clerk") },
      }),
      el("button", {
        className: `btn ${mayorAuthorized ? "btn--gold" : "btn--ghost"}`,
        text: mayorAuthorized ? "✓ MAYOR AUTHORIZES" : "MAYOR AUTHORIZES",
        style: { width: "100%" },
        on: { click: () => toggleAuth("mayor") },
      }),
      el("button", {
        className: "btn btn--gold",
        text: "EMPTY THE LEDGER (AUTHORIZED)",
        attrs: clerkAuthorized && mayorAuthorized ? {} : { disabled: "true" },
        style: { width: "100%", opacity: clerkAuthorized && mayorAuthorized ? "1" : "0.4", pointerEvents: clerkAuthorized && mayorAuthorized ? "auto" : "none" },
        on: { click: () => runSeparationOfDuties() },
      }),
    );
  }

  function toggleAuth(who: "clerk" | "mayor") {
    if (who === "clerk") clerkAuthorized = !clerkAuthorized;
    else mayorAuthorized = !mayorAuthorized;
    highlightNode("clerk", clerkAuthorized);
    highlightNode("mayor_entity", mayorAuthorized);
    playSound("select");
    renderFinalPanel();
  }

  function runSeparationOfDuties() {
    if (!(clerkAuthorized && mayorAuthorized) || treasuryKeysState.separationUsed) return;
    treasuryKeysState.separationUsed = true;
    playSound("confirm");
    highlightNode("clerk", false);
    highlightNode("mayor_entity", false);
    finalPanelEl.style.display = "none";
    questEngine.toast("Two signatures, one vault. No single hand empties it alone.");
    setInstructions("");
    window.setTimeout(() => finishSequence(), 1200);
  }

  // --- Node rendering ----------------------------------------------------
  function nodeBox(pos: { x: number; y: number }) {
    return { left: pos.x - 65, top: pos.y - 35, width: 130, height: 70 };
  }

  function showNode(id: NodeId) {
    if (nodeEls.has(id)) return;
    const def = NODES[id];
    const box = nodeBox(def);
    const nodeEl = el(
      "div",
      {
        attrs: { "data-node": id },
        style: {
          position: "absolute",
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "2px",
          border: `2px solid ${def.color}`,
          borderRadius: "var(--radius)",
          background: "var(--bg-raised)",
          fontFamily: "var(--font-body)",
          fontSize: "12px",
          color: "var(--text-primary)",
          textAlign: "center",
          pointerEvents: "auto",
          opacity: "0",
          transition: "opacity 300ms ease-out",
        },
      },
      [el("span", { text: def.glyph, style: { fontSize: "18px", color: def.color } }), el("span", { text: def.label })],
    );
    nodesLayerEl.appendChild(nodeEl);
    nodeEls.set(id, nodeEl);
    requestAnimationFrame(() => (nodeEl.style.opacity = "1"));

    const badgeRow = el("div", {
      style: {
        position: "absolute",
        left: `${box.left}px`,
        top: `${box.top - 22}px`,
        width: `${box.width}px`,
        display: "flex",
        justifyContent: "center",
        gap: "3px",
        pointerEvents: "none",
      },
    });
    badgesLayerEl.appendChild(badgeRow);
    badgeRows.set(id, badgeRow);
  }

  function hideNode(id: NodeId, opts?: { keep?: boolean }) {
    const nodeEl = nodeEls.get(id);
    if (!nodeEl) return;
    if (opts?.keep) return;
    nodeEl.style.opacity = "0";
    window.setTimeout(() => nodeEl.remove(), 320);
    nodeEls.delete(id);
  }

  function highlightNode(id: NodeId, on: boolean) {
    const nodeEl = nodeEls.get(id);
    if (!nodeEl) return;
    nodeEl.style.boxShadow = on ? "0 0 0 3px var(--accent-gold)" : "";
  }

  const modifierBadgeEls = new Map<ModifierId, HTMLElement>();

  function addBadge(nodeId: NodeId, modifierId: ModifierId, glyph: string) {
    const row = badgeRows.get(nodeId);
    const badgeEl = el("span", { className: "chip", text: glyph, style: { fontSize: "13px", padding: "1px 5px" } });
    row?.appendChild(badgeEl);
    modifierBadgeEls.set(modifierId, badgeEl);
  }

  function setBadgeActive(modifierId: ModifierId, active: boolean) {
    const badgeEl = modifierBadgeEls.get(modifierId);
    if (!badgeEl) return;
    badgeEl.style.opacity = active ? "1" : "0.3";
    badgeEl.style.filter = active ? "none" : "grayscale(1)";
  }

  // --- Palette + drag-to-attach --------------------------------------------
  const paletteItemEls = new Map<ModifierId, HTMLElement>();

  function makePaletteItem(id: ModifierId): HTMLElement {
    const meta = MODIFIER_META[id];
    const itemEl = el(
      "div",
      { className: "drag-card", attrs: { title: meta.def }, style: { position: "static", width: "100%", fontSize: "12px", padding: "8px 6px" } },
      [el("div", { text: meta.glyph, style: { fontSize: "18px" } }), el("div", { text: meta.label, style: { fontSize: "10px", marginTop: "3px" } })],
    );
    itemEl.addEventListener("pointerdown", (e) => {
      if (itemEl.dataset.used === "true") return;
      e.preventDefault();
      startDrag(id, e.clientX, e.clientY);
    });
    paletteItemEls.set(id, itemEl);
    return itemEl;
  }

  function markUsed(id: ModifierId) {
    const itemEl = paletteItemEls.get(id);
    if (!itemEl) return;
    itemEl.dataset.used = "true";
    itemEl.style.opacity = "0.35";
    itemEl.style.cursor = "default";
  }

  let dragGhost: HTMLElement | null = null;
  let dragId: ModifierId | null = null;

  function startDrag(id: ModifierId, clientX: number, clientY: number) {
    dragId = id;
    const meta = MODIFIER_META[id];
    dragGhost = el(
      "div",
      { className: "drag-card", style: { width: "130px", fontSize: "12px", padding: "8px 6px", zIndex: "10", pointerEvents: "none" } },
      [el("div", { text: meta.glyph, style: { fontSize: "18px" } }), el("div", { text: meta.label, style: { fontSize: "10px", marginTop: "3px" } })],
    );
    panelEl.appendChild(dragGhost);
    moveGhost(clientX, clientY);

    const onMove = (e: PointerEvent) => moveGhost(e.clientX, e.clientY);
    const onUp = (e: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      endDrag(e.clientX, e.clientY);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function moveGhost(clientX: number, clientY: number) {
    if (!dragGhost) return;
    const rect = panelEl.getBoundingClientRect();
    const scale = currentScale();
    dragGhost.style.position = "absolute";
    dragGhost.style.left = `${(clientX - rect.left) / scale - 65}px`;
    dragGhost.style.top = `${(clientY - rect.top) / scale - 35}px`;
  }

  function targetNodeAt(clientX: number, clientY: number): "ledger" | "clerk" | null {
    const canvasRect = canvasEl.getBoundingClientRect();
    const scale = currentScale();
    const localX = (clientX - canvasRect.left) / scale;
    const localY = (clientY - canvasRect.top) / scale;
    for (const id of ["ledger", "clerk"] as const) {
      const box = nodeBox(NODES[id]);
      if (localX >= box.left && localX <= box.left + box.width && localY >= box.top && localY <= box.top + box.height) return id;
    }
    return null;
  }

  function endDrag(clientX: number, clientY: number) {
    const id = dragId;
    dragGhost?.remove();
    dragGhost = null;
    dragId = null;
    if (!id) return;
    if (paletteItemEls.get(id)?.dataset.used === "true") return;

    const target = targetNodeAt(clientX, clientY);
    if (!target) return;
    onModifierDrop(id, target);
  }

  function flashRed(target: HTMLElement) {
    target.style.animation = "none";
    void target.offsetWidth;
    target.style.animation = "ds-shake 400ms ease-in-out";
    window.setTimeout(() => (target.style.animation = ""), 400);
  }

  // --- Arrow + packet engine (trimmed copy of blueprintOverlay.ts's) ------
  function trimmed(x1: number, y1: number, x2: number, y2: number, pad: number) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    return { x1: x1 + ux * pad, y1: y1 + uy * pad, x2: x2 - ux * pad, y2: y2 - uy * pad };
  }

  function drawArrow(key: string, from: NodeId, to: NodeId, color: string) {
    removeArrow(key);
    const a = NODES[from];
    const b = NODES[to];
    const t = trimmed(a.x, a.y, b.x, b.y, 68);
    const dx = t.x2 - t.x1;
    const dy = t.y2 - t.y1;
    const length = Math.hypot(dx, dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const lineEl = el("div", {
      style: {
        position: "absolute",
        left: `${t.x1}px`,
        top: `${t.y1 - 1.5}px`,
        width: `${length}px`,
        height: "3px",
        background: color,
        transformOrigin: "0 50%",
        transform: `rotate(${angle}deg)`,
      },
    });
    const headEl = el("div", {
      style: {
        position: "absolute",
        left: `${t.x2}px`,
        top: `${t.y2}px`,
        width: "0",
        height: "0",
        borderTop: "6px solid transparent",
        borderBottom: "6px solid transparent",
        borderLeft: `10px solid ${color}`,
        transform: `translate(-2px, -6px) rotate(${angle}deg)`,
        transformOrigin: "2px 6px",
      },
    });
    arrowsLayerEl.append(lineEl, headEl);
    arrows.set(key, { lineEl, headEl });
  }

  function removeArrow(key: string) {
    const a = arrows.get(key);
    if (!a) return;
    a.lineEl.remove();
    a.headEl.remove();
    arrows.delete(key);
  }

  function makePacketEl(color: string): HTMLElement {
    return el("div", {
      style: {
        position: "absolute",
        width: "14px",
        height: "14px",
        borderRadius: "3px",
        background: color,
        border: "1px solid rgba(0,0,0,0.4)",
        pointerEvents: "none",
        zIndex: "5",
        opacity: "0",
      },
    });
  }

  function startFlow(key: string, from: NodeId, to: NodeId, color: string, intervalMs = 1200) {
    if (spawners.has(key)) return;
    const spawnOne = () => {
      const a = NODES[from];
      const b = NODES[to];
      const packetEl = makePacketEl(color);
      packetsLayerEl.appendChild(packetEl);
      packets.push({ el: packetEl, fromX: a.x - 7, fromY: a.y - 7, toX: b.x - 7, toY: b.y - 7, startTime: performance.now(), durationMs: 1200, color });
    };
    spawnOne();
    const intervalId = window.setInterval(spawnOne, intervalMs);
    spawners.set(key, intervalId);
    if (!packetRaf) packetRaf = requestAnimationFrame(packetTick);
  }

  function stopFlow(key: string) {
    const intervalId = spawners.get(key);
    if (intervalId === undefined) return;
    window.clearInterval(intervalId);
    spawners.delete(key);
  }

  /** One-shot flight, no repeat spawner — used for the bandit's single
   * charge and the audit packet to the logbook. */
  function flyOnce(from: NodeId, to: NodeId, color: string, durationMs: number, onArrive?: () => void) {
    const a = NODES[from];
    const b = NODES[to];
    const packetEl = makePacketEl(color);
    packetsLayerEl.appendChild(packetEl);
    packets.push({ el: packetEl, fromX: a.x - 7, fromY: a.y - 7, toX: b.x - 7, toY: b.y - 7, startTime: performance.now(), durationMs, color, onArrive });
    if (!packetRaf) packetRaf = requestAnimationFrame(packetTick);
  }

  function packetTick(now: number) {
    for (const p of packets) {
      const t = Math.min(1, (now - p.startTime) / p.durationMs);
      const x = p.fromX + (p.toX - p.fromX) * t;
      const y = p.fromY + (p.toY - p.fromY) * t;
      p.el.style.left = `${x}px`;
      p.el.style.top = `${y}px`;
      p.el.style.opacity = t < 0.12 ? String(t / 0.12) : t > 0.88 ? String((1 - t) / 0.12) : "1";
    }
    const arrived = packets.filter((p) => (now - p.startTime) / p.durationMs >= 1);
    if (arrived.length) {
      for (const p of arrived) {
        p.el.remove();
        p.onArrive?.();
      }
      packets = packets.filter((p) => !arrived.includes(p));
    }
    packetRaf = requestAnimationFrame(packetTick);
  }

  function stopAllFlows() {
    for (const key of [...spawners.keys()]) stopFlow(key);
    if (packetRaf) cancelAnimationFrame(packetRaf);
    packetRaf = null;
    for (const p of packets) p.el.remove();
    packets = [];
  }

  // --- Modifier drop handling ----------------------------------------------
  function onModifierDrop(id: ModifierId, target: "ledger" | "clerk") {
    const meta = MODIFIER_META[id];

    // The defense-in-depth trap: an organizational rule with no
    // technical barrier behind it is theater, not security — reject the
    // Countersign outright until both the Vault and the Key are real.
    if (id === "countersign" && (!vaulted || !keyed)) {
      treasuryKeysState.resetCount++;
      treasuryKeysState.brokeDefenseInDepth = true;
      playSound("select");
      questEngine.toast("The Mayor and Clerk stand before an UNLOCKED door, countersigning nothing. The Bandit strolls past them both.");
      const ledgerEl = nodeEls.get("ledger");
      if (ledgerEl) flashRed(ledgerEl);
      return;
    }

    if (target !== meta.target) {
      treasuryKeysState.resetCount++;
      playSound("select");
      questEngine.toast(WRONG_TARGET_MESSAGES[id]);
      const targetEl = nodeEls.get(target);
      if (targetEl) flashRed(targetEl);
      return;
    }

    switch (id) {
      case "vault":
        applyVault();
        break;
      case "key":
        applyKey();
        break;
      case "roster":
        applyRoster();
        break;
      case "logbook":
        applyLogbook();
        break;
      case "countersign":
        applyCountersign();
        break;
    }
  }

  // --- Round 1: the Bandit (technical stops the outsider) ------------------
  function applyVault() {
    if (vaulted) return;
    vaulted = true;
    playSound("chime");
    addBadge("ledger", "vault", "🔒");
    markUsed("vault");
    runBanditTest();
  }

  function runBanditTest() {
    showNode("bandit");
    window.setTimeout(() => {
      playSound("alarm-bell");
      drawArrow("bandit->ledger", "bandit", "ledger", "var(--accent-red)");
      arrows.get("bandit->ledger")!.lineEl.style.animation = "ds-levelup-flash 400ms ease-in-out 2";
      flyOnce("bandit", "ledger", "var(--accent-red)", 700, () => {
        playSound("select");
        removeArrow("bandit->ledger");
        treasuryKeysState.banditStopped = true;
        questEngine.toast("External threat stopped. A lock keeps out those with no right to be here.");
        hideNode("bandit");
        if (!keyed) setInstructions("STEP 2 of 6 — Drag BRASS KEY onto the Clerk so the Treasury still works by day.");
        maybeAdvanceToNight();
      });
    }, 500);
  }

  // --- Round 1b: granting the Clerk legitimate access -----------------------
  function applyKey() {
    if (keyed) return;
    keyed = true;
    playSound("chime");
    addBadge("clerk", "key", "🔑");
    markUsed("key");
    questEngine.toast("Access granted — the Clerk's key opens the vault. Works... in daytime.");
    refreshClerkAccessFlow();
    maybeAdvanceToNight();
  }

  function refreshClerkAccessFlow() {
    if (vaulted && keyed && dayNight === "day") startFlow("clerk->ledger", "clerk", "ledger", "rgba(240, 180, 41, 0.8)", 1400);
    else stopFlow("clerk->ledger");
  }

  // --- Round 2: the night insider (organizational stops the trusted) -------
  function maybeAdvanceToNight() {
    if (!(vaulted && keyed) || nightTriggered) return;
    nightTriggered = true;
    setInstructions("STEP 3 of 6 — Night is coming. Drag SHIFT ROSTER onto the Clerk now, or watch what happens if you don't.");
    window.setTimeout(() => enterNight(), 2400);
  }

  function enterNight() {
    dayNight = "night";
    renderDayNight();
    stopFlow("clerk->ledger");

    if (rosterApplied) {
      resolveNightSuccess(true);
      return;
    }

    playSound("alarm-bell");
    showNode("megamart");
    drawArrow("clerk->megamart", "clerk", "megamart", "var(--accent-red)");
    arrows.get("clerk->megamart")!.lineEl.style.animation = "ds-levelup-flash 900ms ease-in-out infinite";
    startFlow("clerk->megamart", "clerk", "megamart", "var(--accent-red)", 900);
    questEngine.toast(
      "HERALD — Your lock worked perfectly. It let in exactly who you told it to — at midnight. A key with no rule is a key with no conscience.",
    );
    setInstructions("STEP 3 of 6 — Drag SHIFT ROSTER onto the Clerk to stop the key from working at night.");
  }

  function applyRoster() {
    if (rosterApplied) return;
    rosterApplied = true;
    playSound("chime");
    addBadge("clerk", "roster", "🕒");
    markUsed("roster");
    if (dayNight === "night" && !treasuryKeysState.nightClerkStopped) resolveNightSuccess(false);
  }

  function resolveNightSuccess(preEmptive: boolean) {
    if (treasuryKeysState.nightClerkStopped) return;
    treasuryKeysState.nightClerkStopped = true;
    if (!preEmptive) treasuryKeysState.resetCount++;
    stopFlow("clerk->megamart");
    removeArrow("clerk->megamart");
    hideNode("megamart");
    setBadgeActive("key", false);
    const ledgerEl = nodeEls.get("ledger");
    if (ledgerEl) flashRed(ledgerEl);
    questEngine.toast("An ORGANIZATIONAL rule — the key works only 8-to-5. The lock didn't change. The RULE did.");
    setInstructions("STEP 4 of 6 — Night secured. Watch for what happens next, during the day.");
    window.setTimeout(() => enterDay(), 2200);
  }

  // --- Round 3: the day insider (only accountability reaches him) ----------
  function enterDay() {
    dayNight = "day";
    renderDayNight();
    setBadgeActive("key", true);
    refreshClerkAccessFlow();
    if (!dayTestTriggered) {
      dayTestTriggered = true;
      window.setTimeout(() => runDaySnoopEvent(), 1800);
    }
  }

  function runDaySnoopEvent() {
    dayTestPending = true;
    questEngine.toast(
      "HERALD — This one has every right to open the vault — at the right hour, with the right key. No barrier will stop him. So we do the other thing: we make sure he's SEEN.",
    );
    setInstructions("STEP 4 of 6 — Drag WATCHMAN'S LOGBOOK onto the Ledger to log this access.");
    if (logbookApplied) resolveDaySuccess(true);
  }

  function applyLogbook() {
    if (logbookApplied) return;
    logbookApplied = true;
    playSound("chime");
    addBadge("ledger", "logbook", "📖");
    markUsed("logbook");
    if (dayTestPending && !treasuryKeysState.dayClerkAudited) resolveDaySuccess(false);
  }

  function resolveDaySuccess(preEmptive: boolean) {
    if (treasuryKeysState.dayClerkAudited) return;
    treasuryKeysState.dayClerkAudited = true;
    if (!preEmptive) treasuryKeysState.resetCount++;
    const stamp = "14:12";
    flyOnce("clerk", "ledger", "var(--accent-gold)", 600, () => {
      addLogLine(`${stamp} — Junior Clerk — ACCESSED LEDGER (unauthorized purpose)`);
      playSound("chime");
    });
    questEngine.toast("You can't always prevent. You can always ACCOUNT. Audit logging is how trust survives access.");
    setInstructions("STEP 5 of 6 — Drag MAYOR'S COUNTERSIGN onto the Ledger to require two-person authorization.");
    renderFinalPanel();
  }

  // --- Final: separation of duties ------------------------------------------
  function applyCountersign() {
    if (countersignApplied) return;
    countersignApplied = true;
    playSound("chime");
    addBadge("ledger", "countersign", "✍️");
    markUsed("countersign");
    showNode("mayor_entity");
    questEngine.toast("MAYOR — Coin isn't the issue anymore, Agent. Make it so no ONE person can empty this vault alone.");
    renderFinalPanel();
  }

  // --- Completion -------------------------------------------------------
  function finishSequence() {
    if (finished) return;
    finished = true;
    questEngine.toast("MAYOR — So the lock was the easy half. I bought iron when I needed... rules. And a logbook. Fine. FINE. Well done, Agent.");
    window.setTimeout(() => {
      questEngine.toast(
        "HERALD — Technical measures stop the outsider. Organizational measures stop the insider. Neither alone is security — they interlock, or they fail. Write that on the Town Hall door.",
      );
    }, 1400);
    window.setTimeout(() => finish(), 3200);
  }

  function finish() {
    stopAllFlows();
    teardown();
    onClose(true);
  }

  // --- Palette + initial render --------------------------------------------
  paletteEl.append(
    el("div", { text: "TECHNICAL", style: { fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.08em", color: "var(--accent-blue)" } }),
    makePaletteItem("vault"),
    makePaletteItem("key"),
    el("div", { text: "ORGANIZATIONAL", style: { fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.08em", color: "var(--accent-gold)", marginTop: "6px" } }),
    makePaletteItem("roster"),
    makePaletteItem("logbook"),
    makePaletteItem("countersign"),
  );
  hudLayerEl.append(dayNightChipEl);
  canvasEl.append(logPanelEl, finalPanelEl);
  for (const id of ALWAYS_ON) showNode(id);
  renderDayNight();
  setInstructions("STEP 1 of 6 — Drag IRON VAULT onto the Ledger to stop the Bandit outside.");

  // --- Teardown -----------------------------------------------------------
  function teardown() {
    openCount--;
    document.removeEventListener("keydown", onKeydown);
    wrapper.remove();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      stopAllFlows();
      teardown();
      onClose(false);
    }
  }
  document.addEventListener("keydown", onKeydown);
}
