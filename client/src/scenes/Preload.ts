import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config";
import { ROOMS } from "../rooms";
import { LORE_NPC_IDS, LORE_NPC_FRAME_SIZE } from "../npc";
import { QUEST_IDS, questEngine, type QuestDef } from "../questEngine";
import { ACADEMY_TRACK_IDS, ACADEMY_MODULE_IDS, academy, type AcademyTrack, type AcademyModule } from "../academy";
import { events, type EventVideo } from "../events";
import { dossier, type CodexConcept, type TitleDef } from "../dossier";
import { guidedMode, type SequenceStep } from "../guidedMode";
import { recordLoadError } from "../renderDiagnostics";

export class Preload extends Phaser.Scene {
  constructor() {
    super("Preload");
  }

  preload() {
    // Design-system colors (see public/ui/design-system.css) rather than
    // the old raw purple/near-black one-off — this is the first thing
    // anyone sees, it should already look like the rest of the game.
    const centerX = GAME_WIDTH / 2;
    const centerY = GAME_HEIGHT / 2;

    this.add
      .text(centerX, centerY - 40, "PRIVACY VILLAGE", {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "18px",
        color: "#f0b429", // --accent-gold
        letterSpacing: 4,
      })
      .setOrigin(0.5);

    const track = this.add.graphics();
    track.fillStyle(0x1e2130, 1); // --bg-panel
    track.fillRoundedRect(centerX - 160, centerY - 12, 320, 24, 6);
    track.lineStyle(2, 0x3d4257, 1); // --border-strong
    track.strokeRoundedRect(centerX - 160, centerY - 12, 320, 24, 6);

    const bar = this.add.graphics();
    this.load.on("progress", (value: number) => {
      bar.clear();
      if (value <= 0) return;
      bar.fillStyle(0xf0b429, 1); // --accent-gold
      bar.fillRoundedRect(centerX - 156, centerY - 8, 312 * value, 16, 4);
    });

    // Playtest Session 3, P0 — a failed image/spritesheet load used to be
    // silent (Phaser just skips it, and whatever later tries to draw
    // that texture key falls through to a broken/missing-texture look).
    // Every UNEXPECTED load failure across this whole queue now lands in
    // renderDiagnostics.ts's error log, visible via `?debug=render` and
    // attached to any later "render_failure" decisions row. Foreground
    // room PNGs are excluded — none exist yet for any room, and Room.ts
    // already treats that as a normal, optional state (see its
    // `textures.exists(fgKey)` check), not a failure worth surfacing.
    this.load.on("loaderror", (file: Phaser.Loader.File) => {
      if (file.key.startsWith("room-fg-")) return;
      recordLoadError(file.key, file.src);
    });

    // Player avatar — single painted pose (no walk-cycle frames), flipped
    // horizontally for left/right facing. See Room.ts.
    this.load.image("player", "assets/sprites/player/wizard.png");

    // More avatar-picker options (see session.ts AVATAR_OPTIONS) — each a
    // single cropped idle frame from a CraftPix character pack, same
    // static-pose convention as the wizard above.
    this.load.image("player-archer", "assets/sprites/player/archer.png");
    this.load.image("player-paladin", "assets/sprites/player/paladin.png");
    this.load.image("player-viking", "assets/sprites/player/viking.png");

    // Ambient wanderer NPCs (see Room.ts WANDERER_ROUTES).
    this.load.image("npc-knight", "assets/sprites/npc/knight.png");
    this.load.image("npc-herald", "assets/sprites/npc/herald.png");

    // Maren the Healer ("The Healer's Ledger" — see npc.ts) — a 10-frame
    // idle strip, user-provided (a fairy character pack), cropped to a
    // shared bounding box across all 10 source frames so she doesn't
    // jitter as the animation loops. Not part of the LORE_NPC_IDS/
    // LORE_NPC_FRAME_SIZE convention above since she isn't from that
    // source pack. Lives at a different asset path on purpose (see
    // npc.ts's fallbackTexture doc comment): if this file is ever
    // missing, it 404s quietly and npc.ts falls back to the knight
    // placeholder + a console.warn.
    // Frame dimensions below reflect a one-time downscale (see Playtest
    // Session 3, P0): the source strips were exported at up to 14160px
    // wide, well past the ~4096px MAX_TEXTURE_SIZE many integrated/older
    // GPUs enforce — a WebGL texture upload past that cap silently
    // corrupts (the reported "green stripes on black"). Every strip below
    // was resampled to a 3600px total width (comfortable margin under
    // 4096), frame count unchanged, frameWidth/frameHeight recomputed
    // from the resized file — see ?debug=render for a live texture-size
    // report against the current device's actual cap.
    this.load.spritesheet("npc-maren", "assets/npc/healer/maren.png", { frameWidth: 360, frameHeight: 331 });

    // Courier ("The Blueprint of the Post Road" — see npc.ts) — an
    // 18-frame idle strip (a "Forest Ranger" character pack), same
    // union-bbox-crop-across-all-frames treatment as Maren above.
    this.load.spritesheet("npc-courier", "assets/npc/courier/courier.png", { frameWidth: 200, frameHeight: 267 });
    // Villager — 30-frame greeting-animation strip, same treatment,
    // from a different user-provided character pack.
    this.load.spritesheet("npc-villager", "assets/npc/villager/villager.png", { frameWidth: 120, frameHeight: 161 });

    // Mayor ("The Treasury's Two Keys" — see npc.ts) — a 30-frame idle
    // strip (a "Blacksmith" character pack), same treatment.
    this.load.spritesheet("npc-mayor", "assets/npc/mayor/mayor.png", { frameWidth: 120, frameHeight: 164 });

    // Throne guards (Great Hall, flanking the Mayor) — one 10-frame idle
    // strip (a "Knight_02" character pack) reused for both, mirrored via
    // NPCDef.flipX so they face each other rather than reading as the
    // same person twice over.
    this.load.spritesheet("npc-knight-guard", "assets/npc/knight_guard/knight_guard.png", { frameWidth: 360, frameHeight: 328 });

    // Isolde ("The Alchemist's Trials" — see npc.ts) — a 4-frame idle
    // strip built from a CraftPix "Minotaur Tiny Style" pack (see
    // CREDITS.md), same union-bbox-crop-across-all-frames treatment as
    // every other self-built NPC strip. Replaces her original tinted
    // reuse of the Villager sprite.
    this.load.spritesheet("npc-isolde", "assets/npc/isolde/isolde.png", { frameWidth: 443, frameHeight: 411 });

    // Kenney character sheet — not used by the player anymore, kept
    // loaded for the NPC system (Week 2, see PLAN.md).
    this.load.spritesheet("characters", "assets/sprites/rpg-urban-pack/Tilemap/tilemap.png", {
      frameWidth: 16,
      frameHeight: 16,
      margin: 0,
      spacing: 1,
    });

    // Lore NPCs (see PLAN.md Phase 2, Day 2 + npc.ts) — each a 4-frame
    // idle-only strip (these NPCs are static, no pathfinding), frame size
    // varies per character's source pack (see LORE_NPC_FRAME_SIZE).
    for (const id of LORE_NPC_IDS) {
      this.load.spritesheet(`npc-${id}`, `assets/sprites/npc-pack/${id}.png`, LORE_NPC_FRAME_SIZE[id]);
    }

    // "Battle for AI" quest engine (see PLAN.md Phase 2, Day 3).
    for (const id of QUEST_IDS) {
      this.load.json(`quest-${id}`, `data/quests/${id}.json`);
    }

    // Academy learning hub (see PLAN.md "The Academy") — track summaries
    // and the one demo-rule module with real lesson/quiz content.
    for (const id of ACADEMY_TRACK_IDS) {
      this.load.json(`academy-track-${id}`, `data/academy/${id}.json`);
    }
    for (const id of ACADEMY_MODULE_IDS) {
      this.load.json(`academy-module-${id}`, `data/academy/module_${id}.json`);
    }

    // Events panel (see hud.ts) — curated video list from the real
    // Privacy Village YouTube channel, youtube.com/@PrivacyQuest.
    this.load.json("events", "data/events.json");

    // The Agent Dossier (see dossier.ts) — concept trophy catalog and
    // title definitions, each a single flat JSON array rather than
    // per-id files (there's no per-concept content beyond the array
    // entry itself, unlike Academy modules).
    this.load.json("codex", "data/codex.json");
    this.load.json("titles", "data/titles.json");

    // Guided Sequence (see guidedMode.ts) — the hard-gated intended path
    // for a first-time player, s1 (Threat Modeling Academy module) then
    // s2 (The Breach in the Wall).
    this.load.json("sequence", "data/sequence.json");

    // Painted-room assets (see CLAUDE.md). Foreground PNGs and room JSON
    // (walkable polygon/doors/lights, authored via /debug) may not exist
    // yet for every room — missing files 404 quietly and Room.ts falls
    // back to sane defaults.
    for (const room of ROOMS) {
      this.load.image(`room-bg-${room}`, `assets/rooms/${room}_bg.png`);
      this.load.image(`room-fg-${room}`, `assets/rooms/${room}_fg.png`);
      this.load.json(`room-data-${room}`, `assets/rooms/${room}.json`);
    }

    // Background music (see audio.ts's initMusic()) — started once from
    // Title.ts, the first real screen after this loading bar.
    this.load.audio("bgm", "assets/audio/bgm.mp3");

    // UI/ambient sprites still pending (see PLAN.md section 2).
  }

