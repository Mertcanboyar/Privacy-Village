import Phaser from "phaser";
import { Room as LKRoom, RoomEvent, Track, isBrowserSupported, type LocalTrackPublication, type Participant } from "livekit-client";
import type { RoomName } from "./rooms";
import { logVoicePermissionGranted, logVoicePermissionDenied, logVoiceMinutes } from "./instrumentation";

// Framework-free module singleton for spatial voice chat's persistent
// half (see PLAN — Spatial Voice Chat) — same style as academy.ts/
// questEngine.ts: a plain class extending Phaser.Events.EventEmitter so
// hud.ts/voiceSettingsPanel.ts can react without depending on any Scene.
// This is the ONLY module that touches the LiveKit Room/Participant
// objects directly — client/src/net/voiceSpatial.ts (the per-scene
// spatial-audio controller, built separately) only ever calls into this
// module's public API and listens to its events, exactly like Room.ts
// never reaches into colyseus.js's Room object directly either (it goes
// through net/NetClient.ts).
//
// Survives scene.restart() because it's a plain module-level singleton,
// same reason net (NetClient) does — permission/device/mode/volume
// choices are session-scoped preferences, not per-room state, so they
// must outlive a door transition even though the underlying LiveKit
// Room connection itself is torn down and rebuilt on every one (see
// connectToScene()/disconnectFromScene(), called from Room.ts's
// multiplayer wiring block and checkDoors(), mirroring net.connect()/
// net.disconnect() exactly).

const TOKEN_ENDPOINT = "/api/livekit-token";
const LIVEKIT_URL_ENV: string | undefined = import.meta.env.VITE_LIVEKIT_URL;

export type VoicePermissionState = "unasked" | "granted" | "denied" | "unsupported";
export type VoiceMode = "muted" | "open-mic";
export type VoiceConnectionState = "disconnected" | "connecting" | "connected" | "error";

class VoiceManager extends Phaser.Events.EventEmitter {
  private room: LKRoom | null = null;
  private audioContext: AudioContext | null = null;

  private permissionState_: VoicePermissionState = "unasked";
  private mode_: VoiceMode = "muted";
  private pushToTalkHeld_ = false;
  private connectionState_: VoiceConnectionState = "disconnected";

  private outputVolumeMultiplier_ = 1;

  // Set the instant transmission actually starts (unmute), cleared and
  // flushed to logVoiceMinutes() the instant it stops — see
  // applyTransmitState(). A session's own start/stop boundaries are
  // already the aggregation windows that matter, so this needs no
  // separate periodic timer.
  private transmitStartedAt: number | null = null;

  // Bumped on every connectToScene() call and captured by that call's
  // own closure — an in-flight connect racing a subsequent
  // disconnectFromScene()/reconnect (e.g. a fast double door transition)
  // checks this before applying its result, same guard shape as
  // NetClient's own connectToken.
  private connectToken = 0;

  get permissionState(): VoicePermissionState {
    return this.permissionState_;
  }

  get mode(): VoiceMode {
    return this.mode_;
  }

  get pushToTalkHeld(): boolean {
    return this.pushToTalkHeld_;
  }

  /** What the HUD mic button should actually display — collapses the 2
   * persistent booleans (mode) + 1 transient one (pushToTalkHeld) into
   * the ticket's 3 display states. */
  get displayState(): "muted" | "open-mic" | "push-to-talk-held" {
    if (this.pushToTalkHeld_) return "push-to-talk-held";
    return this.mode_;
  }

  get connectionState(): VoiceConnectionState {
    return this.connectionState_;
  }

  get outputVolumeMultiplier(): number {
    return this.outputVolumeMultiplier_;
  }

  getRoom(): LKRoom | null {
    return this.room;
  }

  /** Lazily created on first use (an AudioContext must originate from a
   * user gesture, so creating it at module-load time would be wasted —
   * and on some browsers, blocked/suspended until one occurs anyway). */
  getAudioContext(): AudioContext {
    if (!this.audioContext) this.audioContext = new AudioContext();
    return this.audioContext;
  }

