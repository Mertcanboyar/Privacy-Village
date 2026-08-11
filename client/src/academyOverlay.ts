import Phaser from "phaser";
import { el, countUp } from "./ui/dom";
import {
  academy,
  type AcademyTrack,
  type AcademyModuleSummary,
  type AcademyLessonModule,
  type AcademyCardDrillModule,
  type AcademyCardDrillMultiModule,
  type AcademyDataSieveModule,
  type AcademyLessonDiagramQuizModule,
  type AcademyFieldWork,
  type CardDrillCard,
  type CardDrillMultiCard,
  type DataSieveCard,
  type LessonBlock,
  type QuizQuestion,
  type DiagramQuizQuestion,
} from "./academy";
import { questEngine } from "./questEngine";
import { getSession } from "./session";
import { showImageOverlay, isImageOverlayOpen } from "./ui/imageOverlay";
import { buildDiagram } from "./ui/diagramReader";
import { logDecision } from "./cloud/save";
import type { Room } from "./scenes/Room";

const MODULE_COMPLETE_XP = 100;

// ~120 words/screen hard cap (see PLAN.md's lesson pagination rule) —
// heading/paragraph blocks accumulate onto the current page until adding
// one would cross the cap, while callout/evidence-image blocks always
// get their own page (they carry one distinct idea each, not prose to
// pack alongside neighbors).
const LESSON_PAGE_WORD_CAP = 120;

function blockWordCount(block: LessonBlock): number {
  return block.type === "evidence-image" ? 0 : block.text.split(/\s+/).filter(Boolean).length;
}

// A handful of reference-style callouts (e.g. the PETs cabinet) run well
// past the cap as one block. Splits on "\n\n" item boundaries first
// (preserving the whiteSpace: pre-line list structure renderLessonBlock
// already relies on) since that's the natural seam in this content;
// falls back to sentence boundaries for a block with no such seams. Each
// resulting chunk stays under the cap on its own, standalone chunks
// heavier than the cap included — same "own page regardless" carve-out
// paginateLessonBlocks uses elsewhere.
function splitOversizedText(text: string): string[] {
  const items = text.split(/\n\n+/).filter(Boolean);
  const segments = items.length > 1 ? items : text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const joiner = items.length > 1 ? "\n\n" : " ";
  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const seg of segments) {
    const w = seg.split(/\s+/).filter(Boolean).length;
    if (current.length && words + w > LESSON_PAGE_WORD_CAP) {
      chunks.push(current.join(joiner));
      current = [];
      words = 0;
    }
    current.push(seg);
    words += w;
  }
  if (current.length) chunks.push(current.join(joiner));
  return chunks;
}

function splitOversizedBlocks(blocks: LessonBlock[]): LessonBlock[] {
  const out: LessonBlock[] = [];
  for (const block of blocks) {
    if ((block.type === "paragraph" || block.type === "callout") && blockWordCount(block) > LESSON_PAGE_WORD_CAP) {
      for (const chunk of splitOversizedText(block.text)) {
        out.push({ ...block, text: chunk });
      }
    } else {
      out.push(block);
    }
  }
  return out;
}

function paginateLessonBlocks(rawBlocks: LessonBlock[]): LessonBlock[][] {
  const blocks = splitOversizedBlocks(rawBlocks);
  const pages: LessonBlock[][] = [];
  let current: LessonBlock[] = [];
  let currentWords = 0;
  for (const block of blocks) {
    const words = blockWordCount(block);
    // A page already over the cap breaks before adding more, unless it's
    // still empty (a single block heavier than the cap gets its own page
    // rather than an infinite loop). Never break BEFORE a callout/
    // evidence-image — it's meant to punctuate whatever led into it.
    if (current.length && currentWords + words > LESSON_PAGE_WORD_CAP) {
      pages.push(current);
      current = [];
      currentWords = 0;
    }
    current.push(block);
    currentWords += words;
    // A callout/evidence-image always ends its page — it carries one
    // distinct idea, so nothing unrelated gets appended after it.
    if (block.type === "callout" || block.type === "evidence-image") {
      pages.push(current);
      current = [];
      currentWords = 0;
    }
  }
  if (current.length) pages.push(current);
  return pages.length ? pages : [[]];
}

