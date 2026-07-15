import Phaser from "phaser";
import { addDriftingBackground } from "./drift";
import { el } from "../ui/dom";
import { playSound } from "../audio";

// Title screen (see PLAN.md Phase 2, Day 1). DOM owns the interactive
// chrome, same Phaser-world/DOM-UI split as everywhere else in this game.

export class Title extends Phaser.Scene {
  private overlayEl!: HTMLElement;

  constructor() {
    super("Title");
  }

  create() {
    addDriftingBackground(this);

    this.overlayEl = el(
      "div",
      {
        className: "ds-root",
        style: {
          position: "absolute",
          inset: "0",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-end",
          paddingBottom: "96px",
          pointerEvents: "auto",
        },
      },
      [
        el("h1", {
          text: "Privacy Village",
          style: {
            fontFamily: "var(--font-display)",
            fontWeight: "700",
            fontSize: "56px",
            color: "var(--text-primary)",
            textShadow: "0 4px 24px rgba(0, 0, 0, 0.6)",
            margin: "0",
          },
        }),
        el("button", {
          className: "btn btn--gold",
          text: "Enter the Village",
          style: { marginTop: "24px", fontSize: "16px", padding: "16px 32px" },
          on: { click: () => this.enter() },
        }),
      ],
    );
    document.getElementById("ui-root")!.appendChild(this.overlayEl);

    // Starting CharacterCreate stops this scene (SHUTDOWN fires) — same
    // DOM-cleanup pattern as npc.ts/quest.ts, so the title overlay never
    // lingers over later scenes.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.overlayEl.remove());
  }

  private enter() {
    playSound("select");
    this.cameras.main.fadeOut(400, 10, 10, 15);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start("CharacterCreate");
    });
  }
}
