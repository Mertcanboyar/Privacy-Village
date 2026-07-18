import Phaser from "phaser";
import { getSession } from "./session";
import { playSound } from "./audio";
import type { EvidenceImage } from "./ui/imageOverlay";
import type { EvidenceTableTab } from "./ui/tableOverlay";

// JSON-driven quest engine (see PLAN.md "The Breach in the Wall").
// Deliberately a separate module/file from quest.ts, which is
// specifically the Courthouse Trial (GDPR classification drag-and-drop)
// — this engine drives the arrival flow + "The Breach in the Wall"
// instead.
//
// Framework-free module singleton, same style as session.ts, but a
// separate file since it's a different concern (progress/flags vs.
// identity). Extends Phaser.Events.EventEmitter (a plain class, usable
// outside any Scene) so HUD/Room/npc controllers can subscribe without
// this module depending on any of them.

// Referenced by Preload.ts to load client/public/data/quests/*.json
// without duplicating the id list in two places.
export const QUEST_IDS = ["arrival", "breach_in_the_wall", "innkeepers_shards", "night_the_wall_fell"] as const;

// Clearance is 1 + however many of these narrative milestones are done,
// in ANY order (see setClearance() history — this replaced an earlier
// per-quest "clearanceOnComplete: N" absolute-target scheme, which
// hardcoded a specific quest ordering into the level numbers themselves).
// "courthouse_trial" has no quest wired to it yet (see PLAN.md) — it's
// reserved so completing it later needs no further engine changes, but
// it means Clearance 7 isn't reachable in the current build; 6 is, once
// all five live milestones are done.
export const MILESTONE_IDS = ["welcome", "breach_m1", "breach_m2", "innkeepers_shards", "courthouse_trial", "night_the_wall_fell"] as const;
export type MilestoneId = (typeof MILESTONE_IDS)[number];

export type QuestState = "locked" | "available" | "active" | "complete";

export interface TalkToTrigger {
  type: "talk_to";
  npc: string;
  requiresFlag?: string;
}

export interface ReachZoneTrigger {
  type: "reach_zone";
  zone: string;
}

export type Trigger = TalkToTrigger | ReachZoneTrigger;

export interface QuestStepReveal {
  text?: string;
  /** Faction-conditional variant, used by Q5's final HQ note. */
  textByFaction?: Partial<Record<"fundamentalist" | "apocalypse", string>>;
  color?: string;
  /** Speaker tag on the reveal panel's header — defaults to "INTEL". */
  speaker?: string;
}

export interface QuestStepEvidence {
  images: EvidenceImage[];
  caption: string;
  buttonLabel: string;
}

// Table-shaped evidence (see ui/tableOverlay.ts) — "The Innkeeper's
// Shards"'s sharded logs and sanitized safehouse log, as opposed to
// the image-based evidence above.
export interface QuestStepEvidenceTables {
  tabs: EvidenceTableTab[];
  caption: string;
  buttonLabel: string;
}

// A standalone decision point tied to a reach_zone step rather than an
// NPC conversation — "The Night the Wall Fell"'s fountain-crier beat is
// the only current example (see hud.ts's showStepChoice()). Unlike
// NPCController's DialogueChoice, this isn't hosted by any NPC, so it
// needs its own small event (see QuestManager.resolveStepChoice()).
export interface QuestStepChoiceOption {
  label: string;
  correct: boolean;
  /** Shown via the "reveal" panel if present — omit for a silent
   * correct pick that only fires its toast/scene beat. */
  response?: string;
  /** Speaker tag on that reveal panel — e.g. "HERALD" for a corrective
   * appearance. Defaults to "INTEL". */
  speaker?: string;
  /** Extra toast beyond any response panel. */
  toast?: string;
  /** Consequence hours added to the Decision Clock for a wrong pick —
   * see QuestManager.addClockHours(). No fail state; only cost. */
  clockPenalty?: number;
  /** One-off scene beat to run alongside this option's resolution —
   * only "villagersTurn" exists today (see Room.ts). */
  sceneBeat?: string;
}

export interface QuestStepChoice {
  prompt: string;
  options: QuestStepChoiceOption[];
}

