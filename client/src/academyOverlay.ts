import Phaser from "phaser";
import { el } from "./ui/dom";
import { academy, type AcademyTrack, type AcademyModuleSummary, type LessonBlock } from "./academy";
import { questEngine } from "./questEngine";
import { getSession } from "./session";
import { showImageOverlay, isImageOverlayOpen } from "./ui/imageOverlay";
import type { Room } from "./scenes/Room";

// Full-screen DOM overlay for the Academy learning hub (see PLAN.md "The
// Academy"). Section 1 ("Entrances") built the open/close shell — dim
// +fade backdrop, movement lock (via Room.ts reading academy.isOpen),
// audio duck (via academy.ts itself). Section 3a-b replaces the
// placeholder body with the real hub (3 track cards) and module list
// (field/theory pips) views; lesson/quiz are still placeholders here,
// filled in by the sections that follow.
//
// Scene-bound (constructed with UIOverlay, the one persistent scene,
// same reasoning as HUDController) both for its Key objects and so the
// module list's "IN THE VILLAGE →" pip can reach the Room scene via the
// shared SceneManager.
const FADE_MS = 200;

type AcademyView = "hub" | "moduleList" | "lesson" | "quiz";

export class AcademyOverlay {
  private scene: Phaser.Scene;

  private rootEl: HTMLElement;
  private backdropEl: HTMLElement;
  private stageEl: HTMLElement;
  private bodyEl: HTMLElement;
  private hideTimeout: number | undefined;

  private aKey: Phaser.Input.Keyboard.Key;

