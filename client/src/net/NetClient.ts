import { Client, Room } from "colyseus.js";
import type { Faction } from "../session";

// Presence-only network layer — see PLAN.md's multiplayer section.
//
// This does NOT use getStateCallbacks/onAdd/onChange/onRemove, despite
// that being the obvious API. Verified directly (two real browser tabs
// against the local dev server): room.state.players itself syncs
// correctly in the browser bundle — .size and .forEach both reflect the
// true player count — but getStateCallbacks-registered onAdd/onChange
// handlers simply never fire, neither retroactively for players already
// in the map at connect time nor live for players who join afterward. A
// standalone Node script using the identical colyseus.js version proved
// the callback API itself isn't broken in general — this reproduces the
// project's historically-documented "first connection never receives
// other players" bug, just isolated one step further than the previous
// attempt's theory (missing listeners) got: the listeners fire in Node,
// not in this Vite/browser bundle. Root cause not identified (suspect a
// decorator/bundling interaction) and not worth more of this timebox to
// chase — polling the schema map directly every frame (pollPlayers(),
// called from Room.ts's update()) sidesteps it entirely and is just as
// correct for a ~30-player presence demo.
const COLYSEUS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:2567";

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

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
type StatusChangeHandler = (status: ConnectionStatus, lastError: string | null) => void;

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
  // Single overwritable slots, not arrays: there's only ever one live
  // consumer (the currently active Room scene). Room.ts re-registers on
  // every create(), including scene.restart() on door transitions — that
  // simply repoints these at the new scene's fresh RemotePlayerController
  // rather than accumulating stale handlers pointed at destroyed sprites.
  private addHandler: PlayerAddHandler | null = null;
  private changeHandler: PlayerChangeHandler | null = null;
  private removeHandler: PlayerRemoveHandler | null = null;
  // Unlike the three above, this one's set once by hud.ts (in UIOverlay,
  // constructed before Room.ts's first connect() call and never rebuilt
  // on room transitions) and never needs repointing — it's read by the
  // HUD's connection status dot, purely diagnostic, never gates gameplay.
  private statusHandler: StatusChangeHandler | null = null;
  private status: ConnectionStatus = "disconnected";
  private lastError: string | null = null;

  // pollPlayers()'s own diff baseline — see the file-level comment on why
  // this drives add/change/remove instead of getStateCallbacks.
  private knownPlayers = new Map<string, RemotePlayerSnapshot>();

  private lastSend = 0;
  private lastSentX: number | null = null;
  private lastSentY: number | null = null;
  private lastSentFacing: string | null = null;
  private lastSentMoving: boolean | null = null;

  private connectToken = 0;

  onPlayerAdd(handler: PlayerAddHandler) {
    this.addHandler = handler;
  }

  onPlayerChange(handler: PlayerChangeHandler) {
    this.changeHandler = handler;
  }

  onPlayerRemove(handler: PlayerRemoveHandler) {
    this.removeHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler) {
    this.statusHandler = handler;
  }

  getStatus(): { status: ConnectionStatus; lastError: string | null } {
    return { status: this.status, lastError: this.lastError };
  }

  private setStatus(status: ConnectionStatus, lastError: string | null = null) {
    if (this.status === status && this.lastError === lastError) return;
    this.status = status;
    this.lastError = lastError;
    this.statusHandler?.(status, lastError);
  }

  async connect(sceneId: string, session: NetSession): Promise<void> {
    this.disconnect();
    const token = ++this.connectToken;
    this.setStatus("connecting");
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
      this.setStatus("connected");
      this.sessionId = room.sessionId;
      this.resetSendState();
    } catch (err) {
      // A dead/refused WebSocket typically throws a raw ProgressEvent or
      // CloseEvent from the browser, not an Error — those stringify to
      // useless junk like "[object ProgressEvent]" in the status dot's
      // tooltip, so fall back to a plain description instead of that.
      const message = err instanceof Error ? err.message : "could not reach the server";
      if (!allowRetry || token !== this.connectToken) {
        if (token === this.connectToken) this.setStatus("disconnected", message);
        return;
      }
      this.setStatus("connecting", message); // still trying — one retry left
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      if (token !== this.connectToken) return;
      await this.attemptConnect(sceneId, session, token, false);
    }
  }

  /** Diffs room.state.players against the last-seen snapshot and fires
   * add/change/remove accordingly. Called once per frame from Room.ts's
   * update(), right alongside sendMove(). */
  pollPlayers() {
    if (!this.room) return;
    // this.room resolving (joinOrCreate() awaited) and this.room.state's
    // schema actually finishing its first sync over the websocket are two
    // separate async events — there's a real window (worse over a real
    // network than localhost) where .players is still undefined here.
    // Called unconditionally every frame from Room.ts's update(), ahead of
    // npcController/questController/checkDoors/checkZones — an uncaught
    // throw here would silently starve all of those for every subsequent
    // frame this stays undefined, which is the opposite of "multiplayer
    // failure is silent and solo play is unaffected" (see this file's
    // header comment and CLAUDE.md). No-op instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const players = (this.room.state as any)?.players as Map<string, RemotePlayerSnapshot> | undefined;
    if (!players) return;
    const seen = new Set<string>();

    players.forEach((player, sessionId) => {
      if (sessionId === this.sessionId) return;
      seen.add(sessionId);
      const snapshot = snapshotOf(sessionId, player);
      const prev = this.knownPlayers.get(sessionId);
      if (!prev) {
        this.knownPlayers.set(sessionId, snapshot);
        this.addHandler?.(snapshot);
      } else if (
        prev.x !== snapshot.x ||
        prev.y !== snapshot.y ||
        prev.facing !== snapshot.facing ||
        prev.moving !== snapshot.moving ||
        prev.name !== snapshot.name ||
        prev.faction !== snapshot.faction ||
        prev.spriteId !== snapshot.spriteId ||
        prev.clearance !== snapshot.clearance
      ) {
        this.knownPlayers.set(sessionId, snapshot);
        this.changeHandler?.(snapshot);
      }
    });

    for (const sessionId of this.knownPlayers.keys()) {
      if (!seen.has(sessionId)) {
        this.knownPlayers.delete(sessionId);
        this.removeHandler?.(sessionId);
      }
    }
  }

  disconnect() {
    this.connectToken++;
    if (this.room) {
      this.room.leave();
      this.room = null;
    }
    this.sessionId = null;
    this.knownPlayers.clear();
    this.resetSendState();
    this.setStatus("disconnected");
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