function roomCallToAction(room: AcademyFieldWork["room"]): string {
  if (room === "courthouse") return "IN THE COURTHOUSE →";
  if (room === "tavern") return "IN THE TAVERN →";
  if (room === "great_hall") return "IN THE GREAT HALL →";
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

type AcademyView = "hub" | "moduleList" | "lesson" | "quiz" | "cardDrillIntro" | "cardDrill" | "cardDrillMultiIntro" | "cardDrillMulti" | "dataSieve" | "diagramQuiz";

// Attempt counter for decision-log rows (see answerQuiz()/answerCardDrill()/
// answerCardDrillMulti()) — keyed by module+question/item so a retry on
// the SAME question increments rather than a fresh count each time.
// Same pattern as npc.ts's choiceAttempts.
const answerAttempts = new Map<string, number>();

function nextAnswerAttempt(key: string): number {
  const n = (answerAttempts.get(key) ?? 0) + 1;
  answerAttempts.set(key, n);
  return n;
}

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

  // Lesson pagination — which screen of the current module's lesson
  // blocks is showing, reset to 0 every time a lesson is (re-)entered
  // (see goToLesson()). Recomputing pages from module.lesson on every
  // render() (rather than caching them) keeps this a single source of
  // truth with paginateLessonBlocks() doing the real work.
  private lessonPageIndex = 0;

  // Mastery-model quiz state — one question at a time, reset whenever a
  // fresh quiz starts or advances (see goToQuiz()/nextQuizQuestion()).
  private quizIndex = 0;
  private quizRevealedChoice: number | null = null;
  private quizCorrect = false;

  // "Mapping the Flow"'s interactive-diagram assessment — same one-
  // question-at-a-time mastery/retry convention as the quiz above, but
  // Q1-4 answer by clicking an element on a rendered DFD instead of
  // picking text (see renderDiagramQuiz()/answerDiagramQuizClick()).
  // pickedElementId is only meaningful for "diagram" questions,
  // pickedChoiceIndex only for the one "choice" question (Q5).
  private diagramQuizIndex = 0;
  private diagramQuizRevealed = false;
  private diagramQuizCorrect = false;
  private diagramQuizPickedElementId: string | null = null;
  private diagramQuizPickedChoiceIndex: number | null = null;

  // Card drill state — a working queue (not the original module.cards
  // array): correct answers shift the front card off, wrong answers
  // re-queue it to the end, so drillDeck.length === 0 exactly when every
  // card has been answered correctly once (see answerCardDrill()).
  private drillDeck: CardDrillCard[] = [];
  private drillTotalCards = 0;
  private drillClearedCount = 0;
  private drillRevealed = false;
  private drillPicked: boolean | null = null;
  private drillCorrect = false;

  // Card drill (multi) state — same working-queue mastery pattern as the
  // binary drill above, generalized to N labeled choices instead of a
  // true/false pair (see renderCardDrillMulti()/answerCardDrillMulti()).
  private drillMultiDeck: CardDrillMultiCard[] = [];
  private drillMultiTotalCards = 0;
  private drillMultiClearedCount = 0;
  private drillMultiRevealed = false;
  private drillMultiPickedIndex: number | null = null;
  private drillMultiCorrect = false;
  // Collapsible reference strip (e.g. "THE SIX: ...") — starts collapsed
  // each time a fresh drill begins (see goToCardDrillMulti()).
  private referenceExpanded = false;

  // Data sieve state — all cards shown at once, toggled freely until
  // validated (see renderDataSieve()/toggleSieveCard()/validateSieve()).
  private sieveRemoved = new Set<string>();
  private sieveValidated = false;

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
      // Set by npc.ts's locked-quest dialogue shortcut (see academy.ts's
      // openToModule()) — jump straight to that module's theory instead
      // of the hub. goToTheory() calls render() itself, so the plain
      // hub branch below is the only one that needs its own.
      const pendingModuleId = academy.consumePendingModuleId();
      const pendingModule = pendingModuleId ? academy.getModule(pendingModuleId) : undefined;
      if (pendingModule) {
        this.currentTrackId = pendingModule.track;
        this.goToTheory(pendingModule.id);
      } else {
        this.currentView = "hub";
        this.currentTrackId = null;
        this.currentModuleId = null;
        this.render();
      }
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
    else if (this.currentView === "quiz") this.renderQuiz();
    else if (this.currentView === "cardDrillIntro") this.renderCardDrillIntro();
    else if (this.currentView === "cardDrill") this.renderCardDrill();
    else if (this.currentView === "cardDrillMultiIntro") this.renderCardDrillMultiIntro();
    else if (this.currentView === "cardDrillMulti") this.renderCardDrillMulti();
    else if (this.currentView === "dataSieve") this.renderDataSieve();
    else this.renderDiagramQuiz();
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

  // Module list's "THEORY: BEGIN" — routes to the lesson+quiz flow, the
  // card-drill intro, or the data-sieve screen depending on the
  // module's content type.
  private goToTheory(moduleId: string) {
    const module = academy.getModule(moduleId);
    if (module?.type === "card_drill") this.goToCardDrillIntro(moduleId);
    else if (module?.type === "card_drill_multi") this.goToCardDrillMultiIntro(moduleId);
    else if (module?.type === "data_sieve") this.goToDataSieve(moduleId);
    else this.goToLesson(moduleId);
  }

  private goToLesson(moduleId: string) {
    this.currentModuleId = moduleId;
    this.currentView = "lesson";
    this.lessonPageIndex = 0;
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

  private goToCardDrillIntro(moduleId: string) {
    this.currentModuleId = moduleId;
    this.currentView = "cardDrillIntro";
    this.render();
  }

  private goToCardDrill(module: AcademyCardDrillModule) {
    this.currentModuleId = module.id;
    this.currentView = "cardDrill";
    this.drillDeck = [...module.cards];
    this.drillTotalCards = module.cards.length;
    this.drillClearedCount = 0;
    this.drillRevealed = false;
    this.drillPicked = null;
    this.render();
  }

  private goToCardDrillMultiIntro(moduleId: string) {
    this.currentModuleId = moduleId;
    this.currentView = "cardDrillMultiIntro";
    this.render();
  }

  private goToCardDrillMulti(module: AcademyCardDrillMultiModule) {
    this.currentModuleId = module.id;
    this.currentView = "cardDrillMulti";
    this.drillMultiDeck = [...module.cards];
    this.drillMultiTotalCards = module.cards.length;
    this.drillMultiClearedCount = 0;
    this.drillMultiRevealed = false;
    this.drillMultiPickedIndex = null;
    this.referenceExpanded = false;
    this.render();
  }

  private goToDataSieve(moduleId: string) {
    this.currentModuleId = moduleId;
    this.currentView = "dataSieve";
    this.sieveRemoved = new Set();
    this.sieveValidated = false;
    this.render();
  }

  private goToDiagramQuiz(moduleId: string) {
    this.currentModuleId = moduleId;
    this.currentView = "diagramQuiz";
    this.diagramQuizIndex = 0;
    this.diagramQuizRevealed = false;
    this.diagramQuizCorrect = false;
    this.diagramQuizPickedElementId = null;
    this.diagramQuizPickedChoiceIndex = null;
    this.render();
  }

  // Pings whichever NPC a module's field work belongs to — but only if
  // the player happens to already be standing in that room right now
  // (there's no NPC sprite to tween otherwise). Shared by goToFieldWork()
  // (explicit "take me there" click) and sealTheory() (the passive
  // "theory just sealed, here's where to go" handoff — see PLAN's
  // onboarding fix).
  private pingFieldWorkNpc(fieldWork: AcademyFieldWork) {
    const manager = this.scene.scene.manager;
    const roomScene = manager.getScene("Room") as Room | null;
    if (!roomScene || roomScene.currentRoom !== fieldWork.room) return;
    const ping = fieldWork.ping ?? "herald";
    if (fieldWork.room === "village" && ping === "herald") roomScene.pingHerald();
    else if (fieldWork.room === "village" && ping === "bram") roomScene.pingBram();
    else if (fieldWork.room === "great_hall" && ping === "mayor") roomScene.pingMayor();
    else if (fieldWork.room === "village" && ping === "courthouseDoor") roomScene.pingCourthouseDoor();
    else if (fieldWork.room === "tavern" && ping === "maren") roomScene.pingMaren();
    else if (fieldWork.room === "courthouse" && ping === "quill") roomScene.pingQuill();
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
    if (roomScene.currentRoom === fieldWork.room) {
      this.pingFieldWorkNpc(fieldWork);
    } else {
      const ping = fieldWork.ping ?? "herald";
      manager.start("Room", { room: fieldWork.room, pingCourthouseDoor: fieldWork.room === "village" && ping === "courthouseDoor" });
    }
  }

  // Wraps academy.markTheoryDone() with the study-first inversion's
  // "explicit handoff" — the toast ("THEORY SEALED — your field
  // assignment is now open...") already fires from inside
  // markTheoryDone() itself; this adds the visual half, pinging the
  // quest-giver NPC if the player happens to already be standing where
  // they'd need to go (see pingFieldWorkNpc()'s doc comment). Skipped
  // once field work is already done (nothing to hand off to).
  private sealTheory(moduleId: string) {
    academy.markTheoryDone(moduleId);
    const module = academy.getModule(moduleId);
    if (module?.fieldWork && !academy.getProgress(moduleId).fieldDone) this.pingFieldWorkNpc(module.fieldWork);
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

  // Study-first inversion (see PLAN): a module's THEORY is available the
  // moment its track order allows it — NO clearance gate at all
  // (`clearanceRequired`/questEngine.getClearance() are no longer read
  // here). A module's FIELD WORK pip stays inert until theory seals,
  // since the paired quest-giver is now genuinely LOCKED until then
  // (academy.ts's markTheoryDone() is what unlocks it).
  private renderModuleCard(summary: AcademyModuleSummary): HTMLElement {
    if (!summary.hasContent) {
      return el("div", { className: "quest-card", style: { opacity: "0.5" } }, [
        el("div", { className: "quest-card__icon" }),
        el("div", { className: "quest-card__info" }, [el("div", { className: "quest-card__title", text: summary.title })]),
        el("div", { className: "quest-card__meta" }, [el("span", { className: "chip", text: "IN DEVELOPMENT" })]),
      ]);
    }

    const module = academy.getModule(summary.id);
    const progress = academy.getProgress(summary.id);

    // Sequenced (see PLAN's per-track ordering + academy.ts's
    // isTheoryUnlocked()) — module N+1 stays inert until module N's
    // theory seals, named explicitly rather than a bare "locked" so the
    // player always knows exactly what to go do next. Skipped for a
    // module the player already has real progress on (retroactive field
    // work from before this ordering existed, or theory done some other
    // way) — PLAN's "do not revoke anything" covers visibility too, not
    // just the underlying progress data, so a real FIELD WORK ✓ never
    // hides behind a sequence-lock card.
    const hasRealProgress = progress.theoryDone || (progress.fieldDone && !!module?.fieldWork);
    if (module && !hasRealProgress && !academy.isTheoryUnlocked(module.track, summary.order)) {
      const prior = academy.getPriorModule(module.track, summary.order);
      return el("div", { className: "quest-card", style: { opacity: "0.5" } }, [
        el("div", { className: "quest-card__icon" }),
        el("div", { className: "quest-card__info" }, [el("div", { className: "quest-card__title", text: summary.title })]),
        el("div", { className: "quest-card__meta" }, [
          el("span", { className: "chip", text: prior ? `Complete "${prior.title}" first` : "LOCKED" }),
        ]),
      ]);
    }
    const pips: HTMLElement[] = [];

    // THEORY first (left) — it's the gate, so it reads before the pip
    // it unlocks.
    if (module?.theoryInDevelopment) {
      pips.push(el("span", { className: "chip", text: "THEORY: IN DEVELOPMENT" }));
    } else {
      pips.push(
        progress.theoryDone
          ? el("span", { className: "chip chip--gold", text: "THEORY ✓" })
          : el("button", { className: "btn btn--gold", text: "THEORY: BEGIN", style: { fontSize: "11px", padding: "8px 12px" }, on: { click: () => this.goToTheory(summary.id) } }),
      );
    }

    // Theory-only modules (no fieldWork at all) skip this pip entirely
    // rather than showing a misleading "FIELD WORK ✓" for something
    // that was never a real requirement. A fieldWork module's quest-
    // giver won't offer it until theory seals, so there's nothing to
    // route to yet — show LOCKED instead of a button that would just
    // bounce off the NPC (see npc.ts's locked-quest dialogue).
    if (module?.fieldWork) {
      const fieldWork = module.fieldWork;
      pips.push(
        progress.fieldDone
          ? el("span", { className: "chip chip--gold", text: "FIELD WORK ✓" })
          : progress.theoryDone
            ? el("button", {
                className: "btn btn--ghost",
                text: `FIELD WORK: ${roomCallToAction(fieldWork.room)}`,
                style: { fontSize: "11px", padding: "8px 12px" },
                on: { click: () => this.goToFieldWork(fieldWork) },
              })
            : el("span", { className: "chip", text: "FIELD WORK: LOCKED" }),
      );
    }

    return el("div", { className: "quest-card" }, [
      el("div", { className: "quest-card__icon" }),
      el("div", { className: "quest-card__info" }, [el("div", { className: "quest-card__title", text: summary.title })]),
      el("div", { className: "quest-card__meta", style: { gap: "8px" } }, pips),
    ]);
  }

  private renderLesson() {
    const module = this.currentModuleId ? academy.getModule(this.currentModuleId) : undefined;
    if (!module || module.type === "card_drill" || module.type === "card_drill_multi" || module.type === "data_sieve") {
      this.goToHub();
      return;
    }

    const pages = paginateLessonBlocks(module.lesson);
    this.lessonPageIndex = Phaser.Math.Clamp(this.lessonPageIndex, 0, pages.length - 1);
    const isLastPage = this.lessonPageIndex >= pages.length - 1;

    const header = el("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" } }, [
      el("button", { className: "btn btn--ghost", text: "← BACK", on: { click: () => this.goToModuleList(module.track) } }),
      el("h2", { text: module.title.toUpperCase(), style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px" } }),
    ]);

    const dots = el(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", margin: "0 0 var(--space-3)" } },
      [
        ...pages.map((_, i) =>
          el("span", {
            style: {
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              background: i <= this.lessonPageIndex ? "var(--accent-gold)" : "var(--border-strong)",
            },
          }),
        ),
        el("span", {
          text: `${this.lessonPageIndex + 1} of ${pages.length}`,
          style: { marginLeft: "8px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)" },
        }),
      ],
    );

    const blocks = el(
      "div",
      { className: "briefing" },
      pages[this.lessonPageIndex].map((block) => this.renderLessonBlock(block)),
    );

    const isDiagramQuiz = module.type === "lesson_diagramquiz";
    const navRow = el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "var(--space-3)" } }, [
      this.lessonPageIndex > 0
        ? el("button", { className: "btn btn--ghost", text: "◂ BACK", on: { click: () => this.goToLessonPage(this.lessonPageIndex - 1) } })
        : el("span", {}),
      isLastPage
        ? el("button", {
            className: "btn btn--gold",
            text: isDiagramQuiz ? "READ THE DIAGRAM" : "TAKE THE ASSESSMENT",
            on: { click: () => (isDiagramQuiz ? this.goToDiagramQuiz(module.id) : this.goToQuiz(module.id)) },
          })
        : el("button", {
            className: "btn btn--gold",
            text: "CONTINUE ▸",
            on: { click: () => this.goToLessonPage(this.lessonPageIndex + 1) },
          }),
    ]);

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "720px", maxHeight: "640px", overflowY: "auto" } }, [header, dots, blocks, navRow]));
  }

  private goToLessonPage(pageIndex: number) {
    this.lessonPageIndex = pageIndex;
    this.render();
  }

  private renderLessonBlock(block: LessonBlock): HTMLElement {
    if (block.type === "heading") {
      return el("h3", { text: block.text, style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "20px", margin: "var(--space-2) 0" } });
    }
    if (block.type === "paragraph") {
      return el("p", { className: "briefing__body", text: block.text, style: { marginBottom: "var(--space-2)" } });
    }
    if (block.type === "callout") {
      const accent = block.variant === "gold" ? "var(--accent-gold)" : block.variant === "danger" ? "var(--accent-red)" : "var(--accent-blue)";
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
          // \n-separated multi-item callouts (e.g. "Mapping the Flow"'s
          // four-symbols/depth-layers lists) need this to actually break
          // lines — every prior callout was a single sentence, so this
          // was never load-bearing before.
          whiteSpace: "pre-line",
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
    if (!module || module.type === "card_drill" || module.type === "card_drill_multi" || module.type === "data_sieve" || module.type === "lesson_diagramquiz") {
      this.goToHub();
      return;
    }
    const question = module.quiz[this.quizIndex];
    if (!question) {
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

    const attemptKey = `${this.currentModuleId}:${this.quizIndex}`;
    logDecision("module_quiz_answer", {
      module: this.currentModuleId,
      question: question.q,
      questionIndex: this.quizIndex,
      correct: this.quizCorrect,
      attempt: nextAnswerAttempt(attemptKey),
    });

    this.render();
  }

  private nextQuizQuestion(module: AcademyLessonModule) {
    const isLast = this.quizIndex >= module.quiz.length - 1;
    if (isLast) {
      this.sealTheory(module.id);
      this.goToModuleList(module.track);
      return;
    }
    this.quizIndex++;
    this.quizRevealedChoice = null;
    this.quizCorrect = false;
    this.render();
  }

  private renderCardDrillIntro() {
    const module = this.currentModuleId ? academy.getModule(this.currentModuleId) : undefined;
    if (!module || module.type !== "card_drill") {
      this.goToHub();
      return;
    }

    const header = el("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" } }, [
      el("button", { className: "btn btn--ghost", text: "← BACK", on: { click: () => this.goToModuleList(module.track) } }),
      el("h2", { text: module.title.toUpperCase(), style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px" } }),
    ]);

    const intro = el("p", { className: "briefing__body", text: module.intro });

    const beginBtn = el("button", {
      className: "btn btn--gold",
      text: "BEGIN DRILL",
      style: { marginTop: "var(--space-3)" },
      on: { click: () => this.goToCardDrill(module) },
    });

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "680px" } }, [header, intro, beginBtn]));
  }

  private renderCardDrill() {
    const module = this.currentModuleId ? academy.getModule(this.currentModuleId) : undefined;
    if (!module || module.type !== "card_drill") {
      this.goToHub();
      return;
    }
    const card = this.drillDeck[0];
    if (!card) {
      // advanceCardDrill() already navigates away the instant the deck
      // clears — this is just a guard against rendering an empty state.
      this.goToModuleList(module.track);
      return;
    }

    const dots = el(
      "div",
      { style: { display: "flex", gap: "6px", justifyContent: "center", marginBottom: "var(--space-4)" } },
      Array.from({ length: this.drillTotalCards }, (_, i) =>
        el("span", {
          style: {
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: i < this.drillClearedCount ? "var(--accent-gold)" : "var(--border-strong)",
          },
        }),
      ),
    );

    const itemEl = el("p", {
      text: card.item,
      style: { fontFamily: "var(--font-body)", fontSize: "20px", textAlign: "center", margin: "var(--space-4) 0" },
    });

    const children: HTMLElement[] = [dots, itemEl];

    if (!this.drillRevealed) {
      children.push(
        el("div", { style: { display: "flex", gap: "var(--space-2)" } }, [
          el("button", { className: "btn btn--gold", text: module.trueLabel, style: { flex: "1" }, on: { click: () => this.answerCardDrill(true) } }),
          el("button", { className: "btn btn--ghost", text: module.falseLabel, style: { flex: "1" }, on: { click: () => this.answerCardDrill(false) } }),
        ]),
      );
    } else {
      // Click-to-advance lives on this wrapper only — it doesn't exist
      // yet while the two answer buttons above are showing, so there's
      // no bubbling conflict between "pick an answer" and "tap to
      // continue" sharing a click zone.
      children.push(
        el("div", { style: { cursor: "pointer" }, on: { click: () => this.advanceCardDrill() } }, [
          this.renderCardDrillFeedbackButtons(module),
          el("p", {
            text: card.explain,
            style: { marginTop: "var(--space-3)", fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-muted)" },
          }),
          el("div", {
            text: "CONTINUE ▸",
            style: {
              marginTop: "var(--space-2)",
              textAlign: "center",
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              fontWeight: "700",
              letterSpacing: "0.08em",
              color: "var(--accent-gold)",
              animation: "ds-pulse 1.6s ease-in-out infinite",
            },
          }),
        ]),
      );
    }

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "680px" } }, children));
  }

  private renderCardDrillFeedbackButtons(module: AcademyCardDrillModule): HTMLElement {
    const feedbackStyle: Partial<CSSStyleDeclaration> = this.drillCorrect
      ? { borderColor: "var(--accent-gold)", animation: "ds-quiz-correct 500ms ease-out" }
      : { borderColor: "var(--accent-red)", animation: "ds-shake 400ms ease-in-out" };

    const trueStyle: Partial<CSSStyleDeclaration> = { flex: "1", pointerEvents: "none" };
    const falseStyle: Partial<CSSStyleDeclaration> = { flex: "1", pointerEvents: "none" };
    if (this.drillPicked === true) Object.assign(trueStyle, feedbackStyle);
    else Object.assign(falseStyle, feedbackStyle);

    return el("div", { style: { display: "flex", gap: "var(--space-2)" } }, [
      el("button", { className: "btn btn--gold", text: module.trueLabel, style: trueStyle }),
      el("button", { className: "btn btn--ghost", text: module.falseLabel, style: falseStyle }),
    ]);
  }

  // No penalty, no score — wrong picks re-queue to the end of the deck
  // (see advanceCardDrill()) rather than retrying immediately.
  private answerCardDrill(picked: boolean) {
    const card = this.drillDeck[0];
    if (!card || this.drillRevealed) return;
    this.drillRevealed = true;
    this.drillPicked = picked;
    this.drillCorrect = picked === card.answer;

    logDecision("module_card_drill_answer", {
      module: this.currentModuleId,
      item: card.item,
      picked,
      correct: this.drillCorrect,
      attempt: nextAnswerAttempt(`${this.currentModuleId}:${card.item}`),
    });

    this.render();
  }

  private advanceCardDrill() {
    const module = this.currentModuleId ? academy.getModule(this.currentModuleId) : undefined;
    const card = this.drillDeck.shift();
    if (!card) return;

    if (this.drillCorrect) this.drillClearedCount++;
    else this.drillDeck.push(card);
    this.drillRevealed = false;
    this.drillPicked = null;

    if (this.drillDeck.length === 0) {
      if (module) {
        this.sealTheory(module.id);
        this.goToModuleList(module.track);
      } else {
        this.goToHub();
      }
      return;
    }
    this.render();
  }

  private renderCardDrillMultiIntro() {
    const module = this.currentModuleId ? academy.getModule(this.currentModuleId) : undefined;
    if (!module || module.type !== "card_drill_multi") {
      this.goToHub();
      return;
    }

    const header = el("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" } }, [
      el("button", { className: "btn btn--ghost", text: "← BACK", on: { click: () => this.goToModuleList(module.track) } }),
      el("h2", { text: module.title.toUpperCase(), style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px" } }),
    ]);

    const intro = el("p", { className: "briefing__body", text: module.intro });

    const beginBtn = el("button", {
      className: "btn btn--gold",
      text: "BEGIN DRILL",
      style: { marginTop: "var(--space-3)" },
      on: { click: () => this.goToCardDrillMulti(module) },
    });

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "680px" } }, [header, intro, beginBtn]));
  }

  // Collapsed by default (see goToCardDrillMulti()) — a one-line mono
  // label toggles a small block of reference text pinned above the deck
  // (e.g. "THE SIX: CONSENT · CONTRACT · ..."), so it's available without
  // permanently eating vertical space every card needs.
  private renderReferenceStrip(text: string): HTMLElement {
    const label = text.split(":")[0] ?? "REFERENCE";
    const children: HTMLElement[] = [
      el("div", {
        text: `${this.referenceExpanded ? "▾" : "▸"} ${label}`,
        style: { cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.06em", color: "var(--text-muted)" },
        on: {
          click: () => {
            this.referenceExpanded = !this.referenceExpanded;
            this.render();
          },
        },
      }),
    ];
    if (this.referenceExpanded) {
      children.push(el("div", { text, style: { fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-primary)", marginTop: "6px" } }));
    }
    return el(
      "div",
      { style: { border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)", padding: "8px 12px", marginBottom: "var(--space-3)", background: "var(--bg-raised)" } },
      children,
    );
  }

  private renderCardDrillMulti() {
    const module = this.currentModuleId ? academy.getModule(this.currentModuleId) : undefined;
    if (!module || module.type !== "card_drill_multi") {
      this.goToHub();
      return;
    }
    const card = this.drillMultiDeck[0];
    if (!card) {
      // advanceCardDrillMulti() already navigates away the instant the
      // deck clears — this is just a guard against an empty render.
      this.goToModuleList(module.track);
      return;
    }

    const children: HTMLElement[] = [];
    if (module.referenceStrip) children.push(this.renderReferenceStrip(module.referenceStrip));

    children.push(
      el(
        "div",
        { style: { display: "flex", gap: "6px", justifyContent: "center", marginBottom: "var(--space-4)" } },
        Array.from({ length: this.drillMultiTotalCards }, (_, i) =>
          el("span", {
            style: {
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              background: i < this.drillMultiClearedCount ? "var(--accent-gold)" : "var(--border-strong)",
            },
          }),
        ),
      ),
    );

    children.push(
      el("p", { text: card.item, style: { fontFamily: "var(--font-body)", fontSize: "20px", textAlign: "center", margin: "var(--space-4) 0" } }),
    );

    if (!this.drillMultiRevealed) {
      children.push(
        el(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
          card.choices.map((choice, i) =>
            el("button", {
              className: "btn btn--ghost",
              text: choice,
              style: { width: "100%", justifyContent: "flex-start", textAlign: "left" },
              on: { click: () => this.answerCardDrillMulti(i) },
            }),
          ),
        ),
      );
    } else {
      // Click-to-advance wrapper, same reasoning as the binary drill:
      // it doesn't exist while the choice buttons above are live, so
      // there's no bubbling conflict between "pick an answer" and "tap
      // to continue" sharing a click zone.
      children.push(
        el("div", { style: { cursor: "pointer" }, on: { click: () => this.advanceCardDrillMulti() } }, [
          this.renderCardDrillMultiFeedbackChoices(card),
          el("p", {
            text: card.explain[this.drillMultiPickedIndex!],
            style: { marginTop: "var(--space-3)", fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-muted)" },
          }),
          el("div", {
            text: "CONTINUE ▸",
            style: {
              marginTop: "var(--space-2)",
              textAlign: "center",
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              fontWeight: "700",
              letterSpacing: "0.08em",
              color: "var(--accent-gold)",
              animation: "ds-pulse 1.6s ease-in-out infinite",
            },
          }),
        ]),
      );
    }

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "680px" } }, children));
  }

  private renderCardDrillMultiFeedbackChoices(card: CardDrillMultiCard): HTMLElement {
    return el(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
      card.choices.map((choice, i) => {
        // All choices lock during reveal ("disabled for this pass") —
        // only the picked one gets feedback styling, mirroring the
        // binary drill's pointerEvents:"none" treatment.
        const style: Partial<CSSStyleDeclaration> = { width: "100%", justifyContent: "flex-start", textAlign: "left", pointerEvents: "none" };
        if (i === this.drillMultiPickedIndex) {
          if (this.drillMultiCorrect) {
            style.borderColor = "var(--accent-gold)";
            style.animation = "ds-quiz-correct 500ms ease-out";
          } else {
            style.borderColor = "var(--accent-red)";
            style.animation = "ds-shake 400ms ease-in-out";
          }
        }
        return el("button", { className: "btn btn--ghost", text: choice, style });
      }),
    );
  }

  // No penalty, no score — wrong picks re-queue to the end of the deck
  // (see advanceCardDrillMulti()) rather than retrying immediately.
  private answerCardDrillMulti(index: number) {
    const card = this.drillMultiDeck[0];
    if (!card || this.drillMultiRevealed) return;
    this.drillMultiRevealed = true;
    this.drillMultiPickedIndex = index;
    this.drillMultiCorrect = index === card.answerIndex;
    logDecision("module_card_drill_multi_answer", {
      module: this.currentModuleId,
      item: card.item,
      picked: card.choices[index],
      correct: this.drillMultiCorrect,
      attempt: nextAnswerAttempt(`${this.currentModuleId}:${card.item}`),
    });
    this.render();
  }

  private advanceCardDrillMulti() {
    const module = this.currentModuleId ? academy.getModule(this.currentModuleId) : undefined;
    const card = this.drillMultiDeck.shift();
    if (!card) return;

    if (this.drillMultiCorrect) this.drillMultiClearedCount++;
    else this.drillMultiDeck.push(card);
    this.drillMultiRevealed = false;
    this.drillMultiPickedIndex = null;

    if (this.drillMultiDeck.length === 0) {
      if (module) {
        this.sealTheory(module.id);
        this.goToModuleList(module.track);
      } else {
        this.goToHub();
      }
      return;
    }
    this.render();
  }

  private renderDataSieve() {
    const module = this.currentModuleId ? academy.getModule(this.currentModuleId) : undefined;
    if (!module || module.type !== "data_sieve") {
      this.goToHub();
      return;
    }

    const header = el("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" } }, [
      el("button", { className: "btn btn--ghost", text: "← BACK", on: { click: () => this.goToModuleList(module.track) } }),
      el("h2", { text: module.title.toUpperCase(), style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px" } }),
    ]);

    const goalBox = el(
      "div",
      { style: { borderLeft: "4px solid var(--accent-blue)", background: "var(--bg-raised)", padding: "8px 12px", borderRadius: "var(--radius-sm)", marginBottom: "var(--space-2)" } },
      [
        el("span", { text: "GOAL: ", style: { fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.06em", color: "var(--accent-blue)", fontWeight: "700" } }),
        el("span", { text: module.aiGoal, style: { fontFamily: "var(--font-body)", fontSize: "13px", fontWeight: "600", color: "var(--text-primary)" } }),
      ],
    );

    const briefP = el("p", { className: "briefing__body", text: module.brief, style: { fontSize: "13px", marginBottom: "var(--space-2)" } });

    const cardsList = el(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "6px" } },
      module.cards.map((card) => this.renderSieveCard(card)),
    );

    const children: HTMLElement[] = [header, goalBox, briefP, cardsList];

    if (!this.sieveValidated) {
      children.push(
        el("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "var(--space-2)" } }, [
          el("span", {
            text: `${this.sieveRemoved.size} of ${module.cards.length} marked for removal`,
            style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)" },
          }),
          el("button", { className: "btn btn--gold", text: "RUN THE SIEVE", on: { click: () => this.validateSieve() } }),
        ]),
      );
    } else {
      children.push(
        el("button", {
          className: "btn btn--gold",
          text: "COMPLETE",
          style: { marginTop: "var(--space-2)" },
          on: { click: () => this.completeDataSieve(module) },
        }),
      );
    }

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "680px" } }, children));
  }

  // Single row per card, doing double duty: before validation it's a
  // toggle; after validation it's the SAME row with a correct/wrong
  // border and its reason appended inline, rather than a second full
  // list repeating every card underneath (the original layout scrolled
  // badly because it showed each card twice).
  private renderSieveCard(card: DataSieveCard): HTMLElement {
    const isRemoved = this.sieveRemoved.has(card.id);
    const style: Partial<CSSStyleDeclaration> = {
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      padding: "8px 12px",
      borderRadius: "var(--radius-sm)",
      border: "2px solid var(--border-strong)",
      background: "var(--bg-panel)",
      cursor: this.sieveValidated ? "default" : "pointer",
    };
    if (this.sieveValidated) {
      style.borderColor = isRemoved === card.shouldRemove ? "var(--accent-gold)" : "var(--accent-red)";
    } else if (isRemoved) {
      style.opacity = "0.55";
    }

    const titleRow = el("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" } }, [
      el("span", {
        text: card.label,
        style: {
          fontFamily: "var(--font-body)",
          fontSize: "13px",
          fontWeight: "600",
          textDecoration: isRemoved && !this.sieveValidated ? "line-through" : "none",
          color: isRemoved && !this.sieveValidated ? "var(--text-muted)" : "var(--text-primary)",
        },
      }),
      el("span", { className: isRemoved ? "chip" : "chip chip--gold", text: isRemoved ? "SIEVE OUT" : "KEEP THIS FIELD" }),
    ]);

    const rowChildren: HTMLElement[] = [titleRow];
    if (this.sieveValidated) {
      rowChildren.push(el("p", { text: card.reason, style: { fontFamily: "var(--font-body)", fontSize: "12px", color: "var(--text-muted)", margin: "0" } }));
    }

    return el("div", { style, on: this.sieveValidated ? {} : { click: () => this.toggleSieveCard(card.id) } }, rowChildren);
  }

  private toggleSieveCard(id: string) {
    if (this.sieveRemoved.has(id)) this.sieveRemoved.delete(id);
    else this.sieveRemoved.add(id);
    this.render();
  }

  private validateSieve() {
    this.sieveValidated = true;
    this.render();
  }

  private completeDataSieve(module: AcademyDataSieveModule) {
    this.sealTheory(module.id);
    this.goToModuleList(module.track);
  }

  // "Mapping the Flow"'s interactive-diagram assessment — same mastery/
  // retry shell as renderQuiz() (question counter, explanation on
  // reveal, NEXT/FINISH once correct), but Q1-4 render a clickable DFD
  // instead of text choices. No back button, matching renderQuiz()'s
  // own precedent (once a quiz/assessment starts, ESC to fully close
  // the Academy is the only way out — not a per-question back step).
  private renderDiagramQuiz() {
    const module = this.currentModuleId ? academy.getModule(this.currentModuleId) : undefined;
    if (!module || module.type !== "lesson_diagramquiz") {
      this.goToHub();
      return;
    }
    const question = module.questions[this.diagramQuizIndex];
    if (!question) {
      this.goToHub();
      return;
    }

    const header = el("div", {
      text: `QUESTION ${this.diagramQuizIndex + 1} / ${module.questions.length}`,
      style: { fontFamily: "var(--font-mono)", fontSize: "12px", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: "var(--space-2)" },
    });
    const questionEl = el("h3", { text: question.prompt, style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px", marginBottom: "var(--space-2)" } });

    const children: HTMLElement[] = [header, questionEl];

    if (question.kind === "diagram") {
      const reader = buildDiagram(module.diagram.nodes, module.diagram.arrows, (id) => this.answerDiagramQuizElement(id, question));
      if (this.diagramQuizRevealed) {
        if (this.diagramQuizCorrect) {
          for (const id of question.correctIds) reader.setHighlight(id, "correct");
        } else if (this.diagramQuizPickedElementId) {
          reader.setHighlight(this.diagramQuizPickedElementId, "wrong");
        }
      }
      children.push(reader.containerEl);
    } else {
      children.push(
        el(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
          question.choices.map((choice, i) => this.renderDiagramQuizChoice(question, i, choice)),
        ),
      );
    }

    if (this.diagramQuizRevealed) {
      const explainText =
        question.kind === "diagram"
          ? this.diagramQuizCorrect
            ? question.explain
            : this.roleExplainFor(module, this.diagramQuizPickedElementId)
          : question.explain[this.diagramQuizPickedChoiceIndex!];
      children.push(
        el("p", {
          text: explainText,
          style: { marginTop: "var(--space-3)", fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-muted)" },
        }),
      );
    }

    if (this.diagramQuizCorrect) {
      const isLast = this.diagramQuizIndex >= module.questions.length - 1;
      children.push(
        el("button", {
          className: "btn btn--gold",
          text: isLast ? "FINISH" : "NEXT",
          style: { marginTop: "var(--space-3)" },
          on: { click: () => this.nextDiagramQuizQuestion(module) },
        }),
      );
    }

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "820px", maxHeight: "720px", overflowY: "auto" } }, children));
  }

  private renderDiagramQuizChoice(question: DiagramQuizQuestion & { kind: "choice" }, index: number, text: string): HTMLElement {
    const isRevealed = this.diagramQuizRevealed && this.diagramQuizPickedChoiceIndex === index;
    const isAnswer = index === question.answerIndex;
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
    return el("button", { className: "btn btn--ghost", text, style, on: { click: () => this.answerDiagramQuizChoice(index, question) } });
  }

  // A clicked WRONG element explains what it actually is (not the
  // question's own correct-answer explanation) — see DiagramQuizNode/
  // DiagramQuizArrow's roleExplain doc comment in academy.ts.
  private roleExplainFor(module: AcademyLessonDiagramQuizModule, elementId: string | null): string {
    if (!elementId) return "";
    const node = module.diagram.nodes.find((n) => n.id === elementId);
    if (node) return node.roleExplain;
    return module.diagram.arrows.find((a) => a.id === elementId)?.roleExplain ?? "";
  }

  // No penalty, no score — a wrong click just explains what was
  // actually clicked and stays retryable, same mastery convention as
  // answerQuiz(). Ignores further clicks once this question is
  // correctly answered (the NEXT/FINISH button is the only way on).
  private answerDiagramQuizElement(elementId: string, question: DiagramQuizQuestion & { kind: "diagram" }) {
    if (this.diagramQuizRevealed && this.diagramQuizCorrect) return;
    this.diagramQuizRevealed = true;
    this.diagramQuizPickedElementId = elementId;
    this.diagramQuizCorrect = question.correctIds.includes(elementId);
    logDecision("module_diagram_quiz_answer", {
      module: this.currentModuleId,
      question: question.prompt,
      questionIndex: this.diagramQuizIndex,
      picked: elementId,
      correct: this.diagramQuizCorrect,
      attempt: nextAnswerAttempt(`${this.currentModuleId}:${this.diagramQuizIndex}`),
    });
    this.render();
  }

  private answerDiagramQuizChoice(index: number, question: DiagramQuizQuestion & { kind: "choice" }) {
    if (this.diagramQuizRevealed && this.diagramQuizCorrect) return;
    this.diagramQuizRevealed = true;
    this.diagramQuizPickedChoiceIndex = index;
    this.diagramQuizCorrect = index === question.answerIndex;
    logDecision("module_diagram_quiz_answer", {
      module: this.currentModuleId,
      question: question.prompt,
      questionIndex: this.diagramQuizIndex,
      picked: question.choices[index],
      correct: this.diagramQuizCorrect,
      attempt: nextAnswerAttempt(`${this.currentModuleId}:${this.diagramQuizIndex}`),
    });
    this.render();
  }

  private nextDiagramQuizQuestion(module: AcademyLessonDiagramQuizModule) {
    const isLast = this.diagramQuizIndex >= module.questions.length - 1;
    if (isLast) {
      this.sealTheory(module.id);
      this.goToModuleList(module.track);
      return;
    }
    this.diagramQuizIndex++;
    this.diagramQuizRevealed = false;
    this.diagramQuizCorrect = false;
    this.diagramQuizPickedElementId = null;
    this.diagramQuizPickedChoiceIndex = null;
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
