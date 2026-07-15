import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../config";

// Shared ambient-drift backdrop for Title/CharacterCreate (see PLAN.md
// Phase 2, Day 1) — reuses the already-loaded village background rather
// than new art, slowly panned to feel alive behind the DOM UI.

const DRIFT_SCALE = 1.15;
const DRIFT_DISTANCE_X = 60;
const DRIFT_DISTANCE_Y = 30;
const DRIFT_DURATION_MS = 9000;

export function addDriftingBackground(scene: Phaser.Scene): Phaser.GameObjects.Image {
  const bg = scene.add
    .image(GAME_WIDTH / 2, GAME_HEIGHT / 2, "room-bg-village")
    .setOrigin(0.5)
    .setDisplaySize(GAME_WIDTH * DRIFT_SCALE, GAME_HEIGHT * DRIFT_SCALE);

  scene.tweens.add({
    targets: bg,
    x: GAME_WIDTH / 2 + DRIFT_DISTANCE_X,
    y: GAME_HEIGHT / 2 - DRIFT_DISTANCE_Y,
    duration: DRIFT_DURATION_MS,
    yoyo: true,
    repeat: -1,
    ease: "Sine.easeInOut",
  });

  return bg;
}
