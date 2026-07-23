import { Room, Client } from "colyseus";
import { Schema, type, MapSchema } from "@colyseus/schema";

// Presence-only state — see PLAN.md's multiplayer section. Deliberately
// tiny: local room chat (ephemeral, not part of the synced schema —
// see the "chat" message handler below), no combat, no shared quest
// state, no persistence.
export class PlayerState extends Schema {
  @type("string") name = "";
  @type("string") spriteId = "wizard";
  @type("string") faction = "fundamentalist"; // "fundamentalist" | "apocalypse"
  @type("number") x = 0;
  @type("number") y = 0;
  @type("string") facing = "down"; // "up" | "down" | "left" | "right"
  @type("boolean") moving = false;
  @type("number") clearance = 1; // unused visually today — sent for the future badge display
}

export class SceneState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}

interface JoinOptions {
  sceneId: string;
  name?: string;
  spriteId?: string;
  faction?: string;
  clearance?: number;
}

interface MoveMessage {
  x: number;
  y: number;
  facing: string;
  moving: boolean;
}

interface ChatMessage {
  text: string;
}

const CHAT_MAX_LEN = 120;

// The server has no notion of a room's walkable polygon (that's
// client-side art/collision data, see Room.ts) — clamping to the scene's
// pixel bounds is a sane stand-in, not a real anti-cheat boundary. This
// is a presence demo, not server-authoritative physics.
const SCENE_WIDTH = 1280;
const SCENE_HEIGHT = 720;
const SPAWN_X = SCENE_WIDTH / 2;
const SPAWN_Y = SCENE_HEIGHT - 100;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// One room class, partitioned by scene via filterBy (see index.ts) — a
// player walking Village → Tavern leaves this room instance entirely
// and joins (or creates) the Tavern's, rather than one room class per
// scene id living forever. maxClients/patchRate match the task spec's
// numbers exactly (20Hz state sync, ~30 concurrent).
export class SceneRoom extends Room<SceneState> {
  maxClients = 30;

  onCreate(options: JoinOptions) {
    this.setMetadata({ sceneId: options.sceneId });
    this.setPatchRate(50);
    this.setState(new SceneState());

    this.onMessage("move", (client, message: MoveMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.x = clamp(message.x, 0, SCENE_WIDTH);
      player.y = clamp(message.y, 0, SCENE_HEIGHT);
      player.facing = message.facing || player.facing;
      player.moving = !!message.moving;
    });

    // Ephemeral, room-scoped chat — not part of SceneState, so it never
    // touches the schema/patch pipeline. Relayed to everyone else in
    // this same sceneId room (the partitioning filterBy already gives
    // us "local chat" for free — see index.ts); the sender renders its
    // own bubble immediately client-side rather than waiting on the
    // round trip (see NetClient.sendChat()), so `except: client` here.
    this.onMessage("chat", (client, message: ChatMessage) => {
      if (!this.state.players.has(client.sessionId)) return;
      const text = (message?.text ?? "").toString().trim().slice(0, CHAT_MAX_LEN);
      if (!text) return;
      this.broadcast("chat", { sessionId: client.sessionId, text }, { except: client });
    });
  }

  onJoin(client: Client, options: JoinOptions) {
    const player = new PlayerState();
    player.name = options.name ?? "Traveler";
    player.spriteId = options.spriteId ?? "wizard";
    player.faction = options.faction ?? "fundamentalist";
    player.clearance = options.clearance ?? 1;
    player.x = SPAWN_X;
    player.y = SPAWN_Y;
    this.state.players.set(client.sessionId, player);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
  }
}
