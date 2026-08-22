import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config";
import { attachDebugOverlay } from "../debugOverlay";
import { NPCController, findNpcRoom } from "../npc";
import { QuestController } from "../quest";
import { EventBoardController } from "../eventBoard";
import { roles } from "../roles";
import { ContactExchangeController } from "../contactExchange";
import { getAvatarOption, getFactionColor, getSession } from "../session";
import { questEngine } from "../questEngine";
import { academy } from "../academy";
import { dossier } from "../dossier";
import { tutorial } from "../tutorial";
import { events } from "../events";
import { playSound } from "../audio";
import type { RoomName } from "../rooms";
import { net } from "../net/NetClient";
import { RemotePlayerController, CHAT_BUBBLE_DURATION_MS, CHAT_BUBBLE_STYLE, STAGE_CHAT_BUBBLE_STYLE, EMOTE_BUBBLE_DURATION_MS, EMOTE_ICONS, ROLE_BADGES } from "../net/remotePlayers";
import { VoiceSpatialController } from "../net/voiceSpatial";
import { voice } from "../voice";
import { isUiLocked } from "../cloud/uiLock";
import { ChatController } from "../chat";
import { ChatLogController } from "../chatLog";
import { markSpawn, logOnboardingOrientationShown, logChatMessageSent, logEmoteSent } from "../instrumentation";
import { guidedMode } from "../guidedMode";
import { recordLoadError, logRenderFailure } from "../renderDiagnostics";

const PLAYER_SPEED = 160;
const SCALE_FAR = 0.75;
const SCALE_NEAR = 1.0;

// P0-1 playtest fix: a first-time player who hasn't reached their
// marked objective within 20s of spawn gets one nudge toast — never
// repeats within this page load (module-level, so it survives the
// scene restart every door transition triggers). See
// maybeFireHandlerNudge().
const HANDLER_NUDGE_DELAY_MS = 20000;
let handlerNudgeFired = false;

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

// Short uppercase label for the off-screen objective arrow (see
// refreshObjectiveArrow()) — deliberately separate from academy.ts's
// roomLabel(), which reads as prose ("the tavern") rather than a UI tag.
function roomDisplayName(room: RoomName): string {
  if (room === "tavern") return "TAVERN";
  if (room === "courthouse") return "COURTHOUSE";
  if (room === "great_hall") return "GREAT HALL";
  return "VILLAGE";
}

// The hub every door/Academy trip eventually returns to — its bg/fg
// textures stay resident across room transitions rather than being
// freed by unloadRoomTextures() (see init()/create() below), same
// reasoning as any other "keep the frequently-revisited thing warm"
// cache decision.
const HUB_ROOM: RoomName = "village";

