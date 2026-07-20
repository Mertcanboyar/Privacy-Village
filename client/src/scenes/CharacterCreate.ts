import Phaser from "phaser";
import { addDriftingBackground } from "./drift";
import { el, typewriter, type TypewriterHandle } from "../ui/dom";
import { playSound } from "../audio";
import { AVATAR_OPTIONS, setSession, getSession, type Faction } from "../session";
import { getCurrentUserId } from "../cloud/authState";
import { createProfileAndProgress } from "../cloud/profile";
import { questEngine } from "../questEngine";
import { academy } from "../academy";

// Combined avatar + name + faction screen (see PLAN.md Phase 2, Days 1
// and 3). Avatar options render as plain <img> tags pointing at the
// existing sprite PNGs — simpler than syncing Phaser sprites to DOM
// overlay positions for what's just a picker of static images.

const NAME_LIST = ["Portia", "Cicero", "Selden", "Themis", "Aurelia", "Marcus"];

const RECRUITER_LINE =
  "Welcome to Privacy Village, {name}! Here, ideas spark, creativity flows, and privacy pros gather for workshops, gamified adventures, and real problems worth solving. Before you pass the gates — tell us which spark lights your path.";
const RECRUITER_CLOSING = "Lovely to have you. Follow the lantern-light in — the village, and all its puzzles, await.";

interface CharacterCreateInitData {
  // Set when Title's waitlist gate collects an email — pre-fills the name
  // field with the capitalized local part rather than leaving it blank.
  prefillName?: string;
  // Set when Title's boot() found a live Supabase session with no
  // profile row yet (a first-time signup, not a guest) — on spawn(),
  // this creates the profile + progress rows instead of just entering
  // as a guest. See cloud/profile.ts.
  authenticated?: boolean;
}

export class CharacterCreate extends Phaser.Scene {
  private overlayEl!: HTMLElement;
  private nameInputEl!: HTMLInputElement;
  private confirmBtn!: HTMLButtonElement;
  private avatarEls = new Map<string, HTMLElement>();
  private selectedAvatarId = AVATAR_OPTIONS[0].id;
  private nameValue = "";
  private prefillName = "";
  private authenticated = false;
  private eKey!: Phaser.Input.Keyboard.Key;
  private currentTypewriter: TypewriterHandle | null = null;
  private awaitingSpawn = false;

  constructor() {
    super("CharacterCreate");
  }

  init(data: CharacterCreateInitData) {
    this.prefillName = data?.prefillName ?? "";
    this.authenticated = data?.authenticated ?? false;
  }

