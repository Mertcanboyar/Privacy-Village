// Standalone component catalog — no Phaser, just the design system applied
// to dummy quest content. Served at /ui-kit.html. Every component from
// design-system.css gets one labeled example here so the whole system can
// be reviewed in a single screenshot.
import { el, typewriter, countUp } from "./ui/dom";

const root = document.getElementById("kit-root")!;

function section(label: string, ...children: (Node | string)[]) {
  return el("div", { className: "kit-section" }, [el("div", { className: "kit-section__label", text: label }), ...children]);
}

root.append(
  el("h1", { className: "kit-title", text: "Privacy Village — UI Kit" }),
  el("p", { className: "kit-subtitle", text: "Design tokens + component catalog. Boot.dev-inspired gamified dark UI." }),
);

// 1. Panels ------------------------------------------------------------
root.append(
  section(
    "1 · Panel",
    el("div", { className: "kit-row" }, [
      el("div", { className: "panel", style: { width: "260px" } }, [
        el("div", { style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "16px" }, text: "Base panel" }),
        el("div", { style: { fontFamily: "var(--font-body)", fontSize: "14px", color: "var(--text-muted)", marginTop: "8px" }, text: "bg-panel, 2px border, hard shadow." }),
      ]),
      el("div", { className: "panel panel--glow", style: { width: "260px" } }, [
        el("div", { style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "16px" }, text: "panel--glow" }),
        el("div", { style: { fontFamily: "var(--font-body)", fontSize: "14px", color: "var(--text-muted)", marginTop: "8px" }, text: "Accent-blue outer glow for case/magical content." }),
      ]),
    ]),
  ),
);

// 2. Buttons -------------------------------------------------------------
root.append(
  section(
    "2 · Buttons",
    el("div", { className: "kit-row" }, [
      el("button", { className: "btn btn--gold", text: "Begin Case" }),
      el("button", { className: "btn btn--ghost", text: "Cancel" }),
      el("button", { className: "btn btn--danger", text: "Delete" }),
    ]),
  ),
);

// 3. Quest card ------------------------------------------------------------
root.append(
  section(
    "3 · Quest Card",
    el("div", { className: "quest-card", style: { maxWidth: "460px" } }, [
      el("div", { className: "quest-card__icon" }),
      el("div", { className: "quest-card__info" }, [
        el("div", { className: "quest-card__title", text: "Case #004: AI Vendor Audit" }),
        el("div", { className: "quest-card__desc", text: "Review the chatbot vendor's data handling practices." }),
      ]),
      el("div", { className: "quest-card__meta" }, [
        el("span", { className: "quest-card__xp", text: "+250 XP" }),
        el("span", { className: "chip", text: "MEDIUM" }),
      ]),
    ]),
  ),
);

// 4. Briefing + chips ------------------------------------------------------
root.append(
  section(
    "4 · Briefing",
    el("div", { className: "panel panel--glow", style: { maxWidth: "640px" } }, [
      el("div", { className: "briefing" }, [
        el("div", { className: "briefing__header" }, [
          el("span", { className: "briefing__case", text: "CASE #004-AI" }),
          el("h2", { className: "briefing__title", text: "AI Vendor Chatbot Audit" }),
        ]),
        el("hr", { className: "briefing__divider" }),
        el("p", {
          className: "briefing__body",
          text: "A city council has deployed a third-party chatbot to triage resident support requests. Determine whether the vendor's data processing agreement satisfies Article 28 requirements before renewal.",
        }),
        el("div", { className: "briefing__meta" }, [
          el("span", { className: "chip", text: "EU AI ACT" }),
          el("span", { className: "chip", text: "ANNEX III" }),
          el("span", { className: "chip", text: "45 MIN" }),
        ]),
      ]),
    ]),
  ),
);

// 5. Dialogue (typewriter demo) ---------------------------------------------
const dialogueBody = el("div", { className: "dialogue__body" });
const dialogueHint = el("div", { className: "dialogue__continue" });
const dialogueLine = "Hear ye! The Courthouse has urgent business today — seek the doors if you wish to serve as arbiter.";

function playDialogue() {
  dialogueHint.textContent = "";
  typewriter(dialogueBody, dialogueLine, 18, () => {
    dialogueHint.textContent = "▸ CONTINUE";
  });
}

root.append(
  section(
    "5 · Dialogue",
    el("div", { className: "dialogue", style: { position: "relative", maxWidth: "640px" } }, [
      el("div", { className: "dialogue__name", text: "Herald" }),
      dialogueBody,
      dialogueHint,
    ]),
    el("button", { className: "btn btn--ghost", text: "Replay typewriter", style: { marginTop: "12px" }, on: { click: playDialogue } }),
  ),
);
playDialogue();

