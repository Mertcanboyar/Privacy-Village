// Sound-effect hook points for the Title/CharacterCreate flow (Day 1)
// and the quest engine (Day 3, see PLAN.md Phase 2). No audio assets
// exist in this project yet — this is intentionally a no-op so the
// trigger points already live in the right places and wiring in real
// SFX later is a one-line change here, not a hunt through the scenes.

export type SoundId = "select" | "confirm" | "dice" | "quill-scratch" | "chime" | "fanfare";

export function playSound(_id: SoundId) {
  // No-op until audio assets are sourced.
}

// Per-NPC dialogue "blip" pitch (each character has a distinct pitch on
// a shared blip sound, a la Animal Crossing). No-op for the same reason
// as playSound — the npcId is threaded through now so wiring in a real
// pitch-per-character map later doesn't require touching npc.ts.
export function playBlip(_npcId: string) {
  // No-op until audio assets are sourced.
}

// Ducks background/ambient audio to 30% while a full-screen overlay (the
// Academy) is open. No-op for the same reason as playSound/playBlip.
export function duckAudio(_active: boolean) {
  // No-op until audio assets are sourced.
}
