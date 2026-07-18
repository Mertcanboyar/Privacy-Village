import Phaser from "phaser";
import { el } from "./ui/dom";
import { showImageOverlay } from "./ui/imageOverlay";
import { showTableOverlay } from "./ui/tableOverlay";
import { questEngine, type QuestStepReveal } from "./questEngine";
import { getSession } from "./session";
import { academy } from "./academy";
import { events } from "./events";

// Persistent HUD (see PLAN.md Phase 2, Day 3) — .xp-bar, quest tracker,
// and toast stack from design-system.css, wired to questEngine's events
// for the first time. Lives in UIOverlay.ts specifically because that
// scene is scene.launch()'d once and never scene.restart()'d on room
// transitions, unlike Room.ts — the only scene that actually persists
// the way a HUD needs to.

const TOAST_DISMISS_MS = 3000;
const REVEAL_DISMISS_MS = 5000;

// Cosmetic only — the .xp-bar fill is just points/TOTAL_POINTS, it no
// longer gates Clearance (see questEngine.ts's setClearance()). Sum of
// every payout in the village demo path: Welcome 50 + Breach M1 150 +
// Breach M2 150 + Shards M1 150 + Shards M2 150. (The Courthouse
// Trial's 400 used to be part of this — its content moved to the
// Academy, a parallel points source with its own per-track credential
// bars, not counted here.)
const TOTAL_POINTS = 650;

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

  private toastStackEl: HTMLElement;
  private qKey: Phaser.Input.Keyboard.Key;

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
    questEngine.on("questUpdated", () => this.refreshTracker());
    questEngine.on("reveal", (reveal: QuestStepReveal) => this.showReveal(reveal));
    academy.on("toast", (message: string) => this.showToast(message));

    this.refreshXpBar();
    this.refreshTracker();
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

  private showReveal(reveal: QuestStepReveal) {
    const backdrop = el("div", { className: "ui-backdrop", style: { pointerEvents: "auto" }, on: { click: () => close() } });
    const body = el("p", { className: "briefing__body", text: reveal.text ?? "" });
    if (reveal.color) body.style.color = reveal.color;

    const panel = el(
      "div",
      { className: "panel panel--glow ds-root", style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "560px", pointerEvents: "auto" } },
      [
        el("div", { className: "briefing" }, [
          el("div", { className: "briefing__header" }, [el("span", { className: "briefing__case", text: "INTEL" })]),
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
}
