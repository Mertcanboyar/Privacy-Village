import { el } from "./dom";
import { postRoadFieldNotes } from "../postRoadFieldNotes";
import { questEngine } from "../questEngine";

// Small persistent bottom-left panel for "The Blueprint of the Post
// Road"'s Phase 1 interview notes — mounted once from UIOverlay.ts, same
// lifetime as HUDController/ChatController, so it survives room
// transitions. High z-index (see blueprintOverlay.ts's own 1000) so it
// stays visible over the Phase 2-4 full-screen builder too — the whole
// point of these notes is that they're the player's own documentation,
// carried into the overlay that replaces the free-form village view.
export class FieldNotesPanel {
  private rootEl: HTMLElement;
  private listEl: HTMLElement;
  private caretEl: HTMLElement;
  private collapsed = false;

  constructor() {
    this.listEl = el("div", { style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "8px" } });
    this.caretEl = el("span", { text: "▾" });

    const headerEl = el(
      "div",
      {
        style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", cursor: "pointer" },
        on: { click: () => this.toggleCollapsed() },
      },
      [
        el("span", {
          text: "FIELD NOTES",
          style: { fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.08em", color: "var(--accent-gold)", fontWeight: "700" },
        }),
        this.caretEl,
      ],
    );

    this.rootEl = el(
      "div",
      {
        className: "panel ds-root",
        style: {
          // bottom:24/56px are the HUD's .xp-bar + guest "SAVE YOUR
          // RECORD" button (see hud.ts) — clear of both.
          position: "absolute",
          left: "24px",
          bottom: "110px",
          width: "280px",
          display: "none",
          pointerEvents: "auto",
          zIndex: "1500",
        },
      },
      [headerEl, this.listEl],
    );
    document.getElementById("ui-root")!.appendChild(this.rootEl);

    postRoadFieldNotes.on("changed", () => this.render());
    questEngine.on("questCompleted", (id: string) => {
      if (id === "post_road_blueprint") this.render();
    });

    this.render();
  }

  private toggleCollapsed() {
    this.collapsed = !this.collapsed;
    this.render();
  }

  private render() {
    const notes = postRoadFieldNotes.all;
    if (notes.length === 0 || questEngine.isComplete("post_road_blueprint")) {
      this.rootEl.style.display = "none";
      return;
    }
    this.rootEl.style.display = "block";
    this.caretEl.textContent = this.collapsed ? "▸" : "▾";
    this.listEl.style.display = this.collapsed ? "none" : "flex";
    this.listEl.innerHTML = "";
    for (const note of notes) {
      this.listEl.appendChild(
        el("div", { text: `• ${note}`, style: { fontFamily: "var(--font-body)", fontSize: "11px", color: "var(--text-muted)", lineHeight: "1.4" } }),
      );
    }
  }
}
