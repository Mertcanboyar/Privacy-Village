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
  // Public Agent Dossier title (see client/src/dossier.ts) — the display
  // name (e.g. "Ranger of the Wall"), not an id, so remote clients can
  // render it directly with no title-catalog lookup of their own. Empty
  // string means "no active title", not "unset" (see PlayerState defaults
  // — there's no separate null state here, same as name/spriteId above).
  @type("string") activeTitle = "";
  // §3 "Visible Identity" (see PLAN.md) — "speaker" | "host" | "founding"
  // | "" (no role), assigned client-side from data/roles.json's
  // email-keyed allowlist (see client/src/roles.ts) and sent straight
  // through here, same trust level as spriteId/faction above — no
  // server-side validation, this is cosmetic-only, not a privilege.
  @type("string") role = "";
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
  activeTitle?: string;
  role?: string;
}

interface MoveMessage {
  x: number;
  y: number;
  facing: string;
  moving: boolean;
}

interface ChatMessage {
  text: string;
  stage?: boolean;
}

interface SetTitleMessage {
  title?: string;
}

interface EmoteMessage {
  emoteId?: string;
}

interface ChatHistoryEntry {
  sessionId: string;
  name: string;
  text: string;
  stage: boolean;
  ts: number;
}

const CHAT_MAX_LEN = 120;
const TITLE_MAX_LEN = 60;
const ROLE_IDS = new Set(["speaker", "host", "founding"]);
// §1 "The Gathering" (see PLAN.md) — last 50 messages replayed to a
// joiner so a late arrival isn't dropped into a silent room mid-
// conversation. Plain array, not schema — chat stays deliberately out
// of SceneState/the patch pipeline, same as before this feature.
const CHAT_HISTORY_LIMIT = 50;
// Simple flood guard: reject a message if it would be the 6th within
// the last 5s from the same client. Per-room (this.lastChatAt lives on
// the SceneRoom instance, not module scope), so it resets naturally
// with the room's own lifecycle — no cross-room bookkeeping needed for
// a ~30-player presence demo.
const CHAT_RATE_LIMIT_COUNT = 5;
const CHAT_RATE_LIMIT_WINDOW_MS = 5000;
const EMOTE_IDS = new Set(["wave", "question", "agree", "celebrate"]);

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
  private chatHistory: ChatHistoryEntry[] = [];
  private lastChatAt = new Map<string, number[]>();

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

    // Mid-session title change (Dossier's Journey tab can be opened and
    // re-selected without leaving the room) — same "trust the sender for
    // their own player only" shape as "move" above, just a schema field
    // instead of a broadcast.
    this.onMessage("setTitle", (client, message: SetTitleMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.activeTitle = (message?.title ?? "").toString().trim().slice(0, TITLE_MAX_LEN);
    });

    // Ephemeral, room-scoped chat — not part of SceneState, so it never
    // touches the schema/patch pipeline. Relayed to everyone else in
    // this same sceneId room (the partitioning filterBy already gives
    // us "local chat" for free — see index.ts); the sender renders its
    // own bubble immediately client-side rather than waiting on the
    // round trip (see NetClient.sendChat()), so `except: client` here.
    // `stage` is a client-reported cosmetic flag (was the sender
    // standing in the Tavern's stage zone at send time? — see
    // Room.ts's isOnStage()) — same trust level as "move" above, not a
    // privilege boundary, so it's passed straight through.
    this.onMessage("chat", (client, message: ChatMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const text = (message?.text ?? "").toString().trim().slice(0, CHAT_MAX_LEN);
      if (!text) return;
      if (!this.allowChat(client.sessionId)) return;
      const stage = !!message?.stage;
      const entry: ChatHistoryEntry = { sessionId: client.sessionId, name: player.name, text, stage, ts: Date.now() };
      this.chatHistory.push(entry);
      if (this.chatHistory.length > CHAT_HISTORY_LIMIT) this.chatHistory.shift();
      this.broadcast("chat", { sessionId: client.sessionId, text, stage }, { except: client });
    });

    // §1 "The Gathering" — hotkeys 1-4 (see Room.ts). No text payload,
    // just an id; same broadcast shape as chat but without history or
    // rate-limiting (a burst of waves during a live event is exactly
    // the point, not something to guard against).
    this.onMessage("emote", (client, message: EmoteMessage) => {
      if (!this.state.players.has(client.sessionId)) return;
      const emoteId = (message?.emoteId ?? "").toString();
      if (!EMOTE_IDS.has(emoteId)) return;
      this.broadcast("emote", { sessionId: client.sessionId, emoteId }, { except: client });
    });
  }

  /** Rejects (returns false, no throw — chat is garnish) if this
   * client would exceed CHAT_RATE_LIMIT_COUNT messages within
   * CHAT_RATE_LIMIT_WINDOW_MS. Prunes old timestamps as it goes so
   * this.lastChatAt never grows unbounded for a chatty session. */
  private allowChat(sessionId: string): boolean {
    const now = Date.now();
    const cutoff = now - CHAT_RATE_LIMIT_WINDOW_MS;
    const recent = (this.lastChatAt.get(sessionId) ?? []).filter((t) => t > cutoff);
    if (recent.length >= CHAT_RATE_LIMIT_COUNT) {
      this.lastChatAt.set(sessionId, recent);
      return false;
    }
    recent.push(now);
    this.lastChatAt.set(sessionId, recent);
    return true;
  }

  onJoin(client: Client, options: JoinOptions) {
    const player = new PlayerState();
    player.name = options.name ?? "Traveler";
    player.spriteId = options.spriteId ?? "wizard";
    player.faction = options.faction ?? "fundamentalist";
    player.clearance = options.clearance ?? 1;
    player.activeTitle = (options.activeTitle ?? "").toString().trim().slice(0, TITLE_MAX_LEN);
    const requestedRole = (options.role ?? "").toString();
    player.role = ROLE_IDS.has(requestedRole) ? requestedRole : "";
    player.x = SPAWN_X;
    player.y = SPAWN_Y;
    this.state.players.set(client.sessionId, player);
    // Replay last 50 so a joiner isn't dropped into a silent room
    // mid-conversation — see this.chatHistory's own doc comment.
    if (this.chatHistory.length > 0) client.send("chatHistory", this.chatHistory);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.lastChatAt.delete(client.sessionId);
  }
}
