import Phaser from "phaser";
import { el } from "./ui/dom";
import { dossier } from "./dossier";
import { academy } from "./academy";
import { events } from "./events";
import { questEngine, QUEST_IDS } from "./questEngine";
import { getSession, getAvatarOption, factionColorFor } from "./session";
import { isAuthenticated } from "./cloud/authState";
import { isImageOverlayOpen } from "./ui/imageOverlay";

// Full-screen DOM overlay for the Agent Dossier — a three-tab
// progression page (DOSSIER/CODEX/JOURNEY) layered over the village,
// same shell pattern as academyOverlay.ts: dim+fade backdrop, movement
// lock (Room.ts reads dossier.isOpen), audio duck (dossier.ts itself).
// Opens via the HUD button or the P hotkey (no WASD/E collision, unlike
// Academy's "A").
//
// Scene-bound (constructed with UIOverlay, the one persistent scene)
// purely for consistency with every other overlay in this file's
// family — nothing here actually reaches into the Scene today.
const FADE_MS = 200;

type DossierTab = "dossier" | "codex" | "journey";

// Rank insignia — Clearance is a narrative ladder (see questEngine.ts's
// MILESTONE_IDS doc comment), the Dossier just needs a name for each
// rung. Clamped to this 7-name ladder for display even though the
// engine itself has no hard ceiling at 7 (more milestones have been
// added over time than the ladder was originally sized for) — a real,
// pre-existing quirk this file works around rather than "fixes",
// since uncapping Clearance itself is out of scope here.
const RANK_NAMES = ["Recruit", "Field Agent", "Ranger", "Senior Ranger", "Operative", "Division Handler", "Spymaster"];

function rankFor(clearance: number): string {
  const index = Phaser.Math.Clamp(clearance, 1, RANK_NAMES.length) - 1;
  return RANK_NAMES[index];
}

function factionLabel(faction: string | null): string {
  if (faction === "fundamentalist") return "AI Fundamentalist";
  if (faction === "apocalypse") return "AI Apocalypse";
  return "Unaligned";
}

export class DossierOverlay {
  private rootEl: HTMLElement;
  private backdropEl: HTMLElement;
  private stageEl: HTMLElement;
  private bodyEl: HTMLElement;
  private hideTimeout: number | undefined;

  private currentTab: DossierTab = "dossier";

  constructor(_scene: Phaser.Scene) {
    const root = document.getElementById("ui-root")!;

    this.backdropEl = el("div", {
      style: {
        position: "absolute",
        inset: "0",
        background: "rgba(10, 10, 15, 0.6)",
        opacity: "0",
        transition: `opacity ${FADE_MS}ms ease`,
      },
    });

    this.bodyEl = el("div", { className: "ds-root" });

    const closeBtn = el("button", {
      className: "btn btn--ghost ds-root",
      text: "RETURN TO VILLAGE",
      style: { position: "absolute", top: "24px", right: "24px" },
      on: { click: () => dossier.close() },
    });

    this.stageEl = el(
      "div",
      { className: "ds-root", style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", opacity: "0", transition: `opacity ${FADE_MS}ms ease` } },
      [this.bodyEl],
    );

    this.rootEl = el("div", { className: "ds-root", style: { position: "absolute", inset: "0", display: "none", pointerEvents: "auto" } }, [this.backdropEl, this.stageEl, closeBtn]);
    root.appendChild(this.rootEl);

    this.render();

    dossier.on("opened", () => {
      this.currentTab = "dossier";
      this.render();
      this.show();
    });
    dossier.on("closed", () => this.hide());
    // Live re-render on unlock/refresh events — the toast for a fresh
    // concept/title already fires from dossier.ts itself; this just
    // keeps whichever tab is showing in sync (e.g. a concept unlocking
    // while the Codex tab is open, mid-session).
    dossier.on("conceptUnlocked", () => this.render());
    dossier.on("titleUnlocked", () => this.render());
    dossier.on("activeTitleChanged", () => this.render());
    dossier.on("refreshed", () => this.render());

    document.addEventListener("keydown", this.onKeydown);
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && dossier.isOpen && !isImageOverlayOpen()) {
      dossier.close();
      return;
    }
    // "P" toggles the Dossier from anywhere in the village, same
    // no-hotkey-collision reasoning as "Q" (quest tracker, hud.ts) — a
    // letter that isn't WASD/E. Academy/Events have no hotkey of their
    // own, so a real click can never reach the Dossier's HUD button
    // while either is open (their full-screen backdrop covers it) —
    // but a keyboard listener doesn't care about DOM stacking, so this
    // guard is what stops "P" from popping the Dossier open ON TOP of
    // one of them. Also suppressed while any text field expects the
    // keystroke (chat.ts already stops propagation for its own input,
    // so this never fires while typing there regardless) or the
    // evidence-image viewer owns it.
    if (e.key.toLowerCase() === "p" && !academy.isOpen && !events.isOpen && !isImageOverlayOpen()) dossier.toggle();
  };

