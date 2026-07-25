import { el } from "./dom";
import type { DiagramNodeType, DiagramQuizNode, DiagramQuizArrow } from "../academy";

// Renders a static, clickable data-flow diagram — "Mapping the Flow"'s
// diagram-quiz assessment (see academyOverlay.ts's renderDiagramQuiz()).
// Same node-shape/color language as ui/blueprintOverlay.ts's Post Road
// builder (glyph + colored border per type, straight-line arrows with a
// triangle arrowhead) but far simpler: no drag/drop, no packet
// animation, no stage machine — just render once and report clicks.

const NODE_GLYPH: Record<DiagramNodeType, string> = { entity: "▭", process: "◯", store: "═" };
const NODE_COLOR: Record<DiagramNodeType, string> = { entity: "var(--accent-blue)", process: "var(--accent-gold)", store: "var(--accent-green)" };

const NODE_W = 120;
const NODE_H = 58;

export type HighlightState = "none" | "correct" | "wrong";

export interface DiagramReader {
  containerEl: HTMLElement;
  setHighlight(id: string, state: HighlightState): void;
  clearHighlights(): void;
}

function trimmed(x1: number, y1: number, x2: number, y2: number, pad: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return { x1: x1 + ux * pad, y1: y1 + uy * pad, x2: x2 - ux * pad, y2: y2 - uy * pad };
}

export function buildDiagram(nodes: DiagramQuizNode[], arrows: DiagramQuizArrow[], onElementClick: (id: string) => void): DiagramReader {
  const width = Math.max(...nodes.map((n) => n.x)) + NODE_W;
  const height = Math.max(...nodes.map((n) => n.y)) + NODE_H / 2 + 24;

  const arrowsLayerEl = el("div", { style: { position: "absolute", inset: "0" } });
  const nodesLayerEl = el("div", { style: { position: "absolute", inset: "0" } });

  const containerEl = el(
    "div",
    {
      className: "panel",
      style: {
        position: "relative",
        width: `${width}px`,
        height: `${height}px`,
        margin: "var(--space-2) auto",
        background: "rgba(0, 0, 0, 0.15)",
        overflow: "visible",
      },
    },
    [arrowsLayerEl, nodesLayerEl],
  );

  const applyState = new Map<string, (state: HighlightState) => void>();

  for (const a of arrows) {
    const from = nodes.find((n) => n.id === a.from);
    const to = nodes.find((n) => n.id === a.to);
    if (!from || !to) continue;
    const baseColor = a.danger ? "var(--accent-red)" : "rgba(240, 180, 41, 0.8)";
    const t = trimmed(from.x, from.y, to.x, to.y, NODE_W / 2 + 6);
    const dx = t.x2 - t.x1;
    const dy = t.y2 - t.y1;
    const length = Math.hypot(dx, dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

    const lineEl = el("div", {
      attrs: { "data-el": a.id },
      style: {
        position: "absolute",
        left: `${t.x1}px`,
        top: `${t.y1 - 1.5}px`,
        width: `${length}px`,
        height: a.dashed ? "0" : "3px",
        background: a.dashed ? "none" : baseColor,
        borderTop: a.dashed ? `3px dashed ${baseColor}` : "none",
        transformOrigin: "0 50%",
        transform: `rotate(${angle}deg)`,
        cursor: "pointer",
        pointerEvents: "auto",
      },
      on: { click: () => onElementClick(a.id) },
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
        borderLeft: `10px solid ${baseColor}`,
        transform: `translate(-2px, -6px) rotate(${angle}deg)`,
        transformOrigin: "2px 6px",
        pointerEvents: "none",
      },
    });
    arrowsLayerEl.append(lineEl, headEl);

    if (a.label) {
      const midX = (t.x1 + t.x2) / 2;
      const midY = (t.y1 + t.y2) / 2;
      arrowsLayerEl.appendChild(
        el("div", {
          text: a.label,
          style: {
            position: "absolute",
            left: `${midX}px`,
            top: `${midY - 20}px`,
            transform: "translateX(-50%)",
            fontFamily: "var(--font-mono)",
            fontSize: "9px",
            color: "var(--text-muted)",
            background: "var(--bg-panel)",
            padding: "1px 4px",
            borderRadius: "3px",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          },
        }),
      );
    }

    applyState.set(a.id, (state) => {
      const color = state === "correct" ? "var(--accent-gold)" : state === "wrong" ? "var(--accent-red)" : baseColor;
      if (a.dashed) lineEl.style.borderTopColor = color;
      else lineEl.style.background = color;
      headEl.style.borderLeftColor = color;
    });
  }

  for (const n of nodes) {
    const baseColor = n.danger ? "var(--accent-red)" : NODE_COLOR[n.type];
    const nodeEl = el(
      "div",
      {
        attrs: { "data-el": n.id },
        style: {
          position: "absolute",
          left: `${n.x - NODE_W / 2}px`,
          top: `${n.y - NODE_H / 2}px`,
          width: `${NODE_W}px`,
          height: `${NODE_H}px`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "2px",
          border: `2px solid ${baseColor}`,
          borderRadius: "var(--radius)",
          background: n.danger ? "rgba(239, 71, 111, 0.12)" : "var(--bg-raised)",
          fontFamily: "var(--font-body)",
          fontSize: "11px",
          color: "var(--text-primary)",
          textAlign: "center",
          cursor: "pointer",
          pointerEvents: "auto",
          transition: "box-shadow 150ms ease",
        },
        on: { click: () => onElementClick(n.id) },
      },
      [el("span", { text: NODE_GLYPH[n.type], style: { fontSize: "17px", color: baseColor } }), el("span", { text: n.label })],
    );
    nodesLayerEl.appendChild(nodeEl);

    applyState.set(n.id, (state) => {
      if (state === "none") {
        nodeEl.style.boxShadow = "";
        nodeEl.style.animation = "";
        return;
      }
      const color = state === "correct" ? "var(--accent-gold)" : "var(--accent-red)";
      nodeEl.style.boxShadow = `0 0 0 3px ${color}`;
      nodeEl.style.animation = state === "correct" ? "ds-quiz-correct 500ms ease-out" : "ds-shake 400ms ease-in-out";
      window.setTimeout(() => (nodeEl.style.animation = ""), 500);
    });
  }

  return {
    containerEl,
    setHighlight(id, state) {
      applyState.get(id)?.(state);
    },
    clearHighlights() {
      for (const fn of applyState.values()) fn("none");
    },
  };
}
