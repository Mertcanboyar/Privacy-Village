import Phaser from "phaser";
import { duckAudio } from "./audio";
import { questEngine } from "./questEngine";
import type { EvidenceImage } from "./ui/imageOverlay";
import type { RoomName } from "./rooms";

// Framework-free module singleton for Academy state (see PLAN.md "The
// Academy"). Same style as questEngine.ts/session.ts: a plain class
// extending Phaser.Events.EventEmitter so the Scene-bound DOM UI
// (academyOverlay.ts) can react without this module depending on any
// Scene. Room.ts checks `academy.isOpen` directly to lock player
// movement, exactly like it already imports questEngine directly.

// Referenced by Preload.ts to load client/public/data/academy/*.json
// without duplicating the id list in two places.
export const ACADEMY_TRACK_IDS = ["ai_governance", "privacy_ops", "cyber_security_law"] as const;
// Demo rule: only these have real content (lesson+quiz, card drill, or
// data sieve — see AcademyModule below). Every other module named in a
// track JSON's `modules` array is a locked stub card (name + clearance
// tag only, no separate file).
export const ACADEMY_MODULE_IDS = [
  "threat_modeling",
  "ai_pipeline_mapping",
  "annex_iii_risk_categorization",
  "personal_data_or_not",
  "the_ravens_burden",
  "deidentification_masks_and_chains",
  "lawful_bases_in_the_wild",
  "the_three_locks",
  "seventy_two_hour_clock",
] as const;

export interface AcademyModuleSummary {
  id: string;
  title: string;
  clearanceRequired: number;
  /** True only for ids in ACADEMY_MODULE_IDS — false renders as a
   * name-only locked stub card with no module-list click-through. */
  hasContent: boolean;
}

export interface AcademyTrack {
  id: string;
  title: string;
  credential: string;
  moduleCount: number;
  /** False = whole track renders dimmed on the hub with lockedTag, no
   * module list (Privacy/Cyber Law tracks — 46-trial footer count comes
   * from these two's moduleCount plus ai_governance's, with no per-module
   * data behind them). */
  active: boolean;
  lockedTag?: string;
  modules?: AcademyModuleSummary[];
}

export type LessonBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "callout"; variant: "gold" | "blue" | "danger"; text: string }
  | { type: "evidence-image"; images: EvidenceImage[]; caption: string; buttonLabel: string };

export interface QuizQuestion {
  q: string;
  choices: string[];
  answer: number;
  /** Explanation text per choice, same index as choices — shown whether
   * the pick was right or wrong (see PLAN.md "The Academy" 3d). */
  explain: string[];
}

export interface CardDrillCard {
  item: string;
  answer: boolean;
  explain: string;
}

// A module's field work is a real questEngine quest — Threat Modeling ↔
// the village's "Breach in the Wall" is the only current example. `room`
// drives the module list's "IN THE VILLAGE/COURTHOUSE/TAVERN →" pip:
// where to send the player. Most modules have no matching in-game
// activity at all and simply omit fieldWork — completing the theory
// (a lesson+quiz, or a card drill — see AcademyModule below) alone
// completes the module.
export interface AcademyFieldWork {
  label: string;
  questId: string;
  room: RoomName;
}

interface AcademyModuleBase {
  id: string;
  track: string;
  title: string;
  clearanceRequired: number;
  fieldWork?: AcademyFieldWork;
}

// Lesson content blocks + a 3-question mastery quiz. `type` is omittable
// (absent = lesson) so existing module JSON files don't need a field
// that was never load-bearing before card drills existed.
export interface AcademyLessonModule extends AcademyModuleBase {
  type?: "lesson";
  lesson: LessonBlock[];
  quiz: QuizQuestion[];
}

// One card at a time, binary judgment (see academyOverlay.ts's
// renderCardDrill()) — wrong answers re-queue to the end of the deck
// rather than retrying immediately, so the deck only clears once every
// card has been answered correctly once. trueLabel/falseLabel are the
// two big buttons' text (e.g. "PERSONAL DATA"/"NOT PERSONAL DATA", or
// "SEND IT"/"SIEVE IT OUT") — every card's `answer` is judged against
// whichever button the player picks.
export interface AcademyCardDrillModule extends AcademyModuleBase {
  type: "card_drill";
  intro: string;
  trueLabel: string;
  falseLabel: string;
  cards: CardDrillCard[];
}

export interface CardDrillMultiCard {
  item: string;
  choices: string[];
  answerIndex: number;
  /** Explanation per choice, same index as choices — shown whether the
   * pick was right or wrong, same convention as QuizQuestion.explain. */
  explain: string[];
}

// Same one-card-at-a-time mastery re-queue as AcademyCardDrillModule, but
// each card offers three labeled choices instead of a binary true/false
// pair (see academyOverlay.ts's renderCardDrillMulti()) — "Lawful Bases in
// the Wild" is the first module that needs more than two buckets per
// item. referenceStrip is an optional small collapsible mono strip
// pinned above the deck (e.g. "THE SIX: CONSENT · CONTRACT · ...").
export interface AcademyCardDrillMultiModule extends AcademyModuleBase {
  type: "card_drill_multi";
  intro: string;
  referenceStrip?: string;
  cards: CardDrillMultiCard[];
}

export interface DataSieveCard {
  id: string;
  label: string;
  shouldRemove: boolean;
  reason: string;
}

