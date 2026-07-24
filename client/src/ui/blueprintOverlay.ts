import { el } from "./dom";
import { GAME_WIDTH, GAME_HEIGHT } from "../config";
import { playSound } from "../audio";
import { questEngine } from "../questEngine";
import { postRoadBuilderState, resetPostRoadBuilderState } from "../postRoadBuilderState";

// "The Blueprint of the Post Road" — Phases 2-4 in one continuous
// full-screen DOM overlay/state machine (see the quest spec: guided DFD
// builder, NOT a free-form diagram editor — nodes only ever go into the
// 5 fixed ghost slots below, arrows are click-source-then-target between
// already-filled slots). Same #ui-root/ui-backdrop pattern as
// ledgerSortOverlay.ts/ledgerLockOverlay.ts; the drag-to-place mechanic
// reuses that file's scale-aware Pointer Events technique, generalized
// to a reusable (non-consumed) palette instead of a one-shot tray.

type NodeType = "entity" | "process" | "store";
type PacketState = "plaintext" | "contents-sealed" | "fully-sealed";

type Stage = "placing" | "arrows" | "watching" | "breach" | "cipher_intro" | "cipher_arrows" | "cipher_toggle" | "final";

interface SlotDef {
  id: string;
  label: string | null; // null = the Phase 2 "?" ghost slot, labeled once Phase 4 activates it
  type: NodeType;
  x: number;
  y: number;
}

// Canvas-local (not game-space) coordinates — see canvasEl below.
const SLOTS: SlotDef[] = [
  { id: "villagers", label: "Villagers", type: "entity", x: 100, y: 300 },
  { id: "sorting_desk", label: "Sorting Desk", type: "process", x: 380, y: 300 },
  { id: "vault", label: "Overnight Vault", type: "store", x: 660, y: 300 },
  { id: "couriers", label: "Couriers", type: "entity", x: 900, y: 300 },
  { id: "cipher_desk", label: null, type: "process", x: 240, y: 110 },
];
const BANDIT_X = 380;
const BANDIT_Y = 480;

const NODE_GLYPH: Record<NodeType, string> = { entity: "▭", process: "◯", store: "═" };
const NODE_TYPE_LABEL: Record<NodeType, string> = { entity: "EXTERNAL ENTITY", process: "PROCESS", store: "DATA STORE" };
const NODE_DEF_TEXT: Record<NodeType, string> = {
  entity: "Someone outside the system who sends or receives.",
  process: "Something that acts on data.",
  store: "Somewhere data rests.",
};
const NODE_COLOR: Record<NodeType, string> = { entity: "var(--accent-blue)", process: "var(--accent-gold)", store: "var(--accent-green)" };

const REQUIRED_SLOT_IDS = ["villagers", "sorting_desk", "vault", "couriers"];
const PHASE2_ARROWS: [string, string][] = [
  ["villagers", "sorting_desk"],
  ["sorting_desk", "vault"],
  ["vault", "couriers"],
];
const PHASE4_ARROWS: [string, string][] = [
  ["villagers", "cipher_desk"],
  ["cipher_desk", "sorting_desk"],
];

const WRONG_SLOT_MESSAGES: Record<string, Partial<Record<NodeType, string>>> = {
  villagers: {
    process: "Villagers don't act on the data — they're outside the system looking in.",
    store: "Villagers aren't where data rests — they're outside the system, sending it in.",
  },
  sorting_desk: {
    entity: "The sorting desk isn't a person outside the system — it's what acts on the mail.",
    store: "The desk doesn't hold anything overnight — it just processes what passes through.",
  },
  vault: {
    entity: "The vault isn't someone outside the system — it's where the bundles rest till dawn.",
    process: "The vault doesn't act on anything — it just holds it overnight.",
  },
  couriers: {
    process: "Couriers don't act on the mail's contents — they just carry it onward.",
    store: "Couriers aren't where anything rests — they're already moving it onward.",
  },
  cipher_desk: {
    entity: "The Cipher Desk isn't outside the system — it does the sealing.",
    store: "The Cipher Desk doesn't hold anything — it transforms what passes through.",
  },
};

