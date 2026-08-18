import Phaser from "phaser";
import { net } from "./net/NetClient";
import type { RemotePlayerController } from "./net/remotePlayers";
import { dossier } from "./dossier";
import { academy } from "./academy";
import { events } from "./events";
import { tutorial } from "./tutorial";
import { getCurrentUserId, isAuthenticated } from "./cloud/authState";
import { saveContact } from "./cloud/contacts";
import { el } from "./ui/dom";
import { logContactExchanged } from "./instrumentation";

// §4 "Contact Exchange" (see PLAN.md) — walk up, press E, both sides
// confirm, then (and only then) contact strings cross the wire. See
// net/NetClient.ts's send/on contact* methods and SceneRoom.ts's
// matching relay handlers for the 3-round-trip handshake this drives.
// Guest-gated at the proximity-prompt level (see update()) — a guest
// simply never sees the prompt, matching every other cloud/ feature's
// "no special case, just no data to act on" convention.

const PROXIMITY_RADIUS = 100;

type State =
  | { kind: "idle" }
  | { kind: "confirming"; targetSessionId: string; targetName: string }
  | { kind: "waitingForResponse"; targetSessionId: string; targetName: string }
  | { kind: "incoming"; fromSessionId: string; fromName: string }
  | { kind: "waitingForFinalize"; targetSessionId: string; targetName: string }
  | { kind: "result"; name: string; contact: string };

export class ContactExchangeController {
  private remotePlayers: RemotePlayerController;
  private eKey: Phaser.Input.Keyboard.Key;
  private state: State = { kind: "idle" };

  private promptEl: HTMLElement;
  private panelEl: HTMLElement;
  private panelTitleEl: HTMLElement;
  private panelBodyEl: HTMLElement;
  private panelButtonsEl: HTMLElement;

  constructor(scene: Phaser.Scene, remotePlayers: RemotePlayerController) {
    this.remotePlayers = remotePlayers;
    this.eKey = scene.input.keyboard!.addKey("E");

    this.promptEl = el("div", {
      className: "panel ds-root",
      style: { position: "absolute", left: "50%", bottom: "140px", transform: "translateX(-50%)", padding: "6px 14px", display: "none", pointerEvents: "none" },
    });
    document.getElementById("ui-root")!.appendChild(this.promptEl);

    this.panelTitleEl = el("div", { className: "dialogue__name" });
    this.panelBodyEl = el("div", { className: "dialogue__body", style: { marginTop: "8px" } });
    this.panelButtonsEl = el("div", { style: { display: "flex", gap: "10px", marginTop: "16px" } });
    this.panelEl = el(
      "div",
      {
        className: "panel panel--glow ds-root",
        style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "380px", pointerEvents: "auto", display: "none" },
      },
      [this.panelTitleEl, this.panelBodyEl, this.panelButtonsEl],
    );
    document.getElementById("ui-root")!.appendChild(this.panelEl);