  private currentView: AcademyView = "hub";
  private currentTrackId: string | null = null;
  private currentModuleId: string | null = null;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
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
      on: { click: () => academy.close() },
    });

    this.stageEl = el(
      "div",
      { className: "ds-root", style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", opacity: "0", transition: `opacity ${FADE_MS}ms ease` } },
      [this.bodyEl],
    );

    this.rootEl = el("div", { className: "ds-root", style: { position: "absolute", inset: "0", display: "none", pointerEvents: "auto" } }, [this.backdropEl, this.stageEl, closeBtn]);
    root.appendChild(this.rootEl);

    this.render();

    academy.on("opened", () => {
      this.currentView = "hub";
      this.currentTrackId = null;
      this.currentModuleId = null;
      this.render();
      this.show();
    });
    academy.on("closed", () => this.hide());
    academy.on("progressChanged", () => this.render());

    this.aKey = scene.input.keyboard!.addKey("A");

    // Raw DOM listener rather than Phaser's polled JustDown(): the
    // evidence-image overlay (opened from the lesson view) closes
    // itself synchronously on its own "keydown" listener, and by the
    // time Phaser's next update() tick would poll JustDown() that
    // overlay has already reported itself closed — isImageOverlayOpen()
    // would read stale/false and academy.close() would fire right
    // behind it, closing both in one keypress. Registering here in the
    // constructor (i.e. before any evidence overlay has ever opened)
    // guarantees this listener runs before imageOverlay's later,
    // dynamically-added one for the same "keydown" event, so the check
    // below still sees it as open.
    document.addEventListener("keydown", this.onKeydown);
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && academy.isOpen && !isImageOverlayOpen()) academy.close();
  };

  update() {
    if (Phaser.Input.Keyboard.JustDown(this.aKey)) academy.toggle();
  }

  private render() {
    this.bodyEl.innerHTML = "";
    if (this.currentView === "hub") this.renderHub();
    else if (this.currentView === "moduleList") this.renderModuleList();
    else if (this.currentView === "lesson") this.renderLesson();
    else this.renderQuiz();
  }

  private goToHub() {
    this.currentView = "hub";
    this.render();
  }

  private goToModuleList(trackId: string) {
    this.currentTrackId = trackId;
    this.currentView = "moduleList";
    this.render();
  }

  private goToLesson(moduleId: string) {
    this.currentModuleId = moduleId;
    this.currentView = "lesson";
    this.render();
  }

  private goToQuiz(moduleId: string) {
    this.currentModuleId = moduleId;
    this.currentView = "quiz";
    this.render();
  }

  // Closes the overlay and either flashes the Herald (already in the
  // village) or takes the player there first — used by the module
  // list's "IN THE VILLAGE →" field-work pip.
  private goToHerald() {
    academy.close();
    const manager = this.scene.scene.manager;
    const roomScene = manager.getScene("Room") as Room | null;
    if (!roomScene) return;
    if (roomScene.currentRoom === "village") {
      roomScene.pingHerald();
    } else {
      manager.start("Room", { room: "village" });
    }
  }

  private renderHub() {
    const session = getSession();
    const header = el(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-3)" } },
      [
        el("h2", {
          text: "THE ACADEMY",
          style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "24px", letterSpacing: "0.06em", textTransform: "uppercase" },
        }),
        el("span", { className: "chip chip--gold", text: `C${questEngine.getClearance()} · ${session.name.toUpperCase()}` }),
      ],
    );

    const cardList = el(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
      academy.getAllTracks().map((track) => this.renderTrackCard(track)),
    );

    const footer = el("div", {
      text: "46 TRIALS. THREE PATHS. ONE VILLAGE.",
      style: { marginTop: "var(--space-3)", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: "12px", letterSpacing: "0.08em", color: "var(--text-muted)" },
    });

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "680px", maxHeight: "640px", overflowY: "auto" } }, [header, cardList, footer]));
  }

  private renderTrackCard(track: AcademyTrack): HTMLElement {
    if (!track.active) {
      return el("div", { className: "panel", style: { opacity: "0.5" } }, [
        el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-2)" } }, [
          el("div", {}, [
            el("div", { text: track.title, style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "16px" } }),
            el("div", { text: `${track.moduleCount} MODULES`, style: { fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" } }),
          ]),
          el("span", { className: "chip", text: track.lockedTag ?? "LOCKED" }),
        ]),
      ]);
    }

    const completed = academy.completedCount(track.id);
    const pct = track.moduleCount > 0 ? (completed / track.moduleCount) * 100 : 0;
    return el(
      "div",
      { className: "panel", style: { cursor: "pointer" }, on: { click: () => this.goToModuleList(track.id) } },
      [
        el("div", { text: track.title, style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "16px", marginBottom: "8px" } }),
        el("div", { className: "xp-bar__track" }, [el("div", { className: "xp-bar__fill", style: { width: `${pct}%` } })]),
        el("div", {
          text: `${track.credential.toUpperCase()} — ${completed}/${track.moduleCount} MODULES`,
          style: { marginTop: "6px", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)" },
        }),
      ],
    );
  }

  private renderModuleList() {
    const track = this.currentTrackId ? academy.getTrack(this.currentTrackId) : undefined;
    if (!track) {
      this.goToHub();
      return;
    }

    const header = el("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" } }, [
      el("button", { className: "btn btn--ghost", text: "← HUB", on: { click: () => this.goToHub() } }),
      el("h2", { text: track.title.toUpperCase(), style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px" } }),
    ]);

    const cardList = el(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
      (track.modules ?? []).map((summary) => this.renderModuleCard(summary)),
    );

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "680px", maxHeight: "640px", overflowY: "auto" } }, [header, cardList]));
  }

  private renderModuleCard(summary: AcademyModuleSummary): HTMLElement {
    const eligible = summary.hasContent && questEngine.getClearance() >= summary.clearanceRequired;
    if (!eligible) {
      return el("div", { className: "quest-card", style: { opacity: "0.5" } }, [
        el("div", { className: "quest-card__icon" }),
        el("div", { className: "quest-card__info" }, [el("div", { className: "quest-card__title", text: summary.title })]),
        el("div", { className: "quest-card__meta" }, [el("span", { className: "chip", text: `CLEARANCE ${summary.clearanceRequired} REQUIRED` })]),
      ]);
    }

    const progress = academy.getProgress(summary.id);
    const fieldPip = progress.fieldDone
      ? el("span", { className: "chip chip--gold", text: "FIELD WORK ✓" })
      : el("button", { className: "btn btn--ghost", text: "FIELD WORK: IN THE VILLAGE →", style: { fontSize: "11px", padding: "8px 12px" }, on: { click: () => this.goToHerald() } });
    const theoryPip = progress.theoryDone
      ? el("span", { className: "chip chip--gold", text: "THEORY ✓" })
      : el("button", { className: "btn btn--gold", text: "THEORY: BEGIN", style: { fontSize: "11px", padding: "8px 12px" }, on: { click: () => this.goToLesson(summary.id) } });

    return el("div", { className: "quest-card" }, [
      el("div", { className: "quest-card__icon" }),
      el("div", { className: "quest-card__info" }, [
        el("div", { className: "quest-card__title", text: summary.title }),
        el("div", { className: "quest-card__desc", text: `Clearance ${summary.clearanceRequired} required` }),
      ]),
      el("div", { className: "quest-card__meta", style: { gap: "8px" } }, [fieldPip, theoryPip]),
    ]);
  }

  private renderLesson() {
    const module = this.currentModuleId ? academy.getModule(this.currentModuleId) : undefined;
    if (!module) {
      this.goToHub();
      return;
    }

    const header = el("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" } }, [
      el("button", { className: "btn btn--ghost", text: "← BACK", on: { click: () => this.goToModuleList(module.track) } }),
      el("h2", { text: module.title.toUpperCase(), style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px" } }),
    ]);

    const blocks = el(
      "div",
      { className: "briefing" },
      module.lesson.map((block) => this.renderLessonBlock(block)),
    );

    const assessmentBtn = el("button", {
      className: "btn btn--gold",
      text: "TAKE THE ASSESSMENT",
      style: { marginTop: "var(--space-3)" },
      on: { click: () => this.goToQuiz(module.id) },
    });

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "720px", maxHeight: "640px", overflowY: "auto" } }, [header, blocks, assessmentBtn]));
  }

  private renderLessonBlock(block: LessonBlock): HTMLElement {
    if (block.type === "heading") {
      return el("h3", { text: block.text, style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "20px", margin: "var(--space-2) 0" } });
    }
    if (block.type === "paragraph") {
      return el("p", { className: "briefing__body", text: block.text, style: { marginBottom: "var(--space-2)" } });
    }
    if (block.type === "callout") {
      const accent = block.variant === "gold" ? "var(--accent-gold)" : "var(--accent-blue)";
      return el("div", {
        text: block.text,
        style: {
          borderLeft: `4px solid ${accent}`,
          background: "var(--bg-raised)",
          padding: "var(--space-2)",
          borderRadius: "var(--radius-sm)",
          margin: "var(--space-2) 0",
          fontFamily: "var(--font-body)",
          fontSize: "14px",
          color: "var(--text-primary)",
        },
      });
    }
    // evidence-image — same full-screen zoomable viewer the Herald's
    // mission briefings use.
    return el("div", { style: { margin: "var(--space-2) 0" } }, [
      el("button", { className: "btn btn--ghost", text: block.buttonLabel, on: { click: () => showImageOverlay(block.images, block.caption) } }),
    ]);
  }

  // Placeholder — real quiz content lands in a later section.
  private renderQuiz() {
    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "680px" } }, [el("p", { text: "Quiz lands in a later section.", style: { color: "var(--text-muted)" } })]));
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