// 6. XP bar --------------------------------------------------------------
root.append(
  section(
    "6 · XP Bar",
    el("div", { className: "xp-bar", style: { maxWidth: "420px" } }, [
      el("div", { className: "level-badge", text: "L3" }),
      el("div", { className: "xp-bar__track" }, [el("div", { className: "xp-bar__fill", style: { width: "64%" } })]),
      el("div", { className: "xp-bar__value", text: "640 / 1000" }),
    ]),
  ),
);

// 7. Meters ----------------------------------------------------------------
root.append(
  section(
    "7 · Meters",
    el("div", { style: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "420px" } }, [
      el("div", { className: "meter" }, [
        el("div", { className: "meter__label", text: "Legal Risk" }),
        el("div", { className: "meter__track" }, [el("div", { className: "meter__fill meter__fill--risk", style: { width: "42%" } })]),
        el("div", { className: "meter__delta meter__delta--down", text: "-12" }),
      ]),
      el("div", { className: "meter" }, [
        el("div", { className: "meter__label", text: "User Trust" }),
        el("div", { className: "meter__track" }, [el("div", { className: "meter__fill", style: { width: "78%" } })]),
        el("div", { className: "meter__delta meter__delta--up", text: "+8" }),
      ]),
    ]),
  ),
);

// 8. Badge popup -------------------------------------------------------------
const badgeXp = el("span", { text: "0" });
const badgeIconWrap = el("div");
badgeIconWrap.innerHTML =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 15.27l-5.2 2.74.99-5.79-4.21-4.1 5.82-.85L12 2z" stroke-linejoin="round"/></svg>';

root.append(
  section(
    "8 · Badge Popup",
    el("div", { className: "badge-popup", style: { position: "relative" } }, [
      el("div", { className: "badge-popup__icon" }, [badgeIconWrap.firstElementChild!]),
      el("div", { className: "badge-popup__label", text: "Trial Complete" }),
      el("div", { className: "badge-popup__name", text: "Data Classification Novice" }),
      el("div", { className: "badge-popup__xp" }, [badgeXp, el("span", { text: "XP" })]),
    ]),
  ),
);
countUp(badgeXp, 0, 180, 900);

// 9. Toast -------------------------------------------------------------------
root.append(section("9 · Toast", el("div", { className: "toast", text: "Quest updated" })));

// 10. Leaderboard --------------------------------------------------------
const leaderboardRows: [number, string, string][] = [
  [1, "Anna J.", "1,240 XP"],
  [2, "Marcus T.", "1,105 XP"],
  [3, "Priya K.", "980 XP"],
  [4, "Jonas W.", "760 XP"],
];

root.append(
  section(
    "10 · Leaderboard Row",
    el(
      "div",
      { className: "panel", style: { maxWidth: "420px", padding: "0" } },
      leaderboardRows.map(([rank, name, xp]) =>
        el("div", { className: "leaderboard-row", style: { padding: "12px 20px" } }, [
          el("span", { className: `leaderboard-row__rank${rank <= 3 ? " leaderboard-row__rank--top" : ""}`, text: String(rank) }),
          el("span", { className: "leaderboard-row__avatar" }),
          el("span", { className: "leaderboard-row__name", text: name }),
          el("span", { className: "leaderboard-row__xp", text: xp }),
        ]),
      ),
    ),
  ),
);

// Supporting: drag-card / drop-zone ---------------------------------------
root.append(
  section(
    "Supporting · Drag Card / Drop Zone",
    el("div", { style: { position: "relative", height: "160px", maxWidth: "640px" } }, [
      el("div", { className: "drag-card", style: { left: "50%", top: "20px", transform: "translate(-50%, -50%)" }, text: "Full Name" }),
      el("div", { style: { position: "absolute", left: "0", right: "0", bottom: "0", display: "flex", gap: "16px", height: "100px" } }, [
        el("div", { className: "drop-zone drop-zone--not_personal", style: { flex: "1" }, text: "Not Personal Data" }),
        el("div", { className: "drop-zone drop-zone--personal drop-zone--hover", style: { flex: "1" }, text: "Personal Data" }),
        el("div", { className: "drop-zone drop-zone--sensitive", style: { flex: "1" }, text: "Special Category (Sensitive)" }),
      ]),
    ]),
  ),
);
