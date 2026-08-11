import Phaser from "phaser";
import { GAME_HEIGHT } from "./config";
import type { RoomName } from "./rooms";
import { el, typewriter, type TypewriterHandle } from "./ui/dom";
import { showImageOverlay, type EvidenceImage } from "./ui/imageOverlay";
import { showTableOverlay, type EvidenceTableTab } from "./ui/tableOverlay";
import { openHealersLedgerSort } from "./ui/ledgerSortOverlay";
import { openHealersLedgerLock } from "./ui/ledgerLockOverlay";
import { openBlueprintOverlay } from "./ui/blueprintOverlay";
import { openSealedLetterOverlay } from "./ui/sealedLetterOverlay";
import { openTreasuryOverlay } from "./ui/treasuryOverlay";
import { openMarenWinterReportOverlay } from "./ui/marenWinterReportOverlay";
import { openArchivistsDeskOverlay } from "./ui/archivistsDeskOverlay";
import { getSession, type Faction } from "./session";
import { questEngine, type MilestoneId } from "./questEngine";
import { academy } from "./academy";
import { playSound, playBlip } from "./audio";
import { logDecision } from "./cloud/save";
import { dossier } from "./dossier";
import { healersLedgerState } from "./healersLedgerState";
import { postRoadFieldNotes } from "./postRoadFieldNotes";
import { postRoadBuilderState } from "./postRoadBuilderState";
import { sealedLetterState } from "./sealedLetterState";
import { treasuryKeysState } from "./treasuryKeysState";
import { marenWinterReportState } from "./marenWinterReportState";
import { logFirstQuestAccept, logLockedQuestBounce } from "./instrumentation";
import { archivistsDeskState } from "./archivistsDeskState";

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
  /** Shows one or more images inline, in a row, above the body text on
   * one specific page of a `briefing` set (`atLine` is a `lines` index)
   * — Mission 1's evidence page shows the Stronghold Defense Grid map
   * (one image) inline instead of the gate list starting with a plain
   * text header; Mission 2's shows the three attacker dossiers side by
   * side instead of naming them in text. Separate from `evidence`,
   * which is a button opening a full-screen zoomable overlay of the
   * same images; both can be set on the same DialogueSet. */
  lineImages?: { atLine: number; images: EvidenceImage[] };
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

// Study-first inversion (see PLAN): what a quest-giver says when their
// quest is still `locked` pending its paired Academy module's theory —
// keyed by quest id (each id has exactly one giver, so no need for a
// compound npc+quest key). Every entry here corresponds to a quest with
// a real fieldWork module (see academy.ts's getModuleForQuest()) —
// open()'s check only fires the dialogue when that lookup succeeds, so
// there's no "missing line" case to guard against; a quest still locked
// for some OTHER reason (mid-chain, no module) just falls through to
// ordinary ambient dialogue as before.
const LOCKED_QUEST_LINES: Record<string, string> = {
  breach_in_the_wall: "Not yet, Ranger. Read the Division's briefing on threat modeling first — then I'll hand you the blueprints.",
  post_road_blueprint: "Not yet. Walk the mail route with me once you know how to map where it actually goes — the Academy teaches that part first.",
  sealed_letter: "A forged letter needs a trained eye, Agent. Learn to secure a channel before you go hunting for a broken one.",
  healers_ledger: "Study what makes data sensitive before you touch my ledger, Agent. I'd rather you learned on parchment than on my patients.",
  maren_winter_report: "Before you touch my winter report, learn what a number can hide. The Academy will show you.",
  archivists_desk: "The purpose test, first. Come back when you can recite it.",
  innkeepers_shards: 'Those shards won’t un-shatter themselves, Agent — not without knowing what "de-identified" really means. Study first.',
  treasury_two_keys: "Coin buys a heavier lock, Agent, not a smarter one. Learn what interlocks before you touch my Treasury.",
};

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
  /** Quest id(s) this NPC offers when `available` — an array for an NPC
   * who gives more than one quest over the course of the game (Bram:
   * "The Blueprint of the Post Road," then "The Sealed Letter"); the
   * first id in the list that's actually `available` right now wins,
   * see open()'s giverQuestIds resolution. */
  questGiver?: string | string[];
  /** Falls back to this texture (already loaded by Preload.ts) if
   * `texture` never loaded — e.g. a real sprite that hasn't been
   * dropped into the repo yet. Logs a console.warn naming the expected
   * asset path so the eventual one-file swap is obvious; the fallback
   * is otherwise silent and the game plays on. */
  fallbackTexture?: { key: string; expectedPath: string };
  /** Gentle idle scale-pulse ("breathing") for a static single-frame
   * texture with no `idleAnim` sprite sheet. */
  breathingBob?: boolean;
  /** Tints a reused placeholder texture (e.g. npc-knight) so two minor
   * flavor NPCs sharing that texture don't read as literally the same
   * person — see "The Blueprint of the Post Road"'s Villager/Courier. */
  tint?: number;
  /** Static mirror flip at spawn — for two NPCs sharing one sprite sheet
   * who should face each other (e.g. the Great Hall's throne guards). */
  flipX?: boolean;
}

// --- "The Breach in the Wall" — Herald's mission briefings -----------
// Verbatim mission text (see PLAN.md), pulled out of NPC_SPAWNS below
// only because it's long enough to make the NPCDef literal unreadable
// inline. MISSION_1_PAGES is 2 pages (intro / measures-and-question
// together — the map itself lives only behind the separate "VIEW THE
// BLUEPRINT" evidence button, not inline on this page, so the question
// reads right under the data it's asking about) rather than one long
// scrolling wall of text — the briefing panel is a fixed-height box
// sized to the game's 1280x720 canvas (see its style comment below), so
// each page needs to fit without relying on scroll to reach the answer
// buttons.

const MISSION_1_PAGES = [
  `The Council sits in their high tower, boasting that the Privacy Village is impregnable. "The walls are high," they say. "The wards are ancient." But they look only at what they built, not what they forgot.

I have spent my life hunting the Shadownet. I know that a raider doesn't strike where the armor is thickest; he strikes where the leather is worn. I stole the architect's blueprints from the archives last night. The ink is faded, but the truth is there if you know how to look.

To defend a system, you must first map the Attack Surface. You cannot secure what you do not see. The Council has layered defenses upon the main roads — but my eyes are drawn to the shadows, to the forgotten paths used by servants and smugglers.`,
  `NORTH GATE (The King's Road)
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

🔍 A security system fails when it relies solely on prevention without detection. If a lock is picked in the dark, and no one is watching, is the gate truly shut? Which Gate lacks a Detective Control and relies on a single point of failure?`,
];

