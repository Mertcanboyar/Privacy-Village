# Privacy Village — 30-Day Demo Build Plan

Goal: A 5-minute, professor-facing demo proving three things:

1. The village feels alive (avatar, map, NPCs, ambient life)
2. The learning loop works (NPC quest → in-village case-file scenario → consequences → badge)
3. Assessment is real (decision log → professor dashboard mock)

**Anti-goals (do NOT build):** accounts/auth, credentials system, factions, multiple quests, second map region, mobile support, LMS integration, payment, the 3D AI Safety Lab. Anything not needed for the 5-minute script is a slide, not software.

**Superseded by Phase 2 (see section 7):** the user explicitly reversed "no menus" and "multiple quests" for Phase 2 — a title screen, avatar/name entry, and a 5-quest content sprint are now in scope. The rest of this anti-goals list still holds.

**Definition of done (Day 30):** You can run the scripted walkthrough end-to-end on a video call with zero crashes, and a backup video recording exists.

---

## 1. Architecture

```
┌─────────────────────────────────────────────┐
│  Browser (client)                           │
│  Phaser 3 game                              │
│  (painted rooms: Village/Tavern/Courthouse, │
│   NPCs, in-world quest panel UI)            │
└──────────┬──────────────────────────────────┘
           │ WebSocket (built, not currently wired — see below)
┌──────────▼──────────┐
│  Colyseus server    │
│  (Node) — presence, │
│  positions          │
└─────────────────────┘
```

**Key decisions (locked — do not relitigate mid-build):**

