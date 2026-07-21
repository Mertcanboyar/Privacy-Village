import Phaser from "phaser";
import { GAME_HEIGHT } from "./config";
import type { RoomName } from "./rooms";
import { el, typewriter, type TypewriterHandle } from "./ui/dom";
import { showImageOverlay, type EvidenceImage } from "./ui/imageOverlay";
import { showTableOverlay, type EvidenceTableTab } from "./ui/tableOverlay";
import { getSession, type Faction } from "./session";
import { questEngine, type MilestoneId } from "./questEngine";
import { playSound, playBlip } from "./audio";
import { logDecision } from "./cloud/save";

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

// Decision-log event names per quest + step index (see pickChoice()) —
// "The Breach in the Wall"'s two missions map to the spec's own
// "breach_m1_answer"/"breach_m2_answer" examples; anything else (today,
// just "The Innkeeper's Shards") falls back to `${questId}_answer`
// rather than needing an entry here for every quest that ever adds a
// dialogue choice.
const CHOICE_EVENT_NAMES: Record<string, string[]> = {
  breach_in_the_wall: ["breach_m1_answer", "breach_m2_answer"],
};

function choiceEventName(questId: string | undefined, stepIndex: number): string {
  if (!questId) return "npc_choice";
  const mapped = CHOICE_EVENT_NAMES[questId]?.[stepIndex];
  return mapped ?? `${questId}_answer`;
}

// Counts attempts at the SAME quest step — every pickChoice() call
// (right or wrong) increments it; the key naturally changes once the
// step actually advances, so nothing needs to reset it explicitly.
const choiceAttempts = new Map<string, number>();

function nextAttempt(key: string): number {
  const n = (choiceAttempts.get(key) ?? 0) + 1;
  choiceAttempts.set(key, n);
  return n;
}

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

// Half of the original ~145px convention — sprites read too large at
// that size, per feedback (see session.ts's AVATAR_OPTIONS, halved the
// same way).
const LORE_NPC_TARGET_HEIGHT = 72.5;

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
  /** Immediate points award for picking this specific choice — mid-quest
   * milestones that fire before the quest's own completion payout (e.g.
   * Mission 1's correct answer inside "The Breach in the Wall" — Mission
   * 2's correct answer instead completes the quest, whose own xp covers
   * the payout generically). */
  points?: number;
  /** Narrative milestone this choice fires — see questEngine.ts's
   * MILESTONE_IDS/completeMilestone(). */
  milestone?: MilestoneId;
  /** Decision Clock hours added for picking this choice — "The Night the
   * Wall Fell"'s wrong-choice consequence (no fail state, only cost).
   * Unused outside that quest. */
  clockPenalty?: number;
}

interface EvidenceRef {
  images: EvidenceImage[];
  caption: string;
  buttonLabel: string;
}