export interface QuestStep {
  objective: string;
  trigger: Trigger;
  reveal?: QuestStepReveal;
  /** Reopenable evidence button shown in the HUD tracker while this is
   * the active step — "Player can reopen the blueprint anytime from the
   * tracker while the mission is active" (see PLAN.md "The Breach in
   * the Wall"). Mutually exclusive with evidenceTables. */
  evidence?: QuestStepEvidence;
  evidenceTables?: QuestStepEvidenceTables;
  /** Standalone reach_zone decision point — see QuestStepChoice above.
   * When present, reaching the zone shows this choice instead of
   * advancing the step directly; resolveStepChoice() advances it. */
  choice?: QuestStepChoice;
  /** Decision Clock hours this step's completion costs, regardless of
   * which choice (if any) resolved it — see "The Night the Wall Fell".
   * Unused by any quest without a clock. */
  clockCost?: number;
  /** Toast shown on step advance, overriding the generic "MISSION
   * UPDATED" default — e.g. "MISSION UPDATED — Contained. The clock
   * runs on." */
  toast?: string;
}

export interface QuestDef {
  id: string;
  title: string;
  giver: string; // npc id, "hq" for auto-offered/no-NPC quests, or "auto" for a scripted village-entry trigger (see Room.ts)
  xp: number;
  /** Reduced payout if this flag got set before completion (Q3's loop-back). */
  xpIfFlag?: Record<string, number>;
  /** Shown with Accept/Not-yet buttons when this quest is `available` and giver is an NPC. */
  offer?: string;
  /** Toast shown when an `hq`-given quest auto-activates. */
  opener?: string;
  debrief: string;
  steps: QuestStep[];
  /** Quest ids to flip locked -> available once this quest completes. */
  unlocks?: string[];
  /** Milestone this quest's full completion fires — see MILESTONE_IDS. */
  milestone?: MilestoneId;
  /** Flips this quest locked -> available the moment Clearance reaches
   * this value, checked reactively on every setClearance() raise —
   * unlike `unlocks`, this isn't tied to any specific other quest
   * completing, so it stays correct regardless of milestone order. */
  unlockAtClearance?: number;
  /** "The Night the Wall Fell"'s two Decision Clock outcome variants,
   * shown as a "reveal" panel on completion instead of the generic
   * debrief toast alone — mastery through consequence, not blockage: the
   * quest always completes, but which line plays (and whether the bonus
   * toast fires) depends on whether the clock stayed under 72 hours.
   * Unused by any quest without a Decision Clock. */
  clockDebrief?: { clean: string; late: string; cleanBonusToast?: string };
}

/** Clearance Levels (replaces the old XP-threshold levels — see PLAN.md
 * "The Breach in the Wall") — advanced by explicit narrative milestones
 * via setClearance(), not derived from points. Points still accrue and
 * display on the .xp-bar independently. */
export interface LevelInfo {
  level: number;
  points: number;
}

class QuestManager extends Phaser.Events.EventEmitter {
  private defs = new Map<string, QuestDef>();
  private states = new Map<string, QuestState>();
  private stepIndex = new Map<string, number>();
  private flags: Record<string, boolean> = {};
  private points = 0;
  private clearance = 1;
  private activeQuestId: string | null = null;
  private completedMilestones = new Set<MilestoneId>();

  // "The Night the Wall Fell"'s Decision Clock — quest-scoped, reset
  // when that quest is accepted (see acceptQuest()). No other quest
  // reads or writes this; a hardcoded id check here is simpler than a
  // generic multi-clock system for what is, per DEMO RULE, a one-off
  // mechanic for a single quest.
  private clockHours = 0;
  // Set while a QuestStepChoice is awaiting resolution — guards against
  // notifyReachZone() re-firing the same choice every frame the player
  // stands in the zone before picking an option.
  private awaitingChoice = false;

  loadDefs(defs: QuestDef[]) {
    for (const def of defs) {
      this.defs.set(def.id, def);
      this.states.set(def.id, "locked");
      this.stepIndex.set(def.id, 0);
    }
  }