// All cards shown at once (unlike the card drill's one-at-a-time
// queue) — the player toggles each card as "marked for removal," then
// validates the whole set together and sees every card's correct
// answer + reason at once. Mirrors the source DPIA Protocol project's
// Data Sieve lab UX directly (briefing + card grid + "run the sieve").
export interface AcademyDataSieveModule extends AcademyModuleBase {
  type: "data_sieve";
  aiGoal: string;
  brief: string;
  cards: DataSieveCard[];
}

export type AcademyModule = AcademyLessonModule | AcademyCardDrillModule | AcademyCardDrillMultiModule | AcademyDataSieveModule;

export interface ModuleProgress {
  theoryDone: boolean;
  fieldDone: boolean;
}

const EMPTY_PROGRESS: ModuleProgress = { theoryDone: false, fieldDone: false };

function roomLabel(room: RoomName): string {
  if (room === "tavern") return "the tavern";
  if (room === "courthouse") return "the courthouse";
  return "the village";
}

class AcademyManager extends Phaser.Events.EventEmitter {
  private open_ = false;
  private tracks = new Map<string, AcademyTrack>();
  private modules = new Map<string, AcademyModule>();
  private progress = new Map<string, ModuleProgress>();
  // Guards the completion modal/points/toast from firing more than once
  // per module — theory and field work can each complete the pair, and
  // re-opening the Academy re-runs the retroactive field-work check.
  private celebrated = new Set<string>();

  get isOpen(): boolean {
    return this.open_;
  }

  open() {
    if (this.open_) return;
    this.open_ = true;
    duckAudio(true);
    this.checkRetroactiveFieldWork();
    this.emit("opened");
  }

  close() {
    if (!this.open_) return;
    this.open_ = false;
    duckAudio(false);
    this.emit("closed");
  }

  toggle() {
    if (this.open_) this.close();
    else this.open();
  }

  loadData(tracks: AcademyTrack[], modules: AcademyModule[]) {
    for (const track of tracks) this.tracks.set(track.id, track);
    for (const module of modules) {
      this.modules.set(module.id, module);
      this.progress.set(module.id, { theoryDone: false, fieldDone: this.isFieldWorkDone(module) });
    }
    questEngine.on("questCompleted", (questId: string) => this.onQuestCompleted(questId));
  }

  // No fieldWork at all = trivially satisfied (theory-only module).
  private isFieldWorkDone(module: AcademyModule): boolean {
    return !module.fieldWork || questEngine.isComplete(module.fieldWork.questId);
  }

  getTrack(id: string): AcademyTrack | undefined {
    return this.tracks.get(id);
  }

  getAllTracks(): AcademyTrack[] {
    return ACADEMY_TRACK_IDS.map((id) => this.tracks.get(id)).filter((t): t is AcademyTrack => !!t);
  }

  getModule(id: string): AcademyModule | undefined {
    return this.modules.get(id);
  }

  getProgress(moduleId: string): ModuleProgress {
    return this.progress.get(moduleId) ?? EMPTY_PROGRESS;
  }

  /** Numerator for the hub's credential progress bar — modules where
   * both theoryDone and fieldDone are true (see PLAN.md "Module complete
   * = both true"). */
  completedCount(trackId: string): number {
    const track = this.tracks.get(trackId);
    if (!track?.modules) return 0;
    let n = 0;
    for (const summary of track.modules) {
      const p = this.progress.get(summary.id);
      if (p?.theoryDone && p?.fieldDone) n++;
    }
    return n;
  }

  markTheoryDone(moduleId: string) {
    const p = this.progress.get(moduleId);
    if (!p || p.theoryDone) return;
    p.theoryDone = true;
    this.emit("progressChanged", moduleId);
    const module = this.modules.get(moduleId);
    if (module?.fieldWork && !p.fieldDone) {
      this.emit("toast", `THEORY SEALED — field work awaits at ${roomLabel(module.fieldWork.room)}.`);
    }
    this.tryCompleteModule(moduleId);
  }

  private setFieldDone(moduleId: string) {
    const p = this.progress.get(moduleId);
    if (!p || p.fieldDone) return;
    p.fieldDone = true;
    this.emit("progressChanged", moduleId);
    if (!p.theoryDone) {
      this.emit("toast", "The Academy has recorded your field work. Complete the theory to seal the module.");
    }
    this.tryCompleteModule(moduleId);
  }

  private onQuestCompleted(questId: string) {
    for (const module of this.modules.values()) {
      if (module.fieldWork?.questId === questId) this.setFieldDone(module.id);
    }
  }

  // Belt-and-suspenders re-sync for the demo path: catches a quest that
  // completed before this manager's questCompleted listener was
  // attached, by re-checking on every Academy open rather than relying
  // solely on the live event.
  private checkRetroactiveFieldWork() {
    for (const module of this.modules.values()) {
      const p = this.progress.get(module.id);
      if (p && !p.fieldDone && this.isFieldWorkDone(module)) this.setFieldDone(module.id);
    }
  }

  private tryCompleteModule(moduleId: string) {
    const p = this.progress.get(moduleId);
    if (!p || !p.theoryDone || !p.fieldDone) return;
    if (this.celebrated.has(moduleId)) return;
    this.celebrated.add(moduleId);

    const module = this.modules.get(moduleId);
    const credential = module ? this.tracks.get(module.track)?.credential : undefined;
    questEngine.addPoints(100);
    this.emit("toast", `ACADEMY RECORD FILED — progress toward ${credential ?? "your credential"}.`);
    this.emit("moduleCompleted", moduleId);
  }
}

export const academy = new AcademyManager();
