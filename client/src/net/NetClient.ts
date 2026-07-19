import { Client, Room, getStateCallbacks } from "colyseus.js";
import type { Faction } from "../session";

// Presence-only network layer — see PLAN.md's multiplayer section.
// getStateCallbacks(room) is used deliberately: the previous, abandoned
// client (client/src/net/colyseus.ts, since removed) never registered any
// state-sync listeners at all, which is the most likely explanation for
// this project's historically-documented "first connection never receives
// other players" bug (see Room.ts's git history). getStateCallbacks fires
// onAdd retroactively for entries already in the map at registration time,
// which a hand-rolled room.state.players.onAdd(...) call would too, but
// only if actually wired up — this makes sure it is.
const COLYSEUS_URL = import.meta.env.VITE_COLYSEUS_URL ?? "ws://localhost:2567";

const SEND_INTERVAL_MS = 100; // 10Hz
const RETRY_DELAY_MS = 5000;

export interface NetSession {
  name: string;
  spriteId: string;
  faction: Faction | null;
  clearance?: number;
}

export interface RemotePlayerSnapshot {
  sessionId: string;
  name: string;
  spriteId: string;
  faction: string;
  x: number;
  y: number;
  facing: string;
  moving: boolean;
  clearance: number;
}

type PlayerAddHandler = (player: RemotePlayerSnapshot) => void;
type PlayerChangeHandler = (player: RemotePlayerSnapshot) => void;
type PlayerRemoveHandler = (sessionId: string) => void;

function snapshotOf(sessionId: string, player: {
  name: string; spriteId: string; faction: string; x: number; y: number;
  facing: string; moving: boolean; clearance: number;
}): RemotePlayerSnapshot {
  return {
    sessionId,
    name: player.name,
    spriteId: player.spriteId,
    faction: player.faction,
    x: player.x,
    y: player.y,
    facing: player.facing,
    moving: player.moving,
    clearance: player.clearance,
  };
}

// Multiplayer is garnish, never a dependency — every failure path here is
// silent. The game must play identically solo whether the server is down,
// unreachable, or drops mid-session.
export class NetClient {
  private room: Room | null = null;
  private sessionId: string | null = null;
  private addHandlers: PlayerAddHandler[] = [];
  private changeHandlers: PlayerChangeHandler[] = [];
  private removeHandlers: PlayerRemoveHandler[] = [];

  private lastSend = 0;
  private lastSentX: number | null = null;
  private lastSentY: number | null = null;
  private lastSentFacing: string | null = null;
  private lastSentMoving: boolean | null = null;

  private connectToken = 0;

  onPlayerAdd(handler: PlayerAddHandler) {
    this.addHandlers.push(handler);
  }

  onPlayerChange(handler: PlayerChangeHandler) {
    this.changeHandlers.push(handler);
  }

  onPlayerRemove(handler: PlayerRemoveHandler) {
    this.removeHandlers.push(handler);
  }

  async connect(sceneId: string, session: NetSession): Promise<void> {
    this.disconnect();
    const token = ++this.connectToken;
    await this.attemptConnect(sceneId, session, token, true);
  }

  private async attemptConnect(
    sceneId: string,
    session: NetSession,
    token: number,
    allowRetry: boolean
  ): Promise<void> {
    try {
      const client = new Client(COLYSEUS_URL);
      const room = await client.joinOrCreate("scene", {
        sceneId,
        name: session.name,
        spriteId: session.spriteId,
        faction: session.faction ?? "fundamentalist",
        clearance: session.clearance ?? 1,
      });
      // A newer connect() (or an explicit disconnect()) happened while this
      // one was in flight — drop it rather than wiring up a stale room.
      if (token !== this.connectToken) {
        room.leave();
        return;
      }
      this.room = room;
      this.sessionId = room.sessionId;
      this.resetSendState();
      this.wireStateCallbacks(room);
    } catch {
      if (!allowRetry || token !== this.connectToken) return;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      if (token !== this.connectToken) return;
      await this.attemptConnect(sceneId, session, token, false);
    }
  }

  private wireStateCallbacks(room: Room) {
    const $ = getStateCallbacks(room);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const players = (room.state as any).players;

    $(players).onAdd((player: RemotePlayerSnapshot, sessionId: string) => {
      if (sessionId === this.sessionId) return;
      for (const handler of this.addHandlers) handler(snapshotOf(sessionId, player));
      $(player).onChange(() => {
        if (sessionId === this.sessionId) return;
        for (const handler of this.changeHandlers) handler(snapshotOf(sessionId, player));
      });
    });

    $(players).onRemove((_player: RemotePlayerSnapshot, sessionId: string) => {
      if (sessionId === this.sessionId) return;
      for (const handler of this.removeHandlers) handler(sessionId);
    });
  }

  disconnect() {
    this.connectToken++;
    if (this.room) {
      this.room.leave();
      this.room = null;
    }
    this.sessionId = null;
    this.resetSendState();
  }

  private resetSendState() {
    this.lastSend = 0;
    this.lastSentX = null;
    this.lastSentY = null;
    this.lastSentFacing = null;
    this.lastSentMoving = null;
  }

  /** Throttled to 10Hz and only sent when position/facing/moving actually
   * changed — called unconditionally every frame from Room.ts's update(),
   * rather than driven by a separate scheduled timer. */
  sendMove(x: number, y: number, facing: string, moving: boolean) {
    if (!this.room) return;
    const now = Date.now();
    const changed =
      x !== this.lastSentX || y !== this.lastSentY || facing !== this.lastSentFacing || moving !== this.lastSentMoving;
    if (!changed || now - this.lastSend < SEND_INTERVAL_MS) return;
    this.lastSend = now;
    this.lastSentX = x;
    this.lastSentY = y;
    this.lastSentFacing = facing;
    this.lastSentMoving = moving;
    this.room.send("move", { x, y, facing, moving });
  }
}

export const net = new NetClient();
