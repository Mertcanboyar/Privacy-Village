import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config";
import { ROOMS } from "../rooms";
import { LORE_NPC_IDS, LORE_NPC_FRAME_SIZE } from "../npc";
import { QUEST_IDS, questEngine, type QuestDef } from "../questEngine";
import { ACADEMY_TRACK_IDS, ACADEMY_MODULE_IDS, academy, type AcademyTrack, type AcademyModule } from "../academy";
import { events, type EventVideo } from "../events";

export class Preload extends Phaser.Scene {
  constructor() {
    super("Preload");
  }

  preload() {
    const box = this.add.graphics();
    box.fillStyle(0x222233, 1);
    box.fillRect(GAME_WIDTH / 2 - 160, GAME_HEIGHT / 2 - 20, 320, 24);

    const bar = this.add.graphics();
    this.load.on("progress", (value: number) => {
      bar.clear();
      bar.fillStyle(0x8a5fff, 1);
      bar.fillRect(GAME_WIDTH / 2 - 156, GAME_HEIGHT / 2 - 16, 312 * value, 16);
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

    // Painted-room assets (see CLAUDE.md). Foreground PNGs and room JSON
    // (walkable polygon/doors/lights, authored via /debug) may not exist
    // yet for every room — missing files 404 quietly and Room.ts falls
    // back to sane defaults.
    for (const room of ROOMS) {
      this.load.image(`room-bg-${room}`, `assets/rooms/${room}_bg.png`);
      this.load.image(`room-fg-${room}`, `assets/rooms/${room}_fg.png`);
      this.load.json(`room-data-${room}`, `assets/rooms/${room}.json`);
    }

    // UI/audio/ambient sprites still pending (see PLAN.md section 2).
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
