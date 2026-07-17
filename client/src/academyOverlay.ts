import Phaser from "phaser";
import { el, countUp } from "./ui/dom";
import { academy, type AcademyTrack, type AcademyModuleSummary, type AcademyModule, type AcademyFieldWork, type LessonBlock, type QuizQuestion } from "./academy";
import { questEngine } from "./questEngine";
import { getSession } from "./session";
import { showImageOverlay, isImageOverlayOpen } from "./ui/imageOverlay";
import type { Room } from "./scenes/Room";

const MODULE_COMPLETE_XP = 100;

function roomCallToAction(room: AcademyFieldWork["room"]): string {
  if (room === "courthouse") return "IN THE COURTHOUSE →";
  if (room === "tavern") return "IN THE TAVERN →";
  return "IN THE VILLAGE →";
}

// Full-screen DOM overlay for the Academy learning hub (see PLAN.md "The
// Academy"). Opens via the HUD button or the Village Square door hotspot
// (no hotkey — a bare "A" would collide with WASD movement) — dim+fade
// backdrop, movement lock (via Room.ts reading academy.isOpen), audio
// duck (via academy.ts itself). Hub (3 track cards), module list
// (field/theory pips), lesson, and quiz views all live in one
// view-switch state machine below.
//
// Scene-bound (constructed with UIOverlay, the one persistent scene,
// same reasoning as HUDController) so the module list's "IN THE VILLAGE
// →" pip can reach the Room scene via the shared SceneManager.
const FADE_MS = 200;

type AcademyView = "hub" | "moduleList" | "lesson" | "quiz";

export class AcademyOverlay {
  private scene: Phaser.Scene;

  private rootEl: HTMLElement;
  private backdropEl: HTMLElement;
  private stageEl: HTMLElement;
  private bodyEl: HTMLElement;
  private hideTimeout: number | undefined;

  private currentView: AcademyView = "hub";
  private currentTrackId: string | null = null;
  private currentModuleId: string | null = null;

  // Mastery-model quiz state — one question at a time, reset whenever a
  // fresh quiz starts or advances (see goToQuiz()/nextQuizQuestion()).
  private quizIndex = 0;
  private quizRevealedChoice: number | null = null;
  private quizCorrect = false;

  private badgeEl: HTMLElement;
  private badgeNameEl: HTMLElement;
  private badgeXpEl: HTMLElement;

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

    // --- Module-complete badge popup — floats above whichever view is
    // showing (module list, typically) rather than living inside bodyEl,
    // since render() rebuilds bodyEl from scratch and would wipe it. ---
    this.badgeNameEl = el("div", { className: "badge-popup__name" });
    this.badgeXpEl = el("span", { text: "0" });
    this.badgeEl = el(
      "div",
      { className: "badge-popup ds-root", style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", pointerEvents: "auto", display: "none", zIndex: "10" } },
      [
        el("div", { className: "badge-popup__icon" }, [this.badgeIconSvg()]),
        el("div", { className: "badge-popup__label", text: "MODULE COMPLETE" }),
        this.badgeNameEl,
        el("div", { className: "badge-popup__xp" }, [this.badgeXpEl, el("span", { text: "XP" })]),
        el("div", { className: "chip", text: "CLICK TO CONTINUE", style: { marginTop: "20px", cursor: "pointer" }, on: { click: () => this.hideBadge() } }),
      ],
    );

    this.rootEl = el("div", { className: "ds-root", style: { position: "absolute", inset: "0", display: "none", pointerEvents: "auto" } }, [this.backdropEl, this.stageEl, closeBtn, this.badgeEl]);
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
    academy.on("moduleCompleted", (moduleId: string) => this.showBadge(moduleId));

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
    this.quizIndex = 0;
    this.quizRevealedChoice = null;
    this.quizCorrect = false;
    this.render();
  }

