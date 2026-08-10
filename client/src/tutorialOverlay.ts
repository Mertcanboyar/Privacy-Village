import { el } from "./ui/dom";
import { tutorial } from "./tutorial";
import { GAME_WIDTH } from "./config";

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
  private academyHighlightEl: HTMLElement;
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

    // Frames the real HUD "Study" button — positioned dynamically in
    // show() (see that method's coordinate-space comment), since unlike
    // the quest tracker this button's width depends on its text and
    // isn't a fixed, safely-hardcodable box.
    this.academyHighlightEl = el("div", {
      style: {
        position: "absolute",
        border: "2px solid var(--accent-gold)",
        borderRadius: "var(--radius)",
        boxShadow: "0 0 24px rgba(240, 180, 41, 0.6)",
        animation: "ds-pulse 1.6s ease-in-out infinite",
        opacity: "0",
        transition: `opacity ${FADE_MS}ms ease`,
        pointerEvents: "none",
      },
    });

    const divider = el("div", { style: { borderTop: "1px solid var(--border-strong)", margin: "var(--space-2) 0" } });

    // The two-beat orientation PLAN's onboarding fix asks for — voiced as
    // the Division's standing orders rather than a real spoken NPC line
    // (this overlay fires before the player can move at all, so there's
    // no in-world Herald to walk up to yet), styled to read the same way
    // a HERALD interjection reads elsewhere in this game's dialogue.
    const heraldLine = (text: string) =>
      el("div", { style: { margin: "8px 0" } }, [
        el("span", { text: "HERALD — ", style: { fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: "700", color: "var(--accent-gold)" } }),
        el("span", { text, style: { fontFamily: "var(--font-body)", fontSize: "14px", color: "var(--text-primary)" } }),
      ]);

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
        divider,
        heraldLine(
          "Two things happen in this village, Agent. You STUDY at the Academy — up there, top-left — and you APPLY it in the field, out here, where mistakes cost more.",
        ),
        heraldLine("Study first. Always. The Division does not send unprepared agents through gates. Your first briefing waits inside."),
        el("button", {
          className: "btn btn--gold",
          text: "GOT IT — TO THE ACADEMY",
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
      this.academyHighlightEl,
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
    this.positionAcademyHighlight();
    this.rootEl.style.display = "block";
    requestAnimationFrame(() => {
      this.backdropEl.style.opacity = "1";
      this.highlightEl.style.opacity = "1";
      this.academyHighlightEl.style.opacity = "1";
      this.stageEl.style.opacity = "1";
    });
  }

  // The Study button's width depends on its text, so (unlike the quest
  // tracker's fixed-size highlight) this can't be a static match —
  // computed against the real element's live layout instead. #ui-root
  // sits inside scale.ts's CSS transform: scale() (see style.css's
  // comment on #game-stage), which getBoundingClientRect() reports
  // POST-transform — dividing by the ratio between #ui-root's rendered
  // and true (GAME_WIDTH) width converts back to the same unscaled
  // local px space every other absolute-positioned element here already
  // uses, so this stays correctly aligned at any window size.
  private positionAcademyHighlight() {
    const btn = document.getElementById("hud-academy-btn");
    const uiRoot = document.getElementById("ui-root");
    if (!btn || !uiRoot) return;
    const btnRect = btn.getBoundingClientRect();
    const rootRect = uiRoot.getBoundingClientRect();
    const scale = rootRect.width / GAME_WIDTH;
    const pad = 6;
    this.academyHighlightEl.style.left = `${(btnRect.left - rootRect.left) / scale - pad}px`;
    this.academyHighlightEl.style.top = `${(btnRect.top - rootRect.top) / scale - pad}px`;
    this.academyHighlightEl.style.width = `${btnRect.width / scale + pad * 2}px`;
    this.academyHighlightEl.style.height = `${btnRect.height / scale + pad * 2}px`;
  }

  private hide() {
    this.backdropEl.style.opacity = "0";
    this.highlightEl.style.opacity = "0";
    this.academyHighlightEl.style.opacity = "0";
    this.stageEl.style.opacity = "0";
    this.hideTimeout = window.setTimeout(() => {
      this.rootEl.style.display = "none";
    }, FADE_MS);
  }
}
