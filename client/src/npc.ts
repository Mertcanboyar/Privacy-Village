import Phaser from "phaser";
import { GAME_HEIGHT } from "./config";
import type { RoomName } from "./rooms";
import { el, typewriter, type TypewriterHandle } from "./ui/dom";
import { showImageOverlay, type EvidenceImage } from "./ui/imageOverlay";
import { getSession, type Faction } from "./session";
import { questEngine } from "./questEngine";
import { playSound, playBlip } from "./audio";

// Static NPCs with a "Press E" interaction prompt and a sequential
// dialogue box (see PLAN.md Days 11-12, Phase 2 Days 2-3). Not
// room-JSON-driven yet — spawns are hardcoded here, same pattern as
// Room.ts's WANDERER_ROUTES.
//
// The dialogue box itself is a real DOM element (design-system.css's
// .dialogue component) appended to #ui-root, which floats over the Phaser
// canvas — see CLAUDE.md. The "[E] Talk" prompt and floating name tags stay
// as Phaser Text since they track moving/world-space sprite positions every
// frame, which a DOM element can't do cheaply.

const INTERACT_RADIUS = 70;
const SCALE_FAR = 0.75;
const SCALE_NEAR = 1.0;

function depthScaleFor(y: number): number {
  const t = Phaser.Math.Clamp(y / GAME_HEIGHT, 0, 1);
  return SCALE_FAR + (SCALE_NEAR - SCALE_FAR) * t;
}

// Referenced by Preload.ts to load/animate these sheets without
// duplicating the id list in two places.
export const LORE_NPC_IDS = ["bram", "odile", "quill", "sabine"] as const;

// Lore NPC sprite sheets (see CREDITS.md) — each a 4-frame idle strip
// built from a different CraftPix character pack, frames cropped to
// that character's own union bounding box (see Preload.ts for the
// spritesheet load). Frame sizes vary per source pack, so baseScale is
// computed per NPC rather than a single shared constant, targeting the
// same ~145px on-screen height as the other NPCs (knight/herald).
export const LORE_NPC_FRAME_SIZE: Record<(typeof LORE_NPC_IDS)[number], { frameWidth: number; frameHeight: number }> = {
  bram: { frameWidth: 394, frameHeight: 572 },
  odile: { frameWidth: 422, frameHeight: 563 },
  quill: { frameWidth: 440, frameHeight: 593 },
  sabine: { frameWidth: 458, frameHeight: 569 },
};

const LORE_NPC_TARGET_HEIGHT = 145;

function loreNpcBaseScale(id: (typeof LORE_NPC_IDS)[number]): number {
  return LORE_NPC_TARGET_HEIGHT / LORE_NPC_FRAME_SIZE[id].frameHeight;
}

// --- Conditional dialogue (Day 3) -------------------------------------

interface DialogueCondition {
  flag?: string;
  faction?: Faction;
  questActive?: string;
  questComplete?: string;
}

interface DialogueChoice {
  label: string;
  setFlag?: string;
  response: string;
  /** Extra toast beyond the response line itself. */
  toast?: string;
  /** Immediate points/clearance award for picking this specific choice —
   * mid-quest milestones that fire before the quest's own completion
   * payout (e.g. Mission 1's correct answer inside "The Breach in the
   * Wall" — Mission 2's correct answer instead completes the quest,
   * whose own xp/clearanceOnComplete cover the payout generically). */
  points?: number;
  clearance?: number;
}

interface EvidenceRef {
  images: EvidenceImage[];
  caption: string;
  buttonLabel: string;
}

