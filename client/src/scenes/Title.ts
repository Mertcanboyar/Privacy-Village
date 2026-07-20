import Phaser from "phaser";
import { addDriftingBackground } from "./drift";
import { el } from "../ui/dom";
import { playSound } from "../audio";

// Title screen (see PLAN.md Phase 2, Day 1). DOM owns the interactive
// chrome, same Phaser-world/DOM-UI split as everywhere else in this game.
//
// The waitlist gate below is a soft gate, not a wall: "just exploring"
// always works, and any failure in the /api/waitlist round-trip (network
// down, endpoint missing in local dev, Resend misconfigured server-side)
// must never block entry — see api/waitlist.ts's own failure policy.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Module-level, not instance state — persists across a hypothetical
// re-visit to this scene within the same page load ("never nag again in
// the same session"), even though nothing in the game currently routes
// back to Title once you've left it.
let waitlistHandled = false;

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
          paddingBottom: "64px",
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
            margin: "0 0 24px",
          },
        }),
        waitlistHandled ? this.buildPlainEnterButton() : this.buildWaitlistPanel(),
      ],
    );
    document.getElementById("ui-root")!.appendChild(this.overlayEl);

    // Starting CharacterCreate stops this scene (SHUTDOWN fires) — same
    // DOM-cleanup pattern as npc.ts/quest.ts, so the title overlay never
    // lingers over later scenes.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.overlayEl.remove());
  }

  // Fallback shown only on a hypothetical re-visit after the gate has
  // already been handled once this session — matches the pre-existing
  // single-button title screen.
  private buildPlainEnterButton(): HTMLElement {
    return el("button", {
      className: "btn btn--gold",
      text: "Enter the Village",
      style: { fontSize: "16px", padding: "16px 32px" },
      on: { click: () => this.enter() },
    });
  }

  private buildWaitlistPanel(): HTMLElement {
    let emailInput!: HTMLInputElement;
    let errorEl!: HTMLElement;
    let joinBtn!: HTMLButtonElement;

    const submit = () => {
      const email = emailInput.value.trim();
      if (!EMAIL_RE.test(email)) {
        errorEl.textContent = "That doesn't look like an email address.";
        shake(emailInput);
        return;
      }
      errorEl.textContent = "";
      this.joinWaitlist(email, joinBtn);
    };

    emailInput = el("input", {
      attrs: { type: "email", placeholder: "you@email.com", autocomplete: "email" },
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: "15px",
        padding: "10px 14px",
        borderRadius: "var(--radius-sm)",
        border: "2px solid var(--border-strong)",
        background: "var(--bg-raised)",
        color: "var(--text-primary)",
        textAlign: "center",
        width: "260px",
      },
      on: {
        keydown: (e) => {
          if ((e as KeyboardEvent).key === "Enter") submit();
        },
      },
    });

    errorEl = el("div", {
      style: { fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--accent-red)", minHeight: "14px", marginTop: "6px" },
    });

    joinBtn = el("button", {
      className: "btn btn--gold",
      text: "Join & Enter the Village",
      style: { marginTop: "14px", fontSize: "15px", padding: "14px 28px" },
      on: { click: submit },
    });

    const skipLink = el("a", {
      text: "just exploring →",
      attrs: { href: "#" },
      style: {
        display: "inline-block",
        marginTop: "12px",
        fontFamily: "var(--font-mono)",
        fontSize: "12px",
        color: "var(--text-muted)",
        textDecoration: "none",
        cursor: "pointer",
      },
      on: {
        click: (e) => {
          e.preventDefault();
          waitlistHandled = true;
          playSound("select");
          this.enter();
        },
      },
    });

    const consentLine = el("p", {
      style: {
        marginTop: "16px",
        maxWidth: "320px",
        fontFamily: "var(--font-body)",
        fontSize: "11px",
        lineHeight: "1.5",
        color: "var(--text-muted)",
        textAlign: "center",
      },
    });
    consentLine.append(
      "We'll email you about Privacy Village only. No sharing, unsubscribe anytime. ",
      el("a", {
        text: "Privacy Notice",
        attrs: { href: "/privacy", target: "_blank", rel: "noopener noreferrer" },
        style: { color: "var(--text-muted)", textDecoration: "underline" },
      }),
    );

    return el(
      "div",
      { className: "panel", style: { display: "flex", flexDirection: "column", alignItems: "center", padding: "28px 36px 24px" } },
      [
        el("div", {
          text: "Become a Founding Privacy Villager",
          style: {
            fontFamily: "var(--font-display)",
            fontWeight: "700",
            fontSize: "18px",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontVariantCaps: "small-caps",
            color: "var(--accent-gold)",
          },
        }),
        el("p", {
          text: "Early access to new Trials, the annual festival, and the first credentials.",
          style: { fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-muted)", margin: "8px 0 18px", textAlign: "center", maxWidth: "320px" },
        }),
        emailInput,
        errorEl,
        joinBtn,
        skipLink,
        consentLine,
      ],
    );
  }

  private async joinWaitlist(email: string, joinBtn: HTMLButtonElement) {
    waitlistHandled = true;
    playSound("confirm");
    joinBtn.disabled = true;
    joinBtn.textContent = "Joining…";

    let joined = false;
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      joined = res.ok;
    } catch {
      // Network down, /api unavailable in local dev, etc. — signup
      // problems must never block entry (see api/waitlist.ts).
      joined = false;
    }

    if (joined) this.showToast("Welcome, Agent");
    this.enterWithPrefill(joined ? nameFromEmail(email) : undefined);
  }

  private showToast(message: string) {
    const toast = el("div", { className: "toast", text: message, style: { position: "absolute", bottom: "24px", left: "50%", transform: "translateX(-50%)" } });
    this.overlayEl.appendChild(toast);
  }

  private enter() {
    this.enterWithPrefill(undefined);
  }

  private enterWithPrefill(prefillName: string | undefined) {
    // Brief pause so the "Welcome, Agent" toast is actually readable
    // before the fade takes over — skipped entirely on the skip/no-toast
    // paths, since prefillName being undefined there is fine too.
    const delay = prefillName ? 900 : 0;
    window.setTimeout(() => {
      this.cameras.main.fadeOut(400, 10, 10, 15);
      this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
        this.scene.start("CharacterCreate", { prefillName });
      });
    }, delay);
  }
}

function shake(el: HTMLElement) {
  el.style.animation = "none";
  void el.offsetWidth; // reflow, so re-triggering the same animation twice in a row still plays
  el.style.animation = "ds-shake 400ms ease-in-out";
}

// "sarah.jones@example.com" -> "Sarah.jones" — literal capitalize-first-
// letter per spec, not a full title-case of the local part.
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const capitalized = local.charAt(0).toUpperCase() + local.slice(1);
  return capitalized.slice(0, 16); // matches CharacterCreate's name input maxlength
}
