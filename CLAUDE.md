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

### Multiplayer presence — live, local-only

`server/` (Colyseus, one `SceneRoom` class partitioned by `sceneId` via
`filterBy`) and `client/src/net/NetClient.ts` are wired into the game:
[Room.ts](client/src/scenes/Room.ts) connects on every `create()` (so a
door transition's `scene.restart()` naturally disconnects the old scene
and reconnects to the new one), sends local position/facing/moving at
10Hz (only when changed, and forced to `moving: false` whenever an
overlay has movement locked), and renders remote players through
`client/src/net/remotePlayers.ts`'s `RemotePlayerController` — the same
single-Image system the local player uses (no Sprite/animation frames or
contact-shadow system exist for any character in this project), lerped
toward the network position at 12%/frame with a 150px snap for
teleports/room changes.

**Known quirk, worked around:** `colyseus.js`'s `getStateCallbacks`
(`onAdd`/`onChange`) never fires inside this Vite/browser bundle, even
though the raw schema state (`room.state.players.size`/`.forEach`)
syncs correctly — confirmed by a standalone Node script using the same
library version, where the callbacks fire fine. This is presumably the
same bug this project's earlier multiplayer attempt hit and never
diagnosed. `NetClient.pollPlayers()` works around it by diffing
`room.state.players` directly once a frame instead of relying on those
callbacks — see the file's header comment before touching this again.

**Deployment is out of scope for now** — the server only runs via local
`npm run dev` (`ws://localhost:2567`); nothing is deployed to
Render/Railway/a VPS, and there's no production `wss://` URL or CORS
setup yet. Multiplayer is explicitly garnish: connection failure is
silent (one retry after 5s, then gives up), and the game plays
identically solo with the server down. Scripted wanderers
(`WANDERER_ROUTES`) still exist as a separate, unrelated ambient-life
mechanism — currently empty (see below), not multiplayer's fallback.

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

### NPCs, the quest engine, and the Courthouse desk