interface DialogueSet {
  if?: DialogueCondition;
  lines: string[];
  /** Shown after the last line instead of "[E] Close". No nested trees —
   * picking one always ends the interaction after showing its response. */
  choices?: DialogueChoice[];
  /** Render this set in the big `.briefing`-styled panel instead of the
   * compact bottom dialogue bar — Herald's multi-paragraph mission text
   * (see PLAN.md "The Breach in the Wall"). A choice's response always
   * falls back to the compact box regardless of how the set itself was
   * shown, so this only needs to cover the mission text + its choices. */
  briefing?: { caseLabel: string; title: string };
  /** Evidence button shown inside a `briefing` set's panel. */
  evidence?: EvidenceRef;
  /** Render every choice as .btn--ghost (no "recommended" gold pick) —
   * for genuine multiple-choice quizzes where all options are live. */
  ghostChoices?: boolean;
}

function conditionMatches(cond: DialogueCondition | undefined): boolean {
  if (!cond) return true;
  if (cond.flag && !questEngine.getFlag(cond.flag)) return false;
  if (cond.faction && getSession().faction !== cond.faction) return false;
  if (cond.questActive && !questEngine.isActive(cond.questActive)) return false;
  if (cond.questComplete && !questEngine.isComplete(cond.questComplete)) return false;
  return true;
}

// First matching `if` wins; a set with no `if` is the fallback and
// should be listed last.
function pickDialogueSet(sets: DialogueSet[]): DialogueSet {
  for (const set of sets) {
    if (conditionMatches(set.if)) return set;
  }
  return sets[sets.length - 1];
}

interface NPCDef {
  id: string;
  name: string;
  x: number;
  y: number;
  texture: string;
  baseScale: number;
  idleAnim?: string;
  dialogue: DialogueSet[];
  /** Quest id this NPC offers when that quest is `available`. */
  questGiver?: string;
}

// --- "The Breach in the Wall" — Herald's mission briefings -----------
// Verbatim mission text (see PLAN.md), pulled out of NPC_SPAWNS below
// only because it's long enough to make the NPCDef literal unreadable
// inline.

const MISSION_1_TEXT = `The Council sits in their high tower, boasting that the Privacy Village is impregnable. "The walls are high," they say. "The wards are ancient." But they look only at what they built, not what they forgot.

I have spent my life hunting the Shadownet. I know that a raider doesn't strike where the armor is thickest; he strikes where the leather is worn. I stole the architect's blueprints from the archives last night. The ink is faded, but the truth is there if you know how to look.

To defend a system, you must first map the Attack Surface. You cannot secure what you do not see. The Council has layered defenses upon the main roads, creating a "Defense-in-Depth" strategy — multiple layers of preventative and detective controls. But my eyes are drawn to the shadows, to the forgotten paths used by servants and smugglers.

💾 THE EVIDENCE: STRONGHOLD DEFENSE GRID
Analyze the controls deployed at each gate:

NORTH GATE (The King's Road)
✅ Preventative: Iron Portcullis (Physical Barrier)
✅ Deterrent: Archer Tower (Visible Threat)
✅ Detective: Magic Ward (Alerts on intrusion)

EAST GATE (The Sea Wall)
✅ Preventative: Drawbridge (Access Control)
✅ Deterrent: Kraken Patrol (Physical Threat)
✅ Detective: Lighthouse (Surveillance/Logging)

WEST GATE (The Service Entry)
✅ Preventative: Rusted Padlock (Physical Barrier)
❌ Deterrent: None.
❌ Detective: None (No Watchtower, No Logs).

A security system fails when it relies solely on prevention without detection. If a lock is picked in the dark, and no one is watching, is the gate truly shut?

🔍 Which Gate lacks a Detective Control and relies on a single point of failure?`;