// Table-shaped evidence (see ui/tableOverlay.ts) — "The Innkeeper's
// Shards"'s sharded logs and sanitized safehouse log, as opposed to
// the image-based EvidenceRef above.
interface EvidenceTableRef {
  tabs: EvidenceTableTab[];
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
  /** Evidence button shown inside a `briefing` set's panel. Mutually
   * exclusive with evidenceTables. */
  evidence?: EvidenceRef;
  evidenceTables?: EvidenceTableRef;
  /** Render every choice as .btn--ghost (no "recommended" gold pick) —
   * for genuine multiple-choice quizzes where all options are live. */
  ghostChoices?: boolean;
  /** Lay choices out in a compact wrapping grid (mono font) instead of
   * one-per-row — "The Innkeeper's Shards"'s 10/12-option answer lists,
   * too many for a column without the briefing panel scrolling badly. */
  gridChoices?: boolean;
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
// inline. Split into 3 short pages per mission (intro / evidence /
// question) rather than one long scrolling wall of text — the briefing
// panel is a fixed-height box sized to the game's 1280x720 canvas (see
// its style comment below), so each page needs to fit without relying
// on scroll to reach the answer buttons.

const MISSION_1_PAGES = [
  `The Council sits in their high tower, boasting that the Privacy Village is impregnable. "The walls are high," they say. "The wards are ancient." But they look only at what they built, not what they forgot.

I have spent my life hunting the Shadownet. I know that a raider doesn't strike where the armor is thickest; he strikes where the leather is worn. I stole the architect's blueprints from the archives last night. The ink is faded, but the truth is there if you know how to look.

To defend a system, you must first map the Attack Surface. You cannot secure what you do not see. The Council has layered defenses upon the main roads — but my eyes are drawn to the shadows, to the forgotten paths used by servants and smugglers.`,
  `💾 THE EVIDENCE: STRONGHOLD DEFENSE GRID
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
❌ Detective: None (No Watchtower, No Logs).`,
  `A security system fails when it relies solely on prevention without detection. If a lock is picked in the dark, and no one is watching, is the gate truly shut?

🔍 Which Gate lacks a Detective Control and relies on a single point of failure?`,
];

const MISSION_2_PAGES = [
  `Good work, Ranger. But knowing where they will strike is only half the battle. We must know who is coming. Not every beast in the Shadownet can exploit this breach.

The West Gate sits atop the treacherous "Cliff of Crows."
— An Army cannot march there; the path is too narrow.
— A Wizard cannot strike there; their magic flares would be spotted by the distant Main Tower.
— A Troll is too heavy; the cliff ledge would crumble.

To build a valid Threat Model, we must map the Attacker's Capabilities to the System's Vulnerabilities.`,
  `💾 THE EVIDENCE: THE SHADOWNET DOSSIER
My scouts have intercepted a missive from the enemy camp. Three lieutenants have volunteered for the mission. Analyze their character sheets to see who has the right stats for the job.

We are looking for a threat actor with high Stealth (to avoid the tower) and high Dexterity (to pick the rusted padlock we found).`,
  `🔍 In cybersecurity, you don't defend against "everyone." You defend against the specific actors capable of exploiting your specific gaps. Which Threat Actor can exploit the West Gate without raising the alarm?`,
];

// --- "The Innkeeper's Shards" — Odile's + Herald's mission briefings --
// Same 3-page pattern as MISSION_1/2_PAGES above (intro / evidence /
// question).

const SHARDS_MISSION_1_PAGES = [
  `The innkeeper has "sharded" her data into three isolated logs to prevent anyone from identifying her guests. The Room List knows only a Coat Check Ticket. The Coat Check Log knows only items and timestamps. The City Gate Log knows names and appearances — but nothing of the inn.

She believes separation makes the data anonymous. The Shadownet knows better. By CHAINING these three datasets, anyone can de-anonymize anyone.

Trace the chain. Find the name of the guest in Room 7.`,
  `💾 THE EVIDENCE: THE SHARDED LOGS
Three drawers, three logs — but nothing stops you from laying them side by side.

TABLE A links a Room to a Coat Check Ticket.
TABLE B links a Ticket to an Item and a Check-in Time.
TABLE C links a Name to an Appearance and an Entry Time.

Chain them: Room → Ticket → Item & Time → Name.`,
  `A quasi-identifier is rarely one attribute alone. An item description can match more than one person — the hour it was checked in is what breaks the tie.

🔍 Who sleeps in Room 7?`,
];

const SHARDS_MISSION_2_PAGES = [
  `Word of your trick reached the Archive. Quill's scribes have "sanitized" the Summit's safehouse log — GENERALIZATION (specifics become ranges) and SUPPRESSION (values become *). They claim the log now satisfies k-anonymity with k=2: every row identical to at least one other. If true, no guest stands alone in the data.

They made a mistake. One entry's remaining attributes are STILL unique. If the Shadownet intercepts this log, it can mathematically prove who that person is. Audit the mask. Find the flaw.`,
  `💾 THE EVIDENCE: SAFEHOUSE LOG (SANITIZED)
Quasi-identifiers: Trade | Age Range | District

Twelve entries, generalized and suppressed. Eleven of them should each have at least one identical twin elsewhere in the log. One does not.`,
  `k-anonymity is a chain of twins, Ranger. Compare every row against every other — a single unmatched row breaks the promise for that one person, even if everyone else is safely hidden in a crowd.

🔍 Which Entry ID violates k=2?`,
];

const NPC_SPAWNS: Partial<Record<RoomName, NPCDef[]>> = {
  village: [
    {
      id: "herald",
      name: "Herald",
      // North of the fountain, Village Square (see village.json).
      x: 640,
      y: 500,
      texture: "npc-herald",
      baseScale: 72.5 / 558,
      questGiver: "breach_in_the_wall",
      dialogue: [
        {
          if: { questComplete: "night_the_wall_fell" },
          lines: [
            "Fifty-some hours or a hundred and twenty, Ranger — the wall held because YOU did. The Council still doesn't know how close it came.",
          ],
        },
        {
          if: { questActive: "night_the_wall_fell" },
          lines: ["Go, Ranger! Bram's holding that breach alone — this isn't a drill!"],
        },
        {
          if: { questComplete: "innkeepers_shards" },
          lines: ["The mask slipped once, Ranger. Quill's scribes will not make that mistake twice — not while you're watching."],
        },
        {
          if: { questActive: "innkeepers_shards", flag: "guest_identified" },
          briefing: { caseLabel: "MISSION 2", title: "The Flawed Mask" },
          evidenceTables: {
            tabs: [
              {
                label: "SAFEHOUSE LOG",
                columns: ["Entry ID", "Trade", "Age Range", "District"],
                rows: [
                  ["S-01", "Warden", "> 60", "Northreach"],
                  ["S-02", "Scribe", "30–40", "Lantern Row"],
                  ["S-03", "Smith", "40–50", "* (Suppressed)"],
                  ["S-04", "Courier", "20–30", "Mill Quarter"],
                  ["S-05", "Warden", "> 60", "Northreach"],
                  ["S-06", "Scribe", "30–40", "Lantern Row"],
                  ["S-07", "Smith", "40–50", "* (Suppressed)"],
                  ["S-08", "Courier", "40–50", "Mill Quarter"],
                  ["S-09", "Courier", "20–30", "Mill Quarter"],
                  ["S-10", "Courier", "20–30", "Mill Quarter"],
                  ["S-11", "Weaver", "20–30", "Riverside"],
                  ["S-12", "Weaver", "20–30", "Riverside"],
                ],
              },
            ],
            caption: "EVIDENCE — SAFEHOUSE LOG (SANITIZED)",
            buttonLabel: "VIEW THE LOG",
          },
          ghostChoices: true,
          gridChoices: true,
          lines: SHARDS_MISSION_2_PAGES,
          choices: [
            { label: "S-01", response: "Compare each row against every other. Eleven of them have an identical twin. One does not." },
            { label: "S-02", response: "Compare each row against every other. Eleven of them have an identical twin. One does not." },
            {
              label: "S-03",
              response: "Suppressed twins are still twins — those two rows are identical, star for star. Look for the row with NO twin.",
            },
            { label: "S-04", response: "Three of a kind satisfies k=2 twice over. Find the row that stands alone." },
            { label: "S-05", response: "Compare each row against every other. Eleven of them have an identical twin. One does not." },
            { label: "S-06", response: "Compare each row against every other. Eleven of them have an identical twin. One does not." },
            {
              label: "S-07",
              response: "Suppressed twins are still twins — those two rows are identical, star for star. Look for the row with NO twin.",
            },
            {
              label: "S-08",
              setFlag: "mask_flaw_found",
              response:
                "The courier of forty-some years from the Mill Quarter. Every other courier there is young; the mask slips on the one who isn't. k-anonymity is a chain of twins, Ranger — ONE unique row and the whole promise breaks for that person.",
            },
            { label: "S-09", response: "Three of a kind satisfies k=2 twice over. Find the row that stands alone." },
            { label: "S-10", response: "Three of a kind satisfies k=2 twice over. Find the row that stands alone." },
            { label: "S-11", response: "Compare each row against every other. Eleven of them have an identical twin. One does not." },
            { label: "S-12", response: "Compare each row against every other. Eleven of them have an identical twin. One does not." },
          ],
        },
        {
          if: { questActive: "innkeepers_shards" },
          lines: ["Room 7 won't identify itself on its own, Ranger. The Innkeeper's drawers hold the thread — if you're willing to pull it."],
        },
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
          lines: MISSION_2_PAGES,
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
          lines: MISSION_1_PAGES,
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
              milestone: "breach_m1",
              toast: "INTEL FILED — Prevention without detection is a gate left open.",
              response:
                "The Service Entry. One rusted lock and not a single eye upon it. The Council forgot it because servants use it — attackers love what the powerful forget. You see like a Ranger already.",
            },
          ],
        },
        { lines: ["Not yet, friend. Get your bearings first — there's plenty of time for puzzles once you've settled in."] },
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
          if: { questComplete: "night_the_wall_fell" },
          lines: ["The gate's mended, the wax is set. I still check that padlock twice a night, though."],
        },
        {
          if: { questActive: "night_the_wall_fell", flag: "warden_heard" },
          lines: ["Go on, Ranger — that gate won't wedge itself, and every minute you linger is a minute more they win."],
        },
        {
          if: { questActive: "night_the_wall_fell" },
          briefing: { caseLabel: "STEP 1", title: "Hear the Warden" },
          ghostChoices: true,
          lines: [
            "Agent! The West Gate — the padlock's picked, just as your Ranger said. The archive annex was ENTERED. Scrolls of villager records — debts, faction marks — may be copied, I can't yet say. I know what I saw at 02:00. What I don't know would fill that annex twice over.",
          ],
          choices: [
            {
              label: "A breach is presumed the moment you saw that open annex. The clock is already running — move.",
              setFlag: "warden_heard",
              response: "Then we count from 02:00. Gods help us.",
            },
            {
              label: "Say nothing yet. We investigate fully first — days if we must.",
              setFlag: "warden_heard",
              clockPenalty: 24,
              response: "Days?! Agent, the law counts from KNOWING, not from finishing! The Herald will skin us.",
            },
          ],
        },
        {
          if: { questActive: "arrival" },
          lines: [
            "Welcome to Privacy Village, {name}! The festival's just getting started — workshops, games, and puzzles the whole square through. The walls keep us safe, mostly. The Council likes to say 'impregnable.' I've stopped saying it.",
          ],
        },
        { lines: ["Keep exploring — the gates never truly close, and neither does the fun."] },
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
      questGiver: "innkeepers_shards",
      dialogue: [
        {
          if: { questComplete: "innkeepers_shards" },
          lines: ["Wren's secret is safe with the Division, at least. My drawers, though... I may need better locks, Agent."],
        },
        {
          if: { questActive: "innkeepers_shards", flag: "guest_identified" },
          lines: ["Room 7 has a name now — mine to remember, yours to report. I hear the Herald's already cackling about masks; whatever he's cooked up, it won't wait long."],
        },
        {
          if: { questActive: "innkeepers_shards" },
          briefing: { caseLabel: "MISSION 1", title: "Chains of Identity" },
          evidenceTables: {
            tabs: [
              {
                label: "TABLE A",
                columns: ["Room #", "Guest Status", "Coat Check Ticket #"],
                rows: [
                  ["Room 1", "Occupied", "T-801"],
                  ["Room 2", "Occupied", "T-805"],
                  ["Room 3", "Occupied", "T-809"],
                  ["Room 4", "Occupied", "T-812"],
                  ["Room 5", "Occupied", "T-815"],
                  ["Room 6", "Occupied", "T-820"],
                  ["Room 7", "Occupied", "T-822"],
                  ["Room 8", "Occupied", "T-825"],
                  ["Room 9", "Occupied", "T-830"],
                  ["Room 10", "Occupied", "T-833"],
                ],
              },
              {
                label: "TABLE B",
                columns: ["Ticket #", "Item Description", "Check-in Time"],
                rows: [
                  ["T-801", "Grey Hooded Cloak", "18:00"],
                  ["T-805", "Brown Travel Cloak", "18:05"],
                  ["T-809", "Black Robe", "18:10"],
                  ["T-812", "Grey Pointed Hat", "19:00"],
                  ["T-815", "Heavy Fur Coat", "19:30"],
                  ["T-820", "Blue Hood", "19:45"],
                  ["T-822", "Green Velvet Cloak", "20:15"],
                  ["T-825", "Grey Wool Cloak", "20:45"],
                  ["T-830", "Leather Vest", "21:00"],
                  ["T-833", "White Cape", "21:30"],
                ],
              },
              {
                label: "TABLE C",
                columns: ["Name", "Trade", "Appearance", "Entry Time"],
                rows: [
                  ["Larkin", "Envoy", "Grey Hooded Cloak", "18:00"],
                  ["Berrin", "Miller", "Brown Travel Cloak", "18:05"],
                  ["Corvin", "Scribe", "Black Robe", "18:10"],
                  ["Alderic", "Sage", "Grey Pointed Hat", "19:00"],
                  ["Grum", "Smith", "Heavy Fur Coat", "19:30"],
                  ["Tobin", "Mason", "Blue Hood", "19:45"],
                  ["Petra", "Courier", "Green Velvet Cloak", "19:50"],
                  ["Wren", "Courier", "Green Velvet Cloak", "20:15"],
                  ["Sable", "Weaver", "Grey Wool Cloak", "20:45"],
                  ["Hollis", "Courier", "Green Velvet Cloak", "21:00"],
                ],
              },
            ],
            caption: "EVIDENCE — THE SHARDED LOGS",
            buttonLabel: "VIEW THE LOGS",
          },
          ghostChoices: true,
          gridChoices: true,
          lines: SHARDS_MISSION_1_PAGES,
          choices: [
            {
              label: "LARKIN",
              response: "Start at the room, Ranger. Room 7 holds a ticket. The ticket holds an item and an hour. The gate saw who wore it, and when.",
            },
            {
              label: "BERRIN",
              response: "Start at the room, Ranger. Room 7 holds a ticket. The ticket holds an item and an hour. The gate saw who wore it, and when.",
            },
            {
              label: "CORVIN",
              response: "Start at the room, Ranger. Room 7 holds a ticket. The ticket holds an item and an hour. The gate saw who wore it, and when.",
            },
            {
              label: "ALDERIC",
              response: "Start at the room, Ranger. Room 7 holds a ticket. The ticket holds an item and an hour. The gate saw who wore it, and when.",
            },
            {
              label: "GRUM",
              response: "Start at the room, Ranger. Room 7 holds a ticket. The ticket holds an item and an hour. The gate saw who wore it, and when.",
            },
            {
              label: "TOBIN",
              response: "Start at the room, Ranger. Room 7 holds a ticket. The ticket holds an item and an hour. The gate saw who wore it, and when.",
            },
            {
              label: "PETRA",
              response: "The cloak matches — the hour does not. A quasi-identifier is rarely one attribute. Chain the TIME as well.",
            },
            {
              label: "WREN",
              setFlag: "guest_identified",
              points: 150,
              toast: "INTEL FILED — Sharding without severing the links is a locked door with the key in the lock.",
              response:
                "\"...Wren. Room 7. You chained my drawers together like beads on a string.\" The Herald, listening from the doorway, steps in: \"Three anonymous logs. One identity. That is a LINKAGE ATTACK, Ranger — separation is not anonymization when the links survive.\"",
            },
            {
              label: "SABLE",
              response: "Start at the room, Ranger. Room 7 holds a ticket. The ticket holds an item and an hour. The gate saw who wore it, and when.",
            },
            {
              label: "HOLLIS",
              response: "The cloak matches — the hour does not. A quasi-identifier is rarely one attribute. Chain the TIME as well.",
            },
          ],
        },
        {
          if: { questActive: "arrival" },
          lines: [
            "New face! Welcome to the festival — creativity's in the air, and every corner's got a workshop, a game, or a puzzle worth your time. Settle in... though don't be surprised if the Herald finds you first. He's been pacing the square all morning, itching to share something.",
          ],
        },
        { lines: ["The Griffin's Drink serves stories alongside the ale. Pull up a stool."] },
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
          if: { questComplete: "night_the_wall_fell" },
          lines: ["The Incident Register holds it now, Agent — every hour, every choice. Even the ones that needed no notice."],
        },
        {
          if: { questActive: "night_the_wall_fell", flag: "notice_filed" },
          briefing: { caseLabel: "STEP 5", title: "The Record" },
          lines: [
            "Last duty. Every hour, every choice, every reason — into the Incident Register. Including the East Gate probe last month that touched nothing.",
          ],
          choices: [
            {
              label: "Record everything.",
              setFlag: "incident_recorded",
              response:
                "Even the breaches that need no notice get a page. When the Authority comes — and they come — they ask one thing first: \"show me your records.\"",
            },
          ],
        },
        {
          if: { questActive: "night_the_wall_fell" },
          briefing: { caseLabel: "STEP 3", title: "File While Blind" },
          ghostChoices: true,
          lines: [
            "The notification to the Authority. I can file what we hold: nature of the breach, the categories touched, our containment. But the COUNT, Agent — we still cannot say how many scrolls were copied. Do we file incomplete, or do we wait for certainty?",
          ],
          choices: [
            {
              label: "File now, in phases. State what we know, state what we don't, supplement when we do.",
              setFlag: "notice_filed",
              response: "\"Investigation continuing.\" Four honest words the law was built to accept. Filed.",
            },
            {
              label: "Wait for the full count. Accuracy first.",
              setFlag: "notice_filed",
              clockPenalty: 30,
              response: "And if the count takes a week? Silence past the seventy-second hour is the violation — incompleteness is not. We file NOW.",
            },
          ],
        },
        { lines: ["Forty-six Trials, Agent. The tome on the desk once held one — the Academy holds all of them now."] },
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
  private odilePulse: Phaser.GameObjects.Arc | null = null;

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

