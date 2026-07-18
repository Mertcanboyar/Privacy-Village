import Phaser from "phaser";
import { el } from "./ui/dom";
import { events, type EventVideo } from "./events";

// Full-screen DOM overlay for the Events panel — village-facing window
// onto the real Privacy Village YouTube channel (youtube.com/@PrivacyQuest).
// Same construction pattern as AcademyOverlay: a Scene-bound class whose
// constructor wires up all the DOM/event listeners it needs, instantiated
// once from UIOverlay.ts with no stored reference. Two views: a thumbnail
// grid and a "now playing" embed, swapped via a tiny local state machine
// (mirrors AcademyOverlay's currentView, just two states instead of six).
const FADE_MS = 200;

type EventsView = "grid" | "player";

export class EventsOverlay {
  private rootEl: HTMLElement;
  private backdropEl: HTMLElement;
  private stageEl: HTMLElement;
  private bodyEl: HTMLElement;
  private hideTimeout: number | undefined;

  private currentView: EventsView = "grid";
  private currentVideoId: string | null = null;

  constructor(_scene: Phaser.Scene) {
    const root = document.getElementById("ui-root")!;

    this.backdropEl = el("div", {
      style: { position: "absolute", inset: "0", background: "rgba(10, 10, 15, 0.6)", opacity: "0", transition: `opacity ${FADE_MS}ms ease` },
    });

    this.bodyEl = el("div", { className: "ds-root" });

    const closeBtn = el("button", {
      className: "btn btn--ghost ds-root",
      text: "RETURN TO VILLAGE",
      style: { position: "absolute", top: "24px", right: "24px" },
      on: { click: () => events.close() },
    });

    this.stageEl = el(
      "div",
      { className: "ds-root", style: { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", opacity: "0", transition: `opacity ${FADE_MS}ms ease` } },
      [this.bodyEl],
    );

    this.rootEl = el("div", { className: "ds-root", style: { position: "absolute", inset: "0", display: "none", pointerEvents: "auto" } }, [this.backdropEl, this.stageEl, closeBtn]);
    root.appendChild(this.rootEl);

    this.render();

    events.on("opened", () => {
      this.currentView = "grid";
      this.currentVideoId = null;
      this.render();
      this.show();
    });
    events.on("closed", () => this.hide());

    document.addEventListener("keydown", this.onKeydown);
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && events.isOpen) events.close();
  };

  private render() {
    this.bodyEl.innerHTML = "";
    if (this.currentView === "grid") this.renderGrid();
    else this.renderPlayer();
  }

  private renderGrid() {
    const header = el(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-3)" } },
      [
        el("div", {}, [
          el("h2", {
            text: "VILLAGE EVENTS",
            style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "24px", letterSpacing: "0.06em", textTransform: "uppercase" },
          }),
          el("div", {
            text: "Fireside chats, gaming nights, and dispatches from the real Privacy Village.",
            style: { fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-muted)", marginTop: "4px" },
          }),
        ]),
        el("a", {
          className: "btn btn--ghost",
          text: "@PrivacyQuest ↗",
          attrs: { href: "https://www.youtube.com/@PrivacyQuest", target: "_blank", rel: "noopener noreferrer" },
          style: { fontSize: "12px" },
        }),
      ],
    );

    const grid = el(
      "div",
      { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--space-3)" } },
      events.getVideos().map((video) => this.renderVideoCard(video)),
    );

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "820px", maxHeight: "640px", overflowY: "auto" } }, [header, grid]));
  }

  private renderVideoCard(video: EventVideo): HTMLElement {
    return el(
      "div",
      { className: "panel", style: { cursor: "pointer", padding: "0", overflow: "hidden" }, on: { click: () => this.goToPlayer(video.id) } },
      [
        el("img", {
          attrs: { src: video.thumbnail, alt: video.title, loading: "lazy" },
          style: { width: "100%", aspectRatio: "16 / 9", objectFit: "cover", display: "block", borderBottom: "2px solid var(--border-strong)" },
        }),
        el("div", { style: { padding: "var(--space-2)" } }, [
          el("div", {
            text: video.title,
            style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "13px", lineHeight: "1.35", height: "35px", overflow: "hidden" },
          }),
          el("div", {
            text: video.meta,
            style: { fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)", marginTop: "6px" },
          }),
        ]),
      ],
    );
  }

  private goToPlayer(videoId: string) {
    this.currentView = "player";
    this.currentVideoId = videoId;
    this.render();
  }

  private renderPlayer() {
    const video = events.getVideos().find((v) => v.id === this.currentVideoId);
    if (!video) {
      this.currentView = "grid";
      this.render();
      return;
    }

    const header = el("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" } }, [
      el("button", { className: "btn btn--ghost", text: "← BACK", on: { click: () => this.goToGrid() } }),
    ]);

    const player = el("div", { style: { position: "relative", width: "100%", aspectRatio: "16 / 9", borderRadius: "var(--radius-sm)", overflow: "hidden", border: "2px solid var(--border-strong)" } }, [
      el("iframe", {
        attrs: {
          src: `https://www.youtube.com/embed/${video.id}?rel=0`,
          title: video.title,
          allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
          allowfullscreen: "true",
          frameborder: "0",
        },
        style: { position: "absolute", inset: "0", width: "100%", height: "100%" },
      }),
    ]);

    const title = el("h3", { text: video.title, style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "18px", margin: "var(--space-3) 0 var(--space-2)" } });
    const meta = el("div", { text: video.meta, style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", marginBottom: "var(--space-2)" } });
    const description = el("p", { className: "briefing__body", text: video.description });
    const watchLink = el("a", {
      className: "btn btn--ghost",
      text: "WATCH ON YOUTUBE ↗",
      attrs: { href: `https://www.youtube.com/watch?v=${video.id}`, target: "_blank", rel: "noopener noreferrer" },
      style: { marginTop: "var(--space-3)" },
    });

    this.bodyEl.appendChild(el("div", { className: "panel panel--glow", style: { width: "720px", maxHeight: "640px", overflowY: "auto" } }, [header, player, title, meta, description, watchLink]));
  }

  private goToGrid() {
    this.currentView = "grid";
    this.currentVideoId = null;
    this.render();
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
