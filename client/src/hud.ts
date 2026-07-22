import Phaser from "phaser";
import { el } from "./ui/dom";
import { showImageOverlay } from "./ui/imageOverlay";
import { showTableOverlay } from "./ui/tableOverlay";
import { questEngine, type QuestStepReveal, type QuestStepChoice, type QuestStepChoiceOption } from "./questEngine";
import { getSession } from "./session";
import { academy } from "./academy";
import { events } from "./events";
import { supabase } from "./cloud/supabaseClient";
import { isAuthenticated, hasPendingOtpRequest } from "./cloud/authState";
import { savePendingUpgrade } from "./cloud/pendingUpgrade";
import { buildEmailCapturePanel } from "./cloud/emailCapturePanel";
import { net } from "./net/NetClient";
import { persistenceStatus, type PersistenceStatus } from "./cloud/persistenceStatus";
import { lockUi, unlockUi } from "./cloud/uiLock";

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
// 200. (The Courthouse Trial's 400 used to be part of this — its
// content moved to the Academy, a parallel points source with its own
// per-track credential bars, not counted here.)
const TOTAL_POINTS = 850;

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

  private clockEl: HTMLElement;
  private clockValueEl: HTMLElement;

  private toastStackEl: HTMLElement;
  private qKey: Phaser.Input.Keyboard.Key;

  private netDotEl: HTMLElement;
  private persistDotEl: HTMLElement;

  constructor(scene: Phaser.Scene) {
    const root = document.getElementById("ui-root")!;

    // --- Top bar: Academy + Events buttons (top-left, always visible) ---
    // pointerEvents:"auto" on the row is load-bearing: #ui-root sets
    // pointer-events:none (see style.css) so any child is invisible to a
    // real mouse click unless something in its ancestry opts back in —
    // this button previously had no such opt-in and silently swallowed
    // every real click while still responding to synthetic .click() calls
    // in tests, which is why it looked "broken" only for actual players.
    const academyBtnEl = el("button", {
      className: "btn btn--ghost",
      text: "\u{1F4D6} ACADEMY",
      on: { click: () => academy.toggle() },
    });
    const eventsBtnEl = el("button", {
      className: "btn btn--ghost",
      text: "\u{1F3AC} EVENTS",
      on: { click: () => events.toggle() },
    });
    const topBarEl = el(
      "div",
      { className: "ds-root", style: { position: "absolute", top: "24px", left: "24px", display: "flex", gap: "12px", pointerEvents: "auto" } },
      [academyBtnEl, eventsBtnEl],
    );
    root.appendChild(topBarEl);

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
    root.appendChild(statusRowEl);

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
    root.appendChild(this.xpBarEl);

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
      root.appendChild(
        el(
          "div",
          { className: "ds-root", style: { position: "absolute", left: "24px", bottom: "56px", pointerEvents: "auto" } },
          [saveRecordBtnEl],
        ),
      );
    }

    // --- Quest tracker (top-right, Q toggles) ---
    this.trackerTitleEl = el("div", {
      style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "13px", letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--accent-gold)" },
    });
    this.trackerObjectiveEl = el("div", { style: { fontFamily: "var(--font-body)", fontSize: "14px", color: "var(--text-primary)", marginTop: "6px" } });
    this.trackerCounterEl = el("div", {
      style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", marginTop: "8px", textAlign: "right" },
    });
    this.trackerEvidenceRowEl = el("div", { style: { marginTop: "8px" } });
    this.trackerEl = el(
      "div",
      // pointerEvents:"auto" — same #ui-root opt-in fix as the top bar
      // above; the evidence button inside this panel was equally
      // unclickable for real users before this.
      { className: "panel ds-root", style: { position: "absolute", top: "24px", right: "24px", width: "280px", display: "none", pointerEvents: "auto" } },
      [this.trackerTitleEl, this.trackerObjectiveEl, this.trackerEvidenceRowEl, this.trackerCounterEl],
    );
    root.appendChild(this.trackerEl);

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
    root.appendChild(this.clockEl);

    // --- Toast stack (bottom-right) ---
    this.toastStackEl = el("div", {
      className: "ds-root",
      style: { position: "absolute", right: "24px", bottom: "24px", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px" },
    });
    root.appendChild(this.toastStackEl);

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

    this.refreshXpBar();
    this.refreshTracker();
    this.refreshClock();
  }

  update() {
    if (Phaser.Input.Keyboard.JustDown(this.qKey)) {
      this.trackerVisible = !this.trackerVisible;
      this.refreshTracker();
    }
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

  private refreshTracker() {
    const quest = questEngine.getActiveQuest();
    if (!quest || !this.trackerVisible) {
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