const WRONG_ARROW_MESSAGES: Record<string, string> = {
  "villagers->couriers": "Your notes say couriers draw from the VAULT, not the desk.",
  "villagers->vault": "Your notes say the desk sorts by region first — nothing reaches the vault before that.",
  "sorting_desk->couriers": "Your notes say couriers draw from the VAULT, not the desk.",
  "vault->sorting_desk": "The desk doesn't reach back into the vault — the vault holds what the desk already sorted.",
  "couriers->villagers": "Couriers are the end of this road, not the start.",
  "couriers->sorting_desk": "Couriers draw from the vault — they never send anything back to the desk.",
  "couriers->vault": "Couriers take from the vault. Nothing flows back into it.",
  "sorting_desk->villagers": "Nothing flows back to the villagers from the desk.",
  "vault->villagers": "Nothing flows back to the villagers from the vault.",
  "villagers->sorting_desk:phase4": "Route them through the cipher first.",
};
const WRONG_ARROW_FALLBACK = "That's not how the mail moves — check your notes.";

const MAX_PACKETS = 12;
const PACKET_SPAWN_MS = 1200;
const PACKET_DURATION_MS = 1500;

let openCount = 0;

export function isBlueprintOverlayOpen(): boolean {
  return openCount > 0;
}

/** Opens the Phase 2-4 builder. `onClose(completed)` fires exactly once
 * — `true` only once the whole blueprint (including the Phase 4 access
 * choice) is finished, `false` on an early Escape. Every open starts a
 * fresh attempt (slots/arrows/state all reset) — same "no partial
 * resume" simplification ledgerSortOverlay.ts already established for
 * this project's other full-screen minigames. */
