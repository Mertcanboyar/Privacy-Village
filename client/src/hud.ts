import Phaser from "phaser";
import { el } from "./ui/dom";
import { showImageOverlay } from "./ui/imageOverlay";
import { showTableOverlay } from "./ui/tableOverlay";
import { questEngine, QUEST_IDS, type QuestStepReveal, type QuestStepChoice, type QuestStepChoiceOption } from "./questEngine";
import { getSession } from "./session";
import { academy } from "./academy";
import { dossier } from "./dossier";
import { events } from "./events";
import { supabase } from "./cloud/supabaseClient";
import { isAuthenticated, hasPendingOtpRequest, setCurrentUserId } from "./cloud/authState";
import { savePendingUpgrade } from "./cloud/pendingUpgrade";
import { buildEmailCapturePanel } from "./cloud/emailCapturePanel";
import { net } from "./net/NetClient";
import { persistenceStatus, type PersistenceStatus } from "./cloud/persistenceStatus";
import { lockUi, unlockUi } from "./cloud/uiLock";
import { isMusicMuted, toggleMusic } from "./audio";
import { guidedMode } from "./guidedMode";
import { gathering } from "./gathering";
import type { RoomName } from "./rooms";

// Persistent HUD (see PLAN.md Phase 2, Day 3) — .xp-bar, quest tracker,
// and toast stack from design-system.css, wired to questEngine's events
// for the first time. Lives in UIOverlay.ts specifically because that
// scene is scene.launch()'d once and never scene.restart()'d on room
// transitions, unlike Room.ts — the only scene that actually persists
// the way a HUD needs to.

const TOAST_DISMISS_MS = 3000;
const REVEAL_DISMISS_MS = 5000;

// The Decision Clock (see "The Night the Wall Fell") — quest-scoped, only
// shown while this specific quest is active. Hardcoded id/thresholds
// rather than a generic per-quest clock system, matching questEngine.ts's
// own DEMO RULE reasoning for the same mechanic.
const CLOCK_QUEST_ID = "night_the_wall_fell";
const CLOCK_AMBER_AT = 48;
const CLOCK_RED_AT = 72;

// Cosmetic only — the .xp-bar fill is just points/TOTAL_POINTS, it no
// longer gates Clearance (see questEngine.ts's setClearance()). Sum of
// every payout in the village demo path: Welcome 50 + Breach M1 150 +
// Breach M2 150 + Shards M1 150 + Shards M2 150 + Night the Wall Fell
// 200 + Healer's Ledger 200 + Post Road Blueprint 250 + The Sealed
// Letter 250 + The Treasury's Two Keys 300 + Maren's Winter Report 250
// + The Archivist's Desk 250.
// (The Courthouse Trial's 400 used to be part of this — its content
// moved to the Academy, a parallel points source with its own
// per-track credential bars, not counted here.)
const TOTAL_POINTS = 2350;

function factionAccent(): string {
  return getSession().faction === "apocalypse" ? "var(--accent-red)" : "var(--accent-gold)";
}

export class HUDController {
  private xpFillEl: HTMLElement;
  private xpValueEl: HTMLElement;
  private levelBadgeEl: HTMLElement;
  private xpBarEl: HTMLElement;

  private trackerEl: HTMLElement;
  private trackerTitleEl: HTMLElement;
  private trackerObjectiveEl: HTMLElement;
  private trackerCounterEl: HTMLElement;
  private trackerEvidenceRowEl: HTMLElement;
  private trackerVisible = true;

  private guidedBannerEl: HTMLElement;
  private guidedBannerLabelEl: HTMLElement;

  private countdownBannerEl: HTMLElement;
  private countdownBannerTextEl: HTMLElement;

  private clockEl: HTMLElement;
  private clockValueEl: HTMLElement;

  private toastStackEl: HTMLElement;
  private qKey: Phaser.Input.Keyboard.Key;

  private netDotEl: HTMLElement;
  private persistDotEl: HTMLElement;

  private menuEl: HTMLElement;
  private menuBtnEl: HTMLElement;
  private menuMusicItemEl: HTMLElement;
  private menuGuidedNavItemEl: HTMLElement;
  private menuOpen = false;

  private academyBtnEl: HTMLElement;
  private academyDotEl: HTMLElement;

