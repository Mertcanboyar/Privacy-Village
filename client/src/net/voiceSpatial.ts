import Phaser from "phaser";
import { voice } from "../voice";
import { net } from "./NetClient";
import { getSession } from "../session";
import { el } from "../ui/dom";
import type { RoomName } from "../rooms";

// Per-scene half of spatial voice chat (see PLAN — Spatial Voice Chat) —
// constructed in Room.ts's multiplayer wiring block exactly like
// ContactExchangeController, torn down on the scene's SHUTDOWN event.
// Owns everything that's genuinely per-scene: triggering the LiveKit
// connect once Colyseus has a sessionId, the V/M hotkeys and the one-
// time permission-explanation prompt, and (in later commits) the Web
// Audio spatial graph and stage-occupancy/selective-subscription logic.
// Permission/mode/device/volume state lives in voice.ts instead, since
// those are session-scoped preferences that must survive a
// scene.restart(), not per-room state.
export class VoiceSpatialController {
  private sceneName: RoomName;
  private connectedThisScene = false;

  private pushToTalkKey: Phaser.Input.Keyboard.Key;
  private muteToggleKey: Phaser.Input.Keyboard.Key;

  // Set when the permission-explanation prompt is shown, consumed (and
  // cleared) the moment the player confirms it — lets the confirming
  // click replay whichever action actually triggered the prompt (see
  // showPermissionPrompt()'s doc comment) without any stuck-key risk.
  private pendingAction: "mute-toggle" | "push-to-talk" | null = null;
  private promptEl: HTMLElement;
  private promptOpen = false;

  constructor(scene: Phaser.Scene, sceneName: RoomName) {
    this.sceneName = sceneName;
    this.pushToTalkKey = scene.input.keyboard!.addKey("V");
    this.muteToggleKey = scene.input.keyboard!.addKey("M");

    this.promptEl = el(
      "div",
      {
        className: "dialogue ds-root",
        style: { position: "absolute", left: "60px", right: "60px", bottom: "30px", pointerEvents: "auto", display: "none" },
      },
      [
        el("div", { className: "dialogue__name", text: "MICROPHONE" }),
        el("div", {
          className: "dialogue__body",
          text: "Privacy Village will ask your browser for microphone access so nearby players can hear you. Your mic starts muted either way — press V or M again to talk.",
        }),
        el("div", { className: "dialogue__continue", text: "GOT IT", style: { cursor: "pointer" }, on: { click: () => this.confirmPermissionPrompt() } }),
      ],
    );
    document.getElementById("ui-root")!.appendChild(this.promptEl);

    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.promptEl.remove());
  }

  /** Room.ts folds this into its own otherUiOpen computation, same as
   * every other overlay (NPC dialogue, Academy, chat, ...) — so WASD/
   * other hotkeys stay locked while the explanation is up, same as any
   * other modal-ish interruption in this game. */
  get isShowingPermissionPrompt(): boolean {
    return this.promptOpen;
  }

  /** Called every frame from Room.ts's update(), same tier as
   * net.pollPlayers()/remotePlayers.update(). */
  update(_playerX: number, _playerY: number, uiOpen: boolean) {
    if (!this.connectedThisScene) {
      const sessionId = net.getSessionId();
      if (sessionId) {
        this.connectedThisScene = true;
        void voice.connectToScene(this.sceneName, sessionId, getSession().name);
      }
    }

    // Checked unconditionally (not gated by !uiOpen below) — otherwise
    // holding V, then opening some other overlay (e.g. pressing E near
    // an NPC) mid-hold would skip the release check on the one frame it
    // needed to fire, leaving the mic stuck "held" open until the next
    // full press/release cycle. A level check every frame self-corrects
    // regardless of which frames got gated out from under it.
    if (voice.pushToTalkHeld && !this.pushToTalkKey.isDown) {
      voice.endPushToTalk();
    }

    // §2 "The Gathering" emote hotkeys use this same !uiOpen tier —
    // V/M sit alongside them, not above (no reason a chat box or the
    // Academy should let voice hotkeys leak through either).
    if (!uiOpen) {
      if (Phaser.Input.Keyboard.JustDown(this.muteToggleKey)) this.handleMuteToggle();
      if (Phaser.Input.Keyboard.JustDown(this.pushToTalkKey)) this.handlePushToTalkDown();
    }
  }

  private handleMuteToggle() {
    if (voice.permissionState === "unasked") {
      this.showPermissionPrompt("mute-toggle");
      return;
    }
    voice.setMode(voice.mode === "muted" ? "open-mic" : "muted");
  }

  private handlePushToTalkDown() {
    if (voice.permissionState === "unasked") {
      this.showPermissionPrompt("push-to-talk");
      return;
    }
    voice.beginPushToTalk();
  }

  /** Shown the first time V/M is pressed with permissionState still
   * "unasked" — the confirming click is what actually calls
   * voice.requestMicPermission() (which is what triggers the browser's
   * own mic prompt), then replays whichever action the player originally
   * pressed, so they don't need to press V/M a second time. For push-to-
   * talk specifically, only resumes if V is still physically held at
   * confirm time (the player may well have let go while reaching for the
   * mouse) — the unconditional release check in update() already
   * guarantees correctness either way. */
  private showPermissionPrompt(action: "mute-toggle" | "push-to-talk") {
    this.pendingAction = action;
    this.promptOpen = true;
    this.promptEl.style.display = "block";
  }

  private async confirmPermissionPrompt() {
    const action = this.pendingAction;
    this.pendingAction = null;
    this.promptOpen = false;
    this.promptEl.style.display = "none";

    const granted = await voice.requestMicPermission();
    if (!granted) return;

    if (action === "mute-toggle") voice.setMode(voice.mode === "muted" ? "open-mic" : "muted");
    else if (action === "push-to-talk" && this.pushToTalkKey.isDown) voice.beginPushToTalk();
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
