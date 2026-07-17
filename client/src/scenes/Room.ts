import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config";
import { attachDebugOverlay } from "../debugOverlay";
import { NPCController } from "../npc";
import { QuestController } from "../quest";
import { getAvatarOption, getFactionColor, getSession } from "../session";
import { questEngine } from "../questEngine";
import { academy } from "../academy";
import type { RoomName } from "../rooms";

const PLAYER_SPEED = 160;
const SCALE_FAR = 0.75;
const SCALE_NEAR = 1.0;

// Ambient wanderers — village only (see PLAN.md Day 13 / risk-register
// fallback). Live multiplayer presence was cut: the first Colyseus
// connection a fresh page makes never receives other players into its
// local state (root cause not found; see git history on this file for the
// investigation). These scripted wanderers stand in for "ambient life"
// instead.
const WANDERER_SPEED = 50;
const WANDERER_ARRIVE_DIST = 6;
const WANDERER_PAUSE_MIN_MS = 1000;
const WANDERER_PAUSE_MAX_MS = 3000;
// Empty for now — the "Villager" wanderer was removed per feedback.
// Routes can be added back here; spawnWanderers() handles an empty list fine.
const WANDERER_ROUTES: { name: string; texture: string; baseScale: number; waypoints: Point[] }[] = [];

type Point = [number, number];

interface RoomDoor {
  x: number;
  y: number;
  width: number;
  height: number;
  target: string;
}

interface RoomZone {
  id: string;
  x: number;
  y: number;
  radius: number;
}

interface RoomJSON {
  walkable?: Point[];
  doors?: RoomDoor[];
  zones?: RoomZone[];
}

interface RoomInitData {
  room: RoomName;
}

interface Wanderer {
  image: Phaser.GameObjects.Image;
  nameText: Phaser.GameObjects.Text;
  baseScale: number;
  waypoints: Point[];
  targetIndex: number;
  pauseUntil: number;
}

// Default room shape when no room JSON has been authored yet (see /debug).
const FULL_CANVAS_WALKABLE: Point[] = [
  [0, 0],
  [GAME_WIDTH, 0],
  [GAME_WIDTH, GAME_HEIGHT],
  [0, GAME_HEIGHT],
];