  async create() {
    // Register quest definitions. "arrival" is bootstrapped (unlocked +
    // auto-activated) from Room.ts on first village spawn, not here —
    // this just makes the defs known to the engine.
    const questDefs = QUEST_IDS.map((id) => this.cache.json.get(`quest-${id}`) as QuestDef);
    questEngine.loadDefs(questDefs);

    const academyTracks = ACADEMY_TRACK_IDS.map((id) => this.cache.json.get(`academy-track-${id}`) as AcademyTrack);
    const academyModules = ACADEMY_MODULE_IDS.map((id) => this.cache.json.get(`academy-module-${id}`) as AcademyModule);
    academy.loadData(academyTracks, academyModules);

    events.loadData(this.cache.json.get("events") as EventVideo[]);

    dossier.loadData(this.cache.json.get("codex") as CodexConcept[], this.cache.json.get("titles") as TitleDef[]);

    // guidedMode.loadData() reads academy/questEngine's already-loaded
    // state above to compute the current step, so it must run after
    // both loadData() calls, not before.
    const sequence = this.cache.json.get("sequence") as { steps: SequenceStep[] };
    guidedMode.loadData(sequence.steps);

    // Idle loop for each lore NPC — row 0, cols 0-3 (see preload() comment).
    // 6fps per the source pack's suggested speed.
    for (const id of LORE_NPC_IDS) {
      this.anims.create({
        key: `npc-${id}-idle`,
        frames: this.anims.generateFrameNumbers(`npc-${id}`, { start: 0, end: 3 }),
        frameRate: 6,
        repeat: -1,
      });
    }

    // Maren's idle loop — all 10 frames of her strip (see preload()'s
    // load.spritesheet call above), same 6fps as the lore NPCs.
    this.anims.create({
      key: "npc-maren-idle",
      frames: this.anims.generateFrameNumbers("npc-maren", { start: 0, end: 9 }),
      frameRate: 6,
      repeat: -1,
    });

    // Courier's idle loop — all 18 frames of its strip, same 6fps
    // convention.
    this.anims.create({
      key: "npc-courier-idle",
      frames: this.anims.generateFrameNumbers("npc-courier", { start: 0, end: 17 }),
      frameRate: 6,
      repeat: -1,
    });
    this.anims.create({
      key: "npc-villager-idle",
      frames: this.anims.generateFrameNumbers("npc-villager", { start: 0, end: 29 }),
      frameRate: 6,
      repeat: -1,
    });
    this.anims.create({
      key: "npc-mayor-idle",
      frames: this.anims.generateFrameNumbers("npc-mayor", { start: 0, end: 29 }),
      frameRate: 6,
      repeat: -1,
    });
    this.anims.create({
      key: "npc-knight-guard-idle",
      frames: this.anims.generateFrameNumbers("npc-knight-guard", { start: 0, end: 9 }),
      frameRate: 6,
      repeat: -1,
    });
    this.anims.create({
      key: "npc-isolde-idle",
      frames: this.anims.generateFrameNumbers("npc-isolde", { start: 0, end: 3 }),
      frameRate: 6,
      repeat: -1,
    });

    // Canvas text doesn't reflow when a webfont finishes loading late (unlike
    // DOM text), so make sure the 3 design-system fonts are ready before any
    // Phaser Text (name tags, prompts) that uses them gets created. Race
    // against a timeout so a slow/broken font CDN can't block the game.
    await Promise.race([
      Promise.all([
        document.fonts.load('700 16px "Space Grotesk"'),
        document.fonts.load('400 16px "Inter"'),
        document.fonts.load('700 16px "JetBrains Mono"'),
      ]),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);

    // Room/UIOverlay now start from CharacterCreate's confirm handler,
    // once a name and avatar have been chosen (see PLAN.md Phase 2, Day 1).
    this.scene.start("Title");
  }
}
