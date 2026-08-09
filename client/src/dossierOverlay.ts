import Phaser from "phaser";
import { el } from "./ui/dom";
import { dossier } from "./dossier";
import { academy } from "./academy";
import { events } from "./events";
import { isImageOverlayOpen } from "./ui/imageOverlay";

// Full-screen DOM overlay for the Agent Dossier — a three-tab
// progression page (DOSSIER/CODEX/JOURNEY) layered over the village,
// same shell pattern as academyOverlay.ts: dim+fade backdrop, movement
// lock (Room.ts reads dossier.isOpen), audio duck (dossier.ts itself).
// Opens via the HUD button or the P hotkey (no WASD/E collision, unlike
// Academy's "A").
//
// Scene-bound (constructed with UIOverlay, the one persistent scene)
// purely for consistency with every other overlay in this file's
// family — nothing here actually reaches into the Scene today.
const FADE_MS = 200;

type DossierTab = "dossier" | "codex" | "journey";

export class DossierOverlay {
  private rootEl: HTMLElement;
  private backdropEl: HTMLElement;
  private stageEl: HTMLElement;
  private bodyEl: HTMLElement;
  private hideTimeout: number | undefined;

  private currentTab: DossierTab = "dossier";

  constructor(_scene: Phaser.Scene) {
    const root = document.getElementById("ui-root")!;

    this.backdropEl = el("div", {
      style: {
        position: "absolute",
        inset: "0",
        background: "rgba(10, 10, 15, 0.6)",
        opacity: "0",
        transition: `opacity ${FADE_MS}ms ease`,
      },
    });

    this.bodyEl = el("div", { className: "ds-root" });

    const closeBtn = el("button", {
      className: "btn btn--ghost ds-root",
      text: "RETURN TO VILLAGE",
      style: { position: "absolute", top: "24px", right: "24px" },
      on: { click: () => dossier.close() },
    });

    this.stageEl = el(
      "div",
      { className: "ds-root", style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", opacity: "0", transition: `opacity ${FADE_MS}ms ease` } },
      [this.bodyEl],
    );

    this.rootEl = el("div", { className: "ds-root", style: { position: "absolute", inset: "0", display: "none", pointerEvents: "auto" } }, [this.backdropEl, this.stageEl, closeBtn]);
    root.appendChild(this.rootEl);

    this.render();

    dossier.on("opened", () => {
      this.currentTab = "dossier";
      this.render();
      this.show();
    });
    dossier.on("closed", () => this.hide());
    // Live re-render on unlock/refresh events — the toast for a fresh
    // concept/title already fires from dossier.ts itself; this just
    // keeps whichever tab is showing in sync (e.g. a concept unlocking
    // while the Codex tab is open, mid-session).
    dossier.on("conceptUnlocked", () => this.render());
    dossier.on("titleUnlocked", () => this.render());
    dossier.on("activeTitleChanged", () => this.render());
    dossier.on("refreshed", () => this.render());

    document.addEventListener("keydown", this.onKeydown);
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && dossier.isOpen && !isImageOverlayOpen()) {
      dossier.close();
      return;
    }
    // "P" toggles the Dossier from anywhere in the village, same
    // no-hotkey-collision reasoning as "Q" (quest tracker, hud.ts) — a
    // letter that isn't WASD/E. Academy/Events have no hotkey of their
    // own, so a real click can never reach the Dossier's HUD button
    // while either is open (their full-screen backdrop covers it) —
    // but a keyboard listener doesn't care about DOM stacking, so this
    // guard is what stops "P" from popping the Dossier open ON TOP of
    // one of them. Also suppressed while any text field expects the
    // keystroke (chat.ts already stops propagation for its own input,
    // so this never fires while typing there regardless) or the
    // evidence-image viewer owns it.
    if (e.key.toLowerCase() === "p" && !academy.isOpen && !events.isOpen && !isImageOverlayOpen()) dossier.toggle();
  };

  private render() {
    this.bodyEl.innerHTML = "";
    const tabNav = this.renderTabNav();
    const content = this.currentTab === "dossier" ? this.renderDossierTab() : this.currentTab === "codex" ? this.renderCodexTab() : this.renderJourneyTab();
    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "760px", maxHeight: "660px", overflowY: "auto" } }, [tabNav, content]));
  }

  private goToTab(tab: DossierTab) {
    this.currentTab = tab;
    this.render();
  }

  private renderTabNav(): HTMLElement {
    const tabs: { id: DossierTab; label: string }[] = [
      { id: "dossier", label: "DOSSIER" },
      { id: "codex", label: "CODEX" },
      { id: "journey", label: "JOURNEY" },
    ];
    return el(
      "div",
      { style: { display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-3)" } },
      tabs.map((tab) =>
        el("button", {
          className: this.currentTab === tab.id ? "btn btn--gold" : "btn btn--ghost",
          text: tab.label,
          on: { click: () => this.goToTab(tab.id) },
        }),
      ),
    );
  }

  private renderDossierTab(): HTMLElement {
    return el("div", { text: "The Dossier — coming shortly." });
  }

  private renderCodexTab(): HTMLElement {
    return el("div", { text: "The Codex — coming shortly." });
  }

  private renderJourneyTab(): HTMLElement {
    return el("div", { text: "The Journey — coming shortly." });
  }

  private show() {
    window.clearTimeout(this.hideTimeout);
    this.rootEl.style.display = "block";
    requestAnimationFrame(() => {
      this.backdropEl.style.opacity = "1";
      this.stageEl.style.opacity = "1";
    });
  }

  private hide() {
    this.backdropEl.style.opacity = "0";
    this.stageEl.style.opacity = "0";
    this.hideTimeout = window.setTimeout(() => {
      this.rootEl.style.display = "none";
    }, FADE_MS);
  }
}
