import { el } from "./ui/dom";
import { tutorial } from "./tutorial";

// Scene-bound DOM overlay for the first-visit tutorial — constructed
// once from UIOverlay.ts, same as AcademyOverlay/EventsOverlay/
// DossierOverlay, and for the same reason: that's what guarantees this
// gets appended to #ui-root AFTER HUDController's top bar/quest tracker
// (UIOverlay.create() constructs `hud` first), so the tutorial's dim
// backdrop paints UNDER the tracker it's pointing at rather than
// covering it.
//
// Deliberately simpler than Academy/Dossier: content is 100% static, so
// the DOM is built once here rather than re-rendered per open() call.
const FADE_MS = 200;

function keycap(label: string): HTMLElement {
  return el("span", {
    className: "chip chip--gold",
    text: label,
    style: { minWidth: "20px", textAlign: "center", marginRight: "4px" },
  });
}

function row(keys: string[], text: string): HTMLElement {
  return el("div", { style: { display: "flex", alignItems: "center", gap: "10px", margin: "10px 0" } }, [
    el("div", { style: { display: "flex" } }, keys.map(keycap)),
    el("span", { text, style: { fontFamily: "var(--font-body)", fontSize: "14px", color: "var(--text-primary)" } }),
  ]);
}

export class TutorialOverlay {
  private rootEl: HTMLElement;
  private backdropEl: HTMLElement;
  private highlightEl: HTMLElement;
  private stageEl: HTMLElement;
  private hideTimeout: number | undefined;

  constructor(_scene: Phaser.Scene) {
    const root = document.getElementById("ui-root")!;

    this.backdropEl = el("div", {
      style: {
        position: "absolute",
        inset: "0",
        background: "rgba(10, 10, 15, 0.55)",
        opacity: "0",
        transition: `opacity ${FADE_MS}ms ease`,
      },
    });

    // Frames hud.ts's quest tracker panel (top: 24px, right: 24px,
    // width: 280px) with a small margin — update both if that panel's
    // position/size ever changes, since this is a static match, not a
    // live DOM query against HUDController's internals.
    this.highlightEl = el("div", {
      style: {
        position: "absolute",
        top: "20px",
        right: "20px",
        width: "288px",
        height: "120px",
        border: "2px solid var(--accent-gold)",
        borderRadius: "var(--radius)",
        boxShadow: "0 0 24px rgba(240, 180, 41, 0.6)",
        animation: "ds-pulse 1.6s ease-in-out infinite",
        opacity: "0",
        transition: `opacity ${FADE_MS}ms ease`,
        pointerEvents: "none",
      },
    });

    const panel = el(
      "div",
      { className: "panel panel--glow", style: { width: "440px", padding: "var(--space-3)" } },
      [
        el("div", {
          text: "GETTING STARTED",
          style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px", color: "var(--accent-gold)" },
        }),
        el("div", {
          text: "A quick briefing before you take the field, Agent.",
          style: { fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-muted)", marginTop: "6px" },
        }),
        row(["W", "A", "S", "D"], "Move around the village"),
        row(["E"], "Talk to nearby characters"),
        el("div", { style: { display: "flex", alignItems: "center", gap: "10px", margin: "10px 0" } }, [
          el("span", { text: "↗", style: { fontSize: "18px", color: "var(--accent-gold)" } }),
          el("span", {
            text: "Your current objective always shows top-right.",
            style: { fontFamily: "var(--font-body)", fontSize: "14px", color: "var(--text-primary)" },
          }),
        ]),
        el("button", {
          className: "btn btn--gold",
          text: "GOT IT — TO THE GATES",
          style: { marginTop: "var(--space-2)", width: "100%" },
          on: { click: () => tutorial.close() },
        }),
      ],
    );

    this.stageEl = el(
      "div",
      { style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", opacity: "0", transition: `opacity ${FADE_MS}ms ease` } },
      [panel],
    );

    this.rootEl = el("div", { className: "ds-root", style: { position: "absolute", inset: "0", display: "none", pointerEvents: "auto" } }, [
      this.backdropEl,
      this.highlightEl,
      this.stageEl,
    ]);
    root.appendChild(this.rootEl);

    tutorial.on("opened", () => this.show());
    tutorial.on("closed", () => this.hide());

    // Room.ts can call tutorial.open() synchronously during its own
    // create() — which, on the very first spawn, runs BEFORE UIOverlay's
    // create() constructs this class (scene.start("Room") is queued
    // ahead of scene.launch("UIOverlay") in CharacterCreate.spawn()/
    // Title's spawn helpers) — so the "opened" event above can fire into
    // the void. Catch that case here instead of relying on the event.
    if (tutorial.isOpen) this.show();

    document.addEventListener("keydown", this.onKeydown);
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && tutorial.isOpen) tutorial.close();
  };

  private show() {
    window.clearTimeout(this.hideTimeout);
    this.rootEl.style.display = "block";
    requestAnimationFrame(() => {
      this.backdropEl.style.opacity = "1";
      this.highlightEl.style.opacity = "1";
      this.stageEl.style.opacity = "1";
    });
  }

  private hide() {
    this.backdropEl.style.opacity = "0";
    this.highlightEl.style.opacity = "0";
    this.stageEl.style.opacity = "0";
    this.hideTimeout = window.setTimeout(() => {
      this.rootEl.style.display = "none";
    }, FADE_MS);
  }
}
