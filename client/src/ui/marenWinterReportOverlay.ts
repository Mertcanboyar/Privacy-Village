import { el } from "./dom";
import { GAME_WIDTH, GAME_HEIGHT } from "../config";
import { playSound } from "../audio";
import { questEngine } from "../questEngine";
import { marenWinterReportState, resetMarenWinterReportState } from "../marenWinterReportState";

// "Maren's Winter Report" — a data-engineering-dashboard flavored
// full-screen DOM overlay, same shell/drag/arrow/packet techniques as
// blueprintOverlay.ts/treasuryOverlay.ts. The lesson: minimization is
// changing the SHAPE of data (aggregate/anonymize) as early upstream as
// possible, not merely collecting less — and the aggregation step is a
// judgment call with three outcomes (keep identifiers = breach;
// drop-and-count = correct; over-strip = private but useless), not one
// "correct" config to discover by trial and error alone.
//
// Concept mapping (not shown in-game):
//   Raw health log        = unminimized Art. 9 special-category data
//   Council Vault risk meter = storage limitation + risk-of-processing
//   Statistician's Desk    = aggregation / anonymization transform
//   Drop identifiers + count = transformative minimization (Art. 5(1)(c))
//   Over-strip fail         = anonymization must preserve utility/purpose
//   Upstream transform       = privacy-by-design (Art. 25)

type NodeId = "apothecary" | "vault" | "statistician";
type KeepDrop = "keep" | "drop";
type IllnessRule = "keep" | "drop" | "count";

interface NodePos {
  x: number;
  y: number;
  label: string;
  glyph: string;
  color: string;
}

const NODES: Record<NodeId, NodePos> = {
  apothecary: { x: 170, y: 280, label: "Apothecary", glyph: "▭", color: "var(--accent-blue)" },
  statistician: { x: 480, y: 280, label: "Statistician's Desk", glyph: "◯", color: "var(--accent-gold)" },
  vault: { x: 790, y: 280, label: "Council Vault", glyph: "═", color: "var(--accent-green)" },
};

const RAW_SAMPLE_ROWS = ["Bram · River Street · Flu", "Silas · Town Square · Gout", "Odile · Tavern Corner · Winter Fever", "⋯ 71 more rows"];

let openCount = 0;

export function isMarenWinterReportOverlayOpen(): boolean {
  return openCount > 0;
}

/** Opens the full quest — hook through completion — in one continuous
 * overlay. `onClose(completed)` fires exactly once. Every open starts a
 * fresh attempt, same "no partial resume" simplification every other
 * full-screen minigame in this project already uses. */
