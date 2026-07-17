import Phaser from "phaser";
import { duckAudio } from "./audio";

// Framework-free module singleton for Academy state — open/closed flag
// now, per-module theory/field progress once the data model lands (see
// PLAN.md "The Academy"). Same style as questEngine.ts/session.ts: a
// plain class extending Phaser.Events.EventEmitter so the Scene-bound
// DOM UI (academyOverlay.ts) can react without this module depending on
// any Scene. Room.ts checks `academy.isOpen` directly to lock player
// movement, exactly like it already imports questEngine directly.
class AcademyManager extends Phaser.Events.EventEmitter {
  private open_ = false;

  get isOpen(): boolean {
    return this.open_;
  }

  open() {
    if (this.open_) return;
    this.open_ = true;
    duckAudio(true);
    this.emit("opened");
  }

  close() {
    if (!this.open_) return;
    this.open_ = false;
    duckAudio(false);
    this.emit("closed");
  }

  toggle() {
    if (this.open_) this.close();
    else this.open();
  }
}

export const academy = new AcademyManager();
