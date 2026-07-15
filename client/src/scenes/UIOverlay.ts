import Phaser from "phaser";
import { HUDController } from "../hud";

// HUD scene, runs in parallel with Room — launched once from
// CharacterCreate and never scene.restart()'d on room transitions,
// which is exactly why the persistent XP bar/quest tracker/toast stack
// (see PLAN.md Phase 2, Day 3) live here rather than in Room.ts.
export class UIOverlay extends Phaser.Scene {
  private hud!: HUDController;

  constructor() {
    super("UIOverlay");
  }

  create() {
    this.add
      .text(12, 12, "PRIVACY VILLAGE — DEV BUILD", {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "14px",
        color: "#9aa0b5",
      })
      .setScrollFactor(0);

    this.hud = new HUDController(this);
  }

  update() {
    this.hud.update();
  }
}
