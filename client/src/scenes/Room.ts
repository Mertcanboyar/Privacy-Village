import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config";
import { attachDebugOverlay } from "../debugOverlay";
import { NPCController } from "../npc";
import { QuestController } from "../quest";
import { getAvatarOption, getFactionColor, getSession } from "../session";
import { questEngine } from "../questEngine";
import { academy } from "../academy";
import { events } from "../events";
import { playSound } from "../audio";
import type { RoomName } from "../rooms";
import { net } from "../net/NetClient";
import { RemotePlayerController, CHAT_BUBBLE_DURATION_MS, CHAT_BUBBLE_STYLE } from "../net/remotePlayers";
import { isUiLocked } from "../cloud/uiLock";
import { ChatController } from "../chat";

const PLAYER_SPEED = 160;
const SCALE_FAR = 0.75;
const SCALE_NEAR = 1.0;

// Ambient wanderers — village only (see PLAN.md Day 13). Separate from
// and unrelated to live multiplayer presence (see net/NetClient.ts),
// which is wired in — these are scripted "ambient life" NPCs, not a
// multiplayer fallback.
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
  /** Set by AcademyOverlay's goToFieldWork() when a village-room-switch
   * field-work pip's ping target is the Courthouse door rather than
   * Herald (see academy.ts's AcademyFieldWork.ping). */
  pingCourthouseDoor?: boolean;
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
  // Cold blue-grey overlay while "The Night the Wall Fell" is active —
  // persists across room changes (see refreshIncidentTint(), called at
  // the end of every create()) and lifts on quest completion.
  private incidentTint: Phaser.GameObjects.Rectangle | null = null;
  private pendingCourthouseDoorPing = false;
  private remotePlayers!: RemotePlayerController;
  private chatController!: ChatController;
  private localChatBubble: Phaser.GameObjects.Text | null = null;
  private localChatBubbleExpiresAt = 0;

  constructor() {
    super("Room");
  }

  // Read by AcademyOverlay's "IN THE VILLAGE →" pip to decide whether it
  // needs a full room transition or can just ping the Herald in place.
  get currentRoom(): RoomName {
    return this.roomName;
  }

  pingHerald() {
    this.npcController.pingHerald(this);
  }

  // One-shot flash on the Village Square's door hotspot leading to the
  // Courthouse — same technique as pingHerald(), just anchored to a door
  // hotspot's coordinates instead of an NPC sprite (see academy.ts's
  // AcademyFieldWork.ping doc comment for why this exists).
  pingCourthouseDoor() {
    const door = this.doors.find((d) => d.target === "courthouse");
    if (!door) return;
    const cx = door.x + door.width / 2;
    const cy = door.y + door.height / 2;
    const g = this.add.circle(cx, cy, 10, 0xf0b429, 0.9).setDepth(100002);
    this.tweens.add({ targets: g, radius: 60, alpha: 0, duration: 900, ease: "Cubic.easeOut", onComplete: () => g.destroy() });
  }

  init(data: RoomInitData) {
    this.roomName = data.room ?? "village";
    this.transitioning = false;
    this.wanderers = [];
    this.pendingCourthouseDoorPing = data.pingCourthouseDoor ?? false;
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

    // Presence-only multiplayer (see PLAN.md) — garnish, never a
    // dependency. net.connect() silently retries once then gives up if
    // the server's unreachable, and the game plays identically solo
    // either way. Re-registering the handlers here (rather than once at
    // module scope) is what makes this safe across scene.restart(): each
    // call simply repoints net's single handler slots at this scene's
    // fresh RemotePlayerController, whose predecessor was already torn
    // down by normal Phaser scene teardown.
    this.remotePlayers = new RemotePlayerController(this);
    net.onPlayerAdd((p) => this.remotePlayers.spawn(p));
    net.onPlayerChange((p) => this.remotePlayers.applySnapshot(p));
    net.onPlayerRemove((sessionId) => this.remotePlayers.remove(sessionId));
    // Local room chat — "local" for free, since a door transition already
    // disconnects from this scene's SceneRoom and joins the next one (see
    // the comment above); a chat message never crosses that boundary.
    net.onChat((sessionId, text) => this.remotePlayers.showBubble(sessionId, text));
    net.connect(this.roomName, {
      name: getSession().name,
      spriteId: avatar.id,
      faction: getSession().faction,
      clearance: questEngine.getClearance(),
    });

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

    // Every other door hotspot (village's own doors into Tavern/
    // Courthouse, plus each interior's single door back out) gets the
    // same floating-label treatment as the Academy door above, so entry
    // and exit points read clearly without guessing from the art alone.
    // Village entry doors sit mid-facade, right where these buildings'
    // painted hanging signs already are — labeling above them (like the
    // Academy) collides with that art, so entry labels go below the
    // door, at ground level, instead. The two interior exit doors sit
    // right at the bottom edge of their rooms with no room below them,
    // so those keep the above-door placement.
    for (const door of this.doors) {
      if (door.target === "academy") continue;
      const isEntry = this.roomName === "village";
      const label = isEntry ? `\u{1F6AA} ENTER ${door.target.toUpperCase()}` : "\u{1F6AA} EXIT";
      const labelY = isEntry ? door.y + door.height + 6 : door.y - 8;
      this.add
        .text(door.x + door.width / 2, labelY, label, {
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: "14px",
          color: "#f0b429",
          stroke: "#000000",
          strokeThickness: 3,
        })
        .setOrigin(0.5, isEntry ? 0 : 1)
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
    this.chatController = new ChatController(
      this,
      (text) => this.sendChatMessage(text),
      () => this.resetMovementKeys(),
    );

    this.refreshZoneMarker();
    questEngine.on("questUpdated", this.refreshZoneMarker, this);
    // Re-checked on every questUpdated (not just at scene creation, see
    // below) so the incident starts the instant the k-anonymity puzzle
    // that unlocks it wraps up — that puzzle's giver (Herald) stands in
    // the Village Square, so completing it typically happens with the
    // player already standing in this exact scene. Without this, the
    // only check was the one at the bottom of create(), which only ever
    // ran on the NEXT village-room (re)entry — a confusing, disconnected
    // jump-scare if the player wandered off to the Tavern/Courthouse
    // first and only got shaken awake on their way back.
    questEngine.on("questUpdated", this.checkIncidentTrigger, this);

    this.refreshIncidentTint();
    const onQuestCompleted = (id: string) => {
      if (id === "night_the_wall_fell") this.refreshIncidentTint();
    };
    const onSceneBeat = (beat: string) => {
      if (beat === "villagersTurn") this.npcController.runVillagersTurnBeat(this);
    };
    questEngine.on("questCompleted", onQuestCompleted);
    questEngine.on("sceneBeat", onSceneBeat);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      questEngine.off("questUpdated", this.refreshZoneMarker, this);
      questEngine.off("questUpdated", this.checkIncidentTrigger, this);
      questEngine.off("questCompleted", onQuestCompleted);
      questEngine.off("sceneBeat", onSceneBeat);
      this.zoneMarker?.destroy();
    });

    // Covers the other path: the quest was already unlocked (e.g. the
    // player finished the puzzle, then walked to another room) before
    // this particular village scene instance was created — the listener
    // above only fires on a NEW questUpdated event, not retroactively.
    this.checkIncidentTrigger();

    if (this.roomName === "village" && this.pendingCourthouseDoorPing) {
      this.pendingCourthouseDoorPing = false;
      this.time.delayedCall(300, () => this.pingCourthouseDoor());
    }
  }

  // Cold blue-grey wash over the whole scene while the incident quest is
  // active — a Phaser rectangle rather than a DOM overlay, consistent
  // with how bg/fg art is already rendered as full-canvas Phaser objects
  // (see CLAUDE.md's DOM-vs-canvas split: this is world atmosphere, not
  // UI chrome). Depth 5000 sits above the foreground art (1000) but below
  // name tags/prompts (100000+), so labels stay legible through the tint.
  private refreshIncidentTint() {
    const active = questEngine.isActive("night_the_wall_fell");
    if (active && !this.incidentTint) {
      this.incidentTint = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x2b3a55, 0.25).setOrigin(0, 0).setDepth(5000);
    } else if (!active && this.incidentTint) {
      const tint = this.incidentTint;
      this.incidentTint = null;
      // The fade-out IS the reward ("warm dusk returns") — no snap-cut.
      this.tweens.add({ targets: tint, alpha: 0, duration: 1500, onComplete: () => tint.destroy() });
    }
  }

  // Auto-trigger: the incident starts the moment the player is standing
  // in the Village Square with the quest unlocked but not yet begun —
  // no NPC offers it (see QuestDef.giver's "auto" convention). Called
  // both reactively (questUpdated, so it fires immediately if this is
  // already the live scene) and once at the bottom of create() (so it
  // still fires if the quest unlocked while the player was elsewhere).
  // `!this.transitioning` guards against a second questUpdated firing
  // mid-sequence (acceptQuest() inside triggerIncidentStart() below
  // emits its own) re-entering this while the bell/shake/dash is still
  // playing out.
  private checkIncidentTrigger() {
    if (this.roomName === "village" && !this.transitioning && questEngine.getState("night_the_wall_fell") === "available") {
      this.triggerIncidentStart();
    }
  }

  // Bell, camera shake, Bram's dash, then the quest itself accepts and
  // the tint settles in. `transitioning` doubles as a scripted-sequence
  // lock here (same flag door transitions use) — update() already
  // early-returns on it, freezing movement/interaction for the beat.
  private triggerIncidentStart() {
    this.transitioning = true;
    playSound("alarm-bell");
    this.cameras.main.shake(400, 0.01);

    this.time.delayedCall(150, () => {
      // 50px, comfortably inside NPCController's 70px interact radius —
      // Bram dashing "to the player" should mean the player can talk to
      // him immediately, not take one more step to close the gap.
      this.npcController.triggerBramDash(this, this.player.x - 50, this.player.y);
    });

    this.time.delayedCall(900, () => {
      questEngine.acceptQuest("night_the_wall_fell");
      this.refreshIncidentTint();
      this.transitioning = false;
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

  private resetMovementKeys() {
    this.cursors.up.reset();
    this.cursors.down.reset();
    this.cursors.left.reset();
    this.cursors.right.reset();
    this.wasd.W.reset();
    this.wasd.A.reset();
    this.wasd.S.reset();
    this.wasd.D.reset();
  }

  private sendChatMessage(text: string) {
    net.sendChat(text);
    // Rendered locally regardless of whether the send above actually
    // reached the server — chat is garnish on top of garnish, same
    // "never a dependency" rule multiplayer already follows (see
    // NetClient.ts's header comment); a message you typed should always
    // appear above your own head, solo or not.
    this.localChatBubble?.destroy();
    this.localChatBubble = this.add
      .text(this.player.x, this.player.y - this.player.displayHeight - 24, text, CHAT_BUBBLE_STYLE)
      .setOrigin(0.5, 1)
      .setDepth(100001);
    this.localChatBubbleExpiresAt = this.time.now + CHAT_BUBBLE_DURATION_MS;
  }

  update(time: number) {
    if (this.transitioning) return;

    // Clamp dt: the first frame's delta can be anomalously large (time
    // since page load, not since last frame), which would otherwise let
    // the player or a wanderer warp straight through several waypoints.
    const dt = Math.min(this.game.loop.delta, 50) / 1000;

    const otherUiOpen = this.npcController.dialogueOpen || this.questController.dialogueOpen || academy.isOpen || events.isOpen || isUiLocked();
    this.chatController.update(otherUiOpen);
    const uiOpen = otherUiOpen || this.chatController.isOpen;
    let localMoving = false;

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
      localMoving = moving;
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

    // While an overlay has movement locked, localMoving stays false — the
    // player correctly appears standing (not frozen mid-walk) to others,
    // via the same change-detection sendMove already does internally.
    net.sendMove(this.player.x, this.player.y, this.player.flipX ? "left" : "right", localMoving);
    net.pollPlayers();
    this.remotePlayers.update();

    if (this.localChatBubble) {
      if (time > this.localChatBubbleExpiresAt) {
        this.localChatBubble.destroy();
        this.localChatBubble = null;
      } else {
        this.localChatBubble.setPosition(this.player.x, this.player.y - this.player.displayHeight - 24);
      }
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
        net.disconnect();
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
