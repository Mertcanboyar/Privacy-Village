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
export const QUEST_IDS = ["arrival", "breach_in_the_wall", "innkeepers_shards"] as const;

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
}

export interface QuestDef {
  id: string;
  title: string;
  giver: string; // npc id, or "hq" for auto-offered/no-NPC quests
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
  /** Clearance level to raise to (if higher than current) on full completion —
   * see setClearance(). Milestone-based, not point-threshold-based. */
  clearanceOnComplete?: number;
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

  /** Raises Clearance to `level` if higher than the current one — a no-op
   * otherwise (milestones can fire out of the "expected" order without
   * double-counting, e.g. re-triggering the same step). Fires the flash +
   * fanfare + "CLEARANCE RAISED" toast exactly once per real raise. */
  setClearance(level: number) {
    if (level <= this.clearance) return;
    this.clearance = level;
    playSound("fanfare");
    this.emit("levelUp", level);
    this.emit("toast", `CLEARANCE RAISED — LEVEL ${level}`);
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
    const quest = this.getActiveQuest();
    if (!quest) return;
    const idx = this.getActiveStepIndex();
    const step = quest.steps[idx];
    if (!step || !matches(step.trigger)) return;

    if (step.reveal) {
      const text = step.reveal.textByFaction ? step.reveal.textByFaction[getSession().faction ?? "fundamentalist"] : step.reveal.text;
      this.emit("reveal", { text: text ?? "", color: step.reveal.color });
    }

    const nextIndex = idx + 1;
    if (nextIndex >= quest.steps.length) {
      this.completeActiveQuest();
    } else {
      this.stepIndex.set(quest.id, nextIndex);
      playSound("chime");
      this.emit("toast", "MISSION UPDATED");
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
    // setClearance() plays its own fanfare when it actually raises the
    // level; fall back to a plain completion fanfare otherwise so every
    // quest still gets one, milestone or not.
    if (quest.clearanceOnComplete) this.setClearance(quest.clearanceOnComplete);
    else playSound("fanfare");

    for (const unlockId of quest.unlocks ?? []) {
      if (this.getState(unlockId) !== "locked") continue;
      const unlockDef = this.defs.get(unlockId);
      if (unlockDef?.giver === "hq") {
        this.bootstrapHqQuest(unlockId);
      } else {
        this.states.set(unlockId, "available");
      }
    }
  }

  addPoints(amount: number) {
    this.points += amount;
    this.emit("pointsChanged", this.points, amount);
  }
}

export const questEngine = new QuestManager();