export class Room extends Phaser.Scene {
  private roomName: RoomName = "village";
  private player!: Phaser.GameObjects.Image;
  private playerNameText!: Phaser.GameObjects.Text;
  private playerTitleText!: Phaser.GameObjects.Text;
  private playerRoleText!: Phaser.GameObjects.Text;
  private playerBaseScale = 1;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };
  private walkable: Point[] = FULL_CANVAS_WALKABLE;
  private doors: RoomDoor[] = [];
  private zones: RoomZone[] = [];
  private zoneMarker: Phaser.GameObjects.Graphics | null = null;
  private objectiveArrow: Phaser.GameObjects.Text | null = null;
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
  private eventBoard!: EventBoardController;
  private contactExchange!: ContactExchangeController;
  // Cold blue-grey overlay while "The Night the Wall Fell" is active —
  // persists across room changes (see refreshIncidentTint(), called at
  // the end of every create()) and lifts on quest completion.
  private incidentTint: Phaser.GameObjects.Rectangle | null = null;
  private pendingCourthouseDoorPing = false;
  private remotePlayers!: RemotePlayerController;
  private voiceSpatial!: VoiceSpatialController;
  private chatController!: ChatController;
  private chatLog!: ChatLogController;
  private localChatBubble: Phaser.GameObjects.Text | null = null;
  private localChatBubbleExpiresAt = 0;
  private localEmoteBubble: Phaser.GameObjects.Text | null = null;
  private localEmoteBubbleExpiresAt = 0;
  private emoteKeys!: { ONE: Phaser.Input.Keyboard.Key; TWO: Phaser.Input.Keyboard.Key; THREE: Phaser.Input.Keyboard.Key; FOUR: Phaser.Input.Keyboard.Key };
  // Playtest Session 3, P0 (texture diagnostics + cleanup) — see init(),
  // preload(), create() below.
  private hasEnteredAnyRoom = false;
  private roomToUnload: RoomName | null = null;
  private renderFailed = false;

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

  // Same technique, anchored to Bram — "The Blueprint of the Post
  // Road"'s giver, not Herald (see academy.ts's AcademyFieldWork.ping).
  pingBram() {
    this.npcController.pingBram(this);
  }

  // Same technique, anchored to the Mayor — "The Treasury's Two Keys"'s
  // giver (see academy.ts's AcademyFieldWork.ping).
  pingMayor() {
    this.npcController.pingMayor(this);
  }

  // Same technique, anchored to Maren — "Maren's Winter Report"'s giver
  // (see academy.ts's AcademyFieldWork.ping).
  pingMaren() {
    this.npcController.pingMaren(this);
  }

  // Same technique, anchored to Quill — "The Archivist's Desk"'s giver
  // (see academy.ts's AcademyFieldWork.ping).
  pingQuill() {
    this.npcController.pingQuill(this);
  }

  // Same technique, anchored to Isolde — "The Alchemist's Trials"'s
  // giver (see academy.ts's AcademyFieldWork.ping).
  pingIsolde() {
    this.npcController.pingIsolde(this);
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
    // Per-scene texture cleanup (Playtest Session 3, P0): note which
    // room we're LEAVING (not the very first Room.create() of the
    // session, and not if we're "transitioning" into the same room or
    // into the hub) — actually freed once the new room's own textures
    // are confirmed loaded, in create() below.
    const leavingRoom = this.hasEnteredAnyRoom ? this.roomName : null;
    this.roomName = data.room ?? "village";
    this.roomToUnload = leavingRoom && leavingRoom !== this.roomName && leavingRoom !== HUB_ROOM ? leavingRoom : null;
    this.transitioning = false;
    this.renderFailed = false;
    this.wanderers = [];
    this.pendingCourthouseDoorPing = data.pingCourthouseDoor ?? false;
  }

  preload() {
    // Normally a no-op — every room's bg/fg is already resident from
    // Preload.ts's eager boot-time load. Only does real work if this
    // room's textures were freed by a previous unloadRoomTextures() call
    // (a revisit after leaving) or genuinely failed to load the first
    // time — either way, Phaser's own preload → create sequencing means
    // create() below never runs until this either succeeds or fails.
    const bgKey = `room-bg-${this.roomName}`;
    const fgKey = `room-fg-${this.roomName}`;
    this.load.on("loaderror", (file: Phaser.Loader.File) => {
      if (file.key.startsWith("room-fg-")) return;
      recordLoadError(file.key, file.src);
    });
    if (!this.textures.exists(bgKey)) this.load.image(bgKey, `assets/rooms/${this.roomName}_bg.png`);
    if (!this.textures.exists(fgKey)) this.load.image(fgKey, `assets/rooms/${this.roomName}_fg.png`);
  }

  // Frees a room's bg/fg textures from the game's (global, cross-scene)
  // TextureManager — called from create() once the room we're arriving
  // in is confirmed loaded, never for HUB_ROOM. A later revisit re-fetches
  // via preload()'s existence check above.
  private unloadRoomTextures(room: RoomName) {
    const bgKey = `room-bg-${room}`;
    const fgKey = `room-fg-${room}`;
    if (this.textures.exists(bgKey)) this.textures.remove(bgKey);
    if (this.textures.exists(fgKey)) this.textures.remove(fgKey);
  }

  // Fail loudly, not silently (Playtest Session 3, P0) — a tester's
  // machine once rendered every non-hub room as green-stripes-on-black
  // with nothing surfaced anywhere. If the background this room needs
  // genuinely isn't in the TextureManager by the time create() runs
  // (decode failure, 404, or a corrupted upload some GPU driver still
  // reports as "loaded"), show this instead of drawing garbage, and log
  // it so a report like that one comes with real diagnostic data attached.
  private showRenderFailure(textureKey: string) {
    this.renderFailed = true;
    logRenderFailure(this.game, textureKey);

    const el = document.createElement("div");
    el.id = "render-failure-banner";
    Object.assign(el.style, {
      position: "fixed",
      inset: "0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "16px",
      background: "#0a0a0f",
      color: "#f2f0e9",
      fontFamily: '"Inter", sans-serif',
      zIndex: "1000000",
      textAlign: "center",
      padding: "24px",
    });
    const message = document.createElement("div");
    message.style.fontFamily = '"Space Grotesk", sans-serif';
    message.style.fontSize = "20px";
    message.style.fontWeight = "700";
    message.textContent = "A scene failed to load — please refresh.";
    const reportBtn = document.createElement("button");
    reportBtn.textContent = "[Report]";
    Object.assign(reportBtn.style, {
      fontFamily: '"JetBrains Mono", monospace',
      padding: "10px 20px",
      background: "#f0b429",
      color: "#1a1500",
      border: "none",
      borderRadius: "6px",
      fontWeight: "700",
      cursor: "pointer",
    });
    reportBtn.addEventListener("click", () => {
      logRenderFailure(this.game, textureKey);
      reportBtn.textContent = "Reported — thank you";
      reportBtn.disabled = true;
    });
    el.append(message, reportBtn);
    document.body.appendChild(el);
  }

  create() {
    const bgKey = `room-bg-${this.roomName}`;
    const fgKey = `room-fg-${this.roomName}`;
    const dataKey = `room-data-${this.roomName}`;

    // Now that this room's own textures are confirmed present (preload()
    // above ran to completion before Phaser calls create()), free
    // whatever room we left behind.
    if (this.roomToUnload) {
      this.unloadRoomTextures(this.roomToUnload);
      this.roomToUnload = null;
    }
    this.hasEnteredAnyRoom = true;
    // See guidedMode.ts's primeAfterHydration() doc comment — idempotent,
    // and this is the first point after Title.ts's hydration (if any)
    // has reliably settled, same reasoning as this file's own
    // isFirstSpawn check below.
    guidedMode.primeAfterHydration();

    if (!this.textures.exists(bgKey)) {
      this.showRenderFailure(bgKey);
      return;
    }

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

    // Public Agent Dossier title (see dossier.ts) — same "always create,
    // toggle text/visibility" approach as remotePlayers.ts's titleTag,
    // for the same reason: swapping titles on the Journey tab mid-session
    // is a text update, not a create/destroy.
    this.playerTitleText = this.add
      .text(spawn[0], spawn[1] - this.player.displayHeight - 4, dossier.getActiveTitleDef()?.name ?? "", {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "10px",
        color: getFactionColor(),
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(100000)
      .setVisible(!!dossier.getActiveTitleDef());

    // §3 "Visible Identity" — same always-created/toggle shape as the
    // title tag above, one slot further up the stack.
    const myRoleBadge = ROLE_BADGES[roles.getMyRole() ?? ""];
    this.playerRoleText = this.add
      .text(spawn[0], spawn[1] - this.player.displayHeight - 4, myRoleBadge?.label ?? "", {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "11px",
        fontStyle: "bold",
        color: myRoleBadge?.color ?? "#ffffff",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(100000)
      .setVisible(!!myRoleBadge);
    this.refreshPlayerNameTagPositions();

    const onActiveTitleChanged = () => {
      const def = dossier.getActiveTitleDef();
      this.playerTitleText.setText(def?.name ?? "").setVisible(!!def);
      this.refreshPlayerNameTagPositions();
      net.setActiveTitle(def?.name ?? "");
    };
    dossier.on("activeTitleChanged", onActiveTitleChanged);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => dossier.off("activeTitleChanged", onActiveTitleChanged));

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
    this.voiceSpatial = new VoiceSpatialController(this, this.roomName);
    this.contactExchange = new ContactExchangeController(this, this.remotePlayers);
    net.onPlayerAdd((p) => this.remotePlayers.spawn(p));
    net.onPlayerChange((p) => this.remotePlayers.applySnapshot(p));
    net.onPlayerRemove((sessionId) => this.remotePlayers.remove(sessionId));
    // Local room chat — "local" for free, since a door transition already
    // disconnects from this scene's SceneRoom and joins the next one (see
    // the comment above); a chat message never crosses that boundary.
    this.chatLog = new ChatLogController(this);
    net.onChat((sessionId, text, stage) => {
      if (this.chatLog.isMuted(sessionId)) return;
      this.remotePlayers.showBubble(sessionId, text, stage);
      const name = this.remotePlayers.getName(sessionId) ?? "?";
      this.chatLog.addMessage({ sessionId, name, text, stage, ts: Date.now() });
    });
    net.onChatHistory((entries) => this.chatLog.loadHistory(entries));
    net.onEmote((sessionId, emoteId) => this.remotePlayers.emote(sessionId, emoteId));
    net.connect(this.roomName, {
      name: getSession().name,
      spriteId: avatar.id,
      faction: getSession().faction,
      clearance: questEngine.getClearance(),
      activeTitle: dossier.getActiveTitleDef()?.name ?? "",
      role: roles.getMyRole() ?? "",
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

    // Every interior's single door back out gets a floating "EXIT" label
    // (same treatment as the Academy door above) — the village's own
    // entry doors into Tavern/Courthouse/Great Hall stay unlabeled, per
    // feedback (the painted hanging signs/architecture already read as
    // entrances without a text prompt). The exit doors sit right at the
    // bottom edge of their rooms with no room below them, so the label
    // goes above the door.
    if (this.roomName !== "village") {
      for (const door of this.doors) {
        this.add
          .text(door.x + door.width / 2, door.y - 8, "\u{1F6AA} EXIT", {
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: "14px",
            color: "#f0b429",
            stroke: "#000000",
            strokeThickness: 3,
          })
          .setOrigin(0.5, 1)
          .setDepth(100000);
      }
    }

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys("W,A,S,D") as typeof this.wasd;
    this.emoteKeys = this.input.keyboard!.addKeys("ONE,TWO,THREE,FOUR") as typeof this.emoteKeys;

    attachDebugOverlay(this, this.roomName, this.walkable);

    if (this.roomName === "village") {
      this.spawnWanderers();
      // "arrival" is only ever "locked" the very first time a player
      // (guest or authenticated) spawns into the village — any later
      // visit (door back in, or a returning player already hydrated
      // past Title.ts) has it available/active/complete instead. Read
      // this BEFORE bootstrapHqQuest() flips it, so the tutorial only
      // fires on a genuine first spawn (see tutorial.ts).
      const isFirstSpawn = questEngine.getState("arrival") === "locked";
      if (isFirstSpawn) {
        markSpawn(); // see instrumentation.ts — the "seconds since spawn" clock's zero point
        this.time.delayedCall(HANDLER_NUDGE_DELAY_MS, () => this.maybeFireHandlerNudge());
      }
      const isFirstEverVisit = isFirstSpawn && tutorial.shouldShow();
      // Idempotent — only actually unlocks/activates the first time this
      // ever runs across the whole session (see questEngine.ts).
      questEngine.bootstrapHqQuest("arrival");
      if (isFirstEverVisit) {
        tutorial.open();
        logOnboardingOrientationShown();
      }
    }

    this.npcController = new NPCController(this, this.roomName);
    this.questController = new QuestController(this, this.roomName);
    this.eventBoard = new EventBoardController(this, this.roomName);
    this.chatController = new ChatController(
      this,
      (text) => this.sendChatMessage(text),
      () => this.resetMovementKeys(),
    );

    this.refreshZoneMarker();
    questEngine.on("questUpdated", this.refreshZoneMarker, this);
    this.refreshObjectiveArrow();
    questEngine.on("questUpdated", this.refreshObjectiveArrow, this);

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

    // The Academy can open from several places that bypass npc.ts
    // entirely (HUD button, door hotspot, tracker locked-hint — see
    // NPCController.closeIfOpen()'s doc comment) — close any leftover
    // NPC dialogue/briefing the instant it opens, regardless of which
    // of those triggered it.
    const onAcademyOpened = () => this.npcController.closeIfOpen();
    academy.on("opened", onAcademyOpened);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      questEngine.off("questUpdated", this.refreshZoneMarker, this);
      questEngine.off("questUpdated", this.checkIncidentTrigger, this);
      questEngine.off("questUpdated", this.refreshObjectiveArrow, this);
      questEngine.off("questCompleted", onQuestCompleted);
      questEngine.off("sceneBeat", onSceneBeat);
      academy.off("opened", onAcademyOpened);
      this.zoneMarker?.destroy();
      this.objectiveArrow?.destroy();
      this.voiceSpatial.destroy();
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
  // playing out. `!questEngine.getActiveQuest()` matters now that the
  // paired Academy module's theory alone can unlock this quest (see
  // PLAN's Academy-first inversion) — a player can reach Clearance-
  // independent theory completion while "arrival" (or any other quest)
  // is still active, and acceptQuest() silently no-ops if another quest
  // is already active, which used to strand this quest at "available"
  // forever with no NPC dialogue ever reaching its questActive branches.
  // Waiting for no active quest matches the same "between quests" gate
  // every normal quest-giver offer already uses (see npc.ts's open());
  // the next questUpdated once that quest completes re-checks this.
  private checkIncidentTrigger() {
    if (
      this.roomName === "village" &&
      !this.transitioning &&
      !questEngine.getActiveQuest() &&
      questEngine.getState("night_the_wall_fell") === "available"
    ) {
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

  // Rooms are fixed-camera and never scroll (see CLAUDE.md), so "off
  // screen" only ever means "in a different room" — points at whichever
  // door in THIS room leads toward the current objective NPC (see
  // questEngine.getObjectiveNpcId()), pulsing the same way
  // NPCController's own on-NPC marker does. Every non-village room has
  // exactly one door (back to the village hub), so a target with no
  // direct door here (e.g. tavern -> courthouse) still resolves
  // correctly by falling back to that one door — going through the hub
  // is always the right next step in this 4-room layout.
  private refreshObjectiveArrow() {
    this.objectiveArrow?.destroy();
    this.objectiveArrow = null;

    const npcId = questEngine.getObjectiveNpcId();
    if (!npcId) return;
    const targetRoom = findNpcRoom(npcId);
    if (!targetRoom || targetRoom === this.roomName) return;
    const door = this.doors.find((d) => d.target === targetRoom) ?? this.doors[0];
    if (!door) return;

    const g = this.add
      .text(door.x + door.width / 2, door.y - 20, `▲ ${roomDisplayName(targetRoom)}`, {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "16px",
        fontStyle: "bold",
        color: "#f0b429",
        stroke: "#000000",
        strokeThickness: 4,
      })
      .setOrigin(0.5, 1)
      .setDepth(100002);
    this.tweens.add({ targets: g, scale: { from: 1, to: 1.2 }, alpha: { from: 0.7, to: 1 }, duration: 1200, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    this.objectiveArrow = g;
  }

  // Scheduled once, HANDLER_NUDGE_DELAY_MS after a genuine first spawn
  // (see create()) — a playtest found new players wandering, never
  // noticing the pulsing marker at all. Only fires if the objective is
  // still NPC-shaped and unresolved by then; silent otherwise. Delivered
  // via questEngine.toast() (the only public route into hud.ts's toast
  // stack — see questEngine.ts's toast()).
  private maybeFireHandlerNudge() {
    if (handlerNudgeFired) return;
    if (!questEngine.getObjectiveNpcId()) return;
    handlerNudgeFired = true;
    questEngine.toast("HANDLER: The marked contact is waiting, Agent.");
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

  // Mirrors remotePlayers.ts's per-remote-player positioning: name
  // (always) → title (if active) → role badge (if any), each stacking
  // one slot further up only when the one below it is visible. Called
  // on movement and whenever the active title changes (see the
  // "activeTitleChanged" listener in create()).
  private refreshPlayerNameTagPositions() {
    const headY = this.player.y - this.player.displayHeight - 4;
    this.playerNameText.setPosition(this.player.x, headY);
    let nextY = headY;
    if (this.playerTitleText.visible) {
      nextY -= this.playerNameText.displayHeight + 2;
      this.playerTitleText.setPosition(this.player.x, nextY);
    }
    if (this.playerRoleText.visible) {
      nextY -= (this.playerTitleText.visible ? this.playerTitleText.displayHeight : this.playerNameText.displayHeight) + 2;
      this.playerRoleText.setPosition(this.player.x, nextY);
    }
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
    // "/mute <name>" fallback (see PLAN.md) — a slash command never
    // reaches the server at all, same as any other client-only command
    // would; only the click-a-name-in-the-log path is the "real" UI.
    const muteMatch = text.match(/^\/mute\s+(.+)$/i);
    if (muteMatch) {
      const muted = this.chatLog.muteByName(muteMatch[1]);
      questEngine.toast(muted ? `Muted ${muteMatch[1]}.` : `No one named "${muteMatch[1]}" in this room.`);
      return;
    }

    // §2 "The Gathering" — standing in the Tavern's stage zone renders
    // bigger/gold, scene-wide (the existing scene-scoped broadcast IS
    // "scene-wide" here, see PLAN.md's proximity-chat scope note). A
    // cosmetic flag only, same trust level as "move" — not a privilege
    // boundary, so it rides straight through to the server untouched.
    const isOnStage = this.isPlayerOnZone("stage");

    logChatMessageSent();
    net.sendChat(text, isOnStage);
    // Rendered locally regardless of whether the send above actually
    // reached the server — chat is garnish on top of garnish, same
    // "never a dependency" rule multiplayer already follows (see
    // NetClient.ts's header comment); a message you typed should always
    // appear above your own head, solo or not.
    this.localChatBubble?.destroy();
    this.localChatBubble = this.add
      .text(this.player.x, this.player.y - this.player.displayHeight - 24, text, isOnStage ? STAGE_CHAT_BUBBLE_STYLE : CHAT_BUBBLE_STYLE)
      .setOrigin(0.5, 1)
      .setDepth(100001);
    this.localChatBubbleExpiresAt = this.time.now + CHAT_BUBBLE_DURATION_MS;
    this.chatLog.addMessage({ sessionId: "local", name: getSession().name, text, stage: isOnStage, ts: Date.now() });
  }

  private isPlayerOnZone(zoneId: string): boolean {
    const zone = this.zones.find((z) => z.id === zoneId);
    if (!zone) return false;
    return Phaser.Math.Distance.Between(this.player.x, this.player.y, zone.x, zone.y) < zone.radius;
  }

  private sendLocalEmote(emoteId: string) {
    logEmoteSent(emoteId);
    net.sendEmote(emoteId);
    const icon = EMOTE_ICONS[emoteId];
    if (!icon) return;
    this.localEmoteBubble?.destroy();
    this.localEmoteBubble = this.add
      .text(this.player.x, this.player.y - this.player.displayHeight - 24, icon, { fontSize: "28px" })
      .setOrigin(0.5, 1)
      .setDepth(100001);
    this.localEmoteBubbleExpiresAt = this.time.now + EMOTE_BUBBLE_DURATION_MS;
  }

  update(time: number) {
    if (this.transitioning || this.renderFailed) return;

    // Clamp dt: the first frame's delta can be anomalously large (time
    // since page load, not since last frame), which would otherwise let
    // the player or a wanderer warp straight through several waypoints.
    const dt = Math.min(this.game.loop.delta, 50) / 1000;

    const otherUiOpen =
      this.npcController.dialogueOpen ||
      this.questController.dialogueOpen ||
      this.eventBoard.dialogueOpen ||
      this.contactExchange.uiOpen ||
      academy.isOpen ||
      academy.isCelebrating ||
      events.isOpen ||
      dossier.isOpen ||
      tutorial.isOpen ||
      this.voiceSpatial.isShowingPermissionPrompt ||
      isUiLocked();
    this.chatController.update(otherUiOpen);
    const uiOpen = otherUiOpen || this.chatController.isOpen;
    this.chatLog.update();
    let localMoving = false;

    // §1 "The Gathering" emote hotkeys — gated by !uiOpen same as WASD,
    // so a chat message that happens to start with a digit (typed while
    // the input has focus) never fires one; the input's own keydown
    // stopPropagation (see chat.ts) already prevents Phaser from seeing
    // the keystroke at all in that case, this guard covers every other
    // overlay the same way movement is already covered.
    if (!uiOpen) {
      const emoteId = Phaser.Input.Keyboard.JustDown(this.emoteKeys.ONE)
        ? "wave"
        : Phaser.Input.Keyboard.JustDown(this.emoteKeys.TWO)
          ? "question"
          : Phaser.Input.Keyboard.JustDown(this.emoteKeys.THREE)
            ? "agree"
            : Phaser.Input.Keyboard.JustDown(this.emoteKeys.FOUR)
              ? "celebrate"
              : null;
      if (emoteId) this.sendLocalEmote(emoteId);
    }

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
        this.refreshPlayerNameTagPositions();
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
    this.voiceSpatial.update(this.player.x, this.player.y, uiOpen);

    if (this.localChatBubble) {
      if (time > this.localChatBubbleExpiresAt) {
        this.localChatBubble.destroy();
        this.localChatBubble = null;
      } else {
        this.localChatBubble.setPosition(this.player.x, this.player.y - this.player.displayHeight - 24);
      }
    }

    if (this.localEmoteBubble) {
      if (time > this.localEmoteBubbleExpiresAt) {
        this.localEmoteBubble.destroy();
        this.localEmoteBubble = null;
      } else {
        this.localEmoteBubble.setPosition(this.player.x, this.player.y - this.player.displayHeight - 24);
      }
    }

    this.updateWanderers(time, dt);
    this.npcController.update(this.player.x, this.player.y);
    this.questController.update(this.player.x, this.player.y);
    this.eventBoard.update(this.player.x, this.player.y);
    this.contactExchange.update(this.player.x, this.player.y);

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
        void voice.disconnectFromScene();
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
