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
  "data_flow_mapping",
  "secure_channels",
  "toms",
  "aggregation",
  "purpose_limitation",
  // "The Alchemist's Cabinet" — Privacy Enhancing Technologies, theory-
  // only capstone synthesizing PETs used across earlier quests/modules.
  // Concept mapping: pseudonymisation (Art. 4(5)) · k-anonymity via
  // generalisation/suppression · aggregation · encryption in transit &
  // at rest · access control/minimisation · differential privacy ·
  // secure multiparty computation / homomorphic encryption. Framing:
  // PETs as data protection by design & by default (Art. 25); the
  // utility-vs-protection trade-off; match tool to purpose + risk.
  "pets",
] as const;

export interface AcademyModuleSummary {
  id: string;
  title: string;
  clearanceRequired: number;
  /** Position within this module's track, 1-based — the study-first
   * inversion's sequencing key (module N+1's theory stays locked until
   * module N's theory seals; see AcademyManager.isTheoryUnlocked()).
   * Only real (hasContent: true) modules carry this — a stub card has
   * no order and is simply always inert, regardless of sequencing. */
  order?: number;
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
  /** What the module list's "IN THE VILLAGE →"-style pip visually pings
   * once the player is where it sent them — an NPC sprite ("herald", the
   * default, used by Threat Modeling; "bram", used by "Mapping the
   * Flow"'s "The Blueprint of the Post Road"; "mayor", used by "Measures
   * that Interlock"'s "The Treasury's Two Keys") or the Courthouse door
   * hotspot ("courthouseDoor", used by "The 72-Hour Clock" — its field
   * work, "The Night the Wall Fell," auto-triggers on village entry
   * rather than being offered by any NPC, so there's no sprite to ping;
   * "maren", used by "Shaping the Data"'s "Maren's Winter Report"; "quill",
   * used by "The Purpose Test"'s "The Archivist's Desk"). */
  ping?: "herald" | "bram" | "mayor" | "courthouseDoor" | "maren" | "quill";
}

