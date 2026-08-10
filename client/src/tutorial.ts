import Phaser from "phaser";

// First-visit coach mark — NOT a reusable overlay like Academy/Dossier
// (no hotkey, no re-open button, no persisted server-side state). Shown
// once, right after Room.ts bootstraps the "arrival" quest for a
// genuinely fresh player (see Room.create()'s `if (this.roomName ===
// "village")` block) — explains WASD movement, the [E] interact key,
// and points at the quest tracker. A localStorage flag (not server
// state — this is UX polish, not progress) keeps it from reappearing
// on a guest's next page load; framework-free EventEmitter singleton,
// same pattern as questEngine.ts/academy.ts/dossier.ts, so
// tutorialOverlay.ts can react without this module depending on any
// Scene.

const STORAGE_KEY = "pv_tutorial_seen";

class TutorialManager extends Phaser.Events.EventEmitter {
  isOpen = false;

  /** Room.ts checks this (alongside the "arrival" quest still being
   * locked, i.e. truly the player's first-ever spawn) before calling
   * open(). Defaults to showing the tutorial if localStorage is
   * unavailable (private browsing, etc.) — seeing it once more than
   * strictly necessary is harmless. */
  shouldShow(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) !== "1";
    } catch {
      return true;
    }
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.emit("opened");
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // Nothing to do — worst case the tutorial reappears next session.
    }
    this.emit("closed");
  }
}

export const tutorial = new TutorialManager();
