import Phaser from "phaser";
import { el } from "./ui/dom";
import { academy } from "./academy";

// Full-screen DOM overlay for the Academy learning hub (see PLAN.md "The
// Academy"). Section 1 ("Entrances") only builds the open/close shell —
// dim+fade backdrop, movement lock (via Room.ts reading academy.isOpen),
// audio duck (via academy.ts itself) — with a placeholder panel. The
// hub/module-list/lesson/quiz screens (Sections 2-3) replace the
// placeholder body without touching this shell.
//
// Scene-bound (constructed with UIOverlay, the one persistent scene,
// same reasoning as HUDController) purely so it has a Phaser.Scene to
// pull Key objects from — the A/ESC hotkeys live here, not in hud.ts,
// so toggling is handled in exactly one place (hud.ts's button calls
// academy.toggle() directly; this class never also listens for a click
// that would double-fire alongside a keypress).
const FADE_MS = 200;

export class AcademyOverlay {
  private rootEl: HTMLElement;
  private backdropEl: HTMLElement;
  private stageEl: HTMLElement;
  private bodyEl: HTMLElement;
  private hideTimeout: number | undefined;

  private aKey: Phaser.Input.Keyboard.Key;
  private escKey: Phaser.Input.Keyboard.Key;

  constructor(scene: Phaser.Scene) {
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

    this.stageEl = el(
      "div",
      { className: "ds-root", style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", opacity: "0", transition: `opacity ${FADE_MS}ms ease` } },
      [this.bodyEl],
    );

    this.rootEl = el("div", { className: "ds-root", style: { position: "absolute", inset: "0", display: "none", pointerEvents: "auto" } }, [this.backdropEl, this.stageEl]);
    root.appendChild(this.rootEl);

    this.renderHub();

    academy.on("opened", () => this.show());
    academy.on("closed", () => this.hide());

    this.aKey = scene.input.keyboard!.addKey("A");
    this.escKey = scene.input.keyboard!.addKey("ESC");
  }

  update() {
    if (Phaser.Input.Keyboard.JustDown(this.aKey)) academy.toggle();
    if (academy.isOpen && Phaser.Input.Keyboard.JustDown(this.escKey)) academy.close();
  }

  // Placeholder hub body — replaced with the real hub/module-list/lesson
  // /quiz views in Sections 2-3.
  private renderHub() {
    this.bodyEl.innerHTML = "";
    this.bodyEl.appendChild(
      el("div", { className: "panel panel--glow", style: { width: "560px" } }, [
        el("h2", {
          text: "THE ACADEMY",
          style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "22px", letterSpacing: "0.05em", marginBottom: "var(--space-2)" },
        }),
        el("p", {
          text: "Structured learning content is coming online shortly.",
          style: { fontFamily: "var(--font-body)", fontSize: "14px", color: "var(--text-muted)", marginBottom: "var(--space-3)" },
        }),
        el("button", { className: "btn btn--gold", text: "RETURN TO VILLAGE", on: { click: () => academy.close() } }),
      ]),
    );
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
