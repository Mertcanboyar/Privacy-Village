import Phaser from "phaser";
import type { RemoteTrack } from "livekit-client";
import { voice } from "../voice";
import { net } from "./NetClient";
import { getSession } from "../session";
import { el } from "../ui/dom";
import { logStageSpeakerStarted, logStageSpeakerEnded } from "../instrumentation";
import type { RoomName } from "../rooms";
import type { RemotePlayerController } from "./remotePlayers";
import type { ChatLogController } from "../chatLog";

export interface StageZone {
  x: number;
  y: number;
  radius: number;
}

// Max simultaneous stage broadcasters — see the class doc comment below
// for the tie-break rule this enforces.
const MAX_STAGE_SPEAKERS = 2;

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
// time permission-explanation prompt, the Web Audio spatial graph and
// stage-occupancy logic, and (in a later commit) selective-subscription
// bandwidth management. Permission/mode/device/volume state lives in
// voice.ts instead, since
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

  // §4 "Stage broadcast mode" — the tavern's existing "stage" zone (see
  // Room.ts's own isPlayerOnZone(), already used for stage-styled chat)
  // also broadcasts voice: full volume, centre pan, heard scene-wide,
  // for up to MAX_STAGE_SPEAKERS occupants. null in every room without
  // one (isPositionOnZone() below reads null as "never on stage").
  private stageZone: StageZone | null;
  private stageSpeakers: string[] = [];
  // Rising-edge guard for the "stage is full" toast — reset the moment
  // the local player leaves the zone, so stepping off and back on can
  // show it again (it's genuinely still full), but standing there
  // doesn't spam it every tick.
  private stageFullToastShown = false;
  private localStageSpeakerStartedAt: number | null = null;

  // Bound once so voice.off() in destroy() can actually remove the same
  // function reference these were registered with.
  private onTrackSubscribed = (sessionId: string, track: RemoteTrack) => this.buildAudioGraph(sessionId, track);
  private onTrackUnsubscribed = (sessionId: string) => this.teardownAudioGraph(sessionId);

  constructor(
    scene: Phaser.Scene,
    sceneName: RoomName,
    remotePlayers: RemotePlayerController,
    chatLog: ChatLogController,
    stageZone: StageZone | null,
  ) {
    this.sceneName = sceneName;
    this.remotePlayers = remotePlayers;
    this.chatLog = chatLog;
    this.stageZone = stageZone;
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

  private isPositionOnZone(zone: StageZone | null, x: number, y: number): boolean {
    if (!zone) return false;
    return Phaser.Math.Distance.Between(x, y, zone.x, zone.y) < zone.radius;
  }

  /** True while the local player is one of the (at most
   * MAX_STAGE_SPEAKERS) current stage broadcasters — Room.ts reads this
   * every frame to toggle the local player's own stage ring. */
  get localIsStageSpeaker(): boolean {
    const sessionId = net.getSessionId();
    return !!sessionId && this.stageSpeakers.includes(sessionId);
  }

  /** The 10Hz tick — recomputes stage occupancy (independent of whether
   * anyone's audio is actually subscribed yet — the toast/instrumentation
   * below care about zone occupancy on their own) and every subscribed
   * remote participant's gain/pan, stage speakers overridden to full
   * volume/centre pan regardless of distance. */
  private recomputeSpatialAudio(playerX: number, playerY: number) {
    const positions = new Map(this.remotePlayers.getAllPositions().map((p) => [p.sessionId, p]));
    this.updateStageOccupancy(playerX, playerY, positions);

    if (this.audioGraphs.size === 0) return;
    const audioContext = voice.getAudioContext();

    for (const [sessionId, graph] of this.audioGraphs) {
      const pos = positions.get(sessionId);
      if (!pos) continue; // they've left this scene's RemotePlayerController but haven't unsubscribed yet

      const isStageSpeaker = this.stageSpeakers.includes(sessionId);
      const dx = pos.x - playerX;
      const dy = pos.y - playerY;
      const distance = Math.hypot(dx, dy);

      let targetGain = isStageSpeaker
        ? 1
        : distance <= FULL_VOLUME_PX
          ? 1
          : distance >= SILENT_PX
            ? 0
            : 1 - (distance - FULL_VOLUME_PX) / (SILENT_PX - FULL_VOLUME_PX);
      targetGain *= voice.outputVolumeMultiplier;
      if (this.chatLog.isMuted(sessionId)) targetGain = 0;
      const targetPan = isStageSpeaker ? 0 : clamp(dx / PAN_CLAMP_PX, -1, 1);

      graph.gainNode.gain.setTargetAtTime(targetGain, audioContext.currentTime, RAMP_TIME_CONSTANT);
      graph.pannerNode.pan.setTargetAtTime(targetPan, audioContext.currentTime, RAMP_TIME_CONSTANT);
    }
  }

  /** Determines the current (at most MAX_STAGE_SPEAKERS) stage speakers
   * — every occupant of the zone (local + remote), sorted by sessionId
   * so every client's computation agrees, first N win. This is a
   * lexicographic tie-break, not first-come-first-served: a new arrival
   * whose sessionId happens to sort earlier can displace an existing
   * speaker rather than being the one turned away. Acceptable, documented
   * trade-off for a demo-scale (~10-20 person) live event — matches the
   * existing precedent that stage-chat's own "stage" flag
   * (SceneRoom.ts) is already client-computed and server-trusted, not
   * enforced. A real fix, if this ever needs it, is a small server-side
   * reservation list — not built now. */
  private updateStageOccupancy(playerX: number, playerY: number, positions: Map<string, { x: number; y: number }>) {
    const localSessionId = net.getSessionId();
    const localOnStage = this.isPositionOnZone(this.stageZone, playerX, playerY);

    const occupants: string[] = [];
    if (localOnStage && localSessionId) occupants.push(localSessionId);
    for (const [sessionId, pos] of positions) {
      if (this.isPositionOnZone(this.stageZone, pos.x, pos.y)) occupants.push(sessionId);
    }
    occupants.sort();
    this.stageSpeakers = occupants.slice(0, MAX_STAGE_SPEAKERS);
    this.remotePlayers.setStageSpeakers(this.stageSpeakers);

    if (!localOnStage) {
      this.stageFullToastShown = false;
    } else if (!this.localIsStageSpeaker && !this.stageFullToastShown) {
      this.stageFullToastShown = true;
      voice.emit("toast", "The stage is full.");
    }

    if (this.localIsStageSpeaker && this.localStageSpeakerStartedAt === null) {
      this.localStageSpeakerStartedAt = Date.now();
      logStageSpeakerStarted(this.sceneName);
    } else if (!this.localIsStageSpeaker && this.localStageSpeakerStartedAt !== null) {
      const seconds = Math.round((Date.now() - this.localStageSpeakerStartedAt) / 1000);
      this.localStageSpeakerStartedAt = null;
      logStageSpeakerEnded(this.sceneName, seconds);
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