  // Closes the overlay and sends the player to wherever a module's field
  // work happens — used by the module list's field-work pip. The Herald
  // ping is village-specific flourish (the only room with a ping
  // mechanism); other rooms just get a plain room switch, since the
  // desk/NPC prompt there is already visible once you arrive.
  private goToFieldWork(fieldWork: AcademyFieldWork) {
    academy.close();
    const manager = this.scene.scene.manager;
    const roomScene = manager.getScene("Room") as Room | null;
    if (!roomScene) return;
    const alreadyThere = roomScene.currentRoom === fieldWork.room;
    if (alreadyThere) {
      if (fieldWork.room === "village") roomScene.pingHerald();
    } else {
      manager.start("Room", { room: fieldWork.room });
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

    const module = academy.getModule(summary.id);
    const progress = academy.getProgress(summary.id);
    const pips: HTMLElement[] = [];

    // Theory-only modules (no fieldWork at all) skip this pip entirely
    // rather than showing a misleading "FIELD WORK ✓" for something
    // that was never a real requirement.
    if (module?.fieldWork) {
      const fieldWork = module.fieldWork;
      pips.push(
        progress.fieldDone
          ? el("span", { className: "chip chip--gold", text: "FIELD WORK ✓" })
          : el("button", {
              className: "btn btn--ghost",
              text: `FIELD WORK: ${roomCallToAction(fieldWork.room)}`,
              style: { fontSize: "11px", padding: "8px 12px" },
              on: { click: () => this.goToFieldWork(fieldWork) },
            }),
      );
    }

    pips.push(
      progress.theoryDone
        ? el("span", { className: "chip chip--gold", text: "THEORY ✓" })
        : el("button", { className: "btn btn--gold", text: "THEORY: BEGIN", style: { fontSize: "11px", padding: "8px 12px" }, on: { click: () => this.goToLesson(summary.id) } }),
    );

    return el("div", { className: "quest-card" }, [
      el("div", { className: "quest-card__icon" }),
      el("div", { className: "quest-card__info" }, [
        el("div", { className: "quest-card__title", text: summary.title }),
        el("div", { className: "quest-card__desc", text: `Clearance ${summary.clearanceRequired} required` }),
      ]),
      el("div", { className: "quest-card__meta", style: { gap: "8px" } }, pips),
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

  private renderQuiz() {
    const module = this.currentModuleId ? academy.getModule(this.currentModuleId) : undefined;
    const question = module?.quiz[this.quizIndex];
    if (!module || !question) {
      this.goToHub();
      return;
    }

    const header = el("div", {
      text: `QUESTION ${this.quizIndex + 1} / ${module.quiz.length}`,
      style: { fontFamily: "var(--font-mono)", fontSize: "12px", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: "var(--space-2)" },
    });
    const questionEl = el("h3", { text: question.q, style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px", marginBottom: "var(--space-3)" } });
    const choiceList = el(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
      question.choices.map((choice, i) => this.renderQuizChoice(question, i, choice)),
    );

    const children: HTMLElement[] = [header, questionEl, choiceList];

    if (this.quizRevealedChoice !== null) {
      children.push(
        el("p", {
          text: question.explain[this.quizRevealedChoice],
          style: { marginTop: "var(--space-3)", fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-muted)" },
        }),
      );
    }

    if (this.quizCorrect) {
      const isLast = this.quizIndex >= module.quiz.length - 1;
      children.push(
        el("button", {
          className: "btn btn--gold",
          text: isLast ? "FINISH" : "NEXT",
          style: { marginTop: "var(--space-3)" },
          on: { click: () => this.nextQuizQuestion(module) },
        }),
      );
    }

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "680px" } }, children));
  }

  private renderQuizChoice(question: QuizQuestion, index: number, text: string): HTMLElement {
    const isRevealed = this.quizRevealedChoice === index;
    const isAnswer = index === question.answer;

    const style: Partial<CSSStyleDeclaration> = { width: "100%", justifyContent: "flex-start", textAlign: "left" };
    if (isRevealed) {
      if (isAnswer) {
        style.borderColor = "var(--accent-gold)";
        style.animation = "ds-quiz-correct 500ms ease-out";
      } else {
        style.borderColor = "var(--accent-red)";
        style.animation = "ds-shake 400ms ease-in-out";
      }
    }

    return el("button", { className: "btn btn--ghost", text, style, on: { click: () => this.answerQuiz(index, question) } });
  }

  // No penalty, no score — wrong picks just reveal their explanation and
  // stay retryable (the other choices remain clickable).
  private answerQuiz(index: number, question: QuizQuestion) {
    this.quizRevealedChoice = index;
    this.quizCorrect = index === question.answer;
    this.render();
  }

  private nextQuizQuestion(module: AcademyModule) {
    const isLast = this.quizIndex >= module.quiz.length - 1;
    if (isLast) {
      academy.markTheoryDone(module.id);
      this.goToModuleList(module.track);
      return;
    }
    this.quizIndex++;
    this.quizRevealedChoice = null;
    this.quizCorrect = false;
    this.render();
  }

  private badgeIconSvg(): Node {
    const wrapper = el("div");
    wrapper.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 15.27l-5.2 2.74.99-5.79-4.21-4.1 5.82-.85L12 2z" stroke-linejoin="round"/></svg>';
    return wrapper.firstElementChild!;
  }

  // Guarded to only actually pop while the overlay is visible — if the
  // module completes because the village quest finished second (the
  // player isn't looking at the Academy at all), the toast academy.ts
  // already fires is the only notification; there's no modal for the
  // player to see it land on.
  private showBadge(moduleId: string) {
    if (!academy.isOpen) return;
    const module = academy.getModule(moduleId);
    if (!module) return;
    this.badgeNameEl.textContent = module.title;
    this.badgeEl.style.display = "block";
    countUp(this.badgeXpEl, 0, MODULE_COMPLETE_XP, 900);
  }

  private hideBadge() {
    this.badgeEl.style.display = "none";
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