// Also 2 pages (intro / character-sheets-and-question together). Each
// threat actor's stats are spelled out in text here rather than relying
// on the portrait images alone (see EVIDENCE — THE SHADOWNET DOSSIER
// below) — the images aren't legible enough on their own for the
// player to actually work out the answer.
const MISSION_2_PAGES = [
  `Good work, Ranger. But knowing where they will strike is only half the battle. We must know who is coming. Not every beast in the Shadownet can exploit this breach.

The West Gate sits atop the treacherous "Cliff of Crows."
— An Army cannot march there; the path is too narrow.
— A Wizard cannot strike there; their magic flares would be spotted by the distant Main Tower.
— A Troll is too heavy; the cliff ledge would crumble.

To build a valid Threat Model, we must map the Attacker's Capabilities to the System's Vulnerabilities.`,
  `My scouts have intercepted a missive from the enemy camp. Three lieutenants have volunteered for the mission — read their sheets carefully.

THE DARK SORCERER — INT 18, Stealth 2
Void Blast lights the sky like a signal fire. The Main Tower would spot the flare from a league away.

THE GOBLIN SABOTEUR — DEX 18, Stealth 17
Climbs sheer cliffs like a staircase. No flare, no noise — a shadow among stones.

IRONHORN BERSERKER — STR 18, Stealth 3
Smashes any door, loudly. The cliff ledge would crumble under his weight before he reached the lock.

🔍 We need a threat actor with high Stealth (to avoid the tower) and high Dexterity (to pick the rusted padlock we found). Which Threat Actor can exploit the West Gate without raising the alarm?`,
];

// --- "The Innkeeper's Shards" — Odile's + Herald's mission briefings --
// Same 3-page pattern as MISSION_1/2_PAGES above (intro / evidence /
// question).

