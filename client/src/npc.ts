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
export const LORE_NPC_IDS = ["bram", "odile", "quill", "sabine", "fennick", "patron"] as const;

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
  fennick: { frameWidth: 434, frameHeight: 624 },
  patron: { frameWidth: 400, frameHeight: 553 },
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
    {
      id: "fennick",
      name: "Fennick",
      x: 280,
      y: 620,
      texture: "npc-fennick",
      baseScale: loreNpcBaseScale("fennick"),
      idleAnim: "npc-fennick-idle",
      questGiver: "merchant_oracle",
      dialogue: [
        {
          if: { questComplete: "merchant_oracle" },
          lines: ["The oracle behaves, now that someone's watching it. Apples, Agent? Name and coin is all I need."],
        },
        {
          if: { questActive: "merchant_oracle" },
          lines: ["The oracle again? Very well — what do you make of it, Agent?"],
          choices: [
            {
              label: "A machine that judges people must answer to a person. Demand its reasoning — and keep the power to overrule it.",
              setFlag: "oracle_overseen",
              response: "...You sound like the Division. Fine. Every verdict, I check myself. Name and coin — perhaps just the coin.",
            },
            {
              label: "It's efficient. Let it judge.",
              setFlag: "oracle_mistake",
              response: "My thought exactly! ... Agent, why is everyone leaving? Agent?",
              toast: "HQ: Unacceptable outcome. Return and correct it.",
            },
          ],
        },
        { lines: ["Apples, fresh apples! Or trinkets, if you'd rather. The oracle can name your price, if you dare ask it."] },
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
    {
      id: "patron",
      name: "Frightened Patron",
      x: 600,
      y: 550,
      texture: "npc-patron",
      baseScale: loreNpcBaseScale("patron"),
      idleAnim: "npc-patron-idle",
      questGiver: "whisper_portrait",
      dialogue: [
        { if: { questComplete: "whisper_portrait" }, lines: ["They marked it. I feel better already, though I still won't look at it directly."] },
        { if: { questActive: "whisper_portrait" }, lines: ["Please, Agent — hurry. I keep hearing it clear its throat."] },
        { lines: ["Something is wrong with that portrait. I can feel it watching."] },
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
      dialogue: [
        {
          if: { questActive: "whisper_portrait" },
          lines: [
            "A mimic-enchantment. It needs but a few minutes of a voice to wear it like a mask. The craft is old; the boldness is new. Ask Sabine what the law of the village demands of masks.",
          ],
        },
        {
          if: { questActive: "cover_story" },
          lines: ["The Archive holds the Summit's proceedings. Classified, naturally. Forty-six Trials also sleep in these files — the Division's training cases. You'll face them soon enough."],
        },
        { lines: ["Forty-six Trials, Agent. You've faced but one. Return to the Courthouse when you're ready for the next."] },
      ],
    },
    {
      id: "sabine",
      name: "Sabine",
      x: 280,
      y: 550,
      texture: "npc-sabine",
      baseScale: loreNpcBaseScale("sabine"),
      idleAnim: "npc-sabine-idle",
      dialogue: [
        {
          if: { questActive: "whisper_portrait" },
          lines: ["So. If a voice can be worn, Agent — what must every conjured voice be made to do?"],
          choices: [{ label: "Declare itself.", response: "Correct. Go and make it so." }],
        },
        {
          if: { questActive: "cover_story" },
          lines: ["A new agent. I train by question alone — answers are for those who've earned them. We will speak again, counselor."],
        },
        { lines: ["Sit, if you wish. The bench asks nothing of you but patience."] },
      ],
    },
  ],
};

// The Cat (tavern carpet) is written in the spec but not spawned here —
// no cat sprite exists in the "Village NPC Vol.1" pack (all 6 characters
// are humanoid; see PLAN.md Phase 2, Day 3 asset note), and Q1 drops to
// 4 steps (bram/odile/quill/sabine) without it. For whenever art shows
// up: first talk while cover_story is active — "The cat studies you at
// length. Both factions trust the cat. The cat trusts no one." Any
// later talk — "It has not changed its assessment."

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
      this.spawnOracleProp(scene);
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

  // Fennick's judgment-engine prop (see PLAN.md Phase 2, Day 3) — plain
  // Graphics, not a sprite: a brass box with a glowing blue lens.
  private spawnOracleProp(scene: Phaser.Scene) {
    const x = 335;
    const y = 605;
    const g = scene.add.graphics().setDepth(y - 1);
    g.fillStyle(0x8a6d3a, 1);
    g.fillRoundedRect(x - 14, y - 34, 28, 34, 3);
    g.lineStyle(2, 0x4a3a1f, 1);
    g.strokeRoundedRect(x - 14, y - 34, 28, 34, 3);
    const lens = scene.add.circle(x, y - 20, 5, 0x4cc9f0, 1).setDepth(y);
    scene.tweens.add({ targets: lens, alpha: { from: 1, to: 0.4 }, duration: 700, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
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