  /** Resolves the browser's own mic permission prompt — called once,
   * the first time the player presses V or M with permissionState
   * "unasked" (see voiceSpatial.ts's showPermissionExplanation flow;
   * this method itself does NOT show any UI, it's the "Got it" button's
   * confirm action). Publishes the local mic track via LiveKit (which
   * internally triggers getUserMedia) then immediately mutes it back
   * down — resting state after grant is always "published but muted,"
   * never actively transmitting, matching "join muted, no exceptions."
   * Returns whether the caller should proceed with the action that
   * triggered this (setMode()/beginPushToTalk()). */
  async requestMicPermission(): Promise<boolean> {
    if (this.permissionState_ === "granted") return true;
    if (this.permissionState_ === "denied" || this.permissionState_ === "unsupported") return false;

    if (!isBrowserSupported()) {
      this.permissionState_ = "unsupported";
      this.emit("micStateChanged");
      return false;
    }

    if (!this.room) {
      // Extremely unlikely in practice (connectToScene() fires within a
      // second or two of scene load, well before a player could react
      // and press V/M) but handled rather than silently swallowed — see
      // this.room's own doc comment for why voice never blocks the game
      // either way. Deliberately leaves permissionState at "unasked"
      // (nothing about mic permission itself was decided) so the player
      // can just try again in a moment.
      this.emit("toast", "Voice isn't connected yet — try again in a moment.");
      return false;
    }

    try {
      const pub = await this.room.localParticipant.setMicrophoneEnabled(true);
      await pub?.mute();
      this.permissionState_ = "granted";
      logVoicePermissionGranted();
      this.emit("micStateChanged");
      return true;
    } catch (err) {
      console.warn("[voice] mic permission denied or failed:", err);
      this.permissionState_ = "denied";
      logVoicePermissionDenied();
      this.emit("toast", "Microphone access was denied — you can still use text chat.");
      this.emit("micStateChanged");
      return false;
    }
  }

  /** Two persistent states, toggled by M — see beginPushToTalk()/
   * endPushToTalk() for the third, transient, V-held state. No-ops
   * (returns without changing anything) unless permission is already
   * granted — voiceSpatial.ts is responsible for calling
   * requestMicPermission() first and only calling this once that
   * resolves true. */
  setMode(mode: VoiceMode) {
    if (this.permissionState_ !== "granted") return;
    this.mode_ = mode;
    this.applyTransmitState();
    this.emit("micStateChanged");
  }

  beginPushToTalk() {
    if (this.permissionState_ !== "granted") return;
    this.pushToTalkHeld_ = true;
    this.applyTransmitState();
    this.emit("micStateChanged");
  }

  endPushToTalk() {
    this.pushToTalkHeld_ = false;
    this.applyTransmitState();
    this.emit("micStateChanged");
  }