- **Client:** Phaser 3 + TypeScript + Vite. Web-native, huge ecosystem, fastest path for 2D.
- **Multiplayer:** Colyseus (Node) built and functionally correct (verified with a standalone test client), but **not wired into the game** — the browser's first connection each page load never receives other players' state (root cause not found; see CLAUDE.md). Village room uses 2 scripted wanderers instead. Revisit later if there's time.
- **World: painted scenes, not a tilemap.** 3 fixed, screen-sized rooms — Village, Tavern, Courthouse. Each room is a hand-painted `background PNG` + `foreground occlusion PNG` + a room JSON (walkable polygon, door hotspots, light positions, NPC spawns). Render order: background → NPCs/players (Y-sorted) → foreground PNG. Camera is fixed per room — no scrolling, no camera-follow, no Tiled. Player/NPC sprites scale 1.0→0.75 by Y position for fake depth. Full detail in [CLAUDE.md](CLAUDE.md). (This replaces the Tiled/tilemap approach the Week 1 prototype was built on — see CLAUDE.md for what's superseded.)
- **Scenario integration — native, not an iframe.** Originally planned as an iframe embed of the external ComplianceSim app with a `postMessage` completion handshake. Changed: the Courthouse desk now opens an **in-village quest panel** (`client/src/quest.ts`) built in the same painted/parchment visual language as the rest of the game, no iframe. Content is the "Personal Data Classification Lab" ported from the DPIA Protocol project (`~/Desktop/Cursor/DPIA Protocol/src/modules/personal-data-lab`) — 3 real-world GDPR scenarios (HR onboarding, hospital portal, e-commerce analytics), 18 data-field items total, each classified as Not Personal / Personal / Special Category data with immediate right/wrong feedback and a full decision log. Ends in a "badge earned" screen.
- **Dashboard:** Static mock. One beautifully designed page (Figma or plain HTML/Tailwind), not wired to anything. Class roster, completion %, per-student decision quality, "Export grades (CSV)" button.
- **Hosting:** Client on Vercel/Netlify; Colyseus on a single small VPS or Render instance. No scaling work.

**Repo layout:**

```
privacy-village-demo/
├── client/          # Phaser 3 + Vite + TS
│   ├── src/scenes/  # Boot, Preload, Room, UIOverlay
│   ├── src/net/     # Colyseus client wrapper
│   └── public/assets/
│       ├── rooms/   # {village,tavern,courthouse}_{bg,fg}.png + {room}.json
│       ├── sprites/
│       └── audio/
├── server/          # Colyseus room
├── dashboard/       # static professor dashboard mock
│   ├── index.html + dashboard.js
│   └── ui/design-system.css  # copy of client's — no build step here
├── CLAUDE.md         # architecture reference for future sessions
└── PLAN.md          # this file
```

---

## 2. Asset shopping list (Day 1 — buy, don't make)

- Painted background + foreground occlusion art for 3 rooms (Village, Tavern, Courthouse) — one consistent art style/palette, decided Day 1 and never mixed. Sources: itch.io painted-background packs, commissioned pieces, or AI-generated concept art cleaned up for occlusion layers.
- Character sprite pack with 4-direction walk cycles, several palette variants (this IS your avatar customization — sprite picker, no editor). Pick one sprite pixel scale and keep it consistent across rooms since there's no tile grid to anchor it.
- NPC sprites: 4–5 distinct characters (guard, scholar, detective, barkeep, herald).
- UI pack: dialogue box, buttons, badge/medal icons.
- Audio: one ambient village loop, footsteps, quest-accept chime, badge fanfare (freesound.org / itch.io audio packs).
- Ambient animation sprites: fountain, torch flicker, birds, smoke from chimney. These buy disproportionate "magic" — do not skip.

**Budget:** ~$50–150 total. Keep licenses in a `CREDITS.md`.

---

## 3. Week-by-week plan

### Week 1 (Days 1–7): World & movement

- **D1:** Repo scaffold (Vite + Phaser + TS), buy assets, pick art style.
- **D2–4:** Paint/assemble the 3 rooms (Village, Tavern, Courthouse): background + foreground occlusion PNGs, room JSON (walkable polygon, door hotspots, light positions, NPC spawns).
- **D5–6:** Player avatar: 4-direction movement clamped to the walkable polygon, Y-sort against NPCs, Y-based scale (1.0→0.75) for fake depth, walk animation. No camera follow — rooms are fixed and screen-sized.
- **D7:** Room polish pass + deploy client to Vercel. **Milestone:** walkable village room in a browser URL.

### Week 2 (Days 8–14): Presence & NPCs

- **D8–9:** Colyseus server built (village room, join/leave, position sync). **Fallback trigger hit early:** the browser's first connection each page load never receives other players' state (root cause not found after extensive debugging — sending works, receiving doesn't, confirmed with a standalone test client). Per the fallback below, live multiplayer presence is cut from the village room; server/client code is left in place for a future revisit but isn't wired into the game.
- **D10:** **Skipped.** Multiplayer (the reason for name entry) is cut, there's only 1 player sprite now (not 6), and the script requires opening directly in-world with "never a menu" — a spawn screen would contradict that. Decided with the user rather than building something that no longer fits.
- **D11–12:** NPC system built: static NPCs with a "[E] Talk" proximity prompt and a sequential dialogue box (name + body text + Continue/Close hint), player movement and door checks pause while a dialogue is open. One example NPC live: "Herald" outside the Courthouse door in the village room, JSON-array dialogue lines (`client/src/npc.ts`), not yet wired to the actual quest state (that's Week 3, D15).
- **D13:** Ambient life — **done early as the D8-9 fallback:** 1 scripted wanderer, "Villager" (knight sprite), on a waypoint loop in the village room. The Freya pixel-art sprite originally used for a second wanderer ("Traveler") was reassigned to the Herald NPC instead; the wanderer was removed rather than duplicating the sprite. Fountain/torch animations and ambient audio still pending.
- **D14:** Buffer.

**Fallback trigger (hit on D8-9, see above):** if multiplayer sync is still broken, cut it — replace with 2 scripted "player-looking" wanderers and move on. Professors won't check.

### Week 3 (Days 15–21): The learning loop

- **D15:** Quest flow built: Herald NPC (village, outside the Courthouse door) gives narrative setup via dialogue. Walking into the Courthouse and approaching the desk shows a "[E] Examine the case file" prompt.
- **D16–18:** Done together, ahead of schedule, once the plan changed from an iframe to a native quest panel (see Architecture): `client/src/quest.ts` — intro screen (scenario context/background) → per-item classification → immediate ✅/❌ feedback with the GDPR explanation → scenario-complete tally → next scenario, looping through all 3 scenarios → final badge screen. Every choice is pushed to a decision log (`{scenarioId, itemId, chosen, correct}`), stored in `localStorage` under `pv:badge:personal-data-lab`. Verified end-to-end in-browser, including replaying the quest from scratch. **Later revised** (post-D19, see below) to a drag-and-drop classification mechanic and a "boot.dev-inspired" dark UI design system.
- **D19:** Badge system — done as part of the quest-complete screen above. **Later revised:** the whole UI layer (dialogue, quest panel, badge) was rebuilt as real DOM/CSS (`client/public/ui/design-system.css`, a documented 10-component catalog reviewable at `/ui-kit.html`) floating over the Phaser canvas, since Phaser Graphics/Text can't take CSS classes. The item-classification mechanic became drag-a-card-into-a-zone (native DOM pointer events, replacing the original 3-button/keyboard-only version), and quest completion now shows a proper `.badge-popup` modal (icon, badge name, animated XP count-up) instead of inline panel text. Still no visual badge icon above the avatar in-world, no dashboard wiring.
- **D20–21:** Done. **Milestone hit:** spawn → herald → Courthouse → case file → decisions → badge verified end-to-end using real simulated input (continuous arrow-key movement, walking through both door hotspots, real `[E]` keypresses for dialogue/quest advancement, and genuine `pointerdown`/`pointermove`/`pointerup` sequences for the drag-and-drop classification), not just direct method calls. No bugs found in the connecting logic (proximity prompts, door transitions, `uiOpen` movement gating, decision log persistence).

**Content-length flag for D27 rehearsal:** the full quest is 3 scenarios / 18 items — too long for the script's 1:00–3:00 budget. Rehearsal will need to decide whether the demo shows only Scenario 1 (4 items, ~30–45s) or a couple of items from each scenario; the code doesn't currently have a "skip scenario" shortcut for presenting.

### Week 4 (Days 22–30): Demo theater

- **D22–23:** Done. Professor dashboard mock (static): `dashboard/index.html` — reuses the same design system as the game (`dashboard/ui/design-system.css`, a copy of `client/public/ui/design-system.css`, since the dashboard has no build step and isn't part of the Vite project) for a consistent "gradebook" feel. Header + 4 summary stat cards (students, avg completion, avg decision quality, capstone-ready count), a 25-student roster table (avatar initials, module-completion bar, decision-quality chip color-coded by threshold, capstone-status chip, last-active), and a genuinely functional client-side "Export grades (CSV)" button (downloads the mock roster — no backend, just a Blob). Data is hardcoded/deterministic, not randomized, so it looks identical across reloads and rehearsal recordings.
- **D24:** Tried a lightweight Phaser-rendered signpost + bunting ("DPD '27") in the village plaza as a stand-in for a full painted festival-stage set piece (no free ground space in the painted background, no art pipeline to repaint it). Rejected on sight — pulled back out. The closing script line will need to land without a dedicated visual, or wait for real festival-stage art to be sourced later; no code-level open item here for now.
- **D25–26:** Polish: lighting/tint pass, audio mix, spawn positioning so first frame is gorgeous, kill every visible bug in the scripted path (only the scripted path matters).
- **D27:** Write and rehearse the 5-minute script (below). Time it.
- **D28:** Record the backup video. Full walkthrough, voiceover optional.
- **D29:** Dry-run demo on a real video call with a friendly viewer; fix what confused them.
- **D30:** Freeze. No new features. Book professor calls for Days 31–35.

---

## 4. The 5-minute professor script (build toward this)

- **0:00–1:00** Open in-world at the square (never a menu). Ambient life visible. Line: *"Your students read the GDPR as a PDF and forget it by Friday. Here, they live inside it."*
- **1:00–3:00** Courthouse herald → Personal Data Classification case file → a handful of real-world data-field decisions with immediate right/wrong feedback. Line: *"Every decision is logged — you see how they reasoned about personal vs. sensitive data, not whether they showed up."*
- **3:00–4:00** Badge granted → cut to dashboard mock. Line: *"This is your gradebook."*
- **4:00–5:00** Back to village, pan past Academy to festival stage. Line: *"One case of forty-six. Your syllabus maps onto this village — and every January, your students attend the Disneyland of Privacy alongside the industry."*

---

## 5. Risk register

| Risk | Mitigation |
|---|---|
| Multiplayer netcode eats the schedule | Hit on D8-9: cut to scripted wanderers, as planned |
| Quest content too long for the 5-minute script | Flagged at D18: 3 scenarios/18 items vs. a ~2 min budget — needs a rehearsal decision at D27, no code-level fix yet |
| Art style inconsistency | One art style/palette for all room backgrounds, decided D1 |
| Scope creep (2nd quest, 2nd region, avatars editor) | Anti-goals list above; re-read weekly |
| Live demo failure | D28 backup video; only ever demo the scripted path |
| Solo-dev burnout week 3 | D14 and D21 are buffer-inclusive; cut ambient polish before cutting the loop |

---

## 6. Parallel non-code artifacts (do in evenings, ~4 hrs total)

- One-page syllabus map: Track B (AI Governance, 10 modules) → 12-week seminar, capstone = final exam.
- Objection answers: rigor (decision-log assessment + Creative Privacy Framework / Bilgi pedigree), cheating (branching scenarios + logged reasoning), workload ("the platform grades, you discuss").
- Professor call invites sent by Day 20 for Days 31–35.

---

## 7. Phase 2 — Content Sprint → Multiplayer → Demo theater

Handed over as a new plan once the original 30-day build (sections 1-6)
was substantially done. Order: **Content Sprint (Days 1-3)** → **Multiplayer
window (Days 4-6)** → **Demo theater (final 2 days)**. The demo rule still
applies — only the scripted path has to work, simplest implementation wins.

**Asset reality check (Day 1):** the full Phase 2 doc assumes 4-6 animated
avatar variants, 6 new NPC sprites (including "a Cat" with no analogous
asset), and ~6 sound effects. None of that exists — the project has
exactly 3 static painted sprites (wizard/knight/freya, no animation
frames) and zero audio files. Asked the user; decided to build the real
systems now against the 3 existing sprites as placeholders and build
audio-trigger hook points with no actual sound, so real assets slot in
later without touching logic. Days 2-3 hit this same wall harder (6
brand-new characters) and will need the same call made again per-NPC.

- **Day 1 — Done.** Title screen (`client/src/scenes/Title.ts`): drifting
  `room-bg-village` backdrop (shared with CharacterCreate via
  `client/src/scenes/drift.ts`, a Phaser tween, no new art) + DOM
  "Enter the Village" button. Character screen
  (`client/src/scenes/CharacterCreate.ts`): avatar picker (3 placeholder
  `.avatar-option` cards — the existing wizard/knight/freya sprites,
  rendered as plain `<img>`s, not synced Phaser overlays), name input
  (max 16 chars), 🎲 Randomize (random avatar + name from a short
  fantasy-lawyer list), Confirm (disabled until named). Session state
  (`client/src/session.ts`, a plain module singleton — `{name,
  avatarId}`) flows into `Room.ts`, which now spawns the chosen sprite
  at the chosen scale instead of hardcoding the wizard, with a floating
  name tag above the player matching the existing NPC/wanderer tag
  style. Confirm fades to black and launches `Room`+`UIOverlay`, same as
  the old direct-boot flow did. Sound hooks
  (`client/src/audio.ts::playSound`) are wired at every interaction
  point but no-op — no audio assets yet. New `.avatar-option` /
  `.avatar-option--selected` classes added to `design-system.css` (and
  synced to `dashboard/ui/design-system.css`) as supporting infra, same
  tier as `.drag-card`/`.drop-zone`.
- **Day 2 — Done, minus the Cat.** The sprite gap resolved: the user
  supplied "Village NPC Vol.1" (6 characters, 96×96, 8-direction
  idle+walk sheets — see CREDITS.md). 5 of 6 characters used as Bram,
  Odile, Quill, Sabine, Fennick (`NPC_06` spare, unused); no cat-shaped
  asset in the pack, so **the Cat NPC is still deferred**. `npc.ts`'s
  `NPCView` switched from `Phaser.GameObjects.Image` to `.Sprite` so
  these NPCs can play a real idle animation (row 0, 4 frames, 6fps) —
  `Preload.ts` loads each as a spritesheet and defines the
  `npc-{id}-idle` anim; Herald/Villager/Traveler keep working unchanged
  since Sprite is a superset of Image (no anim call = static frame 0).
  `NPC_SPAWNS` extended from village-only to all 3 rooms: Bram + Fennick
  in the village square, Odile behind the tavern bar, Quill by the
  courthouse evidence desk, Sabine by the courthouse bench. Dialogue
  written per the plan doc's "key beats" for each (Bram's line uses a
  `{name}` token replaced with `getSession().name` at dialogue-open time
  — the first NPC to actually reference the player's chosen name).
  Fennick's dialogue is flavor-only for now (introduces his "loyalty
  parchment" personality) since the Day 3 quest-branching logic isn't
  built yet. Verified in-browser: correct sprite/scale/animation per
  NPC, correct room placement, dialogue + name interpolation all work.
- **Day 3 — Done.** The whole game got a narrative reskin: "Privacy
  Village Festival" is now cover story for a secret AI Summit, the
  player is a Division Agent, XP is "faction points" in all UI copy. A
  Recruiter beat was added to the end of `CharacterCreate.ts` (a
  `.dialogue`-styled panel over `.ui-backdrop`, two faction choice
  buttons) — `session.ts` gained `faction: "fundamentalist" |
  "apocalypse" | null` and `getFactionColor()`, which the player's name
  tag in `Room.ts` now uses instead of a fixed color.

  New `client/src/questEngine.ts` (deliberately separate from
  `quest.ts`, which stays specifically the Courthouse Trial) is a
  JSON-driven, flag-based engine: quest defs load from
  `client/public/data/quests/*.json`, states are `locked|available|
  active|complete`, one quest active at a time, `talk_to`/`reach_zone`
  triggers, points/levels (L1-L5 at 0/200/500/900/1400), and a
  `Phaser.Events.EventEmitter` for toasts/points/level-up/reveal that
  `hud.ts` and `Room.ts` subscribe to. Two schema fields beyond the
  spec's literal example: `offer` (a quest's NPC-offer prose) and
  `reveal`/`reveal.textByFaction` (the `.briefing`-styled popup a
  `reach_zone` step can show, e.g. Q4's intel fragments and Q5's
  faction-conditional HQ note).

  `npc.ts`'s dialogue model became conditional: `NPCDef.dialogue` is now
  a `DialogueSet[]` (each with an optional `if: {flag, faction,
  questActive, questComplete}`, first match wins, last/unconditioned
  entry is the fallback) instead of a flat `lines: string[]`, plus an
  optional `choices` on the last line of a set (Q3's Fennick branch, Q5's
  Sabine prompt) and a separate quest-giver **offer** flow
  (`NPCDef.questGiver`) that shows Accept/Not-yet buttons instead of
  normal dialogue while that quest is `available`. New NPCs: Frightened
  Patron (tavern, gets the pack's 6th/previously-spare sprite),
  `villager_a`/`villager_b` (village, reuse the wanderer's `npc-knight`
  texture — one-line Q3 witnesses, not worth fresh art), and a small
  Graphics-only "oracle" prop (brass box + glowing blue lens) beside
  Fennick's stall. **The Cat NPC is still deferred** — no cat-shaped
  sprite exists in the pack — so Q1 (Cover Story) is 4 steps
  (bram/odile/quill/sabine), not 5; Cat's spec lines are kept in a
  comment for whenever art shows up.

  `hud.ts` (new) is the first real use of the `.xp-bar`/quest-tracker
  `.panel`/`.toast` components from the earlier design-system pass —
  it lives in `UIOverlay.ts` specifically because that scene persists
  across room transitions (`scene.launch()`'d once, never
  `scene.restart()`'d) unlike `Room.ts`. `Q` toggles the tracker.

  Courthouse Trial payout changed from a `totalCorrect*45` flavor number
  to a flat **400** points into `questEngine` (the spec's own tuning
  note, revised down from 500 so the demo path — Q1 50 + Q2 150 + Trial
  400 = 600 — lands the level-up moment during the Trial debrief, on
  camera); the `localStorage` decision-log write is unchanged. All SFX
  cues (quill-scratch, chime, fanfare, per-NPC dialogue blips) route
  through `audio.ts`'s existing no-op stub pattern — still no audio
  assets in this project.
- **Days 4-6 (multiplayer) / final 2 days (demo theater) — Not started.**
  Revisits the Colyseus sync bug cut back in Week 2; hard fallback is
  more scripted wanderers if it's still not stable by end of Day 5.

## 8. "The Breach in the Wall" — simplified quest rework (replaces Phase 2's 5-quest content)

The 5-quest "Battle for AI" content above (Cover Story, Leaked Dossier,
Merchant's Oracle, Dead Drops, Whisper in the Portrait) was deprecated
and removed — kept only the quest **engine** (triggers, flags, tracker,
toasts, dialogue choices), reused for a much shorter story: a two-beat
arrival flow followed by one two-mission quest, "The Breach in the
Wall." Fennick, the Frightened Patron, and the ambient "Villager"
wanderer/`villager_a`/`villager_b` (which only existed to serve the old
quests) were removed rather than kept as flavor-only NPCs — simplest
option, per the task spec's own framing.

**Clearance Levels replace XP-threshold levels entirely.** C1 on
arrival, C2 after both greeters, C3 after Mission 1, C4 after Mission 2
(quest complete, which also unlocks "The Innkeeper's Shards"), C5 after
Innkeeper's Shards' own two missions (see section 9 below). C6 is
currently unclaimed — reserved for future story content; the
Courthouse Trial mechanic this level was once earmarked for was
removed (see `quest.ts` note above) before it ever granted a level.
`questEngine.ts`'s
`setClearance(n)` is milestone-driven (only ever raises, never
derives from points) — see CLAUDE.md for the mechanism. Points/XP still
accrue and show on the `.xp-bar` independently, just no longer gate the
level.

**Arrival ("The Welcome")** — `arrival.json`, `giver: "hq"`,
auto-bootstrapped the same way `cover_story` used to be. Two sequential
`talk_to` steps (Bram, then Odile), +50 pts and Clearance 2 on
completion, `unlocks: ["breach_in_the_wall"]`.

**The Herald** (new NPC, Village Square by the fountain) is the sole
quest giver for both missions of "The Breach in the Wall"
(`breach_in_the_wall.json`) — a grizzled ex-scout, contemptuous of the
Council. A soft gold pulse (Graphics circle, same pulse technique as
the earlier oracle-lens prop) highlights him once Clearance 2 is
reached; before that he has nothing to offer.

Both missions reuse `npc.ts`'s existing choice/flag mechanism exactly
like the old Fennick oracle branch did — the only new pieces are: (1) a
`briefing`-mode `DialogueSet` that renders in the big `.panel.panel--glow`/
`.briefing` component instead of the compact bottom bar, for the long
mission text; (2) an `evidence` descriptor (images/caption/button label)
on both the `DialogueSet` and `QuestStep`, opening
`client/src/ui/imageOverlay.ts`'s full-screen scroll/pinch-zoomable
viewer — reopenable from the HUD tracker while a mission step is active;
(3) `DialogueChoice.points`/`.clearance`, letting a single correct
answer award Mission 1's payout immediately (rather than waiting for
the whole quest to complete, since Mission 2 continues in the same
conversation). Wrong answers set no flag and show a hint via the normal
compact dialogue box — re-opening Herald just re-asks the same question,
free retries, no point loss.

**Evidence images** — `village_map_mission1.jpeg`, `dossier_sorcerer.jpeg`,
`dossier_goblin.jpeg`, `dossier_berserker.jpeg` live in
`client/public/assets/quest/`, sourced from Downloads (`Village Map
Mission 1.jpeg`, `Dark Sorcerer.jpeg`, `goblin.jpeg`, `URuk hai.jpeg`).
The berserker file still reads "Uruk-Hai Berserker" in the artwork
itself, per the task spec's own note ("build against the filename, not
the label") — that's baked-in image content, not a rendered string, so
it doesn't violate the Uruk-Hai/Isen/Orc rename sweep. The blueprint
image likewise still labels the river "River Isen" (same caveat — a
pixel label, not game-rendered text). `imageOverlay.ts`'s "EVIDENCE
PENDING" placeholder card only shows if a file goes missing again.

Both missions' text is paginated into 3 short screens each (intro /
evidence / question) rather than one long scroll — the briefing panel
and the evidence overlay are both sized in fixed px tuned to the game's
1280x720 canvas, not `vh`/`vw` (see CLAUDE.md — `#ui-root` is a static
box, not scaled to the true browser viewport, so viewport units there
size against the wrong frame of reference and can push buttons off the
visible game area on a browser window taller than the game canvas).

### CLAUDE.md pointer

`session.ts` is now the source of truth for player identity — `Room.ts`
no longer hardcodes "the player is the wizard." Any new code that needs
the player's name/sprite should read `getSession()`/`getAvatarOption()`,
not assume the wizard texture.

## 9. "The Innkeeper's Shards" — de-identification quest (unlocks at C4)

A second two-mission quest, structurally identical to "The Breach in
the Wall" (briefing panels, mid-quest `DialogueChoice.points`/`.clearance`,
hint-on-wrong-answer, no point loss on retry) but teaching
de-identification failure modes instead of AI-pipeline risk categories,
and using **data tables** rather than images as evidence — this proved
common enough evidence content (structured rows the player has to
cross-reference) to warrant its own overlay: `client/src/ui/tableOverlay.ts`
mirrors `imageOverlay.ts`'s open-count/ESC-conflict pattern exactly, but
renders styled `.evidence-table` HTML (mono, zebra rows, gold header)
instead of an image viewer, with an optional tab strip when a step has
more than one table (`EvidenceTableTab[]`). `npc.ts`'s `DialogueSet`
gained a matching `evidenceTables` field (mutually exclusive with
`evidence`) and a `gridChoices` flag — a wrapping CSS grid layout for
choice buttons, used here because both missions have 10-12 answer
options that would otherwise force a long one-per-row scroll.

**ODILE** (tavern) is the sole quest giver — a gold pulse (same
technique as the Herald's) highlights her once Clearance 4 is reached.
Her offer dialogue plays only past that threshold; before it she has
nothing new to say. `breach_in_the_wall.json` carries
`"unlocks": ["innkeepers_shards"]` alongside its existing
`clearanceOnComplete: 4`, so the new quest becomes `available` at the
exact moment Clearance 4 is reached — no separate clearance-gate check
needed in dialogue logic beyond the existing `questActive`/`questComplete`
conditionals.

**Mission 1, "Chains of Identity" (150 pts)** teaches linkage attacks:
three tabbed tables (room→ticket, ticket→item/time, name→appearance/time)
that chain together to re-identify the occupant of Room 7 (WREN) despite
the innkeeper's belief that "sharding" her logs across three drawers
made them anonymous. Wrong picks get one of two hint groups — a
time-quasi-identifier hint for the two names sharing the same coat
(Petra, Hollis), a generic "start at the room" hint for everyone else.

**Mission 2, "The Flawed Mask" (150 pts)** teaches k-anonymity:
a single sanitized 12-row safehouse log (generalization + suppression
applied to Trade/Age Range/District) that the Archive claims satisfies
k=2, but one row (S-08) has no twin. Wrong picks get one of three hint
groups — a "suppressed twins are still twins" hint for the two rows
that share a suppressed District (S-03/S-07), a "three of a kind" hint
for the three-way match (S-04/S-09/S-10), and a generic compare-every-row
hint for the six rows that already have a clean twin. Correct answer
completes the quest: +150 pts, Clearance 5, fanfare.

**Academy cross-link** — Privacy track's `deidentification_masks_and_chains`
stub card (`clearanceRequired: 5`, `hasContent: false`) carries a new
`fieldWorkQuestId` pointing at this quest, so it renders a "FIELD WORK"
pip that auto-✓s on quest completion (via `questEngine.isComplete()`,
checked fresh on every Academy render) alongside a static
"THEORY: IN DEVELOPMENT" tag — no lesson/quiz content exists yet.
