import Phaser from "phaser";
import type { RoomName } from "./rooms";
import { el } from "./ui/dom";

// The Courthouse desk used to run the "Personal Data Classification Lab"
// in-world (drag-and-drop GDPR scenarios, a badge, Clearance 5 — see git
// history on this file for that implementation). That content has moved
// to the Academy's "Personal Data or Not?" card drill (see academy.ts /
// academyOverlay.ts) — this is now a pure signpost pointing the player
// there, no quest state, no points.

const DESK_POSITION: [number, number] = [990, 580];
const DESK_INTERACT_RADIUS = 100;
const FLAVOR_LINE = "The tome's lesson has been moved to the Academy archives.";

export class QuestController {
  private active: boolean;
  private eKey: Phaser.Input.Keyboard.Key;
  private promptText: Phaser.GameObjects.Text;
  private messageEl: HTMLElement;
  private open_ = false;

  constructor(scene: Phaser.Scene, roomName: RoomName) {
    this.active = roomName === "courthouse";
    this.eKey = scene.input.keyboard!.addKey("E");

    this.promptText = scene.add
      .text(DESK_POSITION[0], DESK_POSITION[1] - 40, "[E] Examine the tome", {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "14px",
        color: "#f0b429",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(100001)
      .setVisible(false);

    this.messageEl = el(
      "div",
      {
        className: "dialogue ds-root",
        style: { position: "absolute", left: "60px", right: "60px", bottom: "30px", pointerEvents: "auto", display: "none" },
      },
      [
        el("div", { className: "dialogue__name", text: "THE TOME" }),
        el("div", { className: "dialogue__body", text: FLAVOR_LINE }),
        el("div", { className: "dialogue__continue", text: "[E] Close" }),
      ],
    );
    document.getElementById("ui-root")!.appendChild(this.messageEl);

    // scene.restart() (room transitions) tears down this controller and
    // builds a fresh one — without this, the old instance's DOM node
    // would never be removed from #ui-root.
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.messageEl.remove();
    });
  }

  get dialogueOpen(): boolean {
    return this.open_;
  }

  update(playerX: number, playerY: number) {
    if (!this.active) return;

    if (this.open_) {
      if (Phaser.Input.Keyboard.JustDown(this.eKey)) this.close();
      return;
    }

    const dist = Phaser.Math.Distance.Between(playerX, playerY, DESK_POSITION[0], DESK_POSITION[1]);
    if (dist < DESK_INTERACT_RADIUS) {
      this.promptText.setVisible(true);
      if (Phaser.Input.Keyboard.JustDown(this.eKey)) this.open();
    } else {
      this.promptText.setVisible(false);
    }
  }

  private open() {
    this.open_ = true;
    this.promptText.setVisible(false);
    this.messageEl.style.display = "block";
  }

  private close() {
    this.open_ = false;
    this.messageEl.style.display = "none";
  }
}
