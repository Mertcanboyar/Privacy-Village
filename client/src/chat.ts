import Phaser from "phaser";
import { el } from "./ui/dom";

// Local room chat — see net/NetClient.ts's sendChat()/onChat() and
// server/src/rooms/SceneRoom.ts's "chat" message handler. This class
// owns only the input box and the ENTER-to-open/submit/cancel flow;
// Room.ts owns rendering the actual speech bubbles (it already owns
// the local player sprite/name tag those bubbles float above), and
// net/remotePlayers.ts owns everyone else's.

const CHAT_MAX_LEN = 120;

export class ChatController {
  private enterKey: Phaser.Input.Keyboard.Key;
  private inputEl: HTMLInputElement;
  private open = false;
  private onSend: (text: string) => void;
  private resetMovementKeys: () => void;

  constructor(scene: Phaser.Scene, onSend: (text: string) => void, resetMovementKeys: () => void) {
    this.onSend = onSend;
    this.resetMovementKeys = resetMovementKeys;
    this.enterKey = scene.input.keyboard!.addKey("ENTER");

    this.inputEl = el("input", {
      attrs: { type: "text", placeholder: "Say something…", maxlength: String(CHAT_MAX_LEN), autocomplete: "off" },
      style: {
        position: "absolute",
        left: "50%",
        bottom: "24px",
        transform: "translateX(-50%)",
        width: "360px",
        fontFamily: "var(--font-mono)",
        fontSize: "14px",
        padding: "8px 12px",
        borderRadius: "var(--radius-sm)",
        border: "2px solid var(--border-strong)",
        background: "var(--bg-raised)",
        color: "var(--text-primary)",
        pointerEvents: "auto",
        display: "none",
      },
      on: {
        // A focused DOM input doesn't stop keydown events from bubbling
        // up to Phaser's window-level listeners on its own — without
        // stopPropagation, every letter typed here would also move the
        // player (WASD) or pop an NPC dialogue open (E) mid-sentence.
        keydown: (e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            this.submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            this.close();
          }
        },
        // Covers every other way the box loses focus without an
        // explicit Enter/Escape (clicking the game canvas, Tab, etc.) —
        // without this the input could be left open-but-unfocused,
        // silently eating the next ENTER press as "close" instead of
        // "open a new message".
        blur: () => this.close(),
      },
    });
    document.getElementById("ui-root")!.appendChild(this.inputEl);

    // scene.restart() (room transitions) tears this controller down and
    // Room.create() builds a fresh one — same cleanup pattern npc.ts and
    // quest.ts already use for their own #ui-root DOM nodes.
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.inputEl.remove());
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Call once per frame. `otherUiOpen` covers every other overlay this
   * scene already tracks (NPC dialogue, quest desk, Academy, Events,
   * uiLock) — chat should never pop open underneath one of those. Once
   * open, the input's own listeners drive submit/cancel; there is
   * nothing else for this to poll. */
  update(otherUiOpen: boolean) {
    if (this.open || otherUiOpen) return;
    if (Phaser.Input.Keyboard.JustDown(this.enterKey)) this.openBox();
  }

  private openBox() {
    this.open = true;
    // A movement key held down at the exact moment ENTER is pressed
    // would otherwise read as still "down" (Phaser never sees its
    // keyup, since that event gets swallowed once focus — and this
    // input's stopPropagation — take over) and keep sliding the player
    // after the box closes.
    this.resetMovementKeys();
    this.inputEl.value = "";
    this.inputEl.style.display = "block";
    this.inputEl.focus();
  }

  private submit() {
    const text = this.inputEl.value.trim().slice(0, CHAT_MAX_LEN);
    this.close();
    if (text) this.onSend(text);
  }

  private close() {
    if (!this.open) return;
    this.open = false;
    this.inputEl.style.display = "none";
    this.inputEl.blur();
  }
}