interface AcademyModuleBase {
  id: string;
  track: string;
  title: string;
  clearanceRequired: number;
  /** Same field/meaning as AcademyModuleSummary.order — duplicated here
   * for the same reason clearanceRequired already was: the track-index
   * JSON's summary is what gating logic reads, but the module's own
   * file carries its authoritative copy too. */
  order?: number;
  fieldWork?: AcademyFieldWork;
  /** Renders the module list's theory pip as a disabled "IN DEVELOPMENT"
   * chip instead of a clickable "THEORY: BEGIN" button — for a module
   * whose field work exists but whose lesson/quiz content doesn't yet
   * (see "Mapping the Flow"). theoryDone can never become true this way,
   * so the module never joins completedCount()'s numerator — the
   * track's credential bar stays put until real theory content ships. */
  theoryInDevelopment?: boolean;
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

export type DiagramNodeType = "entity" | "process" | "store";

// A DFD node/arrow the player can click on as an answer — see
// ui/diagramReader.ts for the rendering, same node-shape/color language
// as ui/blueprintOverlay.ts's Post Road builder (kept as a separate,
// smaller copy there rather than a cross-import — Academy and the
// village quests are deliberately different subsystems). roleExplain is
// shown when the player clicks this element for the WRONG question —
// a fixed "here's what this actually is" line, independent of which
// diagram question is currently active.
export interface DiagramQuizNode {
  id: string;
  label: string;
  type: DiagramNodeType;
  x: number;
  y: number;
  danger?: boolean;
  roleExplain: string;
}

export interface DiagramQuizArrow {
  id: string;
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  danger?: boolean;
  roleExplain: string;
}

// "Click the right part of the diagram" — correctIds lists every id that
// counts as correct (Q2's "Villagers OR Couriers", Q4's "Bandit Camp or
// its arrow"); all of them flash gold together on a correct pick so the
// player sees every valid answer, not just the one they happened to hit.
export interface DiagramClickQuestion {
  kind: "diagram";
  prompt: string;
  correctIds: string[];
  explain: string;
}

// A few diagram questions are about ZOOM LEVEL, not a clickable part of
// THIS diagram (Q5) — ordinary text multiple-choice, same mastery/retry
// convention as QuizQuestion.
export interface DiagramChoiceQuestion {
  kind: "choice";
  prompt: string;
  choices: string[];
  answerIndex: number;
  explain: string[];
}

export type DiagramQuizQuestion = DiagramClickQuestion | DiagramChoiceQuestion;

// "Mapping the Flow" — lesson blocks (same LessonBlock union as
// AcademyLessonModule) followed by an interactive-diagram assessment
// instead of a text quiz (see academyOverlay.ts's renderDiagramQuiz()).
export interface AcademyLessonDiagramQuizModule extends AcademyModuleBase {
  type: "lesson_diagramquiz";
  lesson: LessonBlock[];
  diagram: { nodes: DiagramQuizNode[]; arrows: DiagramQuizArrow[] };
  questions: DiagramQuizQuestion[];
}

export type AcademyModule =
  | AcademyLessonModule
  | AcademyCardDrillModule
  | AcademyCardDrillMultiModule
  | AcademyDataSieveModule
  | AcademyLessonDiagramQuizModule;

export interface ModuleProgress {
  theoryDone: boolean;
  fieldDone: boolean;
}

const EMPTY_PROGRESS: ModuleProgress = { theoryDone: false, fieldDone: false };

// Serialized shape of everything AcademyManager needs to resume a saved
// game (see cloud/save.ts / profiles.progress.module_state). Same v1
// versioning convention as questEngine.ts's QuestEngineState.
export interface AcademyEngineState {
  v: 1;
  progress: Record<string, ModuleProgress>;
  celebrated: string[];
}

function roomLabel(room: RoomName): string {
  if (room === "tavern") return "the tavern";
  if (room === "courthouse") return "the courthouse";
  if (room === "great_hall") return "the Great Hall";
  return "the village";
}

// Same localStorage idiom as tutorial.ts's "seen it" flag — per-browser,
// not per-account, but that's fine for what this drives (hud.ts's
// persistent Study-button pulse, see PLAN's onboarding signposting):
// the moment this browser has ever opened the Academy once, the pulse
// has done its job and should stop nagging, even for a guest who never
// enlists. An authenticated player's real academy progress (hydrated
// from Supabase) is the stronger signal and wins if the two disagree —
// see hasEverOpened() below.
const OPENED_STORAGE_KEY = "pv_academy_opened";

function markOpenedInStorage() {
  try {
    localStorage.setItem(OPENED_STORAGE_KEY, "1");
  } catch {
    // Nothing to do — worst case the pulse reappears next session.
  }
}

function readOpenedFromStorage(): boolean {
  try {
    return localStorage.getItem(OPENED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
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

  /** Drives hud.ts's persistent "Study" button pulse (see PLAN's
   * onboarding signposting: "pulses until first opened") — true once
   * this browser has ever opened the Academy, OR (the stronger signal,
   * for a returning authenticated player on a fresh browser) once any
   * module's hydrated progress shows real engagement already. Checking
   * bare `fieldDone` here would be wrong — isFieldWorkDone() (see
   * loadData()) trivially marks it true for every theory-only module
   * from the moment it's first loaded, before the player has done
   * anything at all, so only a fieldDone that's paired with a real
   * fieldWork quest counts as actual engagement. */
  hasEverOpened(): boolean {
    if (readOpenedFromStorage()) return true;
    for (const [id, p] of this.progress) {
      if (p.theoryDone) return true;
      const module = this.modules.get(id);
      if (p.fieldDone && module?.fieldWork) return true;
    }
    return false;
  }

  /** True if at least one real module's theory is unlocked (by track
   * order) but not yet done — drives hud.ts's Study-button notification
   * dot. Modules still theory-in-development never count, same as
   * everywhere else they're treated as permanently inert. */
  hasAvailableUnstartedTheory(): boolean {
    for (const module of this.modules.values()) {
      if (module.theoryInDevelopment) continue;
      if (this.getProgress(module.id).theoryDone) continue;
      if (this.isTheoryUnlocked(module.track, module.order)) return true;
    }
    return false;
  }

  // Set by openToModule() (see npc.ts's locked-quest dialogue shortcut)
  // — read once by academyOverlay.ts's "opened" handler to jump straight
  // to a specific module's theory instead of the hub, then cleared via
  // consumePendingModuleId() so a later plain toggle()/open() (the HUD
  // button, the door) doesn't also inherit it.
  private pendingModuleId: string | null = null;

  /** Opens the Academy already navigated to `moduleId`'s theory —
   * npc.ts calls this from a locked quest-giver's dialogue shortcut. */
  openToModule(moduleId: string) {
    this.pendingModuleId = moduleId;
    this.open();
  }

  consumePendingModuleId(): string | null {
    const id = this.pendingModuleId;
    this.pendingModuleId = null;
    return id;
  }

  open() {
    if (this.open_) return;
    this.open_ = true;
    duckAudio(true);
    markOpenedInStorage();
    this.checkRetroactiveFieldWork();
    this.checkRetroactiveQuestUnlocks();
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
      // Registers the theory gate BEFORE any quest's `unlocks` chain can
      // fire (Preload finishes well before gameplay starts) — otherwise
      // e.g. arrival's `unlocks: ["breach_in_the_wall"]` would flip that
      // quest straight to available on arrival's completion regardless
      // of threat_modeling's theory state. See questEngine.unlockQuest().
      if (module.fieldWork) {
        const questId = module.fieldWork.questId;
        const moduleId = module.id;
        questEngine.registerUnlockGate(questId, () => this.getProgress(moduleId).theoryDone);
      }
    }
    questEngine.on("questCompleted", (questId: string) => this.onQuestCompleted(questId));
  }

  serializeState(): AcademyEngineState {
    return {
      v: 1,
      progress: Object.fromEntries(this.progress),
      celebrated: [...this.celebrated],
    };
  }

  /** Restores previously-saved progress — must run after loadData()
   * (Preload.ts) so module ids exist to hydrate against. Overwrites
   * loadData()'s freshly-computed-from-scratch progress map entirely
   * rather than merging, so it doesn't matter that loadData() itself
   * ran before questEngine.hydrateState() had restored quest-completion
   * state (which briefly makes its own fieldDone guess wrong) — this
   * replaces that guess outright. Silent, same as
   * questEngine.hydrateState(); ignores anything not shape v1. */
  hydrateState(saved: AcademyEngineState | null | undefined) {
    if (!saved || saved.v !== 1) return;
    for (const [id, p] of Object.entries(saved.progress)) {
      if (this.modules.has(id)) this.progress.set(id, p);
    }
    this.celebrated = new Set(saved.celebrated);
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

  /** Reverse lookup for npc.ts's locked-quest dialogue: which module (if
   * any) gates this quest via its theory. A linear scan over ~15
   * modules on an occasional dialogue-open is well within budget —
   * no reason to maintain a second index for this. */
  getModuleForQuest(questId: string): AcademyModule | undefined {
    for (const module of this.modules.values()) {
      if (module.fieldWork?.questId === questId) return module;
    }
    return undefined;
  }

  getProgress(moduleId: string): ModuleProgress {
    return this.progress.get(moduleId) ?? EMPTY_PROGRESS;
  }

  /** The module immediately before `order` in `trackId`'s sequence (the
   * highest order strictly less than it), or null if `order` is first
   * (or has no order at all). Shared by isTheoryUnlocked() and
   * academyOverlay.ts's locked-card reason text. */
  getPriorModule(trackId: string, order: number | undefined): AcademyModuleSummary | null {
    if (order == null) return null;
    const track = this.tracks.get(trackId);
    if (!track?.modules) return null;
    let prior: AcademyModuleSummary | null = null;
    for (const summary of track.modules) {
      if (summary.order != null && summary.order < order && (!prior || summary.order > prior.order!)) prior = summary;
    }
    return prior;
  }

  /** Study-first sequencing gate: a module at track position `order` is
   * unlocked if it's first in its track (no order/no earlier order in
   * the track summary — either reads as "nothing to wait on") or the
   * immediately-preceding order's module has sealed its theory. Only
   * the immediate predecessor matters (module N+1 needs module N, not
   * every module before it) — see PLAN.md's per-track ordering. A
   * module with no `order` at all (a hasContent: false stub) always
   * reads as locked; academyOverlay.ts never calls this for those since
   * they render their own "IN DEVELOPMENT" card before reaching here. */
  isTheoryUnlocked(trackId: string, order: number | undefined): boolean {
    if (order == null) return false;
    const prior = this.getPriorModule(trackId, order);
    if (!prior) return true;
    return this.getProgress(prior.id).theoryDone;
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
    // The inversion's core rule: theory GATES field work now, not the
    // other way around — this is the only place a paired field quest
    // ever leaves "locked". unlockQuest() is idempotent/no-op for a
    // quest that's already available/active/complete (a returning
    // player, or one who somehow did the field work first under old
    // save data — see checkRetroactiveQuestUnlocks()), so this never
    // needs its own "already unlocked?" guard.
    if (module?.fieldWork) questEngine.unlockQuest(module.fieldWork.questId);
    if (module?.fieldWork && !p.fieldDone) {
      this.emit("toast", `THEORY SEALED — your field assignment is now open at ${roomLabel(module.fieldWork.room)}.`);
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

  // Same "re-check on every Academy open" belt-and-suspenders as
  // checkRetroactiveFieldWork() above, for the new theory -> quest-unlock
  // direction: a returning player whose saved progress already has
  // theoryDone=true for a module (from before this hook existed, or from
  // a session where markTheoryDone() ran before questEngine had loaded
  // this quest's def) would otherwise sit with a permanently-locked
  // field quest despite having done the theory. unlockQuest() is a no-op
  // for anything not still "locked", so this never revokes progress —
  // see PLAN's "Do not revoke anything" retroactive rule.
  private checkRetroactiveQuestUnlocks() {
    for (const module of this.modules.values()) {
      const p = this.progress.get(module.id);
      if (p?.theoryDone && module.fieldWork) questEngine.unlockQuest(module.fieldWork.questId);
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
