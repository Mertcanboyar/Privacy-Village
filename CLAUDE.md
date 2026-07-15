# Privacy Village — CLAUDE.md

Demo build for a professor-facing walkthrough. Full context, timeline, and
the 5-minute script live in [PLAN.md](PLAN.md) — read that first for what
this project is and why. This file is about how the client is built.

## Architecture (current — painted scenes, not tilemaps)

The village is **not** a scrolling Tiled tilemap. It's a set of fixed,
screen-sized "rooms," each a hand-painted background/foreground pair:

- **3 rooms:** Village, Tavern, Courthouse.
- Each room = `background PNG` + `foreground occlusion PNG` + a `room JSON`
  (walkable polygon, door hotspots, light positions, NPC spawns).
- **Render order:** background → NPCs/players (Y-sorted) → foreground PNG.
  The foreground PNG is what lets players walk "behind" objects painted
  into the scene (e.g. behind a pillar or counter).
- **Camera is fixed per room.** Rooms are screen-sized. No scrolling, no
  camera-follow, no world bounds larger than the viewport.
- **Fake depth:** player/NPC sprite scale interpolates 1.0 → 0.75 based on
  Y position within the room, to sell depth in Courthouse/Village without
  real perspective.
- **No Tiled.** Nothing in this project reads `.tmj`/`.tsx` files anymore.

### Asset/file convention

```
assets/rooms/village_bg.png
assets/rooms/village_fg.png
assets/rooms/village.json
assets/rooms/tavern_bg.png
assets/rooms/tavern_fg.png
assets/rooms/tavern.json
assets/rooms/courthouse_bg.png
assets/rooms/courthouse_fg.png
assets/rooms/courthouse.json
```

Room JSON shape (per room): walkable polygon (for movement clamping),
door hotspots (rect or polygon + target room), light positions (for any
ambient glow/flicker effects), NPC spawn points (position + facing).

### Multiplayer presence — not wired in

`server/` (Colyseus room) and `client/src/net/colyseus.ts` exist and are
individually functional (verified with a standalone Node test client:
joining, leaving, and sending position updates all work correctly), but
**nothing in the game currently connects to them.** Live multiplayer
presence was cut per PLAN.md's Day 8-9 fallback: the browser's first
Colyseus connection each page load never receives other players into its
local state (extensively debugged, root cause not found). [Room.ts](client/src/scenes/Room.ts)
uses scripted wanderers (`WANDERER_ROUTES`) instead — see PLAN.md Day 13.
If you revisit real multiplayer, start by trying to reproduce the bug
outside Vite/Phaser (a plain bundled web page) to isolate whether it's
environment-specific.

### Player identity (Title / CharacterCreate)

`client/src/scenes/Title.ts` and `client/src/scenes/CharacterCreate.ts`
run before `Room` (see PLAN.md Phase 2, Days 1 and 3) — a drifting
village-art backdrop (`client/src/scenes/drift.ts`, shared by both) with
a DOM title/"Enter" button, then an avatar-picker + name-entry DOM form,
then a Recruiter faction-choice beat (same scene, swaps its DOM content
rather than adding a new Scene). `client/src/session.ts`
(`{name, avatarId, faction}`, a plain module singleton, `setSession()`
merges rather than replaces) is the source of truth for player identity
— `Room.ts` reads `getAvatarOption()`/`getSession()`/`getFactionColor()`
to pick the spawned sprite/scale and the player's faction-colored
floating name tag; it no longer hardcodes "the player is the wizard" or
a fixed name-tag color. The 5 avatar options (Wizard, Knight, Paladin,
Archer, Viking) are static painted/cutout sprites reused as placeholders
(no animated variants exist yet). `client/src/audio.ts::playSound`/`playBlip` are no-op hooks
wired at every interaction point across this flow and the quest engine
below, ready for real SFX once sourced.

### NPCs, the quest engine, and the Courthouse Trial

The game's narrative is a covert-fiction layer: the Privacy Village
Festival is cover for a secret "Battle for AI" Summit; the player is a
Division Agent; two factions (`fundamentalist`/`apocalypse`, chosen at
CharacterCreate) color the player's name tag. XP is called "faction
points" in all UI copy. Progress is tracked via **Clearance Levels**
(C1-C5), advanced by narrative milestones rather than point thresholds
— see `questEngine.ts` below. Story content is the arrival flow
("The Welcome") followed by a single two-part quest, "The Breach in the
Wall" (see PLAN.md) — the earlier 5-quest "Battle for AI" content
(Cover Story, Leaked Dossier, Merchant's Oracle, Dead Drops, Whisper in
the Portrait) was deprecated and removed along with the NPCs that only
existed to serve it (Fennick, Frightened Patron, the ambient "Villager"
wanderer, `villager_a`/`villager_b`).

