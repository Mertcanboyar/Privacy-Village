import Phaser from "phaser";
import { addDriftingBackground } from "./drift";
import { el } from "../ui/dom";
import { setSession } from "../session";
import { supabase } from "../cloud/supabaseClient";
import { setCurrentUserId } from "../cloud/authState";
import { fetchProfile, fetchProgress, createProfileAndProgress, type ProfileRow } from "../cloud/profile";
import { takePendingUpgrade, type PendingUpgradeSnapshot } from "../cloud/pendingUpgrade";
import { buildEmailCapturePanel } from "../cloud/emailCapturePanel";
import { questEngine } from "../questEngine";
import { academy } from "../academy";

// Title screen (see PLAN.md Phase 2, Day 1). DOM owns the interactive
// chrome, same Phaser-world/DOM-UI split as everywhere else in this game.
//
// The waitlist/auth gate below is a soft gate, not a wall: "just
// exploring" always works, and any failure anywhere in this file's
// network calls (waitlist POST, Supabase auth, profile/progress fetch)
// must never block entry — see cloud/emailCapturePanel.ts's own
// fallback path and this file's boot()/spawn methods, which all treat
// "couldn't reach it" the same as "declined."

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

    this.overlayEl = el("div", {
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
    });
    document.getElementById("ui-root")!.appendChild(this.overlayEl);

    // Starting CharacterCreate/Room stops this scene (SHUTDOWN fires) —
    // same DOM-cleanup pattern as npc.ts/quest.ts, so the title overlay
    // never lingers over later scenes.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.overlayEl.remove());

    this.boot();
  }

  private heading(): HTMLElement {
    return el("h1", {
      text: "Privacy Village",
      style: {
        fontFamily: "var(--font-display)",
        fontWeight: "700",
        fontSize: "56px",
        color: "var(--text-primary)",
        textShadow: "0 4px 24px rgba(0, 0, 0, 0.6)",
        margin: "0 0 24px",
      },
    });
  }

  private renderPanel(panel: HTMLElement | null) {
    this.overlayEl.innerHTML = "";
    this.overlayEl.appendChild(this.heading());
    if (panel) this.overlayEl.appendChild(panel);
  }

  // Checks for a live Supabase session (magic-link return, or a
  // persisted one from a previous visit — supabase-js keeps the
  // refresh token in localStorage by default) before deciding what to
  // show. Fast either way: this is a local check, not a network round
  // trip, unless the access token actually needs refreshing.
  private async boot() {
    if (!supabase) {
      this.renderPanel(this.buildWelcomePanel());
      return;
    }

    let userId: string | null = null;
    let userEmail: string | null = null;
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      userId = session?.user.id ?? null;
      userEmail = session?.user.email ?? null;
    } catch {
      userId = null;
    }

    if (!userId) {
      this.renderPanel(this.buildWelcomePanel());
      return;
    }

    setCurrentUserId(userId);
    const profile = await fetchProfile(userId);

    if (profile) {
      await this.spawnReturningUser(userId, profile);
      return;
    }

    const pending = takePendingUpgrade();
    if (pending) {
      await this.spawnFromPendingUpgrade(userId, pending);
      return;
    }

    // Authenticated, no profile yet, no pending guest upgrade — a
    // genuinely first-time signup. Go through CharacterCreate as usual,
    // flagged so it creates the profile+progress rows on spawn.
    this.renderPanel(null);
    this.enterWithPrefill(nameFromEmail(userEmail ?? ""), true);
  }

  // The very first thing shown: just the heading over the drifting
  // village art, no modal in front of it — matching how this screen
  // looked before the waitlist gate existed. "Enter the Village" opens
  // the email gate panel (see buildGatePanel()) rather than entering
  // directly, unless that gate's already been handled once this
  // session (waitlistHandled), in which case there's nothing left to
  // show and it goes straight in.
  private buildWelcomePanel(): HTMLElement {
    return el("button", {
      className: "btn btn--gold",
      text: "Enter the Village",
      style: { fontSize: "16px", padding: "16px 32px" },
      on: { click: () => (waitlistHandled ? this.enter() : this.renderPanel(this.buildGatePanel())) },
    });
  }

  private buildGatePanel(): HTMLElement {
    return buildEmailCapturePanel({
      heading: "Become a Founding Privacy Villager",
      subline: "Early access to new Trials, the annual festival, and the first credentials.",
      buttonLabel: "Join & Enter the Village",
      showSkipLink: true,
      onSkip: () => {
        waitlistHandled = true;
        this.enter();
      },
      onFallback: (email, waitlistOk) => {
        waitlistHandled = true;
        if (waitlistOk) this.showToast("Welcome, Agent");
        this.enterWithPrefill(waitlistOk ? nameFromEmail(email) : undefined, false);
      },
    });
  }

  private async spawnReturningUser(userId: string, profile: ProfileRow) {
    setSession({ name: profile.agent_name, avatarId: profile.sprite_id, faction: profile.faction });
    const progressRow = await fetchProgress(userId);
    if (progressRow) {
      questEngine.hydrateState(progressRow.quest_state);
      academy.hydrateState(progressRow.module_state);
    }
    this.renderPanel(null);
    this.showToast(`Welcome back, Agent ${profile.agent_name} — Clearance ${questEngine.getClearance()}`);
    this.fadeToRoom(900);
  }

  private async spawnFromPendingUpgrade(userId: string, pending: PendingUpgradeSnapshot) {
    setSession({ name: pending.name, avatarId: pending.spriteId, faction: pending.faction });
    questEngine.hydrateState(pending.questState);
    academy.hydrateState(pending.moduleState);

    await createProfileAndProgress(userId, {
      agentName: pending.name,
      spriteId: pending.spriteId,
      faction: pending.faction,
      questState: pending.questState,
      moduleState: pending.moduleState,
      clearance: questEngine.getClearance(),
      xp: questEngine.getPoints(),
    });

    this.renderPanel(null);
    this.showToast(`Welcome back, Agent ${pending.name} — record saved`);
    this.fadeToRoom(900);
  }

  private showToast(message: string) {
    const toast = el("div", { className: "toast", text: message, style: { position: "absolute", bottom: "24px", left: "50%", transform: "translateX(-50%)" } });
    this.overlayEl.appendChild(toast);
  }

  private enter() {
    this.enterWithPrefill(undefined, false);
  }

  private enterWithPrefill(prefillName: string | undefined, authenticated: boolean) {
    // Brief pause so a toast (e.g. "Welcome, Agent") is actually
    // readable before the fade takes over — skipped when there's
    // nothing to read.
    const delay = prefillName ? 900 : 0;
    window.setTimeout(() => {
      this.cameras.main.fadeOut(400, 10, 10, 15);
      this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
        this.scene.start("CharacterCreate", { prefillName, authenticated });
      });
    }, delay);
  }

  private fadeToRoom(delayMs: number) {
    window.setTimeout(() => {
      this.cameras.main.fadeOut(400, 10, 10, 15);
      this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
        this.scene.start("Room", { room: "village" });
        this.scene.launch("UIOverlay");
      });
    }, delayMs);
  }
}

// "sarah.jones@example.com" -> "Sarah.jones" — literal capitalize-first-
// letter per spec, not a full title-case of the local part. Empty input
// (a returning-via-magic-link session with no local part handy) just
// yields "".
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  if (!local) return "";
  const capitalized = local.charAt(0).toUpperCase() + local.slice(1);
  return capitalized.slice(0, 16); // matches CharacterCreate's name input maxlength
}
