import type Phaser from "phaser";

// Sound-effect hook points for the Title/CharacterCreate flow (Day 1)
// and the quest engine (Day 3, see PLAN.md Phase 2). No sound-effect
// assets exist in this project yet — this is intentionally a no-op so
// the trigger points already live in the right places and wiring in
// real SFX later is a one-line change here, not a hunt through the
// scenes.

export type SoundId = "select" | "confirm" | "dice" | "quill-scratch" | "chime" | "fanfare" | "alarm-bell";

export function playSound(_id: SoundId) {
  // No-op until SFX assets are sourced.
}

// Per-NPC dialogue "blip" pitch (each character has a distinct pitch on
// a shared blip sound, a la Animal Crossing). No-op for the same reason
// as playSound — the npcId is threaded through now so wiring in a real
// pitch-per-character map later doesn't require touching npc.ts.
export function playBlip(_npcId: string) {
  // No-op until SFX assets are sourced.
}

// --- Background music --------------------------------------------------
// A single looping track, started once from Title.ts (the first real
// screen after Preload's loading bar) and left running for the rest of
// the session — Phaser's sound manager is global to the Game instance,
// not per-Scene, so a Sound object created here keeps playing across
// every later scene.start()/restart() without any extra wiring.

const MUSIC_VOLUME = 0.35;
const MUSIC_DUCK_VOLUME = MUSIC_VOLUME * 0.3;

let music: Phaser.Sound.WebAudioSound | Phaser.Sound.HTML5AudioSound | null = null;
let musicMuted = false;
let musicDucked = false;

/** Starts the background music loop. Safe to call more than once (e.g.
 * if Title ever re-runs) — a second call is a no-op since `music` is
 * already set. */
export function initMusic(scene: Phaser.Scene) {
  if (music) return;
  music = scene.sound.add("bgm", { loop: true, volume: MUSIC_VOLUME }) as Phaser.Sound.WebAudioSound;
  music.play();
}

function applyMusicVolume() {
  if (!music) return;
  music.volume = musicDucked ? MUSIC_DUCK_VOLUME : MUSIC_VOLUME;
}

export function isMusicMuted(): boolean {
  return musicMuted;
}

/** Flips the mute state and returns the new value — used by the HUD's
 * sound-toggle button. No-ops safely if the music hasn't started yet
 * (shouldn't happen once Title has run, but avoids a null crash either
 * way). */
export function toggleMusic(): boolean {
  musicMuted = !musicMuted;
  if (music) music.mute = musicMuted;
  return musicMuted;
}

// Ducks background music to 30% while a full-screen overlay (the
// Academy, the Events panel) is open, restoring it on close — already
// wired up as the call site in academy.ts/events.ts, this just makes it
// real now that actual music exists.
export function duckAudio(active: boolean) {
  musicDucked = active;
  applyMusicVolume();
}