    net.onContactRequestReceived(({ fromSessionId, fromName }) => this.handleIncoming(fromSessionId, fromName));
    net.onContactDeclined(() => this.handleDeclined());
    net.onContactAcceptedByOther(({ fromSessionId, fromName, theirContact }) => this.handleAcceptedByOther(fromSessionId, fromName, theirContact));
    net.onContactFinalized(({ fromName, theirContact }) => this.handleFinalized(fromName, theirContact));

    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.promptEl.remove();
      this.panelEl.remove();
    });
  }

  get uiOpen(): boolean {
    return this.state.kind !== "idle";
  }

  update(playerX: number, playerY: number) {
    // Guards against the ambient prompt (a DOM element, unlike npc.ts/
    // quest.ts's canvas-rendered ones) visually bleeding through a
    // full-screen overlay's backdrop — those overlays' own root DOM
    // nodes were appended to #ui-root earlier (constructed once from
    // UIOverlay) than this controller's (rebuilt every Room.ts
    // create()), so without this check the prompt would sit on top of
    // them in DOM stacking order regardless of which is "really" open.
    if (this.state.kind !== "idle" || !isAuthenticated() || dossier.isOpen || academy.isOpen || events.isOpen || tutorial.isOpen) {
      this.promptEl.style.display = "none";
      return;
    }
    const nearby = this.remotePlayers.findNearby(playerX, playerY, PROXIMITY_RADIUS);
    if (!nearby) {
      this.promptEl.style.display = "none";
      return;
    }
    this.promptEl.textContent = `[E] Exchange contact with ${nearby.name}`;
    this.promptEl.style.display = "block";
    if (Phaser.Input.Keyboard.JustDown(this.eKey)) this.beginConfirm(nearby.sessionId, nearby.name);
  }

  private beginConfirm(targetSessionId: string, targetName: string) {
    this.state = { kind: "confirming", targetSessionId, targetName };
    this.render();
  }

  private handleIncoming(fromSessionId: string, fromName: string) {
    this.state = { kind: "incoming", fromSessionId, fromName };
    this.render();
  }

  private handleDeclined() {
    if (this.state.kind !== "waitingForResponse") return;
    const targetName = this.state.targetName;
    this.state = { kind: "idle" };
    this.render();
    // Nothing else logged — declining leaves no trace beyond this
    // in-session toast, per PLAN.md's "log nothing else."
    window.setTimeout(() => this.flashDeclined(targetName), 0);
  }

  private flashDeclined(targetName: string) {
    this.panelTitleEl.textContent = "DECLINED";
    this.panelBodyEl.textContent = `${targetName} declined the exchange.`;
    this.panelButtonsEl.innerHTML = "";
    this.panelButtonsEl.append(this.button("Close", () => this.close()));
    this.panelEl.style.display = "block";
  }

  // A's side: the client that originally sent the request auto-finalizes
  // the moment B accepts — A already consented back in beginConfirm(),
  // so no second click is needed here (see PLAN.md's handshake step 3).
  private handleAcceptedByOther(fromSessionId: string, fromName: string, theirContact: string) {
    const userId = getCurrentUserId();
    net.sendContactFinalize(fromSessionId, userId, dossier.getContactInfo());
    this.completeExchange(fromName, theirContact);
  }

  // B's side: arrives once A has finalized — B already accepted, so
  // this just delivers the result.
  private handleFinalized(fromName: string, theirContact: string) {
    this.completeExchange(fromName, theirContact);
  }

  private completeExchange(otherName: string, otherContact: string) {
    const userId = getCurrentUserId();
    saveContact(userId ?? "", null, otherName, otherContact);
    logContactExchanged();
    this.state = { kind: "result", name: otherName, contact: otherContact };
    this.render();
  }

  private close() {
    this.state = { kind: "idle" };
    this.panelEl.style.display = "none";
  }

  private button(label: string, onClick: () => void): HTMLElement {
    return el("button", { className: "btn btn--ghost", text: label, on: { click: onClick } });
  }

  private render() {
    this.panelButtonsEl.innerHTML = "";
    switch (this.state.kind) {
      case "idle":
        this.panelEl.style.display = "none";
        return;

      case "confirming": {
        const { targetSessionId, targetName } = this.state;
        this.panelTitleEl.textContent = "EXCHANGE CONTACT";
        this.panelBodyEl.textContent = `Exchange contact details with ${targetName}? This will share your name and the contact info you set in your Dossier.`;
        this.panelButtonsEl.append(
          this.button("Confirm", () => {
            net.sendContactRequest(targetSessionId);
            this.state = { kind: "waitingForResponse", targetSessionId, targetName };
            this.render();
          }),
          this.button("Cancel", () => this.close()),
        );
        break;
      }

      case "waitingForResponse":
        this.panelTitleEl.textContent = "EXCHANGE CONTACT";
        this.panelBodyEl.textContent = `Waiting for ${this.state.targetName} to respond…`;
        this.panelButtonsEl.append(this.button("Cancel", () => this.close()));
        break;

      case "incoming": {
        const { fromSessionId, fromName } = this.state;
        this.panelTitleEl.textContent = "EXCHANGE CONTACT";
        this.panelBodyEl.textContent = `${fromName} wants to exchange contact details with you. This will share your name and the contact info you set in your Dossier.`;
        this.panelButtonsEl.append(
          this.button("Accept", () => {
            const userId = getCurrentUserId();
            net.sendContactAccept(fromSessionId, userId, dossier.getContactInfo());
            this.state = { kind: "waitingForFinalize", targetSessionId: fromSessionId, targetName: fromName };
            this.render();
          }),
          this.button("Decline", () => {
            net.sendContactDecline(fromSessionId);
            this.close();
          }),
        );
        break;
      }

      case "waitingForFinalize":
        this.panelTitleEl.textContent = "EXCHANGE CONTACT";
        this.panelBodyEl.textContent = `Confirming with ${this.state.targetName}…`;
        break;

      case "result": {
        const { name, contact } = this.state;
        this.panelTitleEl.textContent = "CONTACT EXCHANGED";
        this.panelBodyEl.textContent = contact ? `${name}: ${contact}` : `${name} hasn't set a contact string yet.`;
        this.panelButtonsEl.append(this.button("Close", () => this.close()));
        break;
      }
    }
    this.panelEl.style.display = "block";
  }
}