export function openMarenWinterReportOverlay(onClose: (completed: boolean) => void) {
  openCount++;
  resetMarenWinterReportState();

  // --- Board state -----------------------------------------------------
  let severed = false;
  let statisticianPlaced = false;
  let riskMeterValue = 0;
  let finished = false;
  const config: { name: KeepDrop; address: KeepDrop; illness: IllnessRule } = { name: "keep", address: "keep", illness: "keep" };

  const nodeEls = new Map<NodeId, HTMLElement>();
  const badgeRows = new Map<NodeId, HTMLElement>();
  const arrows = new Map<string, { lineEl: HTMLElement; headEl: HTMLElement }>();
  const spawners = new Map<string, number>();
  let packets: { el: HTMLElement; fromX: number; fromY: number; toX: number; toY: number; startTime: number; durationMs: number; onArrive?: () => void }[] = [];
  let packetRaf: number | null = null;
  let meterFillIntervalId: number | null = null;

  // --- Shell -------------------------------------------------------------
  const instructionsEl = el("div", {
    style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", textAlign: "center", marginTop: "8px", minHeight: "16px" },
  });
  const paletteEl = el("div", { style: { display: "flex", flexDirection: "column", gap: "8px", width: "190px", flex: "none" } });
  const arrowsLayerEl = el("div", { style: { position: "absolute", inset: "0", pointerEvents: "none" } });
  const nodesLayerEl = el("div", { style: { position: "absolute", inset: "0", pointerEvents: "none" } });
  const packetsLayerEl = el("div", { style: { position: "absolute", inset: "0", pointerEvents: "none" } });
  const badgesLayerEl = el("div", { style: { position: "absolute", inset: "0", pointerEvents: "none" } });
  const hudLayerEl = el("div", { style: { position: "absolute", inset: "0", pointerEvents: "none" } });
  const canvasEl = el(
    "div",
    {
      style: {
        position: "relative",
        flex: "1",
        height: "560px",
        background: "linear-gradient(180deg, rgba(10,14,22,0.4), rgba(10,14,22,0.15))",
        borderRadius: "var(--radius)",
        border: "1px solid var(--border-strong)",
      },
    },
    [arrowsLayerEl, nodesLayerEl, badgesLayerEl, packetsLayerEl, hudLayerEl],
  );

  const panelEl = el(
    "div",
    { className: "panel panel--glow ds-root", style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "1180px", pointerEvents: "auto" } },
    [
      el("div", { className: "briefing__header" }, [
        el("span", { className: "briefing__case", text: "FIELD WORK" }),
        el("h2", { className: "briefing__title", text: "Maren's Winter Report" }),
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

  // --- Council Vault risk meter + DPIA badge -------------------------------
  const meterEl = el(
    "div",
    { className: "meter", style: { position: "absolute", left: "660px", top: "195px", width: "260px", pointerEvents: "none" } },
    [
      el("div", { className: "meter__label", text: "STORAGE RISK" }),
      el("div", { className: "meter__track" }, [el("div", { className: "meter__fill meter__fill--risk", style: { width: "0%" } })]),
      el("div", { className: "meter__delta", text: "" }),
    ],
  );
  const dpiaBadgeEl = el("div", {
    className: "chip",
    text: "⚠ DPIA ALERT",
    style: { position: "absolute", left: "660px", top: "165px", pointerEvents: "none", display: "none", background: "rgba(239, 71, 111, 0.18)", borderColor: "var(--accent-red)" },
  });

  function setRiskMeter(value: number) {
    riskMeterValue = Math.max(0, Math.min(100, value));
    const fillEl = meterEl.querySelector(".meter__fill") as HTMLElement;
    fillEl.style.width = `${riskMeterValue}%`;
    if (riskMeterValue > marenWinterReportState.riskMeterPeak) marenWinterReportState.riskMeterPeak = riskMeterValue;
    if (riskMeterValue > 0) {
      dpiaBadgeEl.style.display = "inline-flex";
      dpiaBadgeEl.textContent = "⚠ DPIA ALERT";
      dpiaBadgeEl.style.animation = "ds-levelup-flash 700ms ease-in-out infinite";
    } else {
      dpiaBadgeEl.textContent = "✓ CLEAR";
      dpiaBadgeEl.style.animation = "";
      dpiaBadgeEl.style.background = "rgba(6, 214, 160, 0.15)";
      dpiaBadgeEl.style.borderColor = "var(--accent-green)";
    }
  }

  function animateMeterTo(target: number, ms: number, done?: () => void) {
    if (meterFillIntervalId) window.clearInterval(meterFillIntervalId);
    const start = riskMeterValue;
    const startTime = performance.now();
    meterFillIntervalId = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - startTime) / ms);
      setRiskMeter(start + (target - start) * t);
      if (t >= 1) {
        window.clearInterval(meterFillIntervalId!);
        meterFillIntervalId = null;
        done?.();
      }
    }, 60);
  }

  // --- Raw packet inspector panel ------------------------------------------
  const inspectorEl = el(
    "div",
    { className: "panel", style: { position: "absolute", right: "10px", top: "10px", width: "260px", pointerEvents: "auto" } },
    [
      el("div", { text: "RAW LOG (INSPECTOR)", style: { fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.06em", color: "var(--text-muted)" } }),
      ...RAW_SAMPLE_ROWS.map((row) => el("div", { text: row, style: { fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-primary)", marginTop: "4px" } })),
    ],
  );

  // --- Vault contents label -------------------------------------------------
  const vaultContentsEl = el("div", {
    style: { position: "absolute", left: "660px", top: "230px", width: "260px", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)", pointerEvents: "none" },
    text: "Stores: 74 raw patient records",
  });

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
      style: { position: "absolute", left: `${box.left}px`, top: `${box.top - 22}px`, width: `${box.width}px`, display: "flex", justifyContent: "center", gap: "3px", pointerEvents: "none" },
    });
    badgesLayerEl.appendChild(badgeRow);
    badgeRows.set(id, badgeRow);
  }

  function flashRed(target: HTMLElement) {
    target.style.animation = "none";
    void target.offsetWidth;
    target.style.animation = "ds-shake 400ms ease-in-out";
    window.setTimeout(() => (target.style.animation = ""), 400);
  }

  function setBadge(id: NodeId, text: string, tone: "warn" | "ok" | "neutral") {
    const row = badgeRows.get(id);
    if (!row) return;
    row.innerHTML = "";
    const color = tone === "warn" ? "var(--accent-red)" : tone === "ok" ? "var(--accent-green)" : "var(--text-muted)";
    row.appendChild(el("span", { className: "chip", text, style: { fontSize: "11px", padding: "1px 6px", borderColor: color, color } }));
  }

  // --- Arrow + packet engine (trimmed copy of treasuryOverlay.ts's) -------
  function trimmed(x1: number, y1: number, x2: number, y2: number, pad: number) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    return { x1: x1 + ux * pad, y1: y1 + uy * pad, x2: x2 - ux * pad, y2: y2 - uy * pad };
  }

  function nodeCenter(id: NodeId | "slotGap"): { x: number; y: number } {
    if (id === "slotGap") return { x: NODES.statistician.x, y: NODES.statistician.y };
    return NODES[id];
  }

  function drawArrow(key: string, from: NodeId, to: NodeId, color: string, clickable?: () => void): void {
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
        top: `${t.y1 - 2}px`,
        width: `${length}px`,
        height: "4px",
        background: color,
        transformOrigin: "0 50%",
        transform: `rotate(${angle}deg)`,
        pointerEvents: clickable ? "auto" : "none",
        cursor: clickable
          ? `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" font-size="22"><text y="20">%E2%9C%82%EF%B8%8F</text></svg>') 14 14, pointer`
          : "default",
      },
    });
    if (clickable) lineEl.addEventListener("click", clickable);
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
    arrows.set(key, { lineEl, headEl });
  }

  function removeArrow(key: string) {
    const a = arrows.get(key);
    if (!a) return;
    a.lineEl.remove();
    a.headEl.remove();
    arrows.delete(key);
  }

  function makePacketEl(color: string, glyph?: string): HTMLElement {
    return el(
      "div",
      {
        style: {
          position: "absolute",
          width: "22px",
          height: "16px",
          borderRadius: "3px",
          background: color,
          border: "1px solid rgba(0,0,0,0.4)",
          pointerEvents: "none",
          zIndex: "5",
          opacity: "0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "9px",
        },
      },
      glyph ? [el("span", { text: glyph })] : [],
    );
  }

  function startFlow(key: string, from: NodeId, to: NodeId, color: string, glyph: string | undefined, intervalMs = 1200) {
    if (spawners.has(key)) return;
    const spawnOne = () => {
      const a = nodeCenter(from);
      const b = nodeCenter(to);
      const packetEl = makePacketEl(color, glyph);
      packetsLayerEl.appendChild(packetEl);
      packets.push({ el: packetEl, fromX: a.x - 11, fromY: a.y - 8, toX: b.x - 11, toY: b.y - 8, startTime: performance.now(), durationMs: 1200 });
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

  function flyOnce(from: NodeId, to: NodeId, color: string, glyph: string | undefined, durationMs: number, onArrive?: () => void) {
    const a = nodeCenter(from);
    const b = nodeCenter(to);
    const packetEl = makePacketEl(color, glyph);
    packetsLayerEl.appendChild(packetEl);
    packets.push({ el: packetEl, fromX: a.x - 11, fromY: a.y - 8, toX: b.x - 11, toY: b.y - 8, startTime: performance.now(), durationMs, onArrive });
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
    if (meterFillIntervalId) window.clearInterval(meterFillIntervalId);
  }

  // --- Baseline: the breach (direct Apothecary -> Vault) --------------------
  function startBaseline() {
    drawArrow("apothecary->vault", "apothecary", "vault", "var(--accent-red)", severArrow);
    (arrows.get("apothecary->vault")!.lineEl.style as CSSStyleDeclaration).animation = "ds-levelup-flash 900ms ease-in-out infinite";
    startFlow("apothecary->vault", "apothecary", "vault", "rgba(239, 71, 111, 0.85)", "📋", 900);
    vaultContentsEl.textContent = "Stores: 74 raw patient records";
    animateMeterTo(100, 2200, () => {
      questEngine.toast(
        "HERALD — Exact names and addresses, stored forever, to count flu cases. Storage limitation and purpose limitation, both violated. The Vault is a liability just by holding this.",
      );
      setInstructions("STEP 1 of 2 — Click the direct pipe (✂) to sever it, then drag STATISTICIAN'S DESK into the gap.");
    });
  }

  function severArrow() {
    if (severed) return;
    severed = true;
    playSound("select");
    stopFlow("apothecary->vault");
    removeArrow("apothecary->vault");
    markPaletteEnabled();
    renderSlot();
    setInstructions("STEP 1 of 2 — Drag STATISTICIAN'S DESK into the gap between Apothecary and Vault.");
  }

  // --- Ghost slot + palette drag-in ----------------------------------------
  const slotEl = el("div", { style: { display: "none" } });
  function renderSlot() {
    const box = nodeBox(NODES.statistician);
    slotEl.className = "drop-zone";
    slotEl.textContent = "?";
    Object.assign(slotEl.style, {
      display: "flex",
      position: "absolute",
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      fontSize: "22px",
    });
  }

  let paletteItemEl: HTMLElement;
  function markPaletteEnabled() {
    paletteItemEl.style.opacity = "1";
    paletteItemEl.style.cursor = "grab";
    paletteItemEl.dataset.enabled = "true";
  }

  let dragGhost: HTMLElement | null = null;

  function startDrag(clientX: number, clientY: number) {
    if (paletteItemEl.dataset.enabled !== "true" || statisticianPlaced) return;
    dragGhost = el(
      "div",
      { className: "drag-card", style: { width: "130px", fontSize: "12px", padding: "8px 6px", zIndex: "10", pointerEvents: "none" } },
      [el("div", { text: "◯", style: { fontSize: "18px" } }), el("div", { text: "STATISTICIAN'S DESK", style: { fontSize: "10px", marginTop: "3px" } })],
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

  function isOverSlot(clientX: number, clientY: number): boolean {
    const canvasRect = canvasEl.getBoundingClientRect();
    const scale = currentScale();
    const localX = (clientX - canvasRect.left) / scale;
    const localY = (clientY - canvasRect.top) / scale;
    const box = nodeBox(NODES.statistician);
    return localX >= box.left && localX <= box.left + box.width && localY >= box.top && localY <= box.top + box.height;
  }

  function endDrag(clientX: number, clientY: number) {
    dragGhost?.remove();
    dragGhost = null;
    if (!severed || statisticianPlaced) return;
    if (!isOverSlot(clientX, clientY)) return;
    placeStatistician();
  }

  function placeStatistician() {
    statisticianPlaced = true;
    playSound("chime");
    slotEl.style.display = "none";
    showNode("statistician");
    setBadge("statistician", "⚠ UNCONFIGURED", "warn");
    drawArrow("apothecary->statistician", "apothecary", "statistician", "rgba(239, 71, 111, 0.85)");
    startFlow("apothecary->statistician", "apothecary", "statistician", "rgba(239, 71, 111, 0.85)", "📋", 1100);
    drawArrow("statistician->vault", "statistician", "vault", "rgba(255,255,255,0.25)");
    renderConfigPanel();
    setInstructions("STEP 2 of 2 — Set the desk's rules, then click EXECUTE PIPELINE.");
  }

  // --- Config panel (the judgment) ------------------------------------------
  const configPanelEl = el("div", {
    className: "panel",
    style: { position: "absolute", left: "300px", top: "380px", width: "360px", pointerEvents: "auto", display: "none", flexDirection: "column", gap: "8px" },
  });

  function attributeRow(label: string, options: { value: string; text: string }[], current: string, onPick: (v: string) => void): HTMLElement {
    return el("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" } }, [
      el("div", { text: label, style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", width: "90px" } }),
      el(
        "div",
        { style: { display: "flex", gap: "6px" } },
        options.map((opt) =>
          el("button", {
            className: `btn ${current === opt.value ? "btn--gold" : "btn--ghost"}`,
            text: opt.text,
            style: { fontSize: "11px", padding: "6px 10px" },
            on: { click: () => onPick(opt.value) },
          }),
        ),
      ),
    ]);
  }

  function renderConfigPanel() {
    configPanelEl.style.display = "flex";
    configPanelEl.innerHTML = "";
    configPanelEl.append(
      el("div", { text: "STATISTICIAN'S DESK — TRANSFORM RULES", style: { fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.05em", color: "var(--text-muted)" } }),
      attributeRow(
        "NAME",
        [
          { value: "keep", text: "KEEP" },
          { value: "drop", text: "DROP" },
        ],
        config.name,
        (v) => {
          config.name = v as KeepDrop;
          renderConfigPanel();
        },
      ),
      attributeRow(
        "ADDRESS",
        [
          { value: "keep", text: "KEEP" },
          { value: "drop", text: "DROP" },
        ],
        config.address,
        (v) => {
          config.address = v as KeepDrop;
          renderConfigPanel();
        },
      ),
      attributeRow(
        "ILLNESS",
        [
          { value: "keep", text: "KEEP" },
          { value: "drop", text: "DROP" },
          { value: "count", text: "COUNT" },
        ],
        config.illness,
        (v) => {
          config.illness = v as IllnessRule;
          renderConfigPanel();
        },
      ),
      el("button", { className: "btn btn--gold", text: "EXECUTE PIPELINE", style: { width: "100%", marginTop: "4px" }, on: { click: executePipeline } }),
    );
  }

  // --- Execute: the three outcomes -----------------------------------------
  function executePipeline() {
    if (finished) return;
    if (config.name === "keep" || config.address === "keep") {
      resolveFailA();
    } else if (config.illness === "count") {
      resolveSuccess();
    } else {
      resolveFailB();
    }
  }

  function resolveFailA() {
    marenWinterReportState.resetCount++;
    playSound("select");
    setBadge("statistician", "⚠ UNCONFIGURED", "warn");
    let n = 0;
    const burst = window.setInterval(() => {
      flyOnce("statistician", "vault", "rgba(239, 71, 111, 0.85)", "📋", 700);
      n++;
      if (n >= 3) window.clearInterval(burst);
    }, 220);
    const vaultEl = nodeEls.get("vault");
    if (vaultEl) flashRed(vaultEl);
    questEngine.toast("The desk is there but it's still passing names through. Aggregation means DROPPING the identifiers, not forwarding them.");
    vaultContentsEl.textContent = "Stores: 74 raw patient records";
  }

  function resolveFailB() {
    marenWinterReportState.overStripAttempts++;
    playSound("select");
    setBadge("statistician", "⚠ OVER-STRIPPED", "warn");
    let n = 0;
    const burst = window.setInterval(() => {
      flyOnce("statistician", "vault", "rgba(6, 214, 160, 0.8)", "▫", 700);
      n++;
      if (n >= 2) window.clearInterval(burst);
    }, 220);
    animateMeterTo(0, 900);
    vaultContentsEl.textContent = "Stores: Total = 74 (no breakdown)";
    questEngine.toast('The Council writes back: "This says \'200 sick.\' Two hundred of WHAT? We cannot buy medicine blind!"');
    window.setTimeout(() => {
      questEngine.toast("Private, yes — and useless. Anonymization must still serve its purpose. Keep the illness COUNTS; drop the people.");
    }, 1200);
  }

  function resolveSuccess() {
    marenWinterReportState.chosenConfig = `${config.name}_${config.address}_${config.illness}`;
    playSound("chime");
    setBadge("statistician", "✓ CONFIGURED", "ok");
    let n = 0;
    const burst = window.setInterval(() => {
      flyOnce("statistician", "vault", "rgba(6, 214, 160, 0.85)", "📊", 700);
      n++;
      if (n >= 3) window.clearInterval(burst);
    }, 220);
    animateMeterTo(0, 1200);
    vaultContentsEl.textContent = "Stores: Flu 34 · Gout 12 · Winter Fever 28";
    configPanelEl.style.display = "none";
    setInstructions("");
    questEngine.toast("Aggregated. No name, no street — only what the Council actually needed.");
    window.setTimeout(() => finishSequence(), 1600);
  }

  // --- Completion -------------------------------------------------------
  function finishSequence() {
    if (finished) return;
    finished = true;
    questEngine.toast("MAREN — The Council gets their numbers. And no villager's name ever leaves my desk. Why did I never think to count BEFORE I sent?");
    window.setTimeout(() => {
      questEngine.toast(
        "HERALD — Because minimization feels like deletion, and you didn't want to destroy your records. But you don't delete downstream — you TRANSFORM upstream. Strip the risk at the source, and the vault never touches a secret. That is privacy engineering, Ranger, not compliance paperwork.",
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
  paletteItemEl = el(
    "div",
    { className: "drag-card", attrs: { title: "Aggregates or drops each attribute before it reaches the Vault." }, style: { position: "static", width: "100%", fontSize: "12px", padding: "10px 6px", opacity: "0.35", cursor: "default" } },
    [el("div", { text: "◯", style: { fontSize: "20px" } }), el("div", { text: "STATISTICIAN'S DESK", style: { fontSize: "10px", marginTop: "4px" } })],
  );
  paletteItemEl.dataset.enabled = "false";
  paletteItemEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startDrag(e.clientX, e.clientY);
  });
  paletteEl.append(el("div", { text: "PALETTE", style: { fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.08em", color: "var(--accent-gold)" } }), paletteItemEl);

  hudLayerEl.append(dpiaBadgeEl);
  canvasEl.append(meterEl, vaultContentsEl, inspectorEl, slotEl, configPanelEl);
  showNode("apothecary");
  showNode("vault");
  setInstructions("Inspecting the flow from the Apothecary to the Council Vault...");
  startBaseline();

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
