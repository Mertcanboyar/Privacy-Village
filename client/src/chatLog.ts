import Phaser from "phaser";
import { el } from "./ui/dom";

// §1 "The Gathering" (see PLAN.md) — the "room chat" half of the spec's
// "proximity chat + room chat, one system": speech bubbles (see
// net/remotePlayers.ts's showBubble()) are the in-world half, this
// scrollable corner log is the persistent half. Own file rather than
// folded into hud.ts since it owns message-list state (not HUD chrome)
// and a public addMessage()/mute API that scenes/Room.ts calls
// directly, same "Scene-scoped controller" shape as ChatController.
const CHAT_LOG_LIMIT = 50;

export interface ChatLogEntry {
  sessionId: string;
  name: string;
  text: string;
  stage: boolean;
  ts: number;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export class ChatLogController {
  private tKey: Phaser.Input.Keyboard.Key;
  private messages: ChatLogEntry[] = [];
  // Local, in-memory only — "client-side mute list" per PLAN.md, never
  // sent anywhere. Keyed by sessionId (ephemeral, resets on reconnect/
  // door transition, same lifecycle as remote sprites themselves —
  // muting someone doesn't persist across scenes, matching how
  // presence itself doesn't). Spatial voice chat (see
  // net/voiceSpatial.ts's recomputeSpatialAudio()) reuses this exact
  // set for voice too, rather than a second parallel list — muting a
  // name here silences both their chat bubbles and their voice.
  private muted = new Set<string>();
  private collapsed = false;

  private rootEl: HTMLElement;
  private listEl: HTMLElement;
  private toggleBtnEl: HTMLElement;

  constructor(scene: Phaser.Scene) {
    this.tKey = scene.input.keyboard!.addKey("T");

    this.listEl = el("div", { style: { display: "flex", flexDirection: "column", gap: "4px", maxHeight: "220px", overflowY: "auto" } });
    this.toggleBtnEl = el("button", {
      className: "btn btn--ghost",
      text: "CHAT [T]",
      style: { fontSize: "11px", padding: "4px 10px", alignSelf: "flex-end" },
      on: { click: () => this.toggleCollapsed() },
    });
    this.rootEl = el(
      "div",
      {
        className: "panel ds-root",
        style: {
          position: "absolute",
          right: "24px",
          bottom: "24px",
          width: "300px",
          pointerEvents: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          padding: "10px",
        },
      },
      [this.toggleBtnEl, this.listEl],
    );
    document.getElementById("ui-root")!.appendChild(this.rootEl);

    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.rootEl.remove();
    });
  }

  /** Replaces the log with the server's last-50 replay (see
   * NetClient.onChatHistory()) — called once per (re)connect, before
   * any live addMessage() calls for this session. */
  loadHistory(entries: ChatLogEntry[]) {
    this.messages = entries.slice(-CHAT_LOG_LIMIT);
    this.render();
  }

  isMuted(sessionId: string): boolean {
    return this.muted.has(sessionId);
  }

  /** `/mute <name>` fallback (see Room.ts's sendChatMessage()) — matches
   * against names already seen in this log, case-insensitively. Returns
   * whether a match was muted, so the caller can show a toast either way. */
  muteByName(name: string): boolean {
    const target = this.messages.find((m) => m.name.toLowerCase() === name.trim().toLowerCase());
    if (!target) return false;
    this.muted.add(target.sessionId);
    this.render();
    return true;
  }

  addMessage(entry: ChatLogEntry) {
    this.messages.push(entry);
    if (this.messages.length > CHAT_LOG_LIMIT) this.messages.shift();
    this.render();
  }

  update() {
    if (Phaser.Input.Keyboard.JustDown(this.tKey)) this.toggleCollapsed();
  }

  private toggleCollapsed() {
    this.collapsed = !this.collapsed;
    this.listEl.style.display = this.collapsed ? "none" : "flex";
  }

  private render() {
    this.listEl.innerHTML = "";
    for (const m of this.messages) {
      const isMuted = this.muted.has(m.sessionId);
      const row = el(
        "div",
        { style: { fontFamily: "var(--font-mono)", fontSize: "12px", lineHeight: "1.4", opacity: isMuted ? "0.35" : "1" } },
        [
          el("span", { text: `${formatTime(m.ts)} `, style: { color: "var(--text-muted)" } }),
          el("span", {
            text: m.name.toUpperCase(),
            attrs: { title: isMuted ? "Click to unmute this player's chat and voice" : "Click to mute this player's chat and voice" },
            style: { color: m.stage ? "var(--accent-gold)" : "var(--text-primary)", fontWeight: "700", cursor: "pointer" },
            on: { click: () => this.toggleMute(m.sessionId) },
          }),
          el("span", { text: `: ${m.text}`, style: { color: m.stage ? "var(--accent-gold)" : "var(--text-primary)" } }),
        ],
      );
      this.listEl.appendChild(row);
    }
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private toggleMute(sessionId: string) {
    if (this.muted.has(sessionId)) this.muted.delete(sessionId);
    else this.muted.add(sessionId);
    this.render();
  }
}