The game's narrative is a covert-fiction layer: the Privacy Village
Festival is cover for a secret "Battle for AI" Summit; the player is a
Division Agent; two factions (`fundamentalist`/`apocalypse`, chosen at
CharacterCreate) color the player's name tag. XP is called "faction
points" in all UI copy. Progress is tracked via **Clearance Levels**
(C1-C7), advanced by narrative milestones rather than point thresholds
— see `questEngine.ts` below. Story content is the arrival flow
("The Welcome") followed by three two-part quests — "The Breach in the
Wall," "The Innkeeper's Shards," and "The Night the Wall Fell" (see
PLAN.md) — the earlier 5-quest "Battle for AI" content (Cover Story,
Leaked Dossier, Merchant's Oracle, Dead Drops, Whisper in the Portrait)
was deprecated and removed along with the NPCs that only existed to
serve it (Fennick, Frightened Patron, the ambient "Villager" wanderer,
`villager_a`/`villager_b`).

`client/src/npc.ts` — static NPCs (`NPC_SPAWNS`, hardcoded per room, same
pattern as `Room.ts`'s `WANDERER_ROUTES`): a "[E] Talk" proximity prompt
and a dialogue box. NPCs render as `Phaser.GameObjects.Sprite` (not
`Image`) so lore NPCs can play an idle animation via `NPCDef.idleAnim`
(Sprite is a strict superset, so NPCs with no anim — Herald — just show
static frame 0). `NPCDef.dialogue` is a `DialogueSet[]`: each set has an
optional `if: {flag, faction, questActive, questComplete}` (first match
wins, the unconditioned entry is the fallback and must be last) and
either `lines` (sequential, `{name}`-token-aware) or, on the final line,
`choices` (label/setFlag/response/optional toast/points/milestone/
clockPenalty — no nested trees, a choice always ends the interaction,
falling back to the compact dialogue box to show its response even if
the question itself was asked from the big briefing panel below).
`NPCDef.questGiver` triggers a separate Accept/Not-yet **offer** flow
instead of normal dialogue while that quest is `available`. Live NPCs:
Herald (village square, quest giver for "The Breach in the Wall," also
hosts "The Night the Wall Fell"'s fountain debrief lines), Bram
(village square, hosts "The Night the Wall Fell"'s opening step), Odile
(tavern), Quill (courthouse, hosts "The Night the Wall Fell"'s
notification-filing and record-keeping steps, plus an ambient
Academy-nod fallback), Sabine (courthouse, one ambient flavor line).
The 4 lore NPCs
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
(`toast`/`pointsChanged`/`levelUp`/`questUpdated`/`reveal`/`questCompleted`/
`clockChanged`/`clockPenalty`/`stepChoice`/`sceneBeat`) that `hud.ts` and
`Room.ts` subscribe to.

**Clearance Levels** (1-7) are `1 + however many narrative milestones
are complete`, in ANY order — `MILESTONE_IDS` (welcome/breach_m1/
breach_m2/innkeepers_shards/courthouse_trial/night_the_wall_fell) is
the fixed set; `questEngine.completeMilestone(id)` is idempotent and
recomputes Clearance from `completedMilestones.size`, so this stayed
correct when this replaced an earlier scheme where each quest hardcoded
its own absolute `clearanceOnComplete: N` target (order-dependent — a
quest completing "out of sequence" could double-count or skip levels).
`QuestDef.milestone` fires on that quest's final step; `DialogueChoice.
milestone` fires immediately when that specific choice is picked, for
mid-quest milestones (Mission 1's correct answer inside "The Breach in
the Wall" completes the `breach_m1` milestone and pays 150 points
before the quest itself is done). `courthouse_trial` has no quest wired
to it yet, so Clearance 7 isn't reachable in the current build — 6 is,
once the five live milestones are all done. `questEngine.setClearance(n)`
itself only ever raises the level (never lowers, never double-fires),
playing the fanfare + "CLEARANCE RAISED" toast + `levelUp` event exactly
once per real raise, then checks every locked quest's
`unlockAtClearance` threshold — that's what makes "The Night the Wall
Fell" available the moment Clearance hits 5 regardless of which
milestones got there, instead of being tied to one specific prior
quest's completion the way `QuestDef.unlocks` is.

Points/XP still accrue and display on the `.xp-bar` independently of
Clearance — the bar's fill is cosmetic progress toward the demo path's
total possible points (850), not a level gate.

**The Decision Clock** — "The Night the Wall Fell"'s one quest-scoped
mechanic (`questEngine.ts`'s `clockHours`/`addClockHours()`, `hud.ts`'s
top-center panel, gold under 48 / amber 48-71 / red at 72+). Every step
carries a fixed `QuestStep.clockCost` applied on advance regardless of
which choice resolved it; a wrong choice ALSO adds
`DialogueChoice.clockPenalty` (hours only, no fail state — the quest
always completes, but `QuestDef.clockDebrief` picks a different Herald
line, and withholds the bonus toast, if the total lands at 72+).
`QuestStep.choice` is a standalone decision point for a `reach_zone`
step with no hosting NPC (the fountain-crier beat) — `checkStep()` emits
`stepChoice` and waits (`awaitingChoice`) instead of advancing directly;
`hud.ts`'s `showStepChoice()` renders it and calls
`questEngine.resolveStepChoice()` on pick, which applies the penalty,
the step's base cost, and emits `reveal`/`toast`/`sceneBeat` from
whichever option was chosen.

`Room.ts` calls `notifyReachZone()` from `update()` for every room-JSON
`zones` entry the player is standing in (purely proximity-based, no
`[E]` prompt, same as door transitions) and pulses a glow on whichever
zone is the active quest's current objective. `npc.ts` calls
`notifyTalkTo()` when a dialogue interaction closes.

`client/src/hud.ts` (`HUDController`) — the first real use of the
`.xp-bar`/quest-tracker `.panel`/`.toast` components from the earlier
design-system pass. Instantiated by `UIOverlay.ts`, not `Room.ts` — this
matters because `UIOverlay` is `scene.launch()`'d once from
`CharacterCreate` and never `scene.restart()`'d on room transitions
(unlike `Room.ts`, torn down and rebuilt every door), making it the only
scene that persists the way a HUD needs to. `Q` toggles the tracker; the
level badge reads "C1" through "C7".

`client/src/quest.ts` — the Courthouse desk. Used to run the "Personal
Data Classification Lab" in-world (a drag-and-drop GDPR trial that paid
400 points and granted Clearance 5 — see git history on this file); that
content moved to the Academy's "Personal Data or Not?" card drill (see
below), and the desk is now a pure signpost: an `[E]`-triggered flavor
line pointing the player to the Academy, no quest state, no points.
Both NPC dialogue and this signpost pause player movement and door
checks while open (`Room.ts`'s `uiOpen` check) — if you add a third
interactive system, route it through the same pattern rather than
inventing a new one.

### The Academy (learning hub overlay)

A full-screen DOM overlay layered over the village — the structured
"classroom" half of the experience, as opposed to the Village's
narrative/gameplay half. Opens via the HUD's `.btn--ghost` button
(top-left) or the Village Square door hotspot (no hotkey — `A` collides
with WASD movement); ESC or "RETURN TO VILLAGE" closes it. `client/src/academy.ts`
is a framework-free `Phaser.Events.EventEmitter` singleton (same pattern
as `questEngine.ts`) holding 3 tracks and their modules, each loaded
from `client/public/data/academy/*.json` via `Preload.ts`. `client/src/academyOverlay.ts`
is the Scene-bound DOM UI (constructed once from `UIOverlay.ts`,
alongside `HUDController`) — a view-switch state machine (hub → module
list → lesson/card-drill → quiz) rendering `.panel`/`.briefing`/
`.quest-card`/`.badge-popup` design-system components.

Two module content types (`AcademyModule` is a `type`-discriminated
union; a JSON file with no `type` field is a lesson module by default):
`lesson` (heading/paragraph/callout/evidence-image blocks, then a
3-question mastery quiz — wrong picks shake/explain/retry, right picks
flash gold/explain/advance) and `card_drill` (one card at a time,
binary PERSONAL DATA / NOT PERSONAL DATA choice; wrong answers re-queue
to the end of the deck rather than retrying immediately, so the deck
only completes once every card has been answered correctly once — no
score is ever shown, just progress dots).

A module's `fieldWork?: {questId, room, label}` is optional — most
modules are theory-only (no linked in-game activity, module list shows
just a THEORY pip) and complete via `academy.markTheoryDone()` alone.
Where a real quest exists (Threat Modeling Fundamentals ↔ "The Breach in
the Wall"), the module list also shows a FIELD WORK pip that closes the
overlay and routes the player to `fieldWork.room`, syncing `fieldDone`
from `questEngine.isComplete(questId)` both live (on `questCompleted`)
and retroactively (every time the Academy opens, in case the quest
finished first). A module completes — badge-popup modal, +100 points,
its track's credential bar animates, a toast — the first time both
`theoryDone` and `fieldDone` are true, guarded against double-firing.

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