const MISSION_2_TEXT = `Good work, Ranger. But knowing where they will strike is only half the battle. We must know who is coming. Not every beast in the Shadownet can exploit this breach.

The West Gate sits atop the treacherous "Cliff of Crows."
— An Army cannot march there; the path is too narrow.
— A Wizard cannot strike there; their magic flares would be spotted by the distant Main Tower.
— A Troll is too heavy; the cliff ledge would crumble.

To build a valid Threat Model, we must map the Attacker's Capabilities to the System's Vulnerabilities. We are looking for a threat actor with high Stealth (to avoid the tower) and high Dexterity (to pick the rusted padlock we found).

💾 THE EVIDENCE: THE SHADOWNET DOSSIER
My scouts have intercepted a missive from the enemy camp. Three lieutenants have volunteered for the mission. Analyze their character sheets to see who has the right stats for the job.

🔍 In cybersecurity, you don't defend against "everyone." You defend against the specific actors capable of exploiting your specific gaps. Which Threat Actor can exploit the West Gate without raising the alarm?`;

const NPC_SPAWNS: Partial<Record<RoomName, NPCDef[]>> = {
  village: [
    {
      id: "herald",
      name: "Herald",
      // North of the fountain, Village Square (see village.json).
      x: 640,
      y: 500,
      texture: "npc-herald",
      baseScale: 145 / 558,
      questGiver: "breach_in_the_wall",
      dialogue: [
        { if: { questComplete: "breach_in_the_wall" }, lines: ["Well met, Ranger. The Council will never know how close the breach came."] },
        {
          if: { questActive: "breach_in_the_wall", flag: "gate_identified" },
          briefing: { caseLabel: "MISSION 2", title: "Know Thy Enemy" },
          evidence: {
            images: [
              { src: "/assets/quest/dossier_sorcerer.jpeg", label: "The Dark Sorcerer" },
              { src: "/assets/quest/dossier_goblin.jpeg", label: "The Goblin Saboteur" },
              { src: "/assets/quest/dossier_berserker.jpeg", label: "Ironhorn Berserker" },
            ],
            caption: "EVIDENCE — THE SHADOWNET DOSSIER",
            buttonLabel: "VIEW THE DOSSIER",
          },
          ghostChoices: true,
          lines: [MISSION_2_TEXT],
          choices: [
            {
              label: "THE DARK SORCERER",
              response:
                "INT 18, aye — but Void Blast lights the sky. The Main Tower would see the flare from a league away. We need someone the tower CANNOT see.",
            },
            {
              label: "THE GOBLIN SABOTEUR",
              setFlag: "threat_identified",
              response:
                "The Saboteur. DEX 18 for the padlock, and the little wretch climbs sheer cliffs — the Cliff of Crows is a staircase to him. No flare, no noise, no witnesses. THIS is threat modeling, Ranger: not fearing every monster, but knowing exactly which one fits through your gap. Now we know where to post the watch.",
            },
            {
              label: "THE IRONHORN BERSERKER",
              response: "STR 18 and he can smash any door — loudly, and the cliff ledge would crumble under him before he reached it. Weight and noise. Look again.",
            },
          ],
        },
        {
          if: { questActive: "breach_in_the_wall" },
          briefing: { caseLabel: "MISSION 1", title: "The Breach in the Wall" },
          evidence: {
            images: [{ src: "/assets/quest/village_map_mission1.jpeg", label: "Stronghold Defense Grid" }],
            caption: "EVIDENCE — STRONGHOLD DEFENSE GRID",
            buttonLabel: "VIEW THE BLUEPRINT",
          },
          ghostChoices: true,
          lines: [MISSION_1_TEXT],
          choices: [
            {
              label: "NORTH GATE",
              response: "Look again. The King's Road has iron, arrows, AND a ward that cries out. Three layers. Find the gate with no eyes at all.",
            },
            {
              label: "EAST GATE",
              response: "The Sea Wall watches — the lighthouse logs every sail. Find the gate where a picked lock would go unseen.",
            },
            {
              label: "WEST GATE",
              setFlag: "gate_identified",
              points: 150,
              clearance: 3,
              toast: "INTEL FILED — Prevention without detection is a gate left open.",
              response:
                "The Service Entry. One rusted lock and not a single eye upon it. The Council forgot it because servants use it — attackers love what the powerful forget. You see like a Ranger already.",
            },
          ],
        },
        { lines: ["Not yet, Agent. Get your bearings first — the Division's business can wait a moment longer."] },
      ],
    },
    {
      id: "bram",
      name: "Bram",
      x: 750,
      y: 650,
      texture: "npc-bram",
      baseScale: loreNpcBaseScale("bram"),
      idleAnim: "npc-bram-idle",
      dialogue: [
        {
          if: { questActive: "arrival" },
          lines: [
            "Welcome to Privacy Village, {name}. Festival's on — or so we tell outsiders. The walls keep us safe. Mostly. The Council likes to say 'impregnable.' I've stopped saying it.",
          ],
        },
        { lines: ["Keep your eyes open, Agent. The gates never truly close."] },
      ],
    },
  ],
  tavern: [
    {
      id: "odile",
      name: "Odile",
      x: 340,
      y: 470,
      texture: "npc-odile",
      baseScale: loreNpcBaseScale("odile"),
      idleAnim: "npc-odile-idle",
      dialogue: [
        {
          if: { questActive: "arrival" },
          lines: [
            "New face! You've come during the Battle for AI, Agent — two factions under one roof, pretending it's all fireside chats and festival ale. Keep your eyes open. And see the Herald — been pacing the square all morning.",
          ],
        },
        { lines: ["The Griffin's Drink serves secrets alongside the ale, Agent. Drink up."] },
      ],
    },
  ],
  courthouse: [
    {
      id: "quill",
      name: "Quill",
      x: 870,
      y: 630,
      texture: "npc-quill",
      baseScale: loreNpcBaseScale("quill"),
      idleAnim: "npc-quill-idle",
      dialogue: [{ lines: ["Forty-six Trials, Agent. You've faced but one. Return to the Courthouse when you're ready for the next."] }],
    },
    {
      id: "sabine",
      name: "Sabine",
      x: 280,
      y: 550,
      texture: "npc-sabine",
      baseScale: loreNpcBaseScale("sabine"),
      idleAnim: "npc-sabine-idle",
      dialogue: [{ lines: ["Sit, if you wish. The bench asks nothing of you but patience."] }],
    },
  ],
};

