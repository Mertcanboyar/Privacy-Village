import { el } from "./dom";

// Full-screen data-table evidence viewer — "The Innkeeper's Shards"
// evidence is tables, not images (unlike imageOverlay.ts's blueprint/
// dossier), so it needs its own overlay rather than stretching the
// image viewer's zoom/pan machinery to fit. Same DOM-over-Phaser
// pattern as everything else in #ui-root.

export interface EvidenceTableTab {
  label: string;
  columns: string[];
  rows: string[][];
}

// Same openCount convention as imageOverlay.ts's isImageOverlayOpen() —
// lets other ESC/E handlers (NPCController's advance(), the Academy's
// close()) tell whether this overlay is the one that should consume the
// keypress.
let openCount = 0;

export function isTableOverlayOpen(): boolean {
  return openCount > 0;
}

export function showTableOverlay(tabs: EvidenceTableTab[], caption: string) {
  openCount++;
  let activeIndex = 0;
  let tabButtons: HTMLElement[] = [];

  const tableHost = el("div", { className: "evidence-table" });

  function renderActiveTable() {
    tableHost.innerHTML = "";
    const tab = tabs[activeIndex];
    tableHost.appendChild(
      el("table", {}, [
        el("thead", {}, [el("tr", {}, tab.columns.map((col) => el("th", { text: col })))]),
        el("tbody", {}, tab.rows.map((row) => el("tr", {}, row.map((cell) => el("td", { text: cell }))))),
      ]),
    );
  }

  function selectTab(i: number) {
    activeIndex = i;
    renderActiveTable();
    tabButtons.forEach((btn, idx) => {
      btn.classList.toggle("btn--gold", idx === i);
      btn.classList.toggle("btn--ghost", idx !== i);
    });
  }

  const panelChildren: HTMLElement[] = [];
  if (tabs.length > 1) {
    tabButtons = tabs.map((tab, i) =>
      el("button", {
        className: `btn ${i === 0 ? "btn--gold" : "btn--ghost"}`,
        text: tab.label,
        style: { fontSize: "12px", padding: "8px 16px" },
        on: { click: () => selectTab(i) },
      }),
    );
    panelChildren.push(el("div", { style: { display: "flex", gap: "8px", marginBottom: "16px" } }, tabButtons));
  }
  panelChildren.push(tableHost);
  renderActiveTable();

  const panel = el(
    "div",
    {
      className: "panel panel--glow ds-root",
      style: {
        // Fixed px, not vh/vw — #ui-root is a static 1280x720 box (see
        // style.css), not scaled to the true browser viewport.
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: "900px",
        maxHeight: "560px",
        overflowY: "auto",
        pointerEvents: "auto",
      },
    },
    panelChildren,
  );

  const wrapper = el("div", {
    className: "ui-backdrop ds-root",
    style: { position: "absolute", inset: "0", pointerEvents: "auto", zIndex: "1000" },
    on: { click: (e) => e.target === wrapper && close() },
  });
  wrapper.append(
    el("div", {
      text: caption,
      style: {
        position: "absolute",
        top: "24px",
        left: "50%",
        transform: "translateX(-50%)",
        fontFamily: "var(--font-mono)",
        fontSize: "13px",
        fontWeight: "700",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--accent-blue)",
      },
    }),
    panel,
    el("div", {
      text: "[E] or click outside to close",
      style: { position: "absolute", bottom: "24px", left: "50%", transform: "translateX(-50%)", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)" },
    }),
  );

  document.getElementById("ui-root")!.appendChild(wrapper);

  function close() {
    openCount--;
    document.removeEventListener("keydown", onKeydown);
    wrapper.remove();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "e" || e.key === "E" || e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKeydown);
}
