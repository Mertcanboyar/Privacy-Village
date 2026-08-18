import Phaser from "phaser";
import type { RoomName } from "./rooms";
import { el } from "./ui/dom";
import { gathering } from "./gathering";
import { logEventBoardOpened } from "./instrumentation";

// §2 "The Gathering" (see PLAN.md) — the Tavern's event board, a direct
// copy of quest.ts's QuestController shape (fixed position, [E] prompt,
// DOM panel), pointed at gathering.ts instead of static flavor text.

const BOARD_POSITION: [number, number] = [350, 480];
const BOARD_INTERACT_RADIUS = 100;

export class EventBoardController {
  private active: boolean;
  private eKey: Phaser.Input.Keyboard.Key;
  private promptText: Phaser.GameObjects.Text;
  private panelEl: HTMLElement;
  private titleEl: HTMLElement;
  private metaEl: HTMLElement;
  private descriptionEl: HTMLElement;
  private linkEl: HTMLElement;
  private open_ = false;

  constructor(scene: Phaser.Scene, roomName: RoomName) {
    this.active = roomName === "tavern";
    this.eKey = scene.input.keyboard!.addKey("E");

    this.promptText = scene.add
      .text(BOARD_POSITION[0], BOARD_POSITION[1] - 40, "[E] Read the event board", {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "14px",
        color: "#f0b429",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(100001)
      .setVisible(false);

    this.titleEl = el("div", { className: "briefing__title" });
    this.metaEl = el("div", { style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" } });
    this.descriptionEl = el("div", { className: "dialogue__body", style: { marginTop: "12px" } });
    this.linkEl = el("a", {
      className: "btn btn--primary",
      text: "JOIN THE CALL",
      style: { display: "none", marginTop: "16px", textDecoration: "none", textAlign: "center" },
      attrs: { target: "_blank", rel: "noopener noreferrer" },
    });

    this.panelEl = el(
      "div",
      {
        className: "panel panel--glow ds-root",
        style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "440px", pointerEvents: "auto", display: "none" },
      },
      [
        el("div", { className: "dialogue__name", text: "THE EVENT BOARD" }),
        this.titleEl,
        this.metaEl,
        this.descriptionEl,
        this.linkEl,
        el("div", { className: "dialogue__continue", text: "[E] Close", style: { marginTop: "16px" } }),
      ],
    );
    document.getElementById("ui-root")!.appendChild(this.panelEl);

    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.panelEl.remove();
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

    const dist = Phaser.Math.Distance.Between(playerX, playerY, BOARD_POSITION[0], BOARD_POSITION[1]);
    if (dist < BOARD_INTERACT_RADIUS) {
      this.promptText.setVisible(true);
      if (Phaser.Input.Keyboard.JustDown(this.eKey)) this.open();
    } else {
      this.promptText.setVisible(false);
    }
  }

  private open() {
    this.open_ = true;
    this.promptText.setVisible(false);

    const current = gathering.getCurrent();
    if (current) {
      this.titleEl.textContent = current.title;
      this.metaEl.textContent = `Hosted by ${current.host} — ${new Date(current.startsAt).toLocaleString()}`;
      this.descriptionEl.textContent = current.description;
      if (current.externalLink) {
        (this.linkEl as HTMLAnchorElement).href = current.externalLink;
        this.linkEl.style.display = "block";
      } else {
        this.linkEl.style.display = "none";
      }
    } else {
      this.titleEl.textContent = "No gathering scheduled";
      this.metaEl.textContent = "";
      this.descriptionEl.textContent = "Check back later — nothing's on the board right now.";
      this.linkEl.style.display = "none";
    }

    this.panelEl.style.display = "block";
    logEventBoardOpened();
  }

  private close() {
    this.open_ = false;
    this.panelEl.style.display = "none";
  }
}