interface NPCView {
  def: NPCDef;
  image: Phaser.GameObjects.Sprite;
  nameText: Phaser.GameObjects.Text;
}

type DialogueMode = "closed" | "dialogue" | "offer" | "briefing";

export class NPCController {
  private npcs: NPCView[] = [];
  private promptText: Phaser.GameObjects.Text;
  private dialogueEl: HTMLElement;
  private dialogueNameEl: HTMLElement;
  private dialogueBodyEl: HTMLElement;
  private dialogueHintEl: HTMLElement;
  private choiceRowEl: HTMLElement | null = null;

  // Big `.briefing`-styled panel — Herald's mission text (see the
  // DialogueSet.briefing doc comment above). Built once, hidden by
  // default; open()/showLine() switch which of these two DOM structures
  // is visible based on activeSet.briefing.
  private briefingBackdropEl: HTMLElement;
  private briefingEl: HTMLElement;
  private briefingCaseEl: HTMLElement;
  private briefingTitleEl: HTMLElement;
  private briefingBodyEl: HTMLElement;
  private briefingEvidenceRowEl: HTMLElement;
  private briefingHintEl: HTMLElement;
  private briefingChoiceRowEl: HTMLElement | null = null;

  private eKey: Phaser.Input.Keyboard.Key;

  private mode: DialogueMode = "closed";
  private activeNpc: NPCDef | null = null;
  private activeSet: DialogueSet | null = null;
  private offerQuestId: string | null = null;
  private lineIndex = 0;
  private currentTypewriter: TypewriterHandle | null = null;
  private heraldPulse: Phaser.GameObjects.Arc | null = null;