  /** The single place that reconciles mode_/pushToTalkHeld_ with the
   * actual LiveKit track mute state — called after every state change
   * above, so the local mic publication's mute state is always exactly
   * "shouldTransmit ? unmuted : muted," never drifts. */
  private applyTransmitState() {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone) as LocalTrackPublication | undefined;
    if (!pub) return;
    const shouldTransmit = this.pushToTalkHeld_ || this.mode_ === "open-mic";
    if (shouldTransmit && pub.isMuted) {
      void pub.unmute();
      this.transmitStartedAt = Date.now();
    } else if (!shouldTransmit && !pub.isMuted) {
      void pub.mute();
      this.flushVoiceMinutes();
    }
  }

  private flushVoiceMinutes() {
    if (this.transmitStartedAt === null) return;
    const seconds = Math.round((Date.now() - this.transmitStartedAt) / 1000);
    this.transmitStartedAt = null;
    if (seconds > 0) logVoiceMinutes(seconds);
  }

  /** Called once per scene, from Room.ts's multiplayer wiring block,
   * once net.getSessionId() is non-null (i.e. after Colyseus has already
   * connected — see PLAN's identity-scheme decision: the LiveKit
   * participant identity IS the Colyseus sessionId, so this can't run
   * before that exists). No-ops quietly on any failure — same "garnish,
   * never a dependency" rule NetClient.ts already follows; if voice
   * can't connect, the game is unaffected and just has no voice this
   * scene. */
  async connectToScene(sceneName: RoomName, sessionId: string, displayName: string): Promise<void> {
    await this.disconnectFromScene();
    const token = ++this.connectToken;

    if (!LIVEKIT_URL_ENV) {
      console.warn("[voice] VITE_LIVEKIT_URL not set — voice chat unavailable this session.");
      return;
    }

    this.connectionState_ = "connecting";
    this.emit("connectionStateChanged", this.connectionState_);

    try {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, name: displayName, sceneId: sceneName }),
      });
      if (!res.ok) throw new Error(`token endpoint returned ${res.status}`);
      const data = (await res.json()) as { ok: boolean; token?: string; url?: string; error?: string };
      if (!data.ok || !data.token || !data.url) throw new Error(data.error ?? "malformed token response");
      if (token !== this.connectToken) return; // superseded by a newer connect/disconnect while awaiting

      const room = new LKRoom();
      this.wireRoomEvents(room);
      await room.connect(data.url, data.token);
      if (token !== this.connectToken) {
        // A disconnect/reconnect raced ahead of us while connect() was
        // in flight — tear this one down rather than leaving it live
        // and unreferenced.
        await room.disconnect();
        return;
      }

      this.room = room;
      this.connectionState_ = "connected";
      this.emit("connectionStateChanged", this.connectionState_);
    } catch (err) {
      if (token !== this.connectToken) return;
      console.warn("[voice] failed to connect:", err);
      this.connectionState_ = "error";
      this.emit("connectionStateChanged", this.connectionState_);
    }
  }

  /** Mirrors net.disconnect() — called from Room.ts's checkDoors() right
   * alongside it, and from the SHUTDOWN handler as a safety net (this is
   * idempotent, so double-calling across both call sites on the same
   * transition is harmless). */
  async disconnectFromScene(): Promise<void> {
    this.connectToken++;
    this.flushVoiceMinutes();
    const room = this.room;
    this.room = null;
    if (this.connectionState_ !== "disconnected") {
      this.connectionState_ = "disconnected";
      this.emit("connectionStateChanged", this.connectionState_);
    }
    if (!room) return;
    try {
      await room.disconnect();
    } catch (err) {
      console.warn("[voice] error during disconnect (ignored):", err);
    }
  }

  private wireRoomEvents(room: LKRoom) {
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      this.emit(
        "activeSpeakersChanged",
        speakers.map((p) => p.identity),
      );
    });
    room.on(RoomEvent.TrackMuted, (_pub, participant: Participant) => {
      this.emit("participantMicStateChanged", participant.identity, true);
    });
    room.on(RoomEvent.TrackUnmuted, (_pub, participant: Participant) => {
      this.emit("participantMicStateChanged", participant.identity, false);
    });
    room.on(RoomEvent.TrackPublished, (pub, participant: Participant) => {
      if (pub.source === Track.Source.Microphone) this.emit("participantMicStateChanged", participant.identity, pub.isMuted);
    });
    room.on(RoomEvent.TrackUnpublished, (pub, participant: Participant) => {
      if (pub.source === Track.Source.Microphone) this.emit("participantMicStateChanged", participant.identity, null);
    });
    // Forwarded raw (not pre-processed like the events above) — building
    // the Web Audio spatial graph needs the actual RemoteTrack/
    // RemoteTrackPublication objects, so voiceSpatial.ts is the one
    // consumer that legitimately reaches past this module's usual
    // "downstream code never touches LiveKit objects" boundary. Attached
    // here (wireRoomEvents runs before room.connect(), see
    // connectToScene()) rather than voiceSpatial subscribing post-
    // connect, so nothing already-subscribed at join time is missed.
    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (pub.source !== Track.Source.Microphone) return;
      this.emit("trackSubscribed", participant.identity, track);
    });
    room.on(RoomEvent.TrackUnsubscribed, (_track, pub, participant) => {
      if (pub.source !== Track.Source.Microphone) return;
      this.emit("trackUnsubscribed", participant.identity);
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room) return; // already superseded, ignore stale event
      this.flushVoiceMinutes();
      this.room = null;
      this.connectionState_ = "disconnected";
      this.emit("connectionStateChanged", this.connectionState_);
    });
  }
}

export const voice = new VoiceManager();
