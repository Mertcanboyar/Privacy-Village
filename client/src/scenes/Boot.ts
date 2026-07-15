import Phaser from "phaser";

export class Boot extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  create() {
    this.scene.start("Preload");
  }
}