  constructor(scene: Phaser.Scene, roomName: RoomName) {
    this.eKey = scene.input.keyboard!.addKey("E");

    for (const def of NPC_SPAWNS[roomName] ?? []) {
      const image = scene.add.sprite(def.x, def.y, def.texture).setOrigin(0.5, 1);
      image.setScale(def.baseScale * depthScaleFor(def.y));
      image.setDepth(def.y);
      if (def.idleAnim) image.play(def.idleAnim);

      const nameText = scene.add
        .text(def.x, def.y - image.displayHeight - 4, def.name.toUpperCase(), {
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: "14px",
          color: "#f2f0e9",
          stroke: "#000000",
          strokeThickness: 3,
        })
        .setOrigin(0.5, 1)
        .setDepth(100000);

      this.npcs.push({ def, image, nameText });
    }

    if (roomName === "village") {
      this.refreshHeraldPulse(scene);
      const onLevelUp = () => this.refreshHeraldPulse(scene);
      questEngine.on("levelUp", onLevelUp);
      scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => questEngine.off("levelUp", onLevelUp));
    }

    this.promptText = scene.add
      .text(0, 0, "[E] Talk", {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "14px",
        color: "#f0b429",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(100001)
      .setVisible(false);

    this.dialogueNameEl = el("div", { className: "dialogue__name" });
    this.dialogueBodyEl = el("div", { className: "dialogue__body" });
    this.dialogueHintEl = el("div", { className: "dialogue__continue" });
    this.dialogueEl = el(
      "div",
      {
        className: "dialogue",
        style: {
          position: "absolute",
          left: "60px",
          right: "60px",
          bottom: "30px",
          pointerEvents: "auto",
          display: "none",
        },
      },
      [this.dialogueNameEl, this.dialogueBodyEl, this.dialogueHintEl],
    );

    document.getElementById("ui-root")!.appendChild(this.dialogueEl);

    this.briefingCaseEl = el("span", { className: "briefing__case" });
    this.briefingTitleEl = el("h2", { className: "briefing__title" });
    this.briefingBodyEl = el("p", { className: "briefing__body" });
    this.briefingEvidenceRowEl = el("div", { style: { marginTop: "16px" } });
    this.briefingHintEl = el("div", {
      style: {
        textAlign: "right",
        fontFamily: "var(--font-mono)",
        fontSize: "13px",
        fontWeight: "700",
        letterSpacing: "0.08em",
        color: "var(--accent-gold)",
        marginTop: "var(--space-2)",
      },
    });
    this.briefingBackdropEl = el("div", { className: "ui-backdrop", style: { pointerEvents: "auto", display: "none" } });
    this.briefingEl = el(
      "div",
      {
        className: "panel panel--glow ds-root",
        style: {
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: "720px",
          maxHeight: "80vh",
          overflowY: "auto",
          pointerEvents: "auto",
          display: "none",
        },
      },
      [
        el("div", { className: "briefing" }, [
          el("div", { className: "briefing__header" }, [this.briefingCaseEl, this.briefingTitleEl]),
          el("hr", { className: "briefing__divider" }),
          this.briefingBodyEl,
          this.briefingEvidenceRowEl,
        ]),
        this.briefingHintEl,
      ],
    );
    document.getElementById("ui-root")!.appendChild(this.briefingBackdropEl);
    document.getElementById("ui-root")!.appendChild(this.briefingEl);

    // scene.restart() (room transitions) tears down this controller and
    // builds a fresh one — without this, the old instance's DOM nodes would
    // never be removed from #ui-root and orphaned dialogue boxes would pile
    // up on every transition.
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.dialogueEl.remove();
      this.briefingBackdropEl.remove();
      this.briefingEl.remove();
    });
  }

  // "Quest auto-highlights him (subtle gold pulse) once Clearance 2 is
  // reached" (see PLAN.md "The Breach in the Wall") — a soft pulsing
  // circle under the Herald, same Graphics-pulse technique as the oracle
  // lens above. Checked once at construction and again on every future
  // "levelUp" (covers reaching Clearance 2 while already standing here).
  private refreshHeraldPulse(scene: Phaser.Scene) {
    if (this.heraldPulse || questEngine.getClearance() < 2) return;
    const herald = this.npcs.find((n) => n.def.id === "herald");
    if (!herald) return;
    const g = scene.add.circle(herald.def.x, herald.def.y - 20, 34, 0xf0b429, 0.22).setDepth(herald.def.y - 1);
    scene.tweens.add({ targets: g, alpha: { from: 0.22, to: 0.55 }, duration: 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    this.heraldPulse = g;
  }

  get dialogueOpen(): boolean {
    return this.mode !== "closed";
  }

  update(playerX: number, playerY: number) {
    if (this.mode !== "closed") {
      if (Phaser.Input.Keyboard.JustDown(this.eKey)) this.advance();
      return;
    }

    let nearest: NPCView | null = null;
    let nearestDist = INTERACT_RADIUS;
    for (const npc of this.npcs) {
      const dist = Phaser.Math.Distance.Between(playerX, playerY, npc.def.x, npc.def.y);
      if (dist < nearestDist) {
        nearest = npc;
        nearestDist = dist;
      }
    }

    if (nearest) {
      this.promptText.setPosition(nearest.image.x, nearest.image.y - nearest.image.displayHeight - 20);
      this.promptText.setVisible(true);
      if (Phaser.Input.Keyboard.JustDown(this.eKey)) this.open(nearest.def);
    } else {
      this.promptText.setVisible(false);
    }
  }

  private open(def: NPCDef) {
    this.activeNpc = def;
    this.promptText.setVisible(false);
    this.clearChoices();

    if (def.questGiver && questEngine.isAvailable(def.questGiver)) {
      this.mode = "offer";
      this.offerQuestId = def.questGiver;
      this.dialogueEl.style.display = "block";
      this.showOffer();
      return;
    }

    this.activeSet = pickDialogueSet(def.dialogue);
    this.lineIndex = 0;
    if (this.activeSet.briefing) {
      this.mode = "briefing";
      this.briefingBackdropEl.style.display = "block";
      this.briefingEl.style.display = "block";
    } else {
      this.mode = "dialogue";
      this.dialogueEl.style.display = "block";
    }
    this.showLine();
  }

  private showOffer() {
    if (!this.activeNpc || !this.offerQuestId) return;
    const quest = questEngine.getDef(this.offerQuestId);
    this.dialogueNameEl.textContent = this.activeNpc.name;
    this.dialogueHintEl.textContent = "";
    this.currentTypewriter = typewriter(this.dialogueBodyEl, quest?.offer ?? "", 18, () => {
      this.renderChoices([
        { label: "Accept mission", onClick: () => this.acceptOffer() },
        { label: "Not yet", onClick: () => this.declineOffer() },
      ]);
    });
  }

  private acceptOffer() {
    if (this.offerQuestId) {
      playSound("quill-scratch");
      questEngine.acceptQuest(this.offerQuestId);
    }
    this.closeDialogue();
  }

  private declineOffer() {
    if (this.offerQuestId) questEngine.declineQuest(this.offerQuestId);
    this.closeDialogue();
  }

  private showLine() {
    if (!this.activeNpc || !this.activeSet) return;
    const isBriefing = this.mode === "briefing";
    const bodyEl = isBriefing ? this.briefingBodyEl : this.dialogueBodyEl;
    const hintEl = isBriefing ? this.briefingHintEl : this.dialogueHintEl;

    if (isBriefing && this.activeSet.briefing) {
      this.briefingCaseEl.textContent = this.activeSet.briefing.caseLabel;
      this.briefingTitleEl.textContent = this.activeSet.briefing.title;
      this.briefingEvidenceRowEl.innerHTML = "";
    } else {
      this.dialogueNameEl.textContent = this.activeNpc.name;
    }
    hintEl.textContent = "";

    const isLast = this.lineIndex === this.activeSet.lines.length - 1;
    const line = this.activeSet.lines[this.lineIndex].replace("{name}", getSession().name);
    playBlip(this.activeNpc.id);

    this.currentTypewriter = typewriter(bodyEl, line, 18, () => {
      if (isLast && isBriefing && this.activeSet!.evidence) this.renderEvidenceButton(this.activeSet!.evidence);
      if (isLast && this.activeSet!.choices) {
        this.renderChoices(
          this.activeSet!.choices.map((choice) => ({ label: choice.label, onClick: () => this.pickChoice(choice) })),
          this.activeSet!.ghostChoices ?? false,
        );
      } else {
        hintEl.textContent = isLast ? "[E] ▸ CLOSE" : "[E] ▸ CONTINUE";
      }
    });
  }

  private renderEvidenceButton(evidence: EvidenceRef) {
    this.briefingEvidenceRowEl.innerHTML = "";
    this.briefingEvidenceRowEl.appendChild(
      el("button", {
        className: "btn btn--gold",
        text: evidence.buttonLabel,
        on: { click: () => showImageOverlay(evidence.images, evidence.caption) },
      }),
    );
  }

  private pickChoice(choice: DialogueChoice) {
    if (choice.setFlag) questEngine.setFlag(choice.setFlag);
    if (choice.points) questEngine.addPoints(choice.points);
    if (choice.clearance) questEngine.setClearance(choice.clearance);
    if (choice.toast) questEngine.toast(choice.toast);
    this.clearChoices();
    // The response always falls back to the compact dialogue box, even
    // when the question itself was asked from the big briefing panel.
    this.briefingEl.style.display = "none";
    this.briefingBackdropEl.style.display = "none";
    this.mode = "dialogue";
    this.dialogueEl.style.display = "block";
    this.activeSet = { lines: [choice.response] };
    this.lineIndex = 0;
    this.showLine();
  }

  private renderChoices(choices: { label: string; onClick: () => void }[], ghost = false) {
    this.clearChoices();
    const isBriefing = this.mode === "briefing";
    const row = el(
      "div",
      { style: { display: "flex", flexDirection: isBriefing ? "column" : "row", gap: "12px", marginTop: "12px" } },
      choices.map((choice, i) =>
        el("button", {
          className: `btn ${!ghost && i === 0 ? "btn--gold" : "btn--ghost"}`,
          text: choice.label,
          on: { click: choice.onClick },
        }),
      ),
    );
    if (isBriefing) {
      this.briefingChoiceRowEl = row;
      this.briefingEl.appendChild(row);
    } else {
      this.choiceRowEl = row;
      this.dialogueEl.appendChild(row);
    }
  }

  private clearChoices() {
    this.choiceRowEl?.remove();
    this.choiceRowEl = null;
    this.briefingChoiceRowEl?.remove();
    this.briefingChoiceRowEl = null;
  }

  private advance() {
    if (!this.activeNpc) return;
    if (this.choiceRowEl || this.briefingChoiceRowEl) return; // must click a button
    if (this.mode === "offer") return; // must click Accept/Not yet

    if (this.currentTypewriter && !this.currentTypewriter.finished) {
      this.currentTypewriter.skip();
      return;
    }

    if (!this.activeSet) return;
    this.lineIndex++;
    if (this.lineIndex >= this.activeSet.lines.length) {
      this.closeDialogue();
    } else {
      this.showLine();
    }
  }

  private closeDialogue() {
    const npcId = this.activeNpc?.id;
    this.mode = "closed";
    this.activeNpc = null;
    this.activeSet = null;
    this.offerQuestId = null;
    this.dialogueEl.style.display = "none";
    this.briefingEl.style.display = "none";
    this.briefingBackdropEl.style.display = "none";
    this.clearChoices();
    if (npcId) questEngine.notifyTalkTo(npcId);
  }
}
