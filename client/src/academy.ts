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
export const ACADEMY_TRACK_IDS = ["ai_governance", "privacy_data_protection", "cyber_security_law"] as const;
// Demo rule: only these have real lesson/quiz content — one per track,
// plus a second in AI Governance. Every other module named in a track
// JSON's `modules` array is a locked stub card (name + clearance tag
// only, no separate file).
export const ACADEMY_MODULE_IDS = ["threat_modeling", "ai_pipeline_mapping", "personal_data_classification", "malware_incident_triage"] as const;

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

// Completion signal is one of two kinds: a real questEngine quest
// (Threat Modeling ↔ the village's "Breach in the Wall"), or a
// standalone in-game activity that predates the Academy and never
// registered itself as a quest (Personal Data Classification ↔ the
// Courthouse Trial, whose completion is only recorded in localStorage —
// see quest.ts's BADGE_STORAGE_KEY). `room` drives the module list's
// "IN THE VILLAGE/COURTHOUSE/TAVERN →" pip: where to send the player.
// Modules with no matching in-game activity at all (the two brand-new
// theory-only modules below) simply omit fieldWork — completing the
// theory alone completes the module.
export interface AcademyFieldWork {
  label: string;
  questId?: string;
  storageKey?: string;
  room: RoomName;
}

export interface AcademyModule {
  id: string;
  track: string;
  title: string;
  clearanceRequired: number;
  fieldWork?: AcademyFieldWork;
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
      this.progress.set(module.id, { theoryDone: false, fieldDone: this.isFieldWorkDone(module) });
    }
    questEngine.on("questCompleted", (questId: string) => this.onQuestCompleted(questId));
  }

  // No fieldWork at all = trivially satisfied (theory-only module).
  // Otherwise checks whichever completion signal that module's
  // fieldWork declares — a questEngine quest, or a localStorage badge
  // key for older in-game activities that predate the quest system.
  private isFieldWorkDone(module: AcademyModule): boolean {
    const fieldWork = module.fieldWork;
    if (!fieldWork) return true;
    if (fieldWork.questId) return questEngine.isComplete(fieldWork.questId);
    if (fieldWork.storageKey) return !!localStorage.getItem(fieldWork.storageKey);
    return true;
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
      if (module.fieldWork?.questId === questId) this.setFieldDone(module.id);
    }
  }

  // Belt-and-suspenders re-sync for the demo path: catches two cases
  // whenever the Academy opens rather than relying only on a live event
  // — a quest that completed before this manager's questCompleted
  // listener was attached, and storageKey-based field work (the
  // Courthouse Trial), which has no live event of its own to push a
  // completion — its localStorage badge is the only signal, so it can
  // only ever be picked up here, on next open.
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