const SHARDS_MISSION_1_PAGES = [
  `The innkeeper has "sharded" his data into three isolated logs to prevent anyone from identifying his guests. The Room List knows only a Coat Check Ticket. The Coat Check Log knows only items and timestamps. The City Gate Log knows names and appearances — but nothing of the inn.

He believes separation makes the data anonymous. The Shadownet knows better. By CHAINING these three datasets, anyone can de-anonymize anyone.

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

They made a mistake. One entry's remaining attributes are STILL unique. If the Shadownet intercepts this log, it can mathematically prove who that person is. Your job: find the ONE row with no twin.`,
  `💾 THE EVIDENCE: SAFEHOUSE LOG (SANITIZED)
Quasi-identifiers: Trade | Age Range | District

Twelve entries, generalized and suppressed. Eleven of them should each have at least one identical twin elsewhere in the log. One does not.

HOW TO CHECK A TWIN: a match must be exact across all three columns together — same Trade, same Age Range, AND same District. Matching on only one or two columns doesn't count.`,
  `k-anonymity is a chain of twins, Ranger. Compare every row against every other — a single unmatched row breaks the promise for that one person, even if everyone else is safely hidden in a crowd.

TIP: group the rows by Trade first (Wardens, Scribes, Smiths, Couriers, Weavers) — each group should be internally identical. One group has a row that doesn't match its groupmates.

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
            "Seventy-two hours, give or take a nervous breakdown — the wall held because you refused to let the arithmetic beat you to it. The Council will frame this as their own triumph within the week. Grief counseling was never in the budget. Neither was gratitude.",
          ],
        },
        {
          if: { questActive: "night_the_wall_fell" },
          lines: [
            "GO. Bram is standing at a hole in the wall having what I can only describe, clinically, as the worst night of his professional life. This is not a drill. I checked. Twice. My hands are still shaking, which is either adrenaline or the coffee — statistically, could be either.",
          ],
        },
        {
          if: { questComplete: "innkeepers_shards" },
          lines: [
            "The mask slipped exactly once, and you were there to see the face underneath. Quill's scribes have been informed, in writing, that it must never happen again. They filed the memo. They will, of course, do it again. Bureaucracy has a memory like a leaking bucket.",
          ],
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
          lines: [
            "I have nothing further to add to Room 7's ongoing existential crisis. Odile's drawers hold the thread. Go pull on it, gently — the whole tavern is stitched together tighter than anyone in it realizes, and I'd rather you found that out than the Shadownet.",
          ],
        },
        {
          if: { questComplete: "breach_in_the_wall" },
          lines: [
            "Well met. The Council sleeps soundly tonight, blissfully unaware of how close their impregnable little kingdom came to becoming a very embarrassing footnote. I've decided not to tell them. It's kinder this way. For me, mostly.",
          ],
        },
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
        {
          lines: [
            "Not yet. You have the look of someone who hasn't finished orienting themselves in space and time, which is, statistically, most people, most days. Get your bearings. The wall's vulnerabilities have waited this long — they can wait for you to stop wobbling.",
          ],
        },
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
      questGiver: ["post_road_blueprint", "sealed_letter"],
      dialogue: [
        {
          if: { questComplete: "sealed_letter" },
          lines: [
            "The gate stayed shut. Four measures between a forged seal and my desk, and not one of them relied on me simply recognizing a face — which is good, because I wouldn't have. I'm terrible with faces. I'm excellent with paperwork. This is apparently what passes for a personality now.",
          ],
        },
        {
          if: { questComplete: "post_road_blueprint" },
          lines: [
            "It's filed. Twenty years at this desk, and I never once needed to draw where the letters actually go — I just trusted the system, the way you trust a floor to hold you, right up until you watch someone fall through it. I know the map now. I preferred not knowing.",
          ],
        },
        {
          if: { questActive: "post_road_blueprint", flag: "note_bram" },
          lines: [
            "I've said my piece. Go bother the villager who posts and the courier who carries — I only manage the middle, the part nobody thinks about until it breaks. The unglamorous truth of most systems: someone is always quietly holding the middle.",
          ],
        },
        {
          if: { questActive: "post_road_blueprint" },
          lines: [
            "Mail comes in from villagers at the drop box. I sort it at my desk by region — I read the ADDRESS, nothing else, I'm no gossip. Sorted bundles sleep in the vault overnight. Couriers take them at dawn.",
          ],
        },
        {
          if: { questComplete: "night_the_wall_fell" },
          lines: [
            "The gate's mended. The wax seal is set, official, reassuring. I still check that padlock twice a night, because paper promises and iron locks have a long, disappointing history together, and I've stopped pretending otherwise.",
          ],
        },
        {
          if: { questActive: "night_the_wall_fell", flag: "warden_heard" },
          lines: [
            "Go. That gate is not going to wedge itself shut through sheer force of my hoping, and every minute you spend admiring the scenery is a minute the clock doesn't care about. Move, Ranger — I'll stand here and have my crisis quietly.",
          ],
        },
        {
          if: { questActive: "night_the_wall_fell" },
          briefing: { caseLabel: "STEP 1", title: "Hear the Warden" },
          ghostChoices: true,
          lines: [
            "Agent! The West Gate — the padlock's picked, just as your Ranger said. The archive annex was ENTERED. Scrolls of villager records — debts, faction marks — may be copied, I can't yet say. I know what I saw at 02:00. What I don't know would fill that annex twice over. Two truths, and only one starts the clock the law watches: not what was taken, but the moment you learned something was.",
          ],
          choices: [
            {
              label: "A breach is presumed the moment you saw that open annex. The clock is already running — move.",
              setFlag: "warden_heard",
              response: "Then we count from 02:00. The clock doesn't wait for certainty, Agent — only for knowing.",
            },
            {
              label: "Say nothing yet. We investigate fully first — days if we must.",
              setFlag: "warden_heard",
              clockPenalty: 24,
              response: "Days?! Agent, the law counts from KNOWING, not from finishing! Every hour you spend confirming is an hour you'll owe later. The Herald will skin us.",
            },
          ],
        },
        {
          if: { questActive: "arrival" },
          lines: [
            "Welcome to Privacy Village, {name}. The festival is just getting started — workshops, games, puzzles, the whole square dressed up like nothing bad has ever happened here. The walls keep us safe. Mostly. The Council likes the word 'impregnable.' I've personally retired it from my vocabulary, along with 'definitely,' 'certainly,' and 'I'm sure it's fine.'",
          ],
        },
        {
          lines: [
            "Keep exploring. The gates never truly close, which some people find charming and I find, on a purely professional level, deeply concerning.",
          ],
        },
      ],
    },
    {
      // Generic role-based flavor NPC, not a named lore character (see
      // "The Blueprint of the Post Road") — a 30-frame greeting strip
      // (hooded/cloaked variant), distinct from the courier's own strip.
      id: "post_villager",
      name: "Villager",
      x: 1000,
      y: 560,
      texture: "npc-villager",
      baseScale: 75 / 633,
      idleAnim: "npc-villager-idle",
      dialogue: [
        {
          // Flag is "note_post_villager" (see POST_ROAD_NOTES/
          // recordPostRoadNote() below, keyed by this NPCDef's own id).
          if: { questActive: "post_road_blueprint", flag: "note_post_villager" },
          lines: [
            "Find the courier if you haven't. I only know my end of the string — the part where I let go of it and stop thinking about where it lands. Healthy boundaries, or willful ignorance. The line gets blurry.",
          ],
        },
        {
          if: { questActive: "post_road_blueprint" },
          lines: ["I post letters twice a week. Never see where they go after the box."],
        },
        {
          lines: [
            "Best festival in memory, if you're asking a man whose memory mostly consists of drop-box schedules. Mind the seal — the paint's still wet, and I will absolutely know if you touched it.",
          ],
        },
      ],
    },
    {
      id: "courier",
      name: "Courier",
      // Near the west_gate_marker zone (see village.json) — couriers work
      // the gates, same reasoning as Bram vetting faces there.
      x: 220,
      y: 610,
      texture: "npc-courier",
      // Real sprite: an 18-frame idle strip (414x554/frame, see
      // Preload.ts), cropped from a "Forest Ranger" character pack.
      baseScale: 75 / 554,
      idleAnim: "npc-courier-idle",
      dialogue: [
        {
          if: { questActive: "post_road_blueprint", flag: "note_courier" },
          lines: [
            "I've told you everything I know, which is one sentence long and mildly incriminating out of context: the vault, never the desk. Some of us have very narrow, very defensible jurisdictions.",
          ],
        },
        {
          if: { questActive: "post_road_blueprint" },
          lines: ["We collect from the vault at dawn. We never touch the sorting desk — Bram would have our ears."],
        },
        {
          lines: [
            "Can't stop long. The dawn route waits for no one — not festivals, not existential dread, not whatever's happening with your face right now. Move along, I have a schedule and a deeply fragile sense of purpose tied to keeping it.",
          ],
        },
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
          lines: [
            "Wren's secret is safe with the Division, at least — a small comfort, filed next to all my other small comforts. My drawers, though, remain a philosophical embarrassment. I may need better locks. Or fewer secrets. The locks are cheaper.",
          ],
        },
        {
          if: { questActive: "innkeepers_shards", flag: "guest_identified" },
          lines: [
            "Room 7 has a name now. Mine to lie awake remembering, yours to report to men who file things. I hear the Herald is already cackling about masks somewhere — that particular laugh means someone, somewhere, is about to have a very bad week.",
          ],
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
            "A new face. Welcome to the festival — creativity is in the air, along with several other things I'd rather not analyze too closely. Every corner's got a workshop, a game, a puzzle desperate for your attention. Settle in, if you can. Though don't be surprised if the Herald finds you first — he's been pacing the square since dawn, wearing a groove into the cobblestones, itching to tell someone, anyone, about the wall's many, many feelings.",
          ],
        },
        {
          lines: [
            "The Griffin's Drink serves stories alongside the ale, and frankly the stories have a longer shelf life. Pull up a stool. Nobody here is in a hurry to be anywhere else, which should tell you something.",
          ],
        },
      ],
    },
    {
      id: "maren",
      name: "Maren",
      // Right-corner table cluster, clear of Odile (340,470) and the
      // "portrait" zone (790,450,r60) — see tavern.json's walkable rect
      // ([256,422]-[930,720]).
      x: 850,
      y: 600,
      texture: "npc-maren",
      // Real sprite: a 10-frame idle strip (501x461/frame, see
      // Preload.ts), cropped from a fairy character pack. Targets the
      // same ~75px on-screen height every other NPC uses.
      baseScale: 75 / 461,
      idleAnim: "npc-maren-idle",
      fallbackTexture: { key: "npc-knight", expectedPath: "client/public/assets/npc/healer/maren.png" },
      // "Maren's Winter Report" is a direct sequel to "The Healer's
      // Ledger" — same NPC, second quest. See open()'s giverQuestIds
      // resolution (Bram's post_road_blueprint/sealed_letter pair set
      // this precedent).
      questGiver: ["healers_ledger", "maren_winter_report"],
      dialogue: [
        {
          if: { questComplete: "maren_winter_report" },
          lines: [
            "The Council gets their numbers. Not a single villager's name leaves this desk. I keep turning the question over like a coin that won't land: why did it take a crisis for me to think to count BEFORE I sent, instead of after, in a panic, with a lantern and someone else's mistakes?",
          ],
        },
        {
          if: { questComplete: "healers_ledger" },
          lines: [
            "The chest holds. My apprentices grumble about the key — about the extra step, the extra minute, the extra whatever — but grumbling I can live with. Grumbling has never once leaked a single record.",
          ],
        },
        // Everything else about her interaction while a quest is
        // active-but-unresolved is handled by NPCController.open()'s
        // special case (the sorting board/lock puzzle and the report
        // pipeline are full-screen mini-games, not compact dialogue) —
        // this fallback only ever shows before Clearance 3 unlocks the
        // first quest offer.
        {
          lines: [
            "Odile lets me keep a corner of the tavern, on the theory that my patients drink more after bad news, which is either sound business instinct or a quiet accusation. I've chosen not to examine it further.",
          ],
        },
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
      // "The Archivist's Desk" — judging the factions' data requests is
      // literally Quill's job, so he's the natural giver (see open()'s
      // special-case block below for the full-screen ticket queue).
      questGiver: "archivists_desk",
      dialogue: [
        {
          if: { questComplete: "night_the_wall_fell" },
          lines: [
            "The Incident Register holds it now — every hour, every choice, every small cowardice and small courage, all filed under the same flat, indifferent ink. Even the ones that needed no notice get a page. Especially those, honestly. Nobody remembers the near-misses unless someone writes them down.",
          ],
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
            "The notification to the Authority is due within the seventy-second hour of first knowing, Agent — no exceptions for incomplete facts. I can file what we hold: nature of the breach, the categories touched, our containment. But the COUNT — we still cannot say how many scrolls were copied. Do we file incomplete now, or hold it for certainty and gamble on the deadline?",
          ],
          choices: [
            {
              label: "File now, in phases. State what we know, state what we don't, supplement when we do.",
              setFlag: "notice_filed",
              response: "\"Investigation continuing.\" Four honest words the law was built to accept — a partial notice filed on time beats a perfect one filed late. Filed.",
            },
            {
              label: "Wait for the full count. Accuracy first.",
              setFlag: "notice_filed",
              clockPenalty: 30,
              response: "And if the count takes a week? Silence past the seventy-second hour is the violation — incompleteness is not. We file NOW.",
            },
          ],
        },
        {
          if: { questComplete: "archivists_desk" },
          lines: [
            "Six requests, six rulings, and the ledger still balances, which in my experience is closer to a miracle than a Tuesday. The factions grumble — at me, specifically, and not at each other, which I've decided to consider a professional accomplishment rather than a personal tragedy.",
          ],
        },
        {
          lines: [
            "Forty-six Trials. The tome on this desk once held exactly one, hand-copied, precious, alone — now the Academy holds all of them, organized, cross-referenced, and somehow still less comforting than the single lonely copy I remember.",
          ],
        },
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
          lines: [
            "Sit, if you wish. The bench asks nothing of you but patience, which is more than I can say for most of what happens in this building.",
          ],
        },
      ],
    },
  ],
  great_hall: [
    {
      id: "mayor",
      name: "Mayor",
      // Seated ON the throne itself (great_hall_bg.png), not standing
      // beside it — "The Treasury's Two Keys"'s giver, holding court
      // where a Mayor actually would rather than loitering in the town
      // square. x/y is the throne seat's centered position; the idle
      // sprite has no dedicated sitting pose, so this just overlaps the
      // painted throne closely enough to read as occupying it.
      x: 828,
      y: 348,
      texture: "npc-mayor",
      // Real sprite: a 30-frame idle strip (414x567/frame, see
      // Preload.ts), cropped from a "Blacksmith" character pack.
      baseScale: 75 / 567,
      idleAnim: "npc-mayor-idle",
      questGiver: "treasury_two_keys",
      dialogue: [
        {
          if: { questComplete: "treasury_two_keys" },
          lines: [
            "So the lock was the easy half, wasn't it. I bought iron when what I actually needed was rules, and a logbook, and possibly a long hard look at my own decision-making. Fine. FINE. I'm capable of growth. Well done, Agent.",
          ],
        },
        {
          lines: [
            "The Treasury does not, regrettably, lock itself — I've raised the issue in three separate meetings. Mind the steps. I had them polished for the festival, mostly so I'd have something to point at when people ask what I actually do here.",
          ],
        },
      ],
    },
    {
      // Pure flavor — no quest ties, just funny lines when pressed.
      // Flanking the dais steps, one per side (see the crop analysis in
      // the commit that added them): symmetric distance from the
      // throne, both facing inward via flipX.
      id: "throne_guard_reginald",
      name: "Sir Reginald",
      x: 650,
      y: 495,
      texture: "npc-knight-guard",
      // Real sprite: a 10-frame idle strip (559x510/frame, see
      // Preload.ts), cropped from a "Knight_02" character pack.
      baseScale: 75 / 510,
      idleAnim: "npc-knight-guard-idle",
      dialogue: [
        {
          lines: [
            "State your business — actually, don't bother, I already know why everyone comes here. It's the throne. It's always the throne. Nobody has ever once come to see me, specifically, and I've made my peace with that. Mostly.",
            "Standing perfectly still for six hours either builds character or destroys a knee. The data, so far, is inconclusive. My knee has opinions.",
            "The Mayor tips well. Percival, over there, insists HE'S the reason the Mayor tips well. I maintain that I'm the reason Percival still has a job, a pension, and someone to argue with at lunch.",
            "Move along, Agent. There is nothing to see here except me, magnificently, tragically guarding a chair that has never once thanked me for it.",
          ],
        },
      ],
    },
    {
      id: "throne_guard_percival",
      name: "Sir Percival",
      x: 1015,
      y: 495,
      texture: "npc-knight-guard",
      baseScale: 75 / 510,
      flipX: true,
      idleAnim: "npc-knight-guard-idle",
      dialogue: [
        {
          lines: [
            "HALT. ...I'm kidding. Come through. We don't actually stop anyone — the halting is purely ceremonial, like most of what happens in this hall.",
            "Fun fact: this armor has never once stopped a sword. It has, however, successfully stopped three separate arguments about who has to stand in the draft. I consider that a real, tangible victory.",
            "Reginald believes he's funnier than me. He is incorrect, and deeply so. Please tell him I said that, Agent. Word for word. I'll wait.",
            "Guarding a throne is ten percent vigilance and ninety percent the ongoing effort not to fall asleep standing up. Current reading: ninety-one percent. I may already be dreaming.",
          ],
        },
      ],
    },
  ],
};

interface NPCView {
  def: NPCDef;
  image: Phaser.GameObjects.Sprite;
  nameText: Phaser.GameObjects.Text;
}

// Which room an NPC id lives in — Room.ts uses this to know whether the
// current objective NPC (see questEngine.getObjectiveNpcId()) is here
// (gets the ambient pulse, see NPCController.refreshObjectivePulse())
// or in a different room entirely (gets the off-screen door arrow
// instead, since rooms are fixed-camera and never scroll — see
// CLAUDE.md).
export function findNpcRoom(npcId: string): RoomName | undefined {
  for (const [room, defs] of Object.entries(NPC_SPAWNS) as [RoomName, NPCDef[]][]) {
    if (defs.some((d) => d.id === npcId)) return room;
  }
  return undefined;
}

// "minigame" — Maren's two Healer's Ledger mini-games (see open()'s
// special case): a real DOM overlay owns the interaction start to
// finish, this mode only exists so dialogueOpen (and therefore Room.ts's
// uiOpen, which gates WASD/door/zone checks) stays true for its
// duration, and so a stray E press routes into advance()'s existing
// "no activeSet, no-op" guard instead of leaking through to whatever
// NPCController would otherwise do while nothing else is open.
type DialogueMode = "closed" | "dialogue" | "offer" | "briefing" | "minigame";

export class NPCController {
  private npcs: NPCView[] = [];
  private promptText: Phaser.GameObjects.Text;
  private dialogueEl: HTMLElement;
  private dialogueNameEl: HTMLElement;
  private dialogueBodyEl: HTMLElement;
  private dialogueHintEl: HTMLElement;
  private dialogueBackBtn: HTMLButtonElement;
  private choiceRowEl: HTMLElement | null = null;

  // Big `.briefing`-styled panel — Herald's mission text (see the
  // DialogueSet.briefing doc comment above). Built once, hidden by
  // default; open()/showLine() switch which of these two DOM structures
  // is visible based on activeSet.briefing.
  private briefingBackdropEl: HTMLElement;
  private briefingEl: HTMLElement;
  private briefingCaseEl: HTMLElement;
  private briefingTitleEl: HTMLElement;
  private briefingImagesRowEl: HTMLElement;
  private briefingBodyEl: HTMLElement;
  private briefingEvidenceRowEl: HTMLElement;
  private briefingHintEl: HTMLElement;
  private briefingBackBtn: HTMLButtonElement;
  private briefingChoiceRowEl: HTMLElement | null = null;

  private eKey: Phaser.Input.Keyboard.Key;

  private mode: DialogueMode = "closed";
  private activeNpc: NPCDef | null = null;
  private activeSet: DialogueSet | null = null;
  private offerQuestId: string | null = null;
  private lineIndex = 0;
  private currentTypewriter: TypewriterHandle | null = null;
  // Single ambient marker for "whoever the player needs to reach right
  // now" (see questEngine.getObjectiveNpcId()) — replaces what used to
  // be five near-identical per-NPC methods gated on hardcoded clearance
  // thresholds (a leftover of the pre-Academy-inversion unlock scheme,
  // now stale since quests unlock via theory or narrative chains
  // instead). One marker at a time, since only one objective is ever
  // live.
  private objectivePulse: Phaser.GameObjects.Arc | null = null;

  constructor(scene: Phaser.Scene, roomName: RoomName) {
    this.eKey = scene.input.keyboard!.addKey("E");

    for (const def of NPC_SPAWNS[roomName] ?? []) {
      let textureKey = def.texture;
      if (def.fallbackTexture && !scene.textures.exists(textureKey)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[npc.ts] "${def.name}" sprite not found (expected at ${def.fallbackTexture.expectedPath}) — using a placeholder texture. Drop the real asset in at that path and it swaps automatically, no code changes needed.`,
        );
        textureKey = def.fallbackTexture.key;
      }
      const image = scene.add.sprite(def.x, def.y, textureKey).setOrigin(0.5, 1);
      image.setScale(def.baseScale * depthScaleFor(def.y));
      image.setDepth(def.y);
      if (def.tint !== undefined) image.setTint(def.tint);
      if (def.flipX) image.setFlipX(true);
      if (def.idleAnim) image.play(def.idleAnim);
      // Cheap idle motion for a static single-frame texture with no
      // idleAnim strip — a slow scale pulse reads as "breathing" without
      // touching position (which would desync the name tag/depth, both
      // set once here and never recomputed for a stationary NPC).
      if (def.breathingBob) {
        const baseScale = image.scale;
        scene.tweens.add({ targets: image, scale: baseScale * 1.015, duration: 1400, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      }

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

    // Reactive on every questUpdated (accept/unlock/complete, whatever
    // the source), not just levelUp — the old scheme only re-checked on
    // clearance changes, which missed theory-driven unlocks entirely.
    this.refreshObjectivePulse(scene);
    const onObjectiveChange = () => this.refreshObjectivePulse(scene);
    questEngine.on("questUpdated", onObjectiveChange);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => questEngine.off("questUpdated", onObjectiveChange));

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
    this.dialogueBackBtn = el("button", {
      className: "btn btn--ghost",
      text: "◂ BACK",
      style: { fontSize: "11px", padding: "6px 12px", visibility: "hidden" },
      on: { click: () => this.back() },
    });
    const dialogueFooterEl = el(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
      [this.dialogueBackBtn, this.dialogueHintEl],
    );
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
      [this.dialogueNameEl, this.dialogueBodyEl, dialogueFooterEl],
    );

    document.getElementById("ui-root")!.appendChild(this.dialogueEl);

    this.briefingCaseEl = el("span", { className: "briefing__case" });
    this.briefingTitleEl = el("h2", { className: "briefing__title" });
    // Inline evidence image(s) (see DialogueSet.lineImages) — hidden by
    // default, filled in with one <img> per entry only on the specific
    // page that opts in via showLine(). Separate from the
    // evidence-button overlay (renderEvidenceButton()), which stays
    // available for a full-screen zoomable look at the same images.
    this.briefingImagesRowEl = el("div", {
      style: { display: "none", gap: "12px", marginBottom: "var(--space-3)" },
    });
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
      },
    });
    this.briefingBackBtn = el("button", {
      className: "btn btn--ghost",
      text: "◂ BACK",
      style: { fontSize: "11px", padding: "6px 12px", visibility: "hidden" },
      on: { click: () => this.back() },
    });
    const briefingFooterEl = el(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "var(--space-2)" } },
      [this.briefingBackBtn, this.briefingHintEl],
    );
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
          this.briefingImagesRowEl,
          this.briefingBodyEl,
          this.briefingEvidenceRowEl,
        ]),
        briefingFooterEl,
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

  // Ambient marker for "whoever the player needs to reach right now"
  // (see questEngine.getObjectiveNpcId()) — scale+opacity tween, ~1.2s
  // loop, conspicuous enough to catch a first-time player's eye at
  // spawn (the old per-NPC clearance-gated pulses never covered the
  // arrival quest's very first objective at all). Re-run on every
  // questUpdated; no-ops (leaves the marker cleared) if the current
  // objective NPC isn't in this room — Room.ts's off-screen door arrow
  // covers that case instead.
  private refreshObjectivePulse(scene: Phaser.Scene) {
    this.objectivePulse?.destroy();
    this.objectivePulse = null;
    const npcId = questEngine.getObjectiveNpcId();
    if (!npcId) return;
    const target = this.npcs.find((n) => n.def.id === npcId);
    if (!target) return;
    const g = scene.add.circle(target.image.x, target.image.y - 20, 34, 0xf0b429, 0.25).setDepth(target.image.y - 1);
    scene.tweens.add({
      targets: g,
      scale: { from: 1, to: 1.35 },
      alpha: { from: 0.25, to: 0.6 },
      duration: 1200,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    this.objectivePulse = g;
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

  // One-shot flash on Bram, same technique as pingHerald() — used by the
  // Academy's "IN THE VILLAGE →" pip for field work he gives (see
  // academy.ts's AcademyFieldWork.ping).
  pingBram(scene: Phaser.Scene) {
    const bram = this.npcs.find((n) => n.def.id === "bram");
    if (!bram) return;
    const g = scene.add.circle(bram.image.x, bram.image.y - 20, 10, 0xf0b429, 0.9).setDepth(bram.image.y + 1);
    scene.tweens.add({ targets: g, radius: 60, alpha: 0, duration: 900, ease: "Cubic.easeOut", onComplete: () => g.destroy() });
  }

  // One-shot flash on the Mayor, same technique as pingHerald()/pingBram()
  // — used by the Academy's "IN THE VILLAGE →" pip for "Measures that
  // Interlock" (see academy.ts's AcademyFieldWork.ping).
  pingMayor(scene: Phaser.Scene) {
    const mayor = this.npcs.find((n) => n.def.id === "mayor");
    if (!mayor) return;
    const g = scene.add.circle(mayor.image.x, mayor.image.y - 20, 10, 0xf0b429, 0.9).setDepth(mayor.image.y + 1);
    scene.tweens.add({ targets: g, radius: 60, alpha: 0, duration: 900, ease: "Cubic.easeOut", onComplete: () => g.destroy() });
  }

  // One-shot flash on Maren, same technique as pingHerald()/pingBram()/
  // pingMayor() — used by the Academy's "IN THE TAVERN →" pip for
  // "Shaping the Data" (see academy.ts's AcademyFieldWork.ping). She
  // may already have the ambient objective pulse (refreshObjectivePulse()
  // above) if her quest is the current one; this is just the one-shot
  // on-demand flash.
  pingMaren(scene: Phaser.Scene) {
    const maren = this.npcs.find((n) => n.def.id === "maren");
    if (!maren) return;
    const g = scene.add.circle(maren.image.x, maren.image.y - 20, 10, 0xf0b429, 0.9).setDepth(maren.image.y + 1);
    scene.tweens.add({ targets: g, radius: 60, alpha: 0, duration: 900, ease: "Cubic.easeOut", onComplete: () => g.destroy() });
  }

  // One-shot flash on Quill, same technique as pingHerald()/pingBram()/
  // pingMayor()/pingMaren() — used by the Academy's "IN THE COURTHOUSE →"
  // pip for "The Purpose Test"'s "The Archivist's Desk" (see academy.ts's
  // AcademyFieldWork.ping). No ambient pulse exists for Quill yet — this
  // is the only visual cue pointing back to him.
  pingQuill(scene: Phaser.Scene) {
    const quill = this.npcs.find((n) => n.def.id === "quill");
    if (!quill) return;
    const g = scene.add.circle(quill.image.x, quill.image.y - 20, 10, 0xf0b429, 0.9).setDepth(quill.image.y + 1);
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

    // The `!getActiveQuest()` guard matters now that an NPC can be both
    // a giver for one quest and a dialogue host for another (Bram: gives
    // "The Blueprint of the Post Road," then "The Sealed Letter," also
    // hosts "The Night the Wall Fell"'s opening step) — without it, a
    // quest sitting `available` but not yet accepted would hijack this
    // NPC's dialogue even while a DIFFERENT quest is the one currently
    // active and using them for its own content. Matches acceptQuest()'s
    // existing "one active quest at a time" invariant: there's no point
    // offering a quest the engine would silently refuse to activate
    // anyway. `questGiver` may list more than one quest id (see NPCDef's
    // doc comment) — offer whichever one of them is actually available
    // right now.
    const giverQuestIds = def.questGiver ? (Array.isArray(def.questGiver) ? def.questGiver : [def.questGiver]) : [];
    const availableGiverQuestId = giverQuestIds.find((id) => questEngine.isAvailable(id));
    if (availableGiverQuestId && !questEngine.getActiveQuest()) {
      this.mode = "offer";
      this.offerQuestId = availableGiverQuestId;
      this.dialogueEl.style.display = "block";
      this.showOffer();
      return;
    }

    // Study-first inversion (see PLAN) — a quest-giver whose quest is
    // still `locked` because its paired Academy module's theory isn't
    // sealed yet says so in character, with a direct shortcut into that
    // module, instead of silently falling through to ambient dialogue.
    // No gold pulse here (that's reserved for availableGiverQuestId
    // above) — see LOCKED_QUEST_LINES' doc comment for why a quest
    // without a paired module never reaches this branch.
    const lockedGiverQuestId = giverQuestIds.find((id) => questEngine.getState(id) === "locked");
    const lockedModule = lockedGiverQuestId ? academy.getModuleForQuest(lockedGiverQuestId) : undefined;
    if (lockedGiverQuestId && lockedModule && !questEngine.getActiveQuest()) {
      logLockedQuestBounce(lockedGiverQuestId, lockedModule.id);
      this.mode = "dialogue";
      this.dialogueEl.style.display = "block";
      this.dialogueNameEl.textContent = def.name;
      this.dialogueHintEl.textContent = "";
      this.dialogueBackBtn.style.visibility = "hidden";
      this.activeSet = null;
      const moduleId = lockedModule.id;
      this.currentTypewriter = typewriter(this.dialogueBodyEl, LOCKED_QUEST_LINES[lockedGiverQuestId] ?? "Not yet, Agent. Study first.", 18, () => {
        this.renderChoices([
          { label: "Open the Academy", onClick: () => { academy.openToModule(moduleId); this.closeDialogue(); } },
          { label: "Not yet", onClick: () => this.closeDialogue() },
        ]);
      });
      return;
    }

    // Bram re-opens the Post Road builder if the player Escaped out of
    // it early (see openPostRoadBuilder()'s doc comment) — the normal
    // first-time open happens automatically right after the courier
    // interview (see closeDialogue()), not via talking to Bram at all,
    // so this only ever fires on a resume.
    if (def.id === "bram" && questEngine.isActive("post_road_blueprint") && questEngine.getActiveStepIndex() === 3) {
      this.openPostRoadBuilder();
      return;
    }

    // "The Sealed Letter" is one continuous full-screen overlay covering
    // the whole quest (hook + all four measures) — unlike the Post
    // Road's dialogue-then-builder split, there's no interview phase
    // first, so every Bram interaction while this quest is active opens
    // it directly (also how a mid-quest Escape gets resumed — no
    // separate resume check needed).
    if (def.id === "bram" && questEngine.isActive("sealed_letter")) {
      this.openSealedLetter();
      return;
    }

    // "The Treasury's Two Keys" — one continuous full-screen overlay,
    // same "no partial resume" pattern as the Post Road builder / Sealed
    // Letter above (a resumed Escape just restarts the board).
    if (def.id === "mayor" && questEngine.isActive("treasury_two_keys")) {
      this.openTreasuryOverlay();
      return;
    }

    // Maren's two Healer's Ledger mini-games are full-screen DOM
    // overlays, not compact dialogue/briefing text — see DialogueMode's
    // "minigame" doc comment for why this still needs to occupy `mode`
    // for the overlay's whole lifetime. The two flags below are exactly
    // what healers_ledger.json's two steps trigger on (talk_to maren,
    // requiresFlag) — setting them and calling notifyTalkTo() here
    // reuses the engine's normal step-advance path instead of needing a
    // bespoke one for this quest.
    if (def.id === "maren" && questEngine.isActive("healers_ledger")) {
      this.mode = "minigame";
      if (!questEngine.getFlag("ledger_sorted")) {
        openHealersLedgerSort((completed) => {
          this.mode = "closed";
          if (!completed) return;
          questEngine.setFlag("ledger_sorted");
          questEngine.notifyTalkTo("maren");
        });
      } else if (!questEngine.getFlag("chest_locked")) {
        openHealersLedgerLock((completed) => {
          this.mode = "closed";
          if (!completed) return;
          questEngine.setFlag("chest_locked");
          const { breachCount, overClassifyCount, accessChoiceAttempts } = healersLedgerState;
          logDecision("healers_ledger_complete", { breachCount, overClassifyCount, accessChoiceAttempts });
          dossier.recordQuestStat("healers_ledger", { breachCount, overClassifyCount, accessChoiceAttempts });
          if (breachCount === 0 && overClassifyCount === 0) {
            questEngine.toast("COMMENDATION — The Healer's Ledger sorted without a single slip.");
          }
          questEngine.notifyTalkTo("maren");
        });
      } else {
        // Both flags already set but the quest hasn't completed yet —
        // shouldn't happen (the second flag's notifyTalkTo() above always
        // completes the quest, its last step), but don't leave the
        // player stuck in "minigame" mode with nothing open if it does.
        this.mode = "closed";
      }
      return;
    }

    // "Maren's Winter Report" — one continuous full-screen overlay, same
    // "no partial resume" simplification as the other full-screen
    // minigames in this file.
    if (def.id === "maren" && questEngine.isActive("maren_winter_report")) {
      this.openMarenWinterReport();
      return;
    }

    // "The Archivist's Desk" — one continuous full-screen overlay, same
    // "no partial resume" simplification as every other full-screen
    // minigame in this file.
    if (def.id === "quill" && questEngine.isActive("archivists_desk")) {
      this.openArchivistsDesk();
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
    this.dialogueBackBtn.style.visibility = "hidden";
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
      logFirstQuestAccept();
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
    const backBtn = isBriefing ? this.briefingBackBtn : this.dialogueBackBtn;
    backBtn.style.visibility = this.lineIndex > 0 ? "visible" : "hidden";

    if (isBriefing && this.activeSet.briefing) {
      this.briefingCaseEl.textContent = this.activeSet.briefing.caseLabel;
      this.briefingTitleEl.textContent = this.activeSet.briefing.title;
      this.briefingEvidenceRowEl.innerHTML = "";
      const lineImages = this.activeSet.lineImages;
      if (lineImages && lineImages.atLine === this.lineIndex) {
        this.briefingImagesRowEl.innerHTML = "";
        this.briefingImagesRowEl.style.display = "flex";
        for (const img of lineImages.images) {
          this.briefingImagesRowEl.appendChild(
            el("figure", { style: { flex: "1", minWidth: "0", margin: "0" } }, [
              el("img", {
                attrs: { src: img.src, alt: img.label ?? "" },
                style: { width: "100%", display: "block", borderRadius: "var(--radius-sm)", border: "2px solid var(--border-strong)", objectFit: "cover" },
              }),
              ...(img.label
                ? [
                    el("figcaption", {
                      text: img.label,
                      style: {
                        marginTop: "6px",
                        textAlign: "center",
                        fontFamily: "var(--font-mono)",
                        fontSize: "11px",
                        letterSpacing: "0.04em",
                        color: "var(--text-muted)",
                      },
                    }),
                  ]
                : []),
            ]),
          );
        }
      } else {
        this.briefingImagesRowEl.style.display = "none";
      }
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

  // Mirrors advance(), one page backward instead of forward — click-only
  // (the button hides itself at lineIndex 0, see showLine()), so there's
  // no "closeDialogue() on underflow" case to mirror advance()'s.
  private back() {
    if (!this.activeNpc || !this.activeSet || this.lineIndex <= 0) return;
    if (this.currentTypewriter && !this.currentTypewriter.finished) this.currentTypewriter.skip();
    this.clearChoices();
    this.lineIndex--;
    this.showLine();
  }

  private closeDialogue() {
    const npcId = this.activeNpc?.id;
    // Captured before activeSet is cleared below — true only when a real
    // conditional dialogue line was shown (see pickDialogueSet()), false
    // for the offer flow's Accept/Not-yet, which never sets activeSet at
    // all (see open()'s early return). Distinguishes "Bram's interview
    // line actually played" from "the player just accepted the quest by
    // talking to its giver" — both call notifyTalkTo(npcId) with the same
    // npcId, but only the former should record a field note (see
    // recordPostRoadNote() below).
    const hadRealDialogue = this.activeSet !== null;
    this.mode = "closed";
    this.activeNpc = null;
    this.activeSet = null;
    this.offerQuestId = null;
    this.dialogueEl.style.display = "none";
    this.briefingEl.style.display = "none";
    this.briefingBackdropEl.style.display = "none";
    this.clearChoices();
    if (npcId && hadRealDialogue) this.recordPostRoadNote(npcId);
    if (npcId) questEngine.notifyTalkTo(npcId);
    // The courier is the third and last interview — if that just landed
    // the quest on its synthetic 4th step (see post_road_blueprint.json's
    // reach_zone step), open the builder immediately rather than making
    // the player find a fourth thing to click.
    if (npcId === "courier" && questEngine.isActive("post_road_blueprint") && questEngine.getActiveStepIndex() === 3) {
      this.openPostRoadBuilder();
    }
  }

  // Opens "The Blueprint of the Post Road"'s Phase 2-4 builder — called
  // both right after the courier interview (above) and again if the
  // player talks to Bram after Escaping out of it early (see open()'s
  // special-case for "bram"), since the builder itself has no partial-
  // resume (a fresh Escape restarts Phase 2-4 from scratch, same
  // simplification as Maren's two Healer's Ledger mini-games).
  private openPostRoadBuilder() {
    this.mode = "minigame";
    openBlueprintOverlay((completed) => {
      this.mode = "closed";
      if (!completed) return;
      const { slotErrors, arrowErrors, rogueArrowFoundSeconds, cipherToggleAttempts } = postRoadBuilderState;
      logDecision("post_road_blueprint", { slotErrors, arrowErrors, rogueArrowFoundSeconds, cipherToggleAttempts });
      dossier.recordQuestStat("post_road_blueprint", { slotErrors, arrowErrors, rogueArrowFoundSeconds, cipherToggleAttempts });
      if (slotErrors === 0 && arrowErrors === 0 && cipherToggleAttempts === 1) {
        questEngine.toast("COMMENDATION — The Post Road mapped without a wrong stroke.");
      }
      questEngine.notifyReachZone("post_road_blueprint_complete");
    });
  }

  // "The Sealed Letter" — one continuous overlay (hook + all four
  // measures), same "no partial resume" simplification as the other
  // full-screen minigames in this file.
  private openSealedLetter() {
    this.mode = "minigame";
    openSealedLetterOverlay((completed) => {
      this.mode = "closed";
      if (!completed) return;
      const { forgeryCaughtSeconds, passwordChoice, wrongSealAttempts, encryptChoice } = sealedLetterState;
      logDecision("sealed_letter", { forgeryCaughtSeconds, passwordChoice, wrongSealAttempts, encryptChoice });
      dossier.recordQuestStat("sealed_letter", { forgeryCaughtSeconds, passwordChoice, wrongSealAttempts, encryptChoice });
      if (forgeryCaughtSeconds < 30 && passwordChoice === "no" && wrongSealAttempts === 0) {
        questEngine.toast("COMMENDATION — The forgery never fooled you for a moment.");
      }
      questEngine.notifyReachZone("sealed_letter_complete");
    });
  }

  // "The Treasury's Two Keys" — same "no partial resume" simplification
  // as the other full-screen minigames in this file.
  private openTreasuryOverlay() {
    this.mode = "minigame";
    openTreasuryOverlay((completed) => {
      this.mode = "closed";
      if (!completed) return;
      const { banditStopped, nightClerkStopped, dayClerkAudited, separationUsed, resetCount, brokeDefenseInDepth } = treasuryKeysState;
      logDecision("treasury_two_keys", { banditStopped, nightClerkStopped, dayClerkAudited, separationUsed, resetCount, brokeDefenseInDepth });
      dossier.recordQuestStat("treasury_two_keys", { banditStopped, nightClerkStopped, dayClerkAudited, separationUsed, resetCount, brokeDefenseInDepth });
      if (resetCount <= 1 && !brokeDefenseInDepth) {
        questEngine.toast("COMMENDATION — You built it interlocked on the first true try.");
      }
      questEngine.notifyReachZone("treasury_two_keys_complete");
    });
  }

  // "Maren's Winter Report" — same "no partial resume" simplification.
  private openMarenWinterReport() {
    this.mode = "minigame";
    openMarenWinterReportOverlay((completed) => {
      this.mode = "closed";
      if (!completed) return;
      const { chosenConfig, overStripAttempts, riskMeterPeak, resetCount } = marenWinterReportState;
      logDecision("maren_winter_report", { chosenConfig, overStripAttempts, riskMeterPeak, resetCount });
      dossier.recordQuestStat("maren_winter_report", { chosenConfig, overStripAttempts, riskMeterPeak, resetCount });
      if (overStripAttempts === 0 && resetCount <= 1) {
        questEngine.toast("COMMENDATION — The pipeline built clean on the first run.");
      }
      questEngine.notifyReachZone("maren_winter_report_complete");
    });
  }

  // "The Archivist's Desk" — same "no partial resume" simplification.
  private openArchivistsDesk() {
    this.mode = "minigame";
    openArchivistsDeskOverlay((completed) => {
      this.mode = "closed";
      if (!completed) return;
      const { perTicketVerdicts, integrityLost, safeguardChoices } = archivistsDeskState;
      logDecision("archivists_desk", { perTicketVerdicts, integrityLost, safeguardChoices });
      dossier.recordQuestStat("archivists_desk", { perTicketVerdicts, integrityLost, safeguardChoices });
      if (integrityLost === 0) {
        questEngine.toast("COMMENDATION — Every verdict true to the ledger.");
      }
      questEngine.notifyReachZone("archivists_desk_complete");
    });
  }

  // "The Blueprint of the Post Road"'s Phase 1 — the first time each of
  // the three interview NPCs actually delivers their line (not the
  // accept-offer close, see hadRealDialogue above), record its condensed
  // note to the Field Notes panel and set the flag their quest step's
  // requiresFlag waits on (see post_road_blueprint.json). Flag-gated so
  // revisiting any of the three afterward doesn't duplicate the note.
  private recordPostRoadNote(npcId: string) {
    const note = POST_ROAD_NOTES[npcId];
    const flag = `note_${npcId}`;
    if (!note || !questEngine.isActive("post_road_blueprint") || questEngine.getFlag(flag)) return;
    questEngine.setFlag(flag);
    postRoadFieldNotes.add(note);
  }
}

// Condensed DFD-shorthand notes for "The Blueprint of the Post Road"'s
// three interviews — deliberately terser than the interview dialogue
// lines themselves (see NPC_SPAWNS.village above), since these are the
// player's own field documentation, not a transcript.
const POST_ROAD_NOTES: Record<string, string> = {
  bram: "IN: villagers → drop box. PROCESS: sorting desk (address only). STORE: overnight vault. OUT: couriers.",
  post_villager: "Villagers are external — they hand off and lose sight.",
  courier: "Couriers draw from the VAULT, not the desk.",
};