export function openBlueprintOverlay(onClose: (completed: boolean) => void) {
  openCount++;
  resetPostRoadBuilderState();

  let stage: Stage = "placing";
  const filled = new Map<string, NodeType>(); // slotId -> placed type
  const nodeEls = new Map<string, HTMLElement>(); // slotId -> placed node element
  const arrows: { from: string; to: string; lineEl: HTMLElement; headEl: HTMLElement }[] = [];
  const spawners = new Map<string, { intervalId: number; onArrive?: () => void }>();
  let packets: { el: HTMLElement; fromX: number; fromY: number; toX: number; toY: number; startTime: number; onArrive?: () => void }[] = [];
  let packetRaf: number | null = null;
  let selectedSource: string | null = null;
  let banditVisible = false;
  let sealMode: "sealContents" | "sealEverything" | null = null;
  let pileUpCount = 0;
  let breachStartTime = 0;

  // --- Shell -------------------------------------------------------
  const instructionsEl = el("div", {
    style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", textAlign: "center", marginTop: "8px", minHeight: "16px" },
  });
  const paletteEl = el("div", { style: { display: "flex", flexDirection: "column", gap: "10px", width: "170px", flex: "none" } });
  const slotsLayerEl = el("div", { style: { position: "absolute", inset: "0" } });
  const arrowsLayerEl = el("div", { style: { position: "absolute", inset: "0" } });
  const nodesLayerEl = el("div", { style: { position: "absolute", inset: "0" } });
  const packetsLayerEl = el("div", { style: { position: "absolute", inset: "0" } });
  const canvasEl = el("div", { style: { position: "relative", flex: "1", height: "560px", background: "rgba(0,0,0,0.15)", borderRadius: "var(--radius)", border: "1px solid var(--border-strong)" } }, [
    slotsLayerEl,
    arrowsLayerEl,
    nodesLayerEl,
    packetsLayerEl,
  ]);

  const panelEl = el(
    "div",
    {
      className: "panel panel--glow ds-root",
      style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "1180px", pointerEvents: "auto" },
    },
    [
      el("div", { className: "briefing__header" }, [
        el("span", { className: "briefing__case", text: "FIELD WORK" }),
        el("h2", { className: "briefing__title", text: "The Blueprint of the Post Road" }),
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

  // --- Slot ghosts ---------------------------------------------------
  function slotBox(def: SlotDef): { left: number; top: number; width: number; height: number } {
    return { left: def.x - 65, top: def.y - 35, width: 130, height: 70 };
  }

  function renderSlots() {
    slotsLayerEl.innerHTML = "";
    for (const def of SLOTS) {
      if (filled.has(def.id)) continue; // filled slots render as nodes instead, see renderNode()
      const box = slotBox(def);
      const active = def.id !== "cipher_desk" || stage === "cipher_intro" || stage === "cipher_arrows" || stage === "cipher_toggle" || stage === "final";
      const isCipher = def.id === "cipher_desk";
      slotsLayerEl.appendChild(
        el("div", {
          className: "drop-zone",
          text: isCipher && !active ? "?" : (def.label ?? "?"),
          attrs: { "data-slot": def.id },
          style: {
            position: "absolute",
            left: `${box.left}px`,
            top: `${box.top}px`,
            width: `${box.width}px`,
            height: `${box.height}px`,
            borderStyle: isCipher && !active ? "dashed" : "solid",
            opacity: isCipher && !active ? "0.5" : "1",
            fontSize: isCipher && !active ? "22px" : "13px",
          },
        }),
      );
    }
  }

  // --- Placed nodes ----------------------------------------------------
  function renderNode(slotId: string) {
    const def = SLOTS.find((s) => s.id === slotId)!;
    const type = filled.get(slotId)!;
    const box = slotBox(def);
    const label = def.label ?? "Cipher Desk";
    const nodeEl = el(
      "div",
      {
        attrs: { "data-node": slotId },
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
          border: `2px solid ${NODE_COLOR[type]}`,
          borderRadius: "var(--radius)",
          background: "var(--bg-raised)",
          fontFamily: "var(--font-body)",
          fontSize: "12px",
          color: "var(--text-primary)",
          textAlign: "center",
          cursor: "default",
        },
      },
      [
        el("span", { text: NODE_GLYPH[type], style: { fontSize: "18px", color: NODE_COLOR[type] } }),
        el("span", { text: label }),
      ],
    );
    nodeEl.addEventListener("click", () => onNodeClick(slotId));
    nodesLayerEl.appendChild(nodeEl);
    nodeEls.set(slotId, nodeEl);
  }

  function highlightNode(slotId: string, on: boolean) {
    const nodeEl = nodeEls.get(slotId);
    if (!nodeEl) return;
    nodeEl.style.boxShadow = on ? "0 0 0 3px var(--accent-gold)" : "";
  }

  // --- Palette + drag-to-place ------------------------------------------
  function makePaletteItem(type: NodeType): HTMLElement {
    const itemEl = el(
      "div",
      {
        className: "drag-card",
        attrs: { title: NODE_DEF_TEXT[type] },
        style: { position: "static", width: "100%", fontSize: "13px", padding: "10px 6px" },
      },
      [
        el("div", { text: NODE_GLYPH[type], style: { fontSize: "20px" } }),
        el("div", { text: NODE_TYPE_LABEL[type], style: { fontSize: "11px", marginTop: "4px" } }),
      ],
    );

    itemEl.addEventListener("pointerdown", (e) => {
      if (stage !== "placing" && stage !== "cipher_intro") return;
      e.preventDefault();
      startDrag(type, e.clientX, e.clientY, e.pointerId);
    });
    return itemEl;
  }

  let dragGhost: HTMLElement | null = null;
  let dragType: NodeType | null = null;

  function startDrag(type: NodeType, clientX: number, clientY: number, pointerId: number) {
    dragType = type;
    dragGhost = el(
      "div",
      { className: "drag-card", style: { width: "130px", fontSize: "13px", padding: "10px 6px", zIndex: "10", pointerEvents: "none" } },
      [el("div", { text: NODE_GLYPH[type], style: { fontSize: "20px" } }), el("div", { text: NODE_TYPE_LABEL[type], style: { fontSize: "11px", marginTop: "4px" } })],
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
    void pointerId;
  }

  function moveGhost(clientX: number, clientY: number) {
    if (!dragGhost) return;
    const rect = panelEl.getBoundingClientRect();
    const scale = currentScale();
    dragGhost.style.position = "absolute";
    dragGhost.style.left = `${(clientX - rect.left) / scale - 65}px`;
    dragGhost.style.top = `${(clientY - rect.top) / scale - 35}px`;
  }

  function slotAt(clientX: number, clientY: number): SlotDef | null {
    const canvasRect = canvasEl.getBoundingClientRect();
    const scale = currentScale();
    const localX = (clientX - canvasRect.left) / scale;
    const localY = (clientY - canvasRect.top) / scale;
    for (const def of SLOTS) {
      const box = slotBox(def);
      if (localX >= box.left && localX <= box.left + box.width && localY >= box.top && localY <= box.top + box.height) return def;
    }
    return null;
  }

  function endDrag(clientX: number, clientY: number) {
    const type = dragType;
    dragGhost?.remove();
    dragGhost = null;
    dragType = null;
    if (!type) return;

    const slot = slotAt(clientX, clientY);
    if (!slot) return;
    if (filled.has(slot.id)) return; // already placed, ignore
    if (slot.id === "cipher_desk" && stage !== "cipher_intro") return; // not active yet

    if (slot.type === type) {
      playSound("chime");
      filled.set(slot.id, type);
      renderSlots();
      renderNode(slot.id);
      onSlotFilled(slot.id);
    } else {
      postRoadBuilderState.slotErrors++;
      const msg = WRONG_SLOT_MESSAGES[slot.id]?.[type] ?? "That's not the right kind of node for this slot.";
      questEngine.toast(msg);
      const box = slotBox(slot);
      const zoneEl = slotsLayerEl.querySelector(`[data-slot="${slot.id}"]`) as HTMLElement | null;
      if (zoneEl) flashRed(zoneEl);
      void box;
    }
  }

  function flashRed(target: HTMLElement) {
    target.style.animation = "none";
    void target.offsetWidth;
    target.style.animation = "ds-shake 400ms ease-in-out";
    window.setTimeout(() => (target.style.animation = ""), 400);
  }

  function onSlotFilled(_slotId: string) {
    if (stage === "placing" && REQUIRED_SLOT_IDS.every((id) => filled.has(id))) {
      enterArrowsStage();
    } else if (stage === "cipher_intro" && filled.has("cipher_desk")) {
      enterCipherArrowsStage();
    }
  }

  // --- Arrow drawing ----------------------------------------------------
  function arrowKey(from: string, to: string): string {
    return `${from}->${to}`;
  }

  function onNodeClick(slotId: string) {
    if (stage !== "arrows" && stage !== "cipher_arrows") return;
    if (selectedSource === null) {
      selectedSource = slotId;
      highlightNode(slotId, true);
      return;
    }
    if (selectedSource === slotId) {
      highlightNode(slotId, false);
      selectedSource = null;
      return;
    }
    const from = selectedSource;
    const to = slotId;
    highlightNode(from, false);
    selectedSource = null;
    attemptArrow(from, to);
  }

  function attemptArrow(from: string, to: string) {
    const key = arrowKey(from, to);
    if (arrows.some((a) => a.from === from && a.to === to)) return; // already drawn, no-op

    if (stage === "arrows") {
      const isRequired = PHASE2_ARROWS.some(([f, t]) => f === from && t === to);
      if (isRequired) {
        confirmArrow(from, to, "plaintext");
        if (PHASE2_ARROWS.every(([f, t]) => arrows.some((a) => a.from === f && a.to === t))) enterWatchingStage();
        return;
      }
      rejectArrow(from, to, WRONG_ARROW_MESSAGES[key] ?? WRONG_ARROW_FALLBACK);
      return;
    }

    // cipher_arrows stage
    if (from === "villagers" && to === "sorting_desk") {
      rejectArrow(from, to, WRONG_ARROW_MESSAGES["villagers->sorting_desk:phase4"]);
      return;
    }
    const isRequired4 = PHASE4_ARROWS.some(([f, t]) => f === from && t === to);
    if (isRequired4) {
      confirmArrow(from, to, "contents-sealed");
      if (PHASE4_ARROWS.every(([f, t]) => arrows.some((a) => a.from === f && a.to === t))) {
        removeArrowVisual("villagers", "sorting_desk");
        stopArrowFlow("villagers", "sorting_desk");
        enterCipherToggleStage();
      }
      return;
    }
    rejectArrow(from, to, WRONG_ARROW_MESSAGES[key] ?? WRONG_ARROW_FALLBACK);
  }

  function rejectArrow(from: string, to: string, message: string) {
    postRoadBuilderState.arrowErrors++;
    questEngine.toast(message);
    const nodeEl = nodeEls.get(from);
    if (nodeEl) flashRed(nodeEl);
    const targetEl = nodeEls.get(to);
    if (targetEl) flashRed(targetEl);
  }

  function trimmed(x1: number, y1: number, x2: number, y2: number, pad: number) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    return { x1: x1 + ux * pad, y1: y1 + uy * pad, x2: x2 - ux * pad, y2: y2 - uy * pad };
  }

  function drawArrowVisual(from: string, to: string, color: string, clickable: boolean, onClick?: () => void): { lineEl: HTMLElement; headEl: HTMLElement } {
    const fromDef = from === "bandit_camp" ? { x: BANDIT_X, y: BANDIT_Y } : SLOTS.find((s) => s.id === from)!;
    const toDef = to === "bandit_camp" ? { x: BANDIT_X, y: BANDIT_Y } : SLOTS.find((s) => s.id === to)!;
    const t = trimmed(fromDef.x, fromDef.y, toDef.x, toDef.y, 68);
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
        pointerEvents: clickable ? "auto" : "none",
        cursor: clickable
          ? `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" font-size="22"><text y="20">%E2%9C%82%EF%B8%8F</text></svg>') 14 14, pointer`
          : "default",
      },
    });
    if (onClick) lineEl.addEventListener("click", onClick);

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
        pointerEvents: "none",
      },
    });

    arrowsLayerEl.append(lineEl, headEl);
    return { lineEl, headEl };
  }

  function confirmArrow(from: string, to: string, packetState: PacketState) {
    playSound("chime");
    const { lineEl, headEl } = drawArrowVisual(from, to, "rgba(240, 180, 41, 0.8)", false);
    arrows.push({ from, to, lineEl, headEl });
    startArrowFlow(from, to, packetState);
  }

  function removeArrowVisual(from: string, to: string) {
    const idx = arrows.findIndex((a) => a.from === from && a.to === to);
    if (idx === -1) return;
    arrows[idx].lineEl.remove();
    arrows[idx].headEl.remove();
    arrows.splice(idx, 1);
  }

  // --- Packet animation engine -------------------------------------------
  function makePacketEl(state: PacketState): HTMLElement {
    const bodyColor = state === "plaintext" ? "#c8a86b" : "#6b7280";
    const addrColor = state === "fully-sealed" ? "#6b7280" : "#e8dcc0";
    return el(
      "div",
      { style: { position: "absolute", width: "24px", height: "18px", pointerEvents: "none", zIndex: "5", opacity: "0" } },
      [
        el("div", { style: { width: "100%", height: "40%", background: addrColor, border: "1px solid #3d2b1f", borderRadius: "2px 2px 0 0" } }),
        el(
          "div",
          {
            text: state === "plaintext" ? "" : "🔒",
            style: {
              width: "100%",
              height: "60%",
              background: bodyColor,
              border: "1px solid #3d2b1f",
              borderTop: "none",
              borderRadius: "0 0 2px 2px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "8px",
              lineHeight: "1",
            },
          },
        ),
      ],
    );
  }

  function nodeCenter(id: string): { x: number; y: number } {
    if (id === "bandit_camp") return { x: BANDIT_X, y: BANDIT_Y };
    const def = SLOTS.find((s) => s.id === id)!;
    return { x: def.x, y: def.y };
  }

  function startArrowFlow(from: string, to: string, state: PacketState, opts?: { onArrive?: () => void }) {
    const key = arrowKey(from, to);
    if (spawners.has(key)) return;
    const spawnOne = () => {
      if (packets.length >= MAX_PACKETS) return;
      const a = nodeCenter(from);
      const b = nodeCenter(to);
      const packetEl = makePacketEl(state);
      packetsLayerEl.appendChild(packetEl);
      packets.push({ el: packetEl, fromX: a.x - 12, fromY: a.y - 9, toX: b.x - 12, toY: b.y - 9, startTime: performance.now(), onArrive: opts?.onArrive });
    };
    spawnOne();
    const intervalId = window.setInterval(spawnOne, PACKET_SPAWN_MS);
    spawners.set(key, { intervalId, onArrive: opts?.onArrive });
    if (!packetRaf) packetRaf = requestAnimationFrame(packetTick);
  }

  function stopArrowFlow(from: string, to: string) {
    const key = arrowKey(from, to);
    const spawner = spawners.get(key);
    if (!spawner) return;
    window.clearInterval(spawner.intervalId);
    spawners.delete(key);
  }

  function packetTick(now: number) {
    for (const p of packets) {
      const t = Math.min(1, (now - p.startTime) / PACKET_DURATION_MS);
      const x = p.fromX + (p.toX - p.fromX) * t;
      const y = p.fromY + (p.toY - p.fromY) * t;
      p.el.style.left = `${x}px`;
      p.el.style.top = `${y}px`;
      p.el.style.opacity = t < 0.12 ? String(t / 0.12) : t > 0.88 ? String((1 - t) / 0.12) : "1";
    }
    const arrived = packets.filter((p) => (now - p.startTime) / PACKET_DURATION_MS >= 1);
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
    for (const key of [...spawners.keys()]) window.clearInterval(spawners.get(key)!.intervalId);
    spawners.clear();
    if (packetRaf) cancelAnimationFrame(packetRaf);
    packetRaf = null;
    for (const p of packets) p.el.remove();
    packets = [];
  }

  // --- Stage transitions --------------------------------------------------
  function enterArrowsStage() {
    stage = "arrows";
    setInstructions("Click a node, then its destination, to connect the flow: Villagers → Sorting Desk → Vault → Couriers.");
  }

  function enterWatchingStage() {
    stage = "watching";
    setInstructions("Watching the road run...");
    window.setTimeout(() => enterBreachStage(), 3000);
  }

  function enterBreachStage() {
    stage = "breach";
    breachStartTime = performance.now();
    banditVisible = true;
    playSound("alarm-bell");
    const banditEl = el(
      "div",
      {
        style: {
          position: "absolute",
          left: `${BANDIT_X - 65}px`,
          top: `${BANDIT_Y - 35}px`,
          width: "130px",
          height: "70px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "2px",
          border: "2px solid var(--accent-red)",
          borderRadius: "var(--radius)",
          background: "rgba(239, 71, 111, 0.12)",
          fontFamily: "var(--font-body)",
          fontSize: "12px",
          color: "var(--text-primary)",
          textAlign: "center",
          animation: "ds-levelup-flash 600ms ease-out",
        },
      },
      [el("span", { text: "▭", style: { fontSize: "18px", color: "var(--accent-red)" } }), el("span", { text: "BANDIT CAMP" })],
    );
    banditEl.setAttribute("data-node", "bandit_camp");
    nodesLayerEl.appendChild(banditEl);
    nodeEls.set("bandit_camp", banditEl);

    const { lineEl, headEl } = drawArrowVisual("sorting_desk", "bandit_camp", "var(--accent-red)", true, () => onRogueArrowClicked());
    lineEl.style.animation = "ds-levelup-flash 900ms ease-in-out infinite";
    arrows.push({ from: "sorting_desk", to: "bandit_camp", lineEl, headEl });
    startArrowFlow("sorting_desk", "bandit_camp", "plaintext");

    questEngine.toast(
      "HERALD — There it is. The map they drew, and the map they run. Someone at the desk copies what passes through — and the bandits read every word. In the Division's terms, Ranger: INFORMATION DISCLOSURE.",
    );
    window.setTimeout(() => {
      questEngine.toast("BRAM — Someone at my own desk. And here I thought a lock on the vault door made me safe.");
    }, 1400);
    setInstructions("Click the rogue arrow to cut it.");
  }

  function onRogueArrowClicked() {
    if (stage !== "breach") return;
    postRoadBuilderState.rogueArrowFoundSeconds = Math.round((performance.now() - breachStartTime) / 100) / 10;
    playSound("select");
    stopArrowFlow("sorting_desk", "bandit_camp");
    removeArrowVisual("sorting_desk", "bandit_camp");
    nodeEls.get("bandit_camp")?.remove();
    nodeEls.delete("bandit_camp");
    banditVisible = false;
    enterCipherIntroStage();
  }

  function enterCipherIntroStage() {
    stage = "cipher_intro";
    questEngine.toast("HERALD — You patched the leak. Now assume the next one you won't see. A hostile road is the only road there is.");
    renderSlots();
    setInstructions('Drag a ◯ PROCESS node onto the "?" slot to open the Cipher Desk.');
  }

  function enterCipherArrowsStage() {
    stage = "cipher_arrows";
    setInstructions("Rewire the flow: Villagers → Cipher Desk → Sorting Desk.");
  }

  function enterCipherToggleStage() {
    stage = "cipher_toggle";
    // The desk->vault->couriers leg was still carrying Phase 2's
    // plaintext flow up to this instant — pause it now that the cipher
    // sits upstream of it, so nothing sealed downstream shows stale
    // unsealed packets before the player has actually picked a seal.
    stopArrowFlow("sorting_desk", "vault");
    stopArrowFlow("vault", "couriers");
    setInstructions("Set the Cipher Desk's seal.");
    renderToggle();
  }

  // Floats inside the canvas near the Cipher Desk node — the palette
  // column (170px) is too narrow for two buttons plus a badge.
  const toggleEl = el("div", {
    className: "panel",
    style: { position: "absolute", left: "690px", top: "60px", width: "200px", display: "none", flexDirection: "column", gap: "8px", pointerEvents: "auto" },
  });
  function renderToggle() {
    toggleEl.innerHTML = "";
    toggleEl.style.display = "flex";
    toggleEl.append(
      el("div", { text: "CIPHER DESK SEAL", style: { fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.06em", color: "var(--text-muted)" } }),
      el("button", { className: "btn btn--ghost", text: "SEAL THE CONTENTS", style: { width: "100%" }, on: { click: () => pickSeal("sealContents") } }),
      el("button", { className: "btn btn--ghost", text: "SEAL EVERYTHING", style: { width: "100%" }, on: { click: () => pickSeal("sealEverything") } }),
      pileUpBadgeEl,
    );
  }

  const pileUpBadgeEl = el("span", { className: "chip", text: "", style: { display: "none", whiteSpace: "nowrap", alignSelf: "flex-start" } });

  function pickSeal(mode: "sealContents" | "sealEverything") {
    postRoadBuilderState.cipherToggleAttempts++;
    sealMode = mode;
    stopArrowFlow("villagers", "cipher_desk");
    stopArrowFlow("cipher_desk", "sorting_desk");
    stopArrowFlow("sorting_desk", "vault");
    stopArrowFlow("vault", "couriers");
    pileUpCount = 0;
    pileUpBadgeEl.style.display = "none";

    if (mode === "sealEverything") {
      startArrowFlow("villagers", "cipher_desk", "fully-sealed");
      startArrowFlow("cipher_desk", "sorting_desk", "fully-sealed", {
        onArrive: () => {
          pileUpCount++;
          pileUpBadgeEl.textContent = `STUCK AT DESK: ${pileUpCount}`;
          pileUpBadgeEl.style.display = "inline-flex";
        },
      });
      questEngine.toast('BRAM — Agent, I cannot route what I cannot read! These will rot here by morning.');
      window.setTimeout(() => {
        questEngine.toast("Over-protection is a failure mode too. The desk needs the address to do its job — and nothing more.");
      }, 1200);
      // Toggle stays open — the player can pick again.
      return;
    }

    startArrowFlow("villagers", "cipher_desk", "contents-sealed");
    startArrowFlow("cipher_desk", "sorting_desk", "contents-sealed");
    startArrowFlow("sorting_desk", "vault", "contents-sealed");
    startArrowFlow("vault", "couriers", "contents-sealed");
    questEngine.toast("HERALD — Purpose limitation, Ranger. The desk gets exactly what it needs to sort — the address — and not one word more. That is the whole craft.");
    toggleEl.style.display = "none";
    window.setTimeout(() => enterFinalStage(), 1500);
  }

  function enterFinalStage() {
    stage = "final";
    setInstructions("");
    const { lineEl, headEl } = drawArrowVisual("sorting_desk", "bandit_camp", "var(--accent-red)", false);
    arrows.push({ from: "sorting_desk", to: "bandit_camp", lineEl, headEl });
    const banditEl = el(
      "div",
      {
        style: {
          position: "absolute",
          left: `${BANDIT_X - 65}px`,
          top: `${BANDIT_Y - 35}px`,
          width: "130px",
          height: "70px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "2px",
          border: "2px solid var(--accent-red)",
          borderRadius: "var(--radius)",
          background: "rgba(239, 71, 111, 0.12)",
          fontFamily: "var(--font-body)",
          fontSize: "12px",
          color: "var(--text-primary)",
          textAlign: "center",
        },
      },
      [el("span", { text: "▭", style: { fontSize: "18px", color: "var(--accent-red)" } }), el("span", { text: "BANDIT CAMP" })],
    );
    nodesLayerEl.appendChild(banditEl);
    startArrowFlow("sorting_desk", "bandit_camp", "fully-sealed");
    questEngine.toast("They still steal it. They just can't read it. Build for the road you have, not the road you wish for.");
    window.setTimeout(() => finish(), 3000);
  }

  function finish() {
    stopAllFlows();
    teardown();
    onClose(true);
  }

  // --- Palette + initial render --------------------------------------
  paletteEl.append(
    el("div", { text: "NODE PALETTE", style: { fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.08em", color: "var(--text-muted)" } }),
    makePaletteItem("entity"),
    makePaletteItem("process"),
    makePaletteItem("store"),
  );
  canvasEl.appendChild(toggleEl);
  renderSlots();
  setInstructions("Drag each node into its labeled slot.");

  // --- Teardown -------------------------------------------------------
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

  void banditVisible;
  void sealMode;
}
