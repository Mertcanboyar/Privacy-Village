import Phaser from "phaser";
import { duckAudio } from "./audio";
import { questEngine } from "./questEngine";
import type { EvidenceImage } from "./ui/imageOverlay";

// Framework-free module singleton for Academy state (see PLAN.md "The
// Academy"). Same style as questEngine.ts/session.ts: a plain class
// extending Phaser.Events.EventEmitter so the Scene-bound DOM UI
// (academyOverlay.ts) can react without this module depending on any
// Scene. Room.ts checks `academy.isOpen` directly to lock player
// movement, exactly like it already imports questEngine directly.

// Referenced by Preload.ts to load client/public/data/academy/*.json
// without duplicating the id list in two places.
export const ACADEMY_TRACK_IDS = ["ai_governance", "privacy_data_protection", "cyber_security_law"] as const;
// Demo rule: only this one module has real lesson/quiz content — the
// other modules named in ai_governance's track JSON are locked stub
// cards (name + clearance tag only, no separate file).
export const ACADEMY_MODULE_IDS = ["threat_modeling"] as const;

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
  | { type: "callout"; variant: "gold" | "blue"; text: string }
  | { type: "evidence-image"; images: EvidenceImage[]; caption: string; buttonLabel: string };

export interface QuizQuestion {
  q: string;
  choices: string[];
  answer: number;
  /** Explanation text per choice, same index as choices — shown whether
   * the pick was right or wrong (see PLAN.md "The Academy" 3d). */
  explain: string[];
}

export interface AcademyModule {
  id: string;
  track: string;
  title: string;
  clearanceRequired: number;
  fieldWork: { questId: string; label: string };
  lesson: LessonBlock[];
  quiz: QuizQuestion[];
}

export interface ModuleProgress {
  theoryDone: boolean;
  fieldDone: boolean;
}

const EMPTY_PROGRESS: ModuleProgress = { theoryDone: false, fieldDone: false };

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
      this.progress.set(module.id, { theoryDone: false, fieldDone: questEngine.isComplete(module.fieldWork.questId) });
    }
    questEngine.on("questCompleted", (questId: string) => this.onQuestCompleted(questId));
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
    this.tryCompleteModule(moduleId);
  }

  private setFieldDone(moduleId: string) {
    const p = this.progress.get(moduleId);
    if (!p || p.fieldDone) return;
    p.fieldDone = true;
    this.emit("progressChanged", moduleId);
    if (!p.theoryDone) {
      this.emit("toast", "The Academy has recorded your field work. Complete the theory to seal the module. [A]");
    }
    this.tryCompleteModule(moduleId);
  }

  private onQuestCompleted(questId: string) {
    for (const module of this.modules.values()) {
      if (module.fieldWork.questId === questId) this.setFieldDone(module.id);
    }
  }

  // Belt-and-suspenders re-sync for the demo path: if the linked quest
  // somehow completed without setFieldDone firing (e.g. this manager's
  // questCompleted listener wasn't attached yet), catch it up whenever
  // the Academy is opened rather than only on the live event.
  private checkRetroactiveFieldWork() {
    for (const module of this.modules.values()) {
      if (questEngine.isComplete(module.fieldWork.questId)) this.setFieldDone(module.id);
    }
  }

  private tryCompleteModule(moduleId: string) {
    const p = this.progress.get(moduleId);
    if (!p || !p.theoryDone || !p.fieldDone) return;
    if (this.celebrated.has(moduleId)) return;
    this.celebrated.add(moduleId);

    questEngine.addPoints(100);
    this.emit("toast", "ACADEMY RECORD FILED — progress toward Certified AI Governance Lead.");
    this.emit("moduleCompleted", moduleId);
  }
}

export const academy = new AcademyManager();
