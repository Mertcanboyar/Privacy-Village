import { el } from "./dom";

// Full-screen zoomable evidence viewer (see PLAN.md "The Breach in the
// Wall") — used by the Herald's mission briefings for the blueprint
// (1 image) and the dossier (3 images side by side). Same
// DOM-over-Phaser overlay pattern as everything else in #ui-root.

export interface EvidenceImage {
  src: string;
  label?: string;
}

const MIN_SCALE = 1;
const MAX_SCALE = 4;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function touchDist(touches: TouchList): number {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

// Shown in place of an <img> that 404s — the 4 quest images aren't
// supplied yet (see client/public/assets/quest/README.md). Every other
// part of Mission 1/2 works without them.
function placeholderCard(label: string, src: string): HTMLElement {
  return el(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        width: "320px",
        height: "420px",
        border: "2px dashed var(--border-strong)",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-raised)",
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: "13px",
        textAlign: "center",
        padding: "24px",
      },
    },
    [
      el("div", { text: "EVIDENCE PENDING", style: { fontWeight: "700", letterSpacing: "0.08em", color: "var(--accent-gold)" } }),
      el("div", { text: label }),
      el("div", { text: src, style: { fontSize: "11px", opacity: "0.7", wordBreak: "break-all" } }),
    ],
  );
}

export function showImageOverlay(images: EvidenceImage[], caption: string) {
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;
  let pinchStartDist = 0;
  let pinchStartScale = 1;

  const imgRow = el(
    "div",
    {
      style: {
        display: "flex",
        gap: "16px",
        alignItems: "center",
        justifyContent: "center",
        transformOrigin: "center center",
      },
    },
    images.map((img) =>
      el("img", {
        attrs: { src: img.src, alt: img.label ?? caption, draggable: "false" },
        style: {
          maxHeight: "70vh",
          maxWidth: images.length > 1 ? "30vw" : "80vw",
          objectFit: "contain",
          borderRadius: "var(--radius-sm)",
          border: "2px solid var(--border-strong)",
          userSelect: "none",
          pointerEvents: "none",
        },
        on: {
          error: (e) => (e.target as HTMLImageElement).replaceWith(placeholderCard(img.label ?? caption, img.src)),
        },
      }),
    ),
  );

  function applyTransform() {
    imgRow.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  const viewport = el(
    "div",
    { style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", cursor: "grab" } },
    [imgRow],
  );

  const wrapper = el("div", {
    className: "ui-backdrop ds-root",
    style: { position: "absolute", inset: "0", pointerEvents: "auto", zIndex: "1000" },
    on: { click: (e) => e.target === wrapper && close() },
  });
  wrapper.append(
    viewport,
    el("div", {
      text: caption,
      style: {
        position: "absolute",
        top: "24px",
        left: "50%",
        transform: "translateX(-50%)",
        fontFamily: "var(--font-mono)",
        fontSize: "13px",
        fontWeight: "700",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--accent-blue)",
      },
    }),
    el("div", {
      text: "Scroll or pinch to zoom · drag to pan · [E] or click outside to close",
      style: { position: "absolute", bottom: "24px", left: "50%", transform: "translateX(-50%)", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)" },
    }),
  );

  document.getElementById("ui-root")!.appendChild(wrapper);

  function close() {
    document.removeEventListener("keydown", onKeydown);
    wrapper.remove();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "e" || e.key === "E" || e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKeydown);

  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      scale = clamp(scale - e.deltaY * 0.0015, MIN_SCALE, MAX_SCALE);
      applyTransform();
    },
    { passive: false },
  );

  viewport.addEventListener("pointerdown", (e) => {
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    viewport.setPointerCapture(e.pointerId);
    viewport.style.cursor = "grabbing";
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    applyTransform();
  });
  const endDrag = () => {
    dragging = false;
    viewport.style.cursor = "grab";
  };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  // Basic two-finger pinch-to-zoom (touch devices).
  viewport.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      pinchStartDist = touchDist(e.touches);
      pinchStartScale = scale;
    }
  });
  viewport.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      scale = clamp(pinchStartScale * (touchDist(e.touches) / pinchStartDist), MIN_SCALE, MAX_SCALE);
      applyTransform();
    },
    { passive: false },
  );
}