`client/src/npc.ts` — static NPCs (`NPC_SPAWNS`, hardcoded per room, same
pattern as `Room.ts`'s `WANDERER_ROUTES`): a "[E] Talk" proximity prompt
and a dialogue box. NPCs render as `Phaser.GameObjects.Sprite` (not
`Image`) so lore NPCs can play an idle animation via `NPCDef.idleAnim`
(Sprite is a strict superset, so NPCs with no anim — Herald — just show
static frame 0). `NPCDef.dialogue` is a `DialogueSet[]`: each set has an
optional `if: {flag, faction, questActive, questComplete}` (first match
wins, the unconditioned entry is the fallback and must be last) and
either `lines` (sequential, `{name}`-token-aware) or, on the final line,
`choices` (label/setFlag/response/optional toast/points/clearance — no
nested trees, a choice always ends the interaction, falling back to the
compact dialogue box to show its response even if the question itself
was asked from the big briefing panel below). `NPCDef.questGiver`
triggers a separate Accept/Not-yet **offer** flow instead of normal
dialogue while that quest is `available`. Live NPCs: Herald (village
square, quest giver for "The Breach in the Wall"), Bram (village
square), Odile (tavern), Quill + Sabine (courthouse, one ambient flavor
line each, referencing the Courthouse Trial below). The 4 lore NPCs
(`LORE_NPC_IDS`: bram/odile/quill/sabine) each get a 4-frame idle-only
sprite sheet built from a different CraftPix character pack (see
CREDITS.md) — frame size varies per character (`LORE_NPC_FRAME_SIZE` in
`npc.ts`, consumed by `Preload.ts`'s `this.load.spritesheet()` loop), so
`baseScale` is computed per NPC via `loreNpcBaseScale()` rather than one
shared constant.

A `DialogueSet` can also carry `briefing: {caseLabel, title}` +
optional `evidence: {images, caption, buttonLabel}` + `ghostChoices`,
rendering in the big `.panel.panel--glow`/`.briefing` component instead
of the compact bottom `.dialogue` bar — this is how Herald's two
multi-paragraph mission texts (with a "VIEW THE BLUEPRINT"/"VIEW THE
DOSSIER" button) display. That evidence button opens
`client/src/ui/imageOverlay.ts`'s full-screen viewer (scroll/pinch zoom,
drag pan, missing-file placeholder card) — the same evidence descriptor
shape also appears on `QuestStep.evidence` so `hud.ts`'s tracker can
show a "reopen the blueprint" button independent of the NPC dialogue
that first showed it.

`client/src/questEngine.ts` — the JSON-driven quest engine (defs in
`client/public/data/quests/*.json`, loaded via `Preload.ts`'s
`this.load.json()`, same pattern as room data). Deliberately a separate
module from `quest.ts` (below) — different concern, different file.
States are `locked|available|active|complete`, one quest active at a
time, `talk_to`/`reach_zone` step triggers, flags, and points — exposed
via a `Phaser.Events.EventEmitter`
(`toast`/`pointsChanged`/`levelUp`/`questUpdated`/`reveal`/`questCompleted`)
that both `hud.ts` and `Room.ts` subscribe to. **Clearance Levels**
(1-5) are milestone-based, not point-threshold-based:
`questEngine.setClearance(n)` only ever raises the level (never lowers,
never double-fires), playing the fanfare + "CLEARANCE RAISED" toast +
`levelUp` event exactly once per real raise. `QuestDef.clearanceOnComplete`
fires automatically when that quest's final step completes;
`DialogueChoice.clearance`/`.points` fire immediately when that specific
choice is picked, for mid-quest milestones (Mission 1's correct answer
inside "The Breach in the Wall" raises Clearance 3 and pays 150 points
before the quest itself is done — Mission 2's completes the quest,
whose own `xp`/`clearanceOnComplete` cover Clearance 4). Points/XP still
accrue and display on the `.xp-bar` independently of Clearance — the
bar's fill is cosmetic progress toward the demo path's total possible
points (750), not a level gate. `Room.ts` calls `notifyReachZone()` from
`update()` for every room-JSON `zones` entry the player is standing in
(purely proximity-based, no `[E]` prompt, same as door transitions) and
pulses a glow on whichever zone is the active quest's current objective.
`npc.ts` calls `notifyTalkTo()` when a dialogue interaction closes.

`client/src/hud.ts` (`HUDController`) — the first real use of the
`.xp-bar`/quest-tracker `.panel`/`.toast` components from the earlier
design-system pass. Instantiated by `UIOverlay.ts`, not `Room.ts` — this
matters because `UIOverlay` is `scene.launch()`'d once from
`CharacterCreate` and never `scene.restart()`'d on room transitions
(unlike `Room.ts`, torn down and rebuilt every door), making it the only
scene that persists the way a HUD needs to. `Q` toggles the tracker; the
level badge reads "C1" through "C5".

`client/src/quest.ts` — the Courthouse case-file quest (the "Trial").
Not an iframe (the original plan): a native DOM panel
(`client/public/ui/design-system.css`'s `.panel`/`.briefing` components)
appended to `#ui-root`, floating over the Phaser canvas — same
DOM-over-Phaser split used everywhere in this game (`npc.ts`'s dialogue,
`hud.ts`). Interacting with the desk in the Courthouse room opens it.
Content is the "Personal Data Classification Lab," ported verbatim from
`~/Desktop/Cursor/DPIA Protocol/src/modules/personal-data-lab` — 3 GDPR
scenarios, 18 data-field items, each classified via drag-and-drop with
immediate feedback. Every choice is appended to an in-memory decision
log and the final result is written to
`localStorage['pv:badge:personal-data-lab']` — its completion pays a
flat 400 points into `questEngine` and grants **Clearance 5**, the
reserved top level. Both NPC dialogue and the quest panel pause player
movement and door checks while open (`Room.ts`'s `uiOpen` check) — if
you add a third interactive system, route it through the same pattern
rather than inventing a new one.

## Demo rule (read before adding anything)

Only the scripted 5-minute demo path (PLAN.md section 4) has to work.
Do not add features that aren't in PLAN.md. When two implementations are
possible, pick the simpler one. This is a 30-day solo build for one
scripted walkthrough, not a general-purpose engine — resist building for
hypothetical future rooms, quests, or generality beyond the 3 rooms above.

See PLAN.md's anti-goals list for what's explicitly out of scope
(accounts, factions, mobile, LMS integration, etc.) — note that "no
menus" and "multiple quests" were explicitly reversed for Phase 2 (see
PLAN.md section 7); the rule below still applies to everything else.