  /** Unlocks and immediately activates an `hq`-given quest (Q1 on spawn). */
  bootstrapHqQuest(id: string) {
    const def = this.defs.get(id);
    if (!def || this.states.get(id) !== "locked") return;
    this.states.set(id, "available");
    this.acceptQuest(id);
  }

  getDef(id: string): QuestDef | undefined {
    return this.defs.get(id);
  }

  getState(id: string): QuestState {
    return this.states.get(id) ?? "locked";
  }

  getActiveQuest(): QuestDef | null {
    return this.activeQuestId ? (this.defs.get(this.activeQuestId) ?? null) : null;
  }

  getActiveStepIndex(): number {
    return this.activeQuestId ? (this.stepIndex.get(this.activeQuestId) ?? 0) : 0;
  }

  getFlag(name: string): boolean {
    return !!this.flags[name];
  }

  setFlag(name: string) {
    this.flags[name] = true;
  }

  /** Ad-hoc toast not tied to a step/quest transition (e.g. Q3's "wrong
   * choice" HQ note). */
  toast(message: string) {
    this.emit("toast", message);
  }

  getPoints(): number {
    return this.points;
  }

  getLevelInfo(): LevelInfo {
    return { level: this.clearance, points: this.points };
  }

  getClearance(): number {
    return this.clearance;
  }

  getClockHours(): number {
    return this.clockHours;
  }

  /** `isPenalty` distinguishes a wrong-choice consequence from a step's
   * ordinary base cost — hud.ts only flashes the clock red for the
   * former (see "red flash on the clock" in the quest's own spec). */
  addClockHours(amount: number, isPenalty = false) {
    if (!amount) return;
    this.clockHours += amount;
    this.emit("clockChanged", this.clockHours, amount);
    if (isPenalty) this.emit("clockPenalty", amount);
  }

  /** Marks a narrative milestone done (no-op if already done — milestones
   * are idempotent, same guarantee as setClearance()) and recomputes
   * Clearance as 1 + however many are now complete, in whatever order
   * they were reached. */
  completeMilestone(id: MilestoneId) {
    if (this.completedMilestones.has(id)) return;
    this.completedMilestones.add(id);
    this.setClearance(1 + this.completedMilestones.size);
  }

  /** Raises Clearance to `level` if higher than the current one — a no-op
   * otherwise (milestones can fire out of the "expected" order without
   * double-counting, e.g. re-triggering the same step). Fires the flash +
   * fanfare + "CLEARANCE RAISED" toast exactly once per real raise, then
   * checks every locked quest's unlockAtClearance threshold. */
  setClearance(level: number) {
    if (level <= this.clearance) return;
    this.clearance = level;
    playSound("fanfare");
    this.emit("levelUp", level);
    this.emit("toast", `CLEARANCE RAISED — LEVEL ${level}`);

    for (const def of this.defs.values()) {
      if (def.unlockAtClearance && def.unlockAtClearance <= level) this.unlockQuest(def.id);
    }
  }

  /** Giver NPCs offer a quest via dialogue when this is true. */
  isAvailable(id: string): boolean {
    return this.getState(id) === "available";
  }

  isActive(id: string): boolean {
    return this.activeQuestId === id;
  }

  isComplete(id: string): boolean {
    return this.getState(id) === "complete";
  }

  acceptQuest(id: string) {
    const def = this.defs.get(id);
    if (!def || this.getState(id) !== "available") return;
    // "One active quest at a time" — an hq quest auto-activating while
    // another is active shouldn't happen given this project's unlock
    // graph, but guard anyway rather than silently dropping the old one.
    if (this.activeQuestId && this.activeQuestId !== id) return;

    this.states.set(id, "active");
    this.stepIndex.set(id, 0);
    this.activeQuestId = id;
    if (id === "night_the_wall_fell") this.clockHours = 0;
    if (def.opener) this.emit("toast", def.opener);
    this.emit("questUpdated");
  }

  declineQuest(_id: string) {
    // Stays "available" — offered again next time the giver is talked to.
  }

  notifyTalkTo(npcId: string) {
    this.checkStep((trigger) => trigger.type === "talk_to" && trigger.npc === npcId && (!trigger.requiresFlag || this.getFlag(trigger.requiresFlag)));
  }