  private render() {
    this.bodyEl.innerHTML = "";
    const tabNav = this.renderTabNav();
    const content = this.currentTab === "dossier" ? this.renderDossierTab() : this.currentTab === "codex" ? this.renderCodexTab() : this.renderJourneyTab();
    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "760px", maxHeight: "660px", overflowY: "auto" } }, [tabNav, content]));
  }

  private goToTab(tab: DossierTab) {
    this.currentTab = tab;
    this.render();
  }

  private renderTabNav(): HTMLElement {
    const tabs: { id: DossierTab; label: string }[] = [
      { id: "dossier", label: "DOSSIER" },
      { id: "codex", label: "CODEX" },
      { id: "journey", label: "JOURNEY" },
    ];
    return el(
      "div",
      { style: { display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-3)" } },
      tabs.map((tab) =>
        el("button", {
          className: this.currentTab === tab.id ? "btn btn--gold" : "btn btn--ghost",
          text: tab.label,
          on: { click: () => this.goToTab(tab.id) },
        }),
      ),
    );
  }

  private renderDossierTab(): HTMLElement {
    return el("div", {}, [this.renderDossierHeader(), this.renderCredentialBars(), this.renderDecisionRecord(), this.renderSummaryStats()]);
  }

  private renderDossierHeader(): HTMLElement {
    const session = getSession();
    const avatar = getAvatarOption();
    const factionColor = factionColorFor(session.faction);
    const activeTitleDef = dossier.getActiveTitleDef();

    const avatarImg = el("img", {
      attrs: { src: avatar.imageSrc, alt: avatar.label },
      style: { width: "72px", height: "72px", objectFit: "contain", background: "var(--bg-raised)", borderRadius: "var(--radius-sm)", border: `2px solid ${factionColor}` },
    });

    const nameRow = el("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)" } }, [
      el("h2", { text: session.name, style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "22px", margin: "0" } }),
      el("span", {
        className: "chip",
        text: rankFor(questEngine.getClearance()).toUpperCase(),
        style: { borderColor: "var(--accent-gold)", color: "var(--accent-gold)" },
      }),
    ]);

    const factionChip = el("span", {
      text: factionLabel(session.faction).toUpperCase(),
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: "11px",
        letterSpacing: "0.06em",
        color: factionColor,
        border: `1px solid ${factionColor}`,
        borderRadius: "var(--radius-sm)",
        padding: "2px 8px",
        display: "inline-block",
        marginTop: "6px",
      },
    });

    const clearanceLine = el("div", {
      text: `CLEARANCE ${Math.min(questEngine.getClearance(), 7)} — ${rankFor(questEngine.getClearance())}`,
      style: { fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)", marginTop: "6px" },
    });

    const titleLine = el("div", {
      text: activeTitleDef ? activeTitleDef.name.toUpperCase() : "NO ACTIVE TITLE — SELECT ONE ON THE JOURNEY TAB",
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: "12px",
        letterSpacing: "0.06em",
        color: activeTitleDef ? "var(--accent-gold)" : "var(--text-muted)",
        marginTop: "8px",
      },
    });

    const guestNote = !isAuthenticated()
      ? el("div", {
          text: "Enlist to preserve your record — nothing here is saved for a guest.",
          style: { fontFamily: "var(--font-body)", fontSize: "12px", color: "var(--text-muted)", marginTop: "8px", fontStyle: "italic" },
        })
      : null;

    return el(
      "div",
      { style: { display: "flex", gap: "var(--space-3)", alignItems: "flex-start", marginBottom: "var(--space-3)" } },
      [avatarImg, el("div", {}, [nameRow, factionChip, clearanceLine, titleLine, ...(guestNote ? [guestNote] : [])])],
    );
  }

  private renderCredentialBars(): HTMLElement {
    const bars = academy.getAllTracks().map((track) => {
      const completed = academy.completedCount(track.id);
      const pct = track.moduleCount > 0 ? (completed / track.moduleCount) * 100 : 0;
      return el("div", { style: { marginBottom: "10px" } }, [
        el("div", { style: { display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px" } }, [
          el("span", { text: track.credential.toUpperCase() }),
          el("span", { text: `${completed}/${track.moduleCount} — ${Math.round(pct)}%` }),
        ]),
        el("div", { className: "xp-bar__track" }, [el("div", { className: "xp-bar__fill", style: { width: `${pct}%` } })]),
      ]);
    });
    return el("div", { className: "panel", style: { marginBottom: "var(--space-3)" } }, [
      el("h3", { text: "Credential Progress", style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "15px", margin: "0 0 var(--space-2)" } }),
      ...bars,
    ]);
  }

  private renderDecisionRecord(): HTMLElement {
    const log = dossier.getDecisionLog();
    const body: HTMLElement[] =
      log.length > 0
        ? log.map((entry) =>
            el("div", { style: { display: "flex", alignItems: "flex-start", gap: "8px", padding: "8px 0", borderBottom: "1px solid var(--border-strong)" } }, [
              entry.commendation
                ? el("span", { text: "★", style: { color: "var(--accent-gold)", flexShrink: "0" } })
                : el("span", { text: "·", style: { color: "var(--text-muted)", flexShrink: "0" } }),
              el("span", { text: entry.text, style: { fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-primary)" } }),
            ]),
          )
        : [
            el("div", {
              text: isAuthenticated() ? "No entries filed yet — the record fills in as you complete field work." : "Enlist to start a record — nothing is kept for a guest.",
              style: { fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-muted)", fontStyle: "italic" },
            }),
          ];

    return el("div", { className: "panel", style: { marginBottom: "var(--space-3)" } }, [
      el("h3", { text: "Decision Record", style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "15px", margin: "0 0 var(--space-2)" } }),
      el("div", {}, body),
    ]);
  }

  private renderSummaryStats(): HTMLElement {
    const questsCompleted = QUEST_IDS.filter((id) => questEngine.isComplete(id)).length;
    const modulesSealed = academy.getAllTracks().reduce((sum, track) => sum + academy.completedCount(track.id), 0);
    const conceptsMastered = dossier.getUnlockedConcepts().size;
    const conceptsTotal = dossier.getCodex().length;
    const commendations = dossier.countCommendations();
    const breachResponse = questEngine.isComplete("night_the_wall_fell") ? `${questEngine.getClockHours()}h` : "—";

    const stats: [string, string][] = [
      ["QUESTS COMPLETED", `${questsCompleted}/${QUEST_IDS.length}`],
      ["MODULES SEALED", `${modulesSealed}`],
      ["CONCEPTS MASTERED", `${conceptsMastered}/${conceptsTotal}`],
      ["COMMENDATIONS", `${commendations}`],
      ["AVG BREACH RESPONSE", breachResponse],
    ];

    return el(
      "div",
      { className: "panel", style: { display: "flex", flexWrap: "wrap", gap: "var(--space-3)" } },
      stats.map(([label, value]) =>
        el("div", {}, [
          el("div", { text: value, style: { fontFamily: "var(--font-mono)", fontSize: "18px", fontWeight: "700", color: "var(--accent-gold)" } }),
          el("div", { text: label, style: { fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.06em", color: "var(--text-muted)" } }),
        ]),
      ),
    );
  }

  private renderCodexTab(): HTMLElement {
    return el("div", { text: "The Codex — coming shortly." });
  }

  private renderJourneyTab(): HTMLElement {
    return el("div", { text: "The Journey — coming shortly." });
  }

  private show() {
    window.clearTimeout(this.hideTimeout);
    this.rootEl.style.display = "block";
    requestAnimationFrame(() => {
      this.backdropEl.style.opacity = "1";
      this.stageEl.style.opacity = "1";
    });
  }

  private hide() {
    this.backdropEl.style.opacity = "0";
    this.stageEl.style.opacity = "0";
    this.hideTimeout = window.setTimeout(() => {
      this.rootEl.style.display = "none";
    }, FADE_MS);
  }
}