    if (roomName === "tavern") {
      this.refreshOdilePulse(scene);
      const onLevelUp = () => this.refreshOdilePulse(scene);
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
          // Fixed px, not vh — #ui-root is a static 1280x720 box (see
          // style.css), not scaled to the true browser viewport, so a
          // percentage/vh-based height here would size against the wrong
          // frame of reference and can push the choice buttons below the
          // visible game area. Mission text is paginated into short
          // screens (see MISSION_1_PAGES/MISSION_2_PAGES) specifically so
          // this fits without needing the overflow scroll as a crutch.
          position: "absolute",
          left: "240px",
          top: "60px",
          width: "800px",
          maxHeight: "600px",
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
    const g = scene.add.circle(herald.image.x, herald.image.y - 20, 34, 0xf0b429, 0.22).setDepth(herald.image.y - 1);
    scene.tweens.add({ targets: g, alpha: { from: 0.22, to: 0.55 }, duration: 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    this.heraldPulse = g;
  }

  // Same technique, gold-pulsing Odile once Clearance 4 unlocks "The
  // Innkeeper's Shards" — she's the giver, not Herald, for this quest.
  private refreshOdilePulse(scene: Phaser.Scene) {
    if (this.odilePulse || questEngine.getClearance() < 4) return;
    const odile = this.npcs.find((n) => n.def.id === "odile");
    if (!odile) return;
    const g = scene.add.circle(odile.image.x, odile.image.y - 20, 34, 0xf0b429, 0.22).setDepth(odile.image.y - 1);
    scene.tweens.add({ targets: g, alpha: { from: 0.22, to: 0.55 }, duration: 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    this.odilePulse = g;
  }

  // One-shot bright flash on the Herald, distinct from the steady
  // ambient pulse above — used when the Academy's "IN THE VILLAGE →"
  // pip sends the player back to find him (see academy.ts).
  pingHerald(scene: Phaser.Scene) {
    const herald = this.npcs.find((n) => n.def.id === "herald");
    if (!herald) return;
    const g = scene.add.circle(herald.image.x, herald.image.y - 20, 10, 0xf0b429, 0.9).setDepth(herald.image.y + 1);
    scene.tweens.add({ targets: g, radius: 60, alpha: 0, duration: 900, ease: "Cubic.easeOut", onComplete: () => g.destroy() });
  }

  // "The Night the Wall Fell"'s opening beat — Bram slides straight to
  // the player (no pathfinding, just a tween) rather than the player
  // needing to hunt him down mid-alarm. Only tweens the sprite — never
  // def.x/y, which is a shared object living in the module-level
  // NPC_SPAWNS for the whole session; writing to it here would leave
  // Bram permanently relocated on every future room rebuild, long after
  // this quest ends. update()'s proximity check reads the live sprite
  // position for exactly this reason (see its comment).
  triggerBramDash(scene: Phaser.Scene, targetX: number, targetY: number) {
    const bram = this.npcs.find((n) => n.def.id === "bram");
    if (!bram) return;
    scene.tweens.add({
      targets: bram.image,
      x: targetX,
      y: targetY,
      duration: 700,
      ease: "Cubic.easeOut",
      onUpdate: () => {
        bram.image.setScale(bram.def.baseScale * depthScaleFor(bram.image.y));
        bram.image.setDepth(bram.image.y);
        bram.nameText.setPosition(bram.image.x, bram.image.y - bram.image.displayHeight - 4);
      },
    });
  }

  // "The village knows" beat (Step 4, correct choice) — whichever lore
  // NPCs are standing in the current room briefly turn to face the
  // fountain, then resume their normal idle facing. No generic
  // "villager" wanderers are currently spawned (see Room.ts's empty
  // WANDERER_ROUTES), so this reacts with whichever NPCs are actually
  // present rather than inventing sprites that don't exist.
  runVillagersTurnBeat(scene: Phaser.Scene) {
    const FOUNTAIN_X = 640;
    for (const npc of this.npcs) {
      const originalFlip = npc.image.flipX;
      npc.image.setFlipX(FOUNTAIN_X < npc.image.x);
      scene.time.delayedCall(3000, () => npc.image.setFlipX(originalFlip));
    }
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
      // Live sprite position, not npc.def.x/y — def is shared, static spawn
      // config (the same object lives in the module-level NPC_SPAWNS for
      // the whole session), so anything that actually moves an NPC (see
      // triggerBramDash()) must never write back into it.
      const dist = Phaser.Math.Distance.Between(playerX, playerY, npc.image.x, npc.image.y);
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
      // Evidence button appears from page 2 onward (not the intro page)
      // and persists through the question page too.
      if (isBriefing && this.lineIndex >= 1) {
        if (this.activeSet!.evidence) this.renderEvidenceButton(this.activeSet!.evidence);
        else if (this.activeSet!.evidenceTables) this.renderEvidenceTablesButton(this.activeSet!.evidenceTables);
      }
      if (isLast && this.activeSet!.choices) {
        this.renderChoices(
          this.activeSet!.choices.map((choice) => ({ label: choice.label, onClick: () => this.pickChoice(choice) })),
          this.activeSet!.ghostChoices ?? false,
          this.activeSet!.gridChoices ?? false,
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

  private renderEvidenceTablesButton(evidence: EvidenceTableRef) {
    this.briefingEvidenceRowEl.innerHTML = "";
    this.briefingEvidenceRowEl.appendChild(
      el("button", {
        className: "btn btn--gold",
        text: evidence.buttonLabel,
        on: { click: () => showTableOverlay(evidence.tabs, evidence.caption) },
      }),
    );
  }

  private pickChoice(choice: DialogueChoice) {
    const questId = questEngine.getActiveQuest()?.id;
    const stepIndex = questEngine.getActiveStepIndex();
    const attemptKey = `${questId ?? "none"}:${stepIndex}`;

    if (choice.setFlag) questEngine.setFlag(choice.setFlag);
    if (choice.points) questEngine.addPoints(choice.points);
    if (choice.milestone) questEngine.completeMilestone(choice.milestone);
    if (choice.clockPenalty) questEngine.addClockHours(choice.clockPenalty, true);
    if (choice.toast) questEngine.toast(choice.toast);

    logDecision(choiceEventName(questId, stepIndex), {
      npc: this.activeNpc?.id ?? null,
      quest: questId ?? null,
      step: stepIndex,
      label: choice.label,
      setFlag: choice.setFlag ?? null,
      points: choice.points ?? null,
      milestone: choice.milestone ?? null,
      clockPenalty: choice.clockPenalty ?? null,
      attempt: nextAttempt(attemptKey),
    });

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

  private renderChoices(choices: { label: string; onClick: () => void }[], ghost = false, grid = false) {
    this.clearChoices();
    const isBriefing = this.mode === "briefing";
    const rowStyle: Partial<CSSStyleDeclaration> = grid
      ? { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: "8px", marginTop: "12px" }
      : { display: "flex", flexDirection: isBriefing ? "column" : "row", gap: "12px", marginTop: "12px" };
    const row = el(
      "div",
      { style: rowStyle },
      choices.map((choice, i) =>
        el("button", {
          className: `btn ${!ghost && i === 0 ? "btn--gold" : "btn--ghost"}`,
          text: choice.label,
          style: grid ? { fontFamily: "var(--font-mono)", fontSize: "12px", padding: "10px 12px" } : {},
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
