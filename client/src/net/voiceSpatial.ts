import Phaser from "phaser";
import type { RemoteTrack } from "livekit-client";
import { voice } from "../voice";
import { net } from "./NetClient";
import { getSession } from "../session";
import { el } from "../ui/dom";
import type { RoomName } from "../rooms";
import type { RemotePlayerController } from "./remotePlayers";
import type { ChatLogController } from "../chatLog";

// Hearing radius (§3 of the ticket) — full volume within FULL_VOLUME_PX,
// linear fade to silence at SILENT_PX, 0 beyond that.
const FULL_VOLUME_PX = 150;
const SILENT_PX = 450;
// Pan clamps to [-1, 1] at this many px of x-offset either side.
const PAN_CLAMP_PX = 300;
// setTargetAtTime's timeConstant — ~3x this closes ~95% of the gap to a
// newly-set target, which is the point a listener perceives the
// transition as "done." Solving 3τ ≈ 120ms (the ticket's ramp target)
// gives τ = 0.04s. Used for both gain and pan.
const RAMP_TIME_CONSTANT = 0.04;
// Recompute tick — throttled via Date.now() comparison inside update(),
// matching NetClient.sendMove()'s own idiom (this codebase never uses
// setInterval for gameplay-adjacent logic).
const TICK_INTERVAL_MS = 100; // 10Hz

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface VoiceAudioGraph {
  sourceNode: MediaStreamAudioSourceNode;
  gainNode: GainNode;
  pannerNode: StereoPannerNode;
  // Exists purely to kick off the browser's decode pipeline for the
  // MediaStream — stays permanently muted, never the audible path (that's
  // the Web Audio graph, routed straight to audioContext.destination).
  audioEl: HTMLAudioElement;
}

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
  private remotePlayers: RemotePlayerController;
  private chatLog: ChatLogController;
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

  // The Web Audio spatial graph — one entry per remote participant whose
  // mic track is currently subscribed (see wireTrackEvents()), keyed by
  // sessionId (== LiveKit participant identity, see voice.ts).
  private audioGraphs = new Map<string, VoiceAudioGraph>();
  private lastTickAt = 0;

  // Bound once so voice.off() in destroy() can actually remove the same
  // function reference these were registered with.
  private onTrackSubscribed = (sessionId: string, track: RemoteTrack) => this.buildAudioGraph(sessionId, track);
  private onTrackUnsubscribed = (sessionId: string) => this.teardownAudioGraph(sessionId);

  constructor(scene: Phaser.Scene, sceneName: RoomName, remotePlayers: RemotePlayerController, chatLog: ChatLogController) {
    this.sceneName = sceneName;
    this.remotePlayers = remotePlayers;
    this.chatLog = chatLog;
    this.pushToTalkKey = scene.input.keyboard!.addKey("V");
    this.muteToggleKey = scene.input.keyboard!.addKey("M");

    voice.on("trackSubscribed", this.onTrackSubscribed);
    voice.on("trackUnsubscribed", this.onTrackUnsubscribed);

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
  update(playerX: number, playerY: number, uiOpen: boolean) {
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

    const now = Date.now();
    if (now - this.lastTickAt >= TICK_INTERVAL_MS) {
      this.lastTickAt = now;
      this.recomputeSpatialAudio(playerX, playerY);
    }
  }

  /** The 10Hz tick — recomputes every subscribed remote participant's
   * gain/pan from their current position relative to the local player.
   * Stage-broadcast override (full volume, centre pan, regardless of
   * distance) lands here in a later commit; for now this is pure
   * distance-based falloff. */
  private recomputeSpatialAudio(playerX: number, playerY: number) {
    if (this.audioGraphs.size === 0) return;
    const positions = new Map(this.remotePlayers.getAllPositions().map((p) => [p.sessionId, p]));
    const audioContext = voice.getAudioContext();

    for (const [sessionId, graph] of this.audioGraphs) {
      const pos = positions.get(sessionId);
      if (!pos) continue; // they've left this scene's RemotePlayerController but haven't unsubscribed yet

      const dx = pos.x - playerX;
      const dy = pos.y - playerY;
      const distance = Math.hypot(dx, dy);

      let targetGain =
        distance <= FULL_VOLUME_PX ? 1 : distance >= SILENT_PX ? 0 : 1 - (distance - FULL_VOLUME_PX) / (SILENT_PX - FULL_VOLUME_PX);
      targetGain *= voice.outputVolumeMultiplier;
      if (this.chatLog.isMuted(sessionId)) targetGain = 0;
      const targetPan = clamp(dx / PAN_CLAMP_PX, -1, 1);

      graph.gainNode.gain.setTargetAtTime(targetGain, audioContext.currentTime, RAMP_TIME_CONSTANT);
      graph.pannerNode.pan.setTargetAtTime(targetPan, audioContext.currentTime, RAMP_TIME_CONSTANT);
    }
  }

  /** MediaStreamSource → GainNode → StereoPannerNode → destination, one
   * chain per subscribed remote mic track (see voice.ts's trackSubscribed
   * forwarding). Starts silent/centred — the very next 10Hz tick sets the
   * real gain/pan, same as the reference implementation setting the
   * panner "far away" initially so nothing pops in at full volume for
   * one frame. */
  private buildAudioGraph(sessionId: string, track: RemoteTrack) {
    this.teardownAudioGraph(sessionId); // defensive — a stale graph should never outlive a fresh subscription
    const audioContext = voice.getAudioContext();
    const mediaStream = new MediaStream([track.mediaStreamTrack]);

    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const gainNode = audioContext.createGain();
    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    const pannerNode = audioContext.createStereoPanner();
    pannerNode.pan.setValueAtTime(0, audioContext.currentTime);
    sourceNode.connect(gainNode).connect(pannerNode).connect(audioContext.destination);

    const audioEl = document.createElement("audio");
    audioEl.muted = true;
    audioEl.srcObject = mediaStream;
    void audioEl.play().catch(() => {}); // autoplay can reject before a user gesture; harmless, the graph above is the real path

    this.audioGraphs.set(sessionId, { sourceNode, gainNode, pannerNode, audioEl });
  }

  private teardownAudioGraph(sessionId: string) {
    const graph = this.audioGraphs.get(sessionId);
    if (!graph) return;
    graph.sourceNode.disconnect();
    graph.gainNode.disconnect();
    graph.pannerNode.disconnect();
    graph.audioEl.srcObject = null;
    graph.audioEl.remove();
    this.audioGraphs.delete(sessionId);
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

  /** Torn down on the scene's SHUTDOWN event. Does NOT disconnect the
   * LiveKit Room itself; Room.ts's checkDoors() calls
   * voice.disconnectFromScene() directly, right alongside
   * net.disconnect(), same as this class never owning net's own
   * connection either — this only tears down what THIS instance built:
   * the Web Audio graphs and its own subscriptions on the (persistent)
   * voice singleton, so a fresh scene's VoiceSpatialController doesn't
   * end up with two sets of listeners reacting to the same events. */
  destroy() {
    voice.off("trackSubscribed", this.onTrackSubscribed);
    voice.off("trackUnsubscribed", this.onTrackUnsubscribed);
    for (const sessionId of [...this.audioGraphs.keys()]) this.teardownAudioGraph(sessionId);
  }
}