function pointInPolygon([px, py]: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function depthScaleFor(y: number): number {
  const t = Phaser.Math.Clamp(y / GAME_HEIGHT, 0, 1);
  return SCALE_FAR + (SCALE_NEAR - SCALE_FAR) * t;
}

export class Room extends Phaser.Scene {
  private roomName: RoomName = "village";
  private player!: Phaser.GameObjects.Image;
  private playerNameText!: Phaser.GameObjects.Text;
  private playerBaseScale = 1;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };
  private walkable: Point[] = FULL_CANVAS_WALKABLE;
  private doors: RoomDoor[] = [];
  private zones: RoomZone[] = [];
  private zoneMarker: Phaser.GameObjects.Graphics | null = null;
  private transitioning = false;
  // Edge-detected rather than level-triggered: unlike a room door (which
  // warps the player away from the hotspot on trigger), the Academy door
  // opens an overlay in place, so the player is still standing in the
  // hotspot the instant they close it — without this, closing while
  // still inside the doorway would immediately reopen it.
  private wasInsideAcademyDoor = false;
  private wanderers: Wanderer[] = [];
  private npcController!: NPCController;
  private questController!: QuestController;

  constructor() {
    super("Room");
  }

  init(data: RoomInitData) {
    this.roomName = data.room ?? "village";
    this.transitioning = false;
    this.wanderers = [];
  }

  create() {
    const bgKey = `room-bg-${this.roomName}`;
    const fgKey = `room-fg-${this.roomName}`;
    const dataKey = `room-data-${this.roomName}`;

    this.add.image(0, 0, bgKey).setOrigin(0, 0).setDisplaySize(GAME_WIDTH, GAME_HEIGHT);

    const roomData: RoomJSON = this.cache.json.has(dataKey) ? this.cache.json.get(dataKey) : {};
    this.walkable = roomData.walkable && roomData.walkable.length >= 3 ? roomData.walkable : FULL_CANVAS_WALKABLE;
    this.doors = roomData.doors ?? [];
    this.zones = roomData.zones ?? [];

    const avatar = getAvatarOption();
    this.playerBaseScale = avatar.baseScale;

    const spawn: Point = [GAME_WIDTH / 2, GAME_HEIGHT - 100];
    this.player = this.add.image(spawn[0], spawn[1], avatar.texture).setOrigin(0.5, 1);
    this.applyDepthScale(spawn[1]);

    this.playerNameText = this.add
      .text(spawn[0], spawn[1] - this.player.displayHeight - 4, getSession().name.toUpperCase(), {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "14px",
        color: getFactionColor(),
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(100000);

    if (this.textures.exists(fgKey)) {
      this.add.image(0, 0, fgKey).setOrigin(0, 0).setDisplaySize(GAME_WIDTH, GAME_HEIGHT).setDepth(1000);
    }

    // The Academy building's doorway is partly obscured by foreground
    // market-stall art, so it gets a floating label (same convention as
    // NPC name tags — high depth so it reads above the foreground PNG)
    // in addition to the door hotspot itself.
    const academyDoor = this.doors.find((d) => d.target === "academy");
    if (academyDoor) {
      this.add
        .text(academyDoor.x + academyDoor.width / 2, academyDoor.y - 8, "\u{1F3DB} ACADEMY", {
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: "14px",
          color: "#f0b429",
          stroke: "#000000",
          strokeThickness: 3,
        })
        .setOrigin(0.5, 1)
        .setDepth(100000);
    }

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys("W,A,S,D") as typeof this.wasd;

    attachDebugOverlay(this, this.roomName, this.walkable);

    if (this.roomName === "village") {
      this.spawnWanderers();
      // Idempotent — only actually unlocks/activates the first time this
      // ever runs across the whole session (see questEngine.ts).
      questEngine.bootstrapHqQuest("arrival");
    }

    this.npcController = new NPCController(this, this.roomName);
    this.questController = new QuestController(this, this.roomName);

    this.refreshZoneMarker();
    questEngine.on("questUpdated", this.refreshZoneMarker, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      questEngine.off("questUpdated", this.refreshZoneMarker, this);
      this.zoneMarker?.destroy();
    });
  }

  // Pulses a glow on whichever of this room's zones is the active
  // quest's current reach_zone objective (none, if the objective is a
  // talk_to step or lives in a different room).
  private refreshZoneMarker() {
    this.zoneMarker?.destroy();
    this.zoneMarker = null;

    const quest = questEngine.getActiveQuest();
    if (!quest) return;
    const step = quest.steps[questEngine.getActiveStepIndex()];
    if (!step || step.trigger.type !== "reach_zone") return;
    const zoneId = step.trigger.zone;
    const zone = this.zones.find((z) => z.id === zoneId);
    if (!zone) return;

    const g = this.add.graphics().setDepth(zone.y - 1);
    g.fillStyle(0x4cc9f0, 0.35);
    g.fillCircle(zone.x, zone.y, zone.radius * 0.4);
    g.lineStyle(2, 0x4cc9f0, 0.8);
    g.strokeCircle(zone.x, zone.y, zone.radius * 0.4);
    this.tweens.add({ targets: g, alpha: { from: 1, to: 0.35 }, duration: 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    this.zoneMarker = g;
  }

  private spawnWanderers() {
    for (const route of WANDERER_ROUTES) {
      const [startX, startY] = route.waypoints[0];
      const image = this.add.image(startX, startY, route.texture).setOrigin(0.5, 1);
      image.setScale(route.baseScale * depthScaleFor(startY));
      image.setDepth(startY);

      const nameText = this.add
        .text(startX, startY - image.displayHeight - 4, route.name.toUpperCase(), {
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: "14px",
          color: "#f2f0e9",
          stroke: "#000000",
          strokeThickness: 3,
        })
        .setOrigin(0.5, 1)
        .setDepth(100000);

      this.wanderers.push({
        image,
        nameText,
        baseScale: route.baseScale,
        waypoints: route.waypoints,
        targetIndex: 1 % route.waypoints.length,
        pauseUntil: 0,
      });
    }
  }

  private updateWanderers(time: number, dt: number) {
    for (const wanderer of this.wanderers) {
      if (time < wanderer.pauseUntil) continue;

      const [tx, ty] = wanderer.waypoints[wanderer.targetIndex];
      const dx = tx - wanderer.image.x;
      const dy = ty - wanderer.image.y;
      const dist = Math.hypot(dx, dy);

      if (dist <= WANDERER_ARRIVE_DIST) {
        wanderer.targetIndex = (wanderer.targetIndex + 1) % wanderer.waypoints.length;
        wanderer.pauseUntil = time + Phaser.Math.Between(WANDERER_PAUSE_MIN_MS, WANDERER_PAUSE_MAX_MS);
        continue;
      }

      const step = WANDERER_SPEED * dt;
      wanderer.image.x += (dx / dist) * step;
      wanderer.image.y += (dy / dist) * step;
      wanderer.image.setFlipX(dx < 0);
      wanderer.image.setScale(wanderer.baseScale * depthScaleFor(wanderer.image.y));
      wanderer.image.setDepth(wanderer.image.y);
      wanderer.nameText.setPosition(wanderer.image.x, wanderer.image.y - wanderer.image.displayHeight - 4);
    }
  }

  private applyDepthScale(y: number) {
    this.player.setScale(this.playerBaseScale * depthScaleFor(y));
    this.player.setDepth(y);
  }

  update(time: number) {
    if (this.transitioning) return;

    // Clamp dt: the first frame's delta can be anomalously large (time
    // since page load, not since last frame), which would otherwise let
    // the player or a wanderer warp straight through several waypoints.
    const dt = Math.min(this.game.loop.delta, 50) / 1000;

    const uiOpen = this.npcController.dialogueOpen || this.questController.dialogueOpen || academy.isOpen;

    if (!uiOpen) {
      const left = this.cursors.left.isDown || this.wasd.A.isDown;
      const right = this.cursors.right.isDown || this.wasd.D.isDown;
      const up = this.cursors.up.isDown || this.wasd.W.isDown;
      const down = this.cursors.down.isDown || this.wasd.S.isDown;

      let vx = 0;
      let vy = 0;
      if (left) vx -= 1;
      if (right) vx += 1;
      if (up) vy -= 1;
      if (down) vy += 1;

      const moving = vx !== 0 || vy !== 0;
      if (moving) {
        const len = Math.hypot(vx, vy);
        const stepX = (vx / len) * PLAYER_SPEED * dt;
        const stepY = (vy / len) * PLAYER_SPEED * dt;

        // Resolve X and Y independently so the player slides along a
        // walkable-polygon edge instead of freezing on diagonal movement.
        let x = this.player.x;
        let y = this.player.y;
        if (pointInPolygon([x + stepX, y], this.walkable)) x += stepX;
        if (pointInPolygon([x, y + stepY], this.walkable)) y += stepY;

        this.player.setPosition(x, y);
        this.applyDepthScale(y);
        this.playerNameText.setPosition(x, y - this.player.displayHeight - 4);
      }

      if (left) this.player.setFlipX(true);
      else if (right) this.player.setFlipX(false);
    }

    this.updateWanderers(time, dt);
    this.npcController.update(this.player.x, this.player.y);
    this.questController.update(this.player.x, this.player.y);

    if (!uiOpen) {
      this.checkDoors();
      this.checkZones();
    }
  }

  private checkDoors() {
    for (const door of this.doors) {
      const inside =
        this.player.x >= door.x &&
        this.player.x <= door.x + door.width &&
        this.player.y >= door.y &&
        this.player.y <= door.y + door.height;

      // The Academy overlay IS the interior — no separate room to
      // restart into, so the player never leaves the hotspot on open.
      // Trigger only on the rising edge (see wasInsideAcademyDoor).
      if (door.target === "academy") {
        if (inside && !this.wasInsideAcademyDoor) academy.open();
        this.wasInsideAcademyDoor = inside;
        continue;
      }

      if (inside) {
        this.transitioning = true;
        this.scene.restart({ room: door.target as RoomName });
        return;
      }
    }
  }

  // reach_zone quest triggers (see questEngine.ts) — purely proximity
  // based, no [E] prompt, matching how door transitions already work.
  // notifyReachZone() internally no-ops unless this zone id matches the
  // active quest's current step, so it's safe to call for every zone
  // the player happens to be standing in, every frame.
  private checkZones() {
    for (const zone of this.zones) {
      const dist = Phaser.Math.Distance.Between(this.player.x, this.player.y, zone.x, zone.y);
      if (dist < zone.radius) {
        questEngine.notifyReachZone(zone.id);
      }
    }
  }
}