  notifyReachZone(zoneId: string) {
    this.checkStep((trigger) => trigger.type === "reach_zone" && trigger.zone === zoneId);
  }

  private checkStep(matches: (trigger: Trigger) => boolean) {
    if (this.awaitingChoice) return;
    const quest = this.getActiveQuest();
    if (!quest) return;
    const idx = this.getActiveStepIndex();
    const step = quest.steps[idx];
    if (!step || !matches(step.trigger)) return;

    if (step.choice) {
      this.awaitingChoice = true;
      this.emit("stepChoice", step.choice);
      return;
    }

    if (step.clockCost) this.addClockHours(step.clockCost);
    this.advanceStep(quest, idx, step);
  }

  /** Resolves a QuestStepChoice picked from hud.ts's showStepChoice() —
   * applies the option's penalty (if any) and the step's own base cost,
   * shows its response as a "reveal" panel (if any), then advances the
   * step exactly like a normal trigger match would. */
  resolveStepChoice(option: QuestStepChoiceOption) {
    const quest = this.getActiveQuest();
    if (!quest || !this.awaitingChoice) return;
    this.awaitingChoice = false;
    const idx = this.getActiveStepIndex();
    const step = quest.steps[idx];

    if (option.clockPenalty) this.addClockHours(option.clockPenalty, true);
    if (step?.clockCost) this.addClockHours(step.clockCost);
    if (option.response) this.emit("reveal", { text: option.response, speaker: option.speaker });
    if (option.toast) this.emit("toast", option.toast);
    if (option.sceneBeat) this.emit("sceneBeat", option.sceneBeat);

    if (step) this.advanceStep(quest, idx, step);
  }

  private advanceStep(quest: QuestDef, idx: number, step: QuestStep) {
    if (step.reveal) {
      const text = step.reveal.textByFaction ? step.reveal.textByFaction[getSession().faction ?? "fundamentalist"] : step.reveal.text;
      this.emit("reveal", { text: text ?? "", color: step.reveal.color, speaker: step.reveal.speaker });
    }

    const nextIndex = idx + 1;
    if (nextIndex >= quest.steps.length) {
      this.completeActiveQuest();
    } else {
      this.stepIndex.set(quest.id, nextIndex);
      playSound("chime");
      this.emit("toast", step.toast ?? "MISSION UPDATED");
      this.emit("questUpdated");
    }
  }

  private completeActiveQuest() {
    const quest = this.getActiveQuest();
    if (!quest) return;

    let xp = quest.xp;
    if (quest.xpIfFlag) {
      for (const [flag, amount] of Object.entries(quest.xpIfFlag)) {
        if (this.getFlag(flag)) {
          xp = amount;
          break;
        }
      }
    }

    this.states.set(quest.id, "complete");
    this.activeQuestId = null;
    this.addPoints(xp);
    this.emit("toast", `INTEL FILED — ${quest.debrief} (+${xp} faction points)`);
    this.emit("questCompleted", quest.id);
    this.emit("questUpdated");
    // completeMilestone() plays its own fanfare when it actually raises
    // the level; fall back to a plain completion fanfare otherwise so
    // every quest still gets one, milestone or not.
    if (quest.milestone) this.completeMilestone(quest.milestone);
    else playSound("fanfare");

    if (quest.clockDebrief) {
      const clean = this.clockHours < 72;
      this.emit("reveal", { text: clean ? quest.clockDebrief.clean : quest.clockDebrief.late, speaker: "HERALD" });
      if (clean && quest.clockDebrief.cleanBonusToast) this.emit("toast", quest.clockDebrief.cleanBonusToast);
    }

    for (const unlockId of quest.unlocks ?? []) this.unlockQuest(unlockId);
  }

  private unlockQuest(id: string) {
    if (this.getState(id) !== "locked") return;
    const def = this.defs.get(id);
    if (def?.giver === "hq") this.bootstrapHqQuest(id);
    else this.states.set(id, "available");
  }

  addPoints(amount: number) {
    this.points += amount;
    this.emit("pointsChanged", this.points, amount);
  }
}

export const questEngine = new QuestManager();
