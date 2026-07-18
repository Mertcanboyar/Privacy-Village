import Phaser from "phaser";
import { addDriftingBackground } from "./drift";
import { el, typewriter, type TypewriterHandle } from "../ui/dom";
import { playSound } from "../audio";
import { AVATAR_OPTIONS, setSession, type Faction } from "../session";

// Combined avatar + name + faction screen (see PLAN.md Phase 2, Days 1
// and 3). Avatar options render as plain <img> tags pointing at the
// existing sprite PNGs — simpler than syncing Phaser sprites to DOM
// overlay positions for what's just a picker of static images.

const NAME_LIST = ["Portia", "Cicero", "Selden", "Themis", "Aurelia", "Marcus"];

const RECRUITER_LINE =
  "Welcome to Privacy Village, {name}! Here, ideas spark, creativity flows, and privacy pros gather for workshops, gamified adventures, and real problems worth solving. Before you pass the gates — tell us which spark lights your path.";
const RECRUITER_CLOSING = "Lovely to have you. Follow the lantern-light in — the village, and all its puzzles, await.";

export class CharacterCreate extends Phaser.Scene {
  private overlayEl!: HTMLElement;
  private nameInputEl!: HTMLInputElement;
  private confirmBtn!: HTMLButtonElement;
  private avatarEls = new Map<string, HTMLElement>();
  private selectedAvatarId = AVATAR_OPTIONS[0].id;
  private nameValue = "";
  private eKey!: Phaser.Input.Keyboard.Key;
  private currentTypewriter: TypewriterHandle | null = null;
  private awaitingSpawn = false;

  constructor() {
    super("CharacterCreate");
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

    this.nameInputEl = el("input", {
      attrs: { type: "text", maxlength: "16", placeholder: "Your name" },
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
      this.buildFactionButton("fundamentalist", "btn--gold", "AI Optimist", "Machines can be taught — the future is bright, if we build it with care."),
      this.buildFactionButton("apocalypse", "btn--danger", "AI Skeptic", "Machines must be watched closely — every safeguard matters."),
    ]);
    dialogue.appendChild(buttonRow);
  }

  private buildFactionButton(faction: Faction, variant: string, label: string, subtitle: string): HTMLElement {
    return el(
      "button",
      {
        className: `btn ${variant}`,
        style: { flex: "1", flexDirection: "column", gap: "6px", padding: "16px", height: "auto", whiteSpace: "normal" },
        on: { click: () => this.chooseFaction(faction) },
      },
      [el("div", { text: label }), el("div", { style: { fontFamily: "var(--font-body)", fontWeight: "400", textTransform: "none", letterSpacing: "normal", fontSize: "12px", opacity: "0.85" }, text: subtitle })],
    );
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

  private spawn() {
    this.currentTypewriter = null;
    this.cameras.main.fadeOut(400, 10, 10, 15);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start("Room", { room: "village" });
      this.scene.launch("UIOverlay");
    });
  }
}
