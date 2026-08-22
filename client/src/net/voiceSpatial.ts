import Phaser from "phaser";
import { voice } from "../voice";
import { net } from "./NetClient";
import { getSession } from "../session";
import type { RoomName } from "../rooms";

// Per-scene half of spatial voice chat (see PLAN — Spatial Voice Chat) —
// constructed in Room.ts's multiplayer wiring block exactly like
// ContactExchangeController, torn down on the scene's SHUTDOWN event.
// Owns everything that's genuinely per-scene: triggering the LiveKit
// connect once Colyseus has a sessionId, and (in later commits) the V/M
// hotkeys, the Web Audio spatial graph, and stage-occupancy/selective-
// subscription logic. Permission/mode/device/volume state lives in
// voice.ts instead, since those are session-scoped preferences that
// must survive a scene.restart(), not per-room state.
export class VoiceSpatialController {
  private sceneName: RoomName;
  private connectedThisScene = false;

  constructor(scene: Phaser.Scene, sceneName: RoomName) {
    void scene;
    this.sceneName = sceneName;
  }

  /** Called every frame from Room.ts's update(), same tier as
   * net.pollPlayers()/remotePlayers.update(). Right now this only
   * polls for net.getSessionId() becoming available (Colyseus connects
   * asynchronously and retries once on failure — see NetClient's own
   * connect()) so it can trigger the one-time LiveKit connect for this
   * scene; hotkey handling and the spatial audio recompute tick land
   * here in later commits. */
  update(_playerX: number, _playerY: number, _uiOpen: boolean) {
    if (this.connectedThisScene) return;
    const sessionId = net.getSessionId();
    if (!sessionId) return;
    this.connectedThisScene = true;
    void voice.connectToScene(this.sceneName, sessionId, getSession().name);
  }

  /** Torn down on the scene's SHUTDOWN event — currently a no-op since
   * there's no per-scene Web Audio graph yet (added in a later commit).
   * Does NOT disconnect the LiveKit Room itself; Room.ts's checkDoors()
   * calls voice.disconnectFromScene() directly, right alongside
   * net.disconnect(), same as this class never owning net's own
   * connection either. */
  destroy() {
    // Nothing to tear down yet.
  }
}