  create() {
    addDriftingBackground(this);
    this.eKey = this.input.keyboard!.addKey("E");

    this.overlayEl = el("div", {
      className: "ds-root",
      style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "auto" },
    });
    document.getElementById("ui-root")!.appendChild(this.overlayEl);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.overlayEl.remove());

    this.showAvatarForm();
  }

  private showAvatarForm() {
    this.overlayEl.innerHTML = "";

    const avatarRow = el(
      "div",
      { style: { display: "flex", gap: "16px", marginTop: "8px", marginBottom: "24px" } },
      AVATAR_OPTIONS.map((opt) => {
        const card = el(
          "div",
          { className: "avatar-option", on: { click: () => this.selectAvatar(opt.id) } },
          [el("img", { attrs: { src: opt.imageSrc, alt: opt.label } }), el("span", { text: opt.label })],
        );
        this.avatarEls.set(opt.id, card);
        return card;
      }),
    );

    this.nameValue = this.prefillName;

    this.nameInputEl = el("input", {
      attrs: { type: "text", maxlength: "16", placeholder: "Your name", value: this.prefillName },
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: "16px",
        padding: "10px 14px",
        borderRadius: "var(--radius-sm)",
        border: "2px solid var(--border-strong)",
        background: "var(--bg-raised)",
        color: "var(--text-primary)",
        textAlign: "center",
        width: "220px",
      },
      on: {
        input: (e) => {
          this.nameValue = (e.target as HTMLInputElement).value;
          this.updateConfirmState();
        },
      },
    });

    const diceBtn = el("button", {
      className: "btn btn--ghost",
      text: "🎲 Randomize",
      style: { marginTop: "16px" },
      on: { click: () => this.randomize() },
    });

    this.confirmBtn = el("button", {
      className: "btn btn--gold",
      text: "Confirm",
      style: { marginTop: "16px", marginLeft: "12px" },
      on: { click: () => this.confirm() },
    });

    const panel = el(
      "div",
      { className: "panel", style: { display: "flex", flexDirection: "column", alignItems: "center", padding: "32px 40px" } },
      [
        el("p", {
          text: "The village keeper welcomes you and notes your name for the festival roll.",
          style: { fontFamily: "var(--font-body)", color: "var(--text-muted)", margin: "0 0 20px" },
        }),
        avatarRow,
        this.nameInputEl,
        el("div", {}, [diceBtn, this.confirmBtn]),
      ],
    );

    this.overlayEl.appendChild(panel);
    this.selectAvatar(this.selectedAvatarId);
    this.updateConfirmState();
  }

  private selectAvatar(id: string) {
    this.selectedAvatarId = id;
    for (const [optId, cardEl] of this.avatarEls) {
      cardEl.classList.toggle("avatar-option--selected", optId === id);
    }
  }

  private updateConfirmState() {
    this.confirmBtn.disabled = this.nameValue.trim().length === 0;
  }

  private randomize() {
    playSound("dice");
    const avatar = Phaser.Utils.Array.GetRandom(AVATAR_OPTIONS);
    const name = Phaser.Utils.Array.GetRandom(NAME_LIST);
    this.selectAvatar(avatar.id);
    this.nameInputEl.value = name;
    this.nameValue = name;
    this.updateConfirmState();
  }

  private confirm() {
    const name = this.nameValue.trim();
    if (!name) return;

    setSession({ name, avatarId: this.selectedAvatarId });
    this.showRecruiter();
  }

  // --- Welcome Keeper / path selection (Day 3) --------------------------

  private showRecruiter() {
    this.overlayEl.innerHTML = "";

    const backdrop = el("div", { className: "ui-backdrop" });
    const nameTab = el("div", { className: "dialogue__name", text: "Keeper" });
    const body = el("div", { className: "dialogue__body" });
    const dialogue = el("div", { className: "dialogue", style: { position: "relative", width: "640px" } }, [nameTab, body]);

    this.overlayEl.append(backdrop, dialogue);

    const line = RECRUITER_LINE.replace("{name}", this.nameValue.trim());
    this.currentTypewriter = typewriter(body, line, 18, () => this.showFactionChoices(dialogue));
  }

  private showFactionChoices(dialogue: HTMLElement) {
    const buttonRow = el("div", { style: { display: "flex", gap: "16px", marginTop: "20px" } }, [
      this.buildFactionOption(
        "fundamentalist",
        "btn--gold",
        "AI Fundamentalist",
        "Machines can be taught — the future is bright, if we build it with care.",
        "https://www.privacyvillage.org/AI-Fundamentalist-Faction-HQ-541d2072ad1a45e3b8746636eef57bf8",
      ),
      this.buildFactionOption(
        "apocalypse",
        "btn--danger",
        "AI Apocalypse",
        "Machines must be watched closely — every safeguard matters.",
        "https://www.privacyvillage.org/AI-Apocalypse-Faction-HQ-166f281b24208038a791e79bb6a0bf10",
      ),
    ]);
    dialogue.appendChild(buttonRow);
  }

  // A <button> can't contain an <a> (invalid HTML, and the link's clicks
  // would bubble into the button's own onclick) — so the lore link is a
  // sibling below the button, not nested inside it, wrapped in a shared
  // flex column so the pair still reads as one faction's info block.
  private buildFactionOption(faction: Faction, variant: string, label: string, subtitle: string, loreUrl: string): HTMLElement {
    const button = el(
      "button",
      {
        className: `btn ${variant}`,
        style: { flexDirection: "column", gap: "6px", padding: "16px", height: "auto", width: "100%", whiteSpace: "normal" },
        on: { click: () => this.chooseFaction(faction) },
      },
      [el("div", { text: label }), el("div", { style: { fontFamily: "var(--font-body)", fontWeight: "400", textTransform: "none", letterSpacing: "normal", fontSize: "12px", opacity: "0.85" }, text: subtitle })],
    );

    const loreLink = el("a", {
      text: "Learn more about the faction lore →",
      attrs: { href: loreUrl, target: "_blank", rel: "noopener noreferrer" },
      style: {
        display: "block",
        marginTop: "8px",
        textAlign: "center",
        fontFamily: "var(--font-mono)",
        fontSize: "11px",
        color: "var(--text-muted)",
        textDecoration: "none",
      },
    });

    return el("div", { style: { flex: "1", display: "flex", flexDirection: "column" } }, [button, loreLink]);
  }

  private chooseFaction(faction: Faction) {
    playSound("quill-scratch");
    setSession({ faction });
    this.showRecruiterClosing();
  }

  private showRecruiterClosing() {
    this.overlayEl.innerHTML = "";
    const nameTab = el("div", { className: "dialogue__name", text: "Keeper" });
    const body = el("div", { className: "dialogue__body" });
    const hint = el("div", { className: "dialogue__continue" });
    const dialogue = el("div", { className: "dialogue", style: { position: "relative", width: "640px" } }, [nameTab, body, hint]);
    this.overlayEl.appendChild(dialogue);

    this.currentTypewriter = typewriter(body, RECRUITER_CLOSING, 18, () => {
      hint.textContent = "[E] ▸ ENTER THE VILLAGE";
      this.awaitingSpawn = true;
    });
  }

  update() {
    if (!Phaser.Input.Keyboard.JustDown(this.eKey)) return;

    if (this.currentTypewriter && !this.currentTypewriter.finished) {
      this.currentTypewriter.skip();
      return;
    }
    // Only the closing line's "finished" state should let E trigger the
    // spawn — the opening line also finishes typing, but what comes next
    // there is faction buttons (mouse-only), not a keyboard advance.
    if (this.awaitingSpawn) this.spawn();
  }

  private async spawn() {
    // Guards against E getting mashed during the fade-out re-firing this
    // (previously harmless when spawn() was just a scene transition —
    // now it would also mean a duplicate profile/progress insert below).
    if (!this.awaitingSpawn) return;
    this.awaitingSpawn = false;
    this.currentTypewriter = null;

    if (this.authenticated) {
      const userId = getCurrentUserId();
      if (userId) {
        await createProfileAndProgress(userId, {
          agentName: getSession().name,
          spriteId: getSession().avatarId,
          faction: getSession().faction,
          questState: questEngine.serializeState(),
          moduleState: academy.serializeState(),
          clearance: questEngine.getClearance(),
          xp: questEngine.getPoints(),
        });
      }
    }

    this.cameras.main.fadeOut(400, 10, 10, 15);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start("Room", { room: "village" });
      this.scene.launch("UIOverlay");
    });
  }
}