  constructor(scene: Phaser.Scene) {
    const root = document.getElementById("ui-root")!;

    // Single wrapper for all of this HUD's persistent DOM (as opposed to
    // the transient popups further below — reveal/step-choice panels,
    // the save-record modal, the XP-delta/level-up flashes — which are
    // already self-contained and self-removing on their own). Nothing
    // ever stopped UIOverlay before "Return to Title Screen" needed to,
    // so there was never a cleanup path for this DOM — this wrapper plus
    // the SHUTDOWN listener below is that path, mirroring Title.ts's own
    // overlayEl/SHUTDOWN pattern.
    const hudRootEl = el("div", { className: "ds-root", style: { position: "absolute", inset: "0", pointerEvents: "none" } });
    root.appendChild(hudRootEl);

    // --- Top bar: Academy + Events + Menu buttons (top-left, always
    // visible) ---
    // pointerEvents:"auto" on the row is load-bearing: #ui-root sets
    // pointer-events:none (see style.css) so any child is invisible to a
    // real mouse click unless something in its ancestry opts back in —
    // this button previously had no such opt-in and silently swallowed
    // every real click while still responding to synthetic .click() calls
    // in tests, which is why it looked "broken" only for actual players.
    // "STUDY" (renamed from "ACADEMY") + "FIELD WORK" (the village
    // itself — no button of its own, but see npc.ts's dialogue copy and
    // hud.ts's tracker) is the permanent vocabulary split PLAN's
    // onboarding fix asks for — never call the Academy anything else in
    // player-facing copy. The dot and pulse are both onboarding
    // signposting: the dot marks "a theory is unlocked and unstarted"
    // (see academy.hasAvailableUnstartedTheory()), the pulse marks
    // "you've never opened this at all" (academy.hasEverOpened()) — see
    // refreshAcademyButton(), called on every academy progress/open/
    // close event plus once here at construction.
    this.academyDotEl = el("span", {
      style: {
        position: "absolute",
        top: "-4px",
        right: "-4px",
        width: "10px",
        height: "10px",
        borderRadius: "50%",
        background: "var(--accent-gold)",
        boxShadow: "0 0 6px rgba(240, 180, 41, 0.8)",
        display: "none",
      },
    });
    this.academyBtnEl = el(
      "button",
      {
        className: "btn btn--ghost",
        attrs: { id: "hud-academy-btn" },
        text: "\u{1F4D6} STUDY",
        style: { position: "relative" },
        on: { click: () => academy.toggle() },
      },
      [this.academyDotEl],
    );
    academy.on("opened", () => this.refreshAcademyButton());
    academy.on("closed", () => this.refreshAcademyButton());
    academy.on("progressChanged", () => this.refreshAcademyButton());
    const eventsBtnEl = el("button", {
      className: "btn btn--ghost",
      text: "\u{1F3AC} EVENTS",
      on: { click: () => events.toggle() },
    });
    const dossierBtnEl = el("button", {
      className: "btn btn--ghost",
      text: "\u{1F396} PROFILE",
      on: { click: () => dossier.toggle() },
    });
    this.menuBtnEl = el("button", {
      className: "btn btn--ghost",
      text: "☰ MENU",
      on: { click: () => this.toggleMenu() },
    });
    const topBarEl = el(
      "div",
      { className: "ds-root", style: { position: "absolute", top: "24px", left: "24px", display: "flex", gap: "12px", pointerEvents: "auto" } },
      [this.academyBtnEl, eventsBtnEl, dossierBtnEl, this.menuBtnEl],
    );
    hudRootEl.appendChild(topBarEl);

    // --- User menu dropdown (below the top bar) — Return to Title,
    // Music toggle, and (guests excluded) Sign Out. Same JS-driven
    // style.display toggle as the quest tracker below, rather than a new
    // manager-singleton class — this is HUD-local state, nothing else
    // needs to know it's open. ---
    this.menuMusicItemEl = el("button", {
      className: "btn btn--ghost",
      text: isMusicMuted() ? "\u{1F507} MUSIC: OFF" : "\u{1F50A} MUSIC: ON",
      style: { width: "100%", textAlign: "left" },
      on: {
        click: () => {
          const muted = toggleMusic();
          this.menuMusicItemEl.textContent = muted ? "\u{1F507} MUSIC: OFF" : "\u{1F50A} MUSIC: ON";
        },
      },
    });
    const returnToTitleItemEl = el("button", {
      className: "btn btn--ghost",
      text: "\u{1F6AA} RETURN TO TITLE SCREEN",
      style: { width: "100%", textAlign: "left" },
      on: {
        click: () => {
          this.closeMenu();
          net.disconnect();
          scene.scene.stop("Room");
          scene.scene.stop("UIOverlay");
          scene.scene.manager.start("Title", { skipAutoContinue: true });
        },
      },
    });
    // Escape hatch for a returning player who already knows the ropes
    // (see guidedMode.ts) — flips the manual on/off flag directly, same
    // idiom as the Music toggle above. guidedMode's own "changed" event
    // (subscribed below) keeps this label in sync if it's ever toggled
    // from anywhere else.
    this.menuGuidedNavItemEl = el("button", {
      className: "btn btn--ghost",
      text: guidedMode.isManuallyDisabled() ? "\u{1F9ED} GUIDED NAV: OFF" : "\u{1F9ED} GUIDED NAV: ON",
      style: { width: "100%", textAlign: "left" },
      on: {
        click: () => guidedMode.setManuallyDisabled(!guidedMode.isManuallyDisabled()),
      },
    });
    const menuItems = [returnToTitleItemEl, this.menuMusicItemEl, this.menuGuidedNavItemEl];
    if (supabase && isAuthenticated()) {
      menuItems.push(
        el("button", {
          className: "btn btn--ghost",
          text: "\u{1F512} SIGN OUT",
          style: { width: "100%", textAlign: "left" },
          on: {
            click: async () => {
              this.closeMenu();
              net.disconnect();
              if (supabase) await supabase.auth.signOut();
              setCurrentUserId(null);
              window.location.reload();
            },
          },
        }),
      );
    }
    this.menuEl = el(
      "div",
      {
        className: "panel ds-root",
        style: { position: "absolute", top: "112px", left: "24px", width: "240px", display: "none", pointerEvents: "auto", flexDirection: "column", gap: "8px" },
      },
      menuItems,
    );
    hudRootEl.appendChild(this.menuEl);

    const onDocClick = (e: MouseEvent) => {
      if (!this.menuOpen) return;
      if (e.target instanceof Node && (this.menuEl.contains(e.target) || this.menuBtnEl.contains(e.target))) return;
      this.closeMenu();
    };
    const onDocKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.menuOpen) this.closeMenu();
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onDocKeydown);

    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      hudRootEl.remove();
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onDocKeydown);
    });

    // --- Status dots (top-left, below Academy/Events) — diagnostic only,
    // never gate anything. MP = multiplayer connection (net/NetClient.ts,
    // silent by design otherwise); ACCT = whether progress is actually
    // saving to Supabase (cloud/persistenceStatus.ts). Hover either dot
    // for the exact reason it's not green. */
    const dotStyle = (): Partial<CSSStyleDeclaration> => ({
      width: "9px",
      height: "9px",
      borderRadius: "50%",
      display: "inline-block",
      transition: "background 200ms ease, box-shadow 200ms ease",
    });
    this.netDotEl = el("span", { style: dotStyle() });
    this.persistDotEl = el("span", { style: dotStyle() });
    const statusLabel = (text: string) => el("span", { text, style: { fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.04em" } });
    const statusRowEl = el(
      "div",
      { className: "ds-root", style: { position: "absolute", top: "72px", left: "24px", display: "flex", gap: "14px", alignItems: "center", pointerEvents: "auto" } },
      [
        el("div", { style: { display: "flex", alignItems: "center", gap: "6px" } }, [this.netDotEl, statusLabel("MP")]),
        el("div", { style: { display: "flex", alignItems: "center", gap: "6px" } }, [this.persistDotEl, statusLabel("ACCT")]),
      ],
    );
    hudRootEl.appendChild(statusRowEl);

    net.onStatusChange(() => this.refreshNetDot());
    this.refreshNetDot();
    persistenceStatus.on("changed", () => this.refreshPersistDot());
    this.refreshPersistDot();

    // --- XP bar (bottom-left, always visible) ---
    this.levelBadgeEl = el("div", { className: "level-badge", text: "C1" });
    this.xpFillEl = el("div", { className: "xp-bar__fill", style: { width: "0%" } });
    this.xpValueEl = el("div", { className: "xp-bar__value", text: "0 PTS" });
    this.xpBarEl = el(
      "div",
      { className: "xp-bar ds-root", style: { position: "absolute", left: "24px", bottom: "24px", width: "300px" } },
      [this.levelBadgeEl, el("div", { className: "xp-bar__track" }, [this.xpFillEl]), this.xpValueEl],
    );
    hudRootEl.appendChild(this.xpBarEl);

    // --- "Save your record" (bottom-left, above the XP bar) — guests
    // only, and only when persistence is actually configured at all
    // (no point offering it if Supabase env vars are absent). Opens the
    // same email-capture panel Title.ts's gate uses, in a floating
    // modal over the game rather than replacing the whole screen.
    // Hidden once a magic link is already pending for this session
    // (e.g. Title's low-friction gate, see cloud/emailCapturePanel.ts's
    // blockOnAuth option, already fired one and never waits to confirm
    // it — so isAuthenticated() alone stays false right after a real
    // signup) — showing it anyway would just invite a second
    // signInWithOtp() for the same address, which cloud/authState.ts's
    // resend-cooldown guard would now skip silently, so this is a UX
    // clarity fix on top of that, not the only thing preventing 429s. ---
    if (supabase && !isAuthenticated() && !hasPendingOtpRequest()) {
      const saveRecordBtnEl = el("button", {
        className: "btn btn--ghost",
        text: "SAVE YOUR RECORD",
        style: { fontSize: "11px", padding: "8px 12px" },
        on: { click: () => this.openSaveRecordModal() },
      });
      hudRootEl.appendChild(
        el(
          "div",
          { className: "ds-root", style: { position: "absolute", left: "24px", bottom: "56px", pointerEvents: "auto" } },
          [saveRecordBtnEl],
        ),
      );
    }

    // --- Quest tracker (top-right, Q toggles) ---
    // panel--glow-gold + panel--tracker-glow (see design-system.css): a
    // breathing gold glow so this persistent panel keeps drawing the eye
    // at a glance — players reported not noticing it sitting quietly in
    // the corner as a plain .panel. Title/objective text sized up a
    // notch for the same reason.
    this.trackerTitleEl = el("div", {
      style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "14px", letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--accent-gold)" },
    });
    this.trackerObjectiveEl = el("div", { style: { fontFamily: "var(--font-body)", fontSize: "15px", color: "var(--text-primary)", marginTop: "6px" } });
    this.trackerCounterEl = el("div", {
      style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", marginTop: "8px", textAlign: "right" },
    });
    this.trackerEvidenceRowEl = el("div", { style: { marginTop: "8px" } });
    this.trackerEl = el(
      "div",
      // pointerEvents:"auto" — same #ui-root opt-in fix as the top bar
      // above; the evidence button inside this panel was equally
      // unclickable for real users before this.
      {
        className: "panel panel--glow-gold panel--tracker-glow ds-root",
        style: { position: "absolute", top: "24px", right: "24px", width: "290px", display: "none", pointerEvents: "auto" },
      },
      [this.trackerTitleEl, this.trackerObjectiveEl, this.trackerEvidenceRowEl, this.trackerCounterEl],
    );
    hudRootEl.appendChild(this.trackerEl);

    // --- Guided Sequence objective banner (top-center, see
    // guidedMode.ts) --- Unmissable and non-dismissible (update()'s Q
    // handling ignores it entirely) on purpose — the playtest finding
    // this exists for was players never noticing the ordinary corner
    // tracker at all. refreshTracker() hides the corner tracker
    // whenever this banner is showing, so the two never compete for
    // attention; the Decision Clock (also top-center) never actually
    // coexists with it in practice since "The Night the Wall Fell" is
    // always locked during guided mode's 2-step sequence.
    this.guidedBannerLabelEl = el("div", {
      style: { fontFamily: "var(--font-body)", fontSize: "15px", fontWeight: "600", color: "var(--text-primary)" },
    });
    this.guidedBannerEl = el(
      "div",
      {
        className: "panel panel--glow-gold panel--tracker-glow ds-root",
        style: {
          position: "absolute",
          // top:84px, not 24px — the top bar's buttons (STUDY/EVENTS/
          // PROFILE/MENU, left:24) end around x~530, and this banner's
          // minWidth/centering puts its own left edge around x~420,
          // wide enough to sit on top of and swallow clicks on MENU at
          // the same top:24 row. Sitting just below it clears that
          // collision without narrowing the banner's readable width.
          top: "84px",
          left: "50%",
          transform: "translateX(-50%)",
          minWidth: "420px",
          maxWidth: "640px",
          textAlign: "center",
          padding: "10px 24px",
          display: "none",
          pointerEvents: "auto",
        },
      },
      [
        el("div", {
          text: "OBJECTIVE",
          style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "11px", letterSpacing: "0.08em", color: "var(--accent-gold)" },
        }),
        this.guidedBannerLabelEl,
      ],
    );
    hudRootEl.appendChild(this.guidedBannerEl);

    // --- §2 "The Gathering" countdown banner (top-center, all scenes,
    // see PLAN.md) --- top:168px, not 84px like the guided banner above
    // — that banner's own padding/text puts its bottom edge around
    // y~150 when shown, and the two CAN coexist (unlike the guided
    // banner vs. the Decision Clock), so this sits below it rather than
    // reusing its slot. Verified live against both that banner and the
    // top bar, same discipline as the guided banner's own comment.
    this.countdownBannerTextEl = el("div", {
      style: { fontFamily: "var(--font-body)", fontSize: "14px", fontWeight: "600", color: "var(--text-primary)" },
    });
    this.countdownBannerEl = el(
      "div",
      {
        className: "panel panel--glow-gold ds-root",
        style: {
          position: "absolute",
          top: "168px",
          left: "50%",
          transform: "translateX(-50%)",
          padding: "8px 20px",
          display: "none",
          pointerEvents: "auto",
          textAlign: "center",
          cursor: "pointer",
        },
        on: {
          click: () => {
            net.disconnect();
            scene.scene.get("Room").scene.restart({ room: "tavern" as RoomName });
          },
        },
      },
      [this.countdownBannerTextEl],
    );
    hudRootEl.appendChild(this.countdownBannerEl);

    scene.time.addEvent({ delay: 30000, loop: true, callback: () => this.refreshCountdownBanner() });
    this.refreshCountdownBanner();

    // --- Decision Clock (top-center, only while "The Night the Wall
    // Fell" is active) ---
    this.clockValueEl = el("span", { text: "⏱ HOUR 0 OF 72" });
    this.clockEl = el(
      "div",
      {
        className: "panel ds-root",
        style: {
          position: "absolute",
          top: "24px",
          left: "50%",
          transform: "translateX(-50%)",
          padding: "8px 20px",
          fontFamily: "var(--font-mono)",
          fontSize: "13px",
          fontWeight: "700",
          letterSpacing: "0.06em",
          color: "var(--accent-gold)",
          display: "none",
        },
      },
      [this.clockValueEl],
    );
    hudRootEl.appendChild(this.clockEl);

    // --- Toast stack (bottom-right) ---
    this.toastStackEl = el("div", {
      className: "ds-root",
      style: { position: "absolute", right: "24px", bottom: "24px", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px" },
    });
    hudRootEl.appendChild(this.toastStackEl);

    this.qKey = scene.input.keyboard!.addKey("Q");

    questEngine.on("toast", (message: string) => this.showToast(message));
    questEngine.on("pointsChanged", (points: number, delta: number) => this.onPointsChanged(points, delta));
    questEngine.on("levelUp", () => {
      this.refreshXpBar();
      this.flashLevelUp();
    });
    questEngine.on("questUpdated", () => {
      this.refreshTracker();
      this.refreshClock();
    });
    questEngine.on("clockChanged", () => this.refreshClock());
    questEngine.on("clockPenalty", () => this.flashClockPenalty());
    questEngine.on("reveal", (reveal: QuestStepReveal) => this.showReveal(reveal));
    questEngine.on("stepChoice", (choice: QuestStepChoice) => this.showStepChoice(choice));
    academy.on("toast", (message: string) => this.showToast(message));
    guidedMode.on("changed", () => {
      this.refreshTracker();
      this.menuGuidedNavItemEl.textContent = guidedMode.isManuallyDisabled() ? "\u{1F9ED} GUIDED NAV: OFF" : "\u{1F9ED} GUIDED NAV: ON";
    });

    this.refreshXpBar();
    this.refreshTracker();
    this.refreshClock();
    this.refreshAcademyButton();
  }

  private refreshAcademyButton() {
    this.academyBtnEl.style.animation = academy.hasEverOpened() ? "" : "ds-pulse 1.6s ease-in-out infinite";
    this.academyDotEl.style.display = academy.hasAvailableUnstartedTheory() ? "block" : "none";
  }

  /** The paired module's id+title for the first still-`locked` quest in
   * QUEST_IDS order, or null if none is locked-behind-a-module right
   * now (nothing to report, or every remaining locked quest is gated
   * by something other than theory — e.g. still mid-`unlocks`-chain). */
  private nextLockedQuestHint(): { id: string; title: string } | null {
    for (const id of QUEST_IDS) {
      if (questEngine.getState(id) !== "locked") continue;
      const module = academy.getModuleForQuest(id);
      if (module) return { id: module.id, title: module.title };
    }
    return null;
  }

  update() {
    // The guided banner isn't the dismissible tracker — Q is ignored
    // entirely while it's showing (see refreshTracker()'s guided-mode
    // branch), so there's no way to accidentally hide the one thing
    // this whole feature exists to keep visible.
    if (Phaser.Input.Keyboard.JustDown(this.qKey) && !guidedMode.isActive()) {
      this.trackerVisible = !this.trackerVisible;
      this.refreshTracker();
    }
  }

  private toggleMenu() {
    this.menuOpen = !this.menuOpen;
    this.menuEl.style.display = this.menuOpen ? "flex" : "none";
  }

  private closeMenu() {
    this.menuOpen = false;
    this.menuEl.style.display = "none";
  }

  private refreshXpBar() {
    const { level, points } = questEngine.getLevelInfo();
    this.levelBadgeEl.textContent = `C${level}`;
    const pct = Phaser.Math.Clamp((points / TOTAL_POINTS) * 100, 0, 100);
    this.xpFillEl.style.width = `${pct}%`;
    this.xpValueEl.textContent = `${points} PTS`;
  }

  private refreshNetDot() {
    const { status, lastError } = net.getStatus();
    const color = status === "connected" ? "var(--accent-green)" : status === "connecting" ? "var(--accent-amber)" : "var(--text-muted)";
    this.netDotEl.style.background = color;
    this.netDotEl.style.boxShadow = `0 0 4px ${color}`;
    const detail = status === "connected" ? "connected" : status === "connecting" ? "connecting…" : `disconnected${lastError ? ` — ${lastError}` : ""}`;
    this.netDotEl.title = `Multiplayer: ${detail}`;
  }

  private refreshPersistDot() {
    const { status, lastError } = persistenceStatus.get();
    const color: Record<PersistenceStatus, string> = { ok: "var(--accent-green)", guest: "var(--accent-amber)", error: "var(--accent-red)" };
    this.persistDotEl.style.background = color[status];
    this.persistDotEl.style.boxShadow = `0 0 4px ${color[status]}`;
    const detail =
      status === "ok"
        ? "signed in, progress saving"
        : status === "guest"
          ? "guest — sign up to save progress"
          : `signed in, but saving is failing${lastError ? ` — ${lastError}` : ""}`;
    this.persistDotEl.title = `Account: ${detail}`;
  }

  // §2 "The Gathering" — shown from 60 minutes before start through the
  // event's own duration, then hidden again; polled every 30s (see the
  // constructor's scene.time.addEvent) rather than every frame, since a
  // countdown that's only ever accurate to the minute doesn't need to.
  private refreshCountdownBanner() {
    const current = gathering.getCurrent();
    const minutes = gathering.getMinutesUntilStart();
    if (!current || minutes === null || minutes > 60) {
      this.countdownBannerEl.style.display = "none";
      return;
    }
    const endsAt = new Date(current.startsAt).getTime() + current.durationMin * 60000;
    if (Date.now() >= endsAt) {
      this.countdownBannerEl.style.display = "none";
      return;
    }
    this.countdownBannerTextEl.textContent =
      minutes > 0 ? `The Gathering begins in ${minutes} minute${minutes === 1 ? "" : "s"} — the Tavern.` : "The Gathering has begun — the Tavern.";
    this.countdownBannerEl.style.display = "block";
  }

  private refreshTracker() {
    // Guided Sequence (see guidedMode.ts) takes over the whole role this
    // method normally plays — the corner tracker stays fully hidden
    // while it's active, so the two never compete for the player's
    // attention (and there's nothing here for Q to toggle either, see
    // update()).
    const guidedStep = guidedMode.getCurrentStep();
    if (guidedMode.isActive() && guidedStep) {
      this.trackerEl.style.display = "none";
      this.guidedBannerLabelEl.textContent = guidedStep.label;
      this.guidedBannerEl.style.display = "block";
      return;
    }
    this.guidedBannerEl.style.display = "none";

    // Reset every render — only the LOCKED branch below re-enables this,
    // so a stale click target never lingers into an unrelated state
    // (the objective line is otherwise plain text, never clickable).
    this.trackerObjectiveEl.style.cursor = "";
    this.trackerObjectiveEl.onclick = null;

    const quest = questEngine.getActiveQuest();
    if (!quest) {
      // Between one quest completing and the player finding/accepting
      // the next one, getActiveQuest() is null — show that next quest's
      // nextHint (if it has one) rather than leaving the corner blank
      // with no clue what to do (see QuestDef.nextHint).
      const hint = questEngine.getNextHint();
      if (hint && this.trackerVisible) {
        this.trackerEl.style.display = "block";
        this.trackerTitleEl.textContent = "NEXT OBJECTIVE";
        this.trackerObjectiveEl.textContent = hint;
        this.trackerEvidenceRowEl.innerHTML = "";
        this.trackerCounterEl.textContent = "";
        return;
      }
      // Study-first inversion (see PLAN, section 4): nothing available
      // to accept either — if the reason is a quest sitting `locked`
      // behind its paired module's theory, say so explicitly rather
      // than leaving the corner blank (same reasoning as the nextHint
      // branch above). Picks the first such quest in QUEST_IDS order —
      // this content only ever has one theory-gated quest meaningfully
      // "next" at a time in the scripted demo path, so there's no need
      // for anything smarter than first-match.
      const lockedHint = this.nextLockedQuestHint();
      if (lockedHint && this.trackerVisible) {
        this.trackerEl.style.display = "block";
        this.trackerTitleEl.textContent = "LOCKED";
        this.trackerObjectiveEl.textContent = `Click here to complete "${lockedHint.title}" at the Academy →`;
        // Direct jump — click the objective line to open the Academy
        // straight to that module's theory instead of the hub (same
        // shortcut npc.ts's locked-quest dialogue offers).
        this.trackerObjectiveEl.style.cursor = "pointer";
        this.trackerObjectiveEl.onclick = () => academy.openToModule(lockedHint.id);
        this.trackerEvidenceRowEl.innerHTML = "";
        this.trackerCounterEl.textContent = "";
        return;
      }
      this.trackerEl.style.display = "none";
      return;
    }
    if (!this.trackerVisible) {
      this.trackerEl.style.display = "none";
      return;
    }
    const idx = questEngine.getActiveStepIndex();
    const step = quest.steps[idx];
    this.trackerEl.style.display = "block";
    this.trackerTitleEl.textContent = quest.title;
    this.trackerObjectiveEl.textContent = step?.objective ?? "";
    this.trackerCounterEl.textContent = `${idx + 1}/${quest.steps.length}`;

    this.trackerEvidenceRowEl.innerHTML = "";
    if (step?.evidence) {
      const evidence = step.evidence;
      this.trackerEvidenceRowEl.appendChild(
        el("button", {
          className: "btn btn--ghost",
          text: evidence.buttonLabel,
          style: { width: "100%" },
          on: { click: () => showImageOverlay(evidence.images, evidence.caption) },
        }),
      );
    } else if (step?.evidenceTables) {
      const evidenceTables = step.evidenceTables;
      this.trackerEvidenceRowEl.appendChild(
        el("button", {
          className: "btn btn--ghost",
          text: evidenceTables.buttonLabel,
          style: { width: "100%" },
          on: { click: () => showTableOverlay(evidenceTables.tabs, evidenceTables.caption) },
        }),
      );
    }
  }

  private refreshClock() {
    if (!questEngine.isActive(CLOCK_QUEST_ID)) {
      this.clockEl.style.display = "none";
      return;
    }
    const hours = questEngine.getClockHours();
    this.clockEl.style.display = "block";
    this.clockValueEl.textContent = `⏱ HOUR ${hours} OF 72`;
    this.clockEl.style.color = hours >= CLOCK_RED_AT ? "var(--accent-red)" : hours >= CLOCK_AMBER_AT ? "var(--accent-amber)" : "var(--accent-gold)";
  }

  // "Red flash on the clock" for a wrong-choice penalty — reuses the
  // same shake keyframe the quiz/card-drill wrong-answer states already
  // use, plus a momentary red border regardless of the clock's current
  // gold/amber/red color. Both reset after the shake completes — without
  // this the inline borderColor override sticks forever, since nothing
  // else ever touches it (refreshClock() only sets the text color).
  private flashClockPenalty() {
    this.clockEl.style.animation = "ds-shake 400ms ease-in-out";
    this.clockEl.style.borderColor = "var(--accent-red)";
    window.setTimeout(() => {
      this.clockEl.style.animation = "";
      this.clockEl.style.borderColor = "";
    }, 400);
  }

  private onPointsChanged(_points: number, delta: number) {
    this.refreshXpBar();
    this.showFloatingDelta(delta);
  }

  private showFloatingDelta(amount: number) {
    const deltaEl = el("div", {
      className: "ds-root",
      text: `+${amount}`,
      style: {
        position: "absolute",
        left: "24px",
        bottom: "60px",
        fontFamily: "var(--font-mono)",
        fontWeight: "700",
        fontSize: "16px",
        color: factionAccent(),
        animation: "ds-delta-float 1200ms ease-out forwards",
      },
    });
    document.getElementById("ui-root")!.appendChild(deltaEl);
    setTimeout(() => deltaEl.remove(), 1300);
  }

  private flashLevelUp() {
    const flashEl = el("div", {
      style: { position: "absolute", inset: "0", background: "var(--accent-gold)", opacity: "0", animation: "ds-levelup-flash 700ms ease-out forwards" },
    });
    document.getElementById("ui-root")!.appendChild(flashEl);
    setTimeout(() => flashEl.remove(), 800);
  }

  private showToast(message: string) {
    const toastEl = el("div", { className: "toast", text: message });
    this.toastStackEl.appendChild(toastEl);
    setTimeout(() => {
      toastEl.classList.add("toast--out");
      setTimeout(() => toastEl.remove(), 220);
    }, TOAST_DISMISS_MS);
  }

  // Mid-session guest upgrade — same email-capture panel Title.ts's
  // gate uses, floated over the game instead of replacing the screen.
  // The magic link is a real page navigation, so current progress gets
  // snapshotted into localStorage right before the OTP email sends
  // (see cloud/pendingUpgrade.ts) — Title.ts's boot() claims it back
  // and creates the profile+progress rows the next time the page loads
  // with a fresh authenticated session and no profile row yet.
  private openSaveRecordModal() {
    const backdrop = el("div", { className: "ui-backdrop", style: { pointerEvents: "auto" } });
    const modalWrap = el("div", {
      className: "ds-root",
      style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" },
    });

    const close = () => {
      backdrop.remove();
      modalWrap.remove();
    };

    const panel = buildEmailCapturePanel({
      heading: "Save Your Record",
      subline: "Turn this session into a permanent Founding Privacy Villager account.",
      buttonLabel: "Save & Continue Playing",
      showSkipLink: false,
      beforeAuthSubmit: () => {
        savePendingUpgrade({
          v: 1,
          name: getSession().name,
          spriteId: getSession().avatarId,
          faction: getSession().faction,
          questState: questEngine.serializeState(),
          moduleState: academy.serializeState(),
          dossierState: dossier.serializeState(),
        });
      },
      // Freezes player movement (Room.ts's uiOpen reads isUiLocked())
      // for exactly the async window this modal is doing real network
      // work — released in emailCapturePanel.ts's own try/finally, so a
      // network error or thrown exception mid-submit can't strand the
      // player frozen once the modal itself is still visibly open but
      // no longer doing anything.
      onSubmitStart: () => lockUi(),
      onSubmitEnd: () => unlockUi(),
      onFallback: (_email, waitlistOk) => {
        close();
        this.showToast(waitlistOk ? "Couldn't reach the account service — try again shortly." : "Couldn't reach the server — try again shortly.");
      },
    });
    panel.style.pointerEvents = "auto";

    backdrop.addEventListener("click", close);
    modalWrap.appendChild(panel);
    document.getElementById("ui-root")!.append(backdrop, modalWrap);
  }

  private showReveal(reveal: QuestStepReveal) {
    const backdrop = el("div", { className: "ui-backdrop", style: { pointerEvents: "auto" }, on: { click: () => close() } });
    const body = el("p", { className: "briefing__body", text: reveal.text ?? "" });
    if (reveal.color) body.style.color = reveal.color;

    const panel = el(
      "div",
      { className: "panel panel--glow ds-root", style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "560px", pointerEvents: "auto" } },
      [
        el("div", { className: "briefing" }, [
          el("div", { className: "briefing__header" }, [el("span", { className: "briefing__case", text: reveal.speaker ?? "INTEL" })]),
          el("hr", { className: "briefing__divider" }),
          body,
        ]),
        el("div", {
          text: "[E] or click to dismiss",
          style: { textAlign: "center", marginTop: "16px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)" },
        }),
      ],
    );

    const wrapper = el("div", { style: { position: "absolute", inset: "0" } }, [backdrop, panel]);
    document.getElementById("ui-root")!.appendChild(wrapper);

    const timeout = setTimeout(close, REVEAL_DISMISS_MS);
    function close() {
      clearTimeout(timeout);
      wrapper.remove();
    }
    panel.addEventListener("click", close);
  }

  // A standalone decision point tied to a reach_zone step rather than an
  // NPC conversation (see QuestStepChoice) — "The Night the Wall Fell"'s
  // fountain-crier beat is the only current example. Structurally a
  // sibling of showReveal(): same backdrop/panel, buttons instead of a
  // dismiss link. Picking an option calls resolveStepChoice(), which
  // fires its own "reveal" (if the option has a response) independently
  // of this panel — this one's only job is to close itself on pick.
  private showStepChoice(choice: QuestStepChoice) {
    const body = el("p", { className: "briefing__body", text: choice.prompt });
    const buttonRow = el(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "12px", marginTop: "16px" } },
      choice.options.map((option) =>
        el("button", {
          className: "btn btn--ghost",
          text: option.label,
          style: { width: "100%" },
          on: { click: () => resolve(option) },
        }),
      ),
    );

    const panel = el(
      "div",
      { className: "panel panel--glow ds-root", style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "560px", pointerEvents: "auto" } },
      [el("div", { className: "briefing" }, [el("div", { className: "briefing__header" }, [el("span", { className: "briefing__case", text: "DECISION" })]), el("hr", { className: "briefing__divider" }), body]), buttonRow],
    );

    const backdrop = el("div", { className: "ui-backdrop", style: { pointerEvents: "auto" } });
    const wrapper = el("div", { style: { position: "absolute", inset: "0" } }, [backdrop, panel]);
    document.getElementById("ui-root")!.appendChild(wrapper);

    function resolve(option: QuestStepChoiceOption) {
      wrapper.remove();
      questEngine.resolveStepChoice(option);
    }
  }
}
