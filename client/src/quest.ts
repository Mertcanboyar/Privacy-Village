import Phaser from "phaser";
import type { RoomName } from "./rooms";
import { el, countUp } from "./ui/dom";
import { questEngine } from "./questEngine";

// The Courthouse case file — "Personal Data Classification Lab" (see
// PLAN.md Week 3). Content ported faithfully from the source DPIA Protocol
// project (~/Desktop/Cursor/DPIA Protocol/src/modules/personal-data-lab).
//
// UI is real DOM (design-system.css's .panel/.briefing/.badge-popup, plus
// the .drag-card/.drop-zone supporting classes) appended to #ui-root,
// floating over the Phaser canvas — see CLAUDE.md. Drag the item card into
// one of the 3 category zones, or press 1/2/3.

export type DataCategory = "not_personal" | "personal" | "sensitive";

interface DataItem {
  id: string;
  label: string;
  description: string;
  correctCategory: DataCategory;
  explanation: string;
}

interface Scenario {
  id: string;
  title: string;
  context: string;
  background: string;
  difficultyLabel: string;
  items: DataItem[];
}

const CATEGORY_META: Record<DataCategory, { label: string }> = {
  not_personal: { label: "Not Personal Data" },
  personal: { label: "Personal Data" },
  sensitive: { label: "Special Category (Sensitive)" },
};

const SCENARIOS: Scenario[] = [
  {
    id: "hr_onboarding",
    title: "HR Onboarding Platform",
    difficultyLabel: "Level 1 · Easy",
    context:
      'TechCorp is a 2,000-employee software company headquartered in Munich, Germany. They are rolling out a new digital onboarding system called "TechStart" to replace their paper-based process. HR has uploaded a range of data fields about incoming hires into the system — from basic contact details to canteen preferences.',
    background:
      "As the Data Protection Officer, you have been asked to review four data fields before TechStart goes live next Monday. Classify each field as Personal Data, Special Category (Sensitive) Data, or Not Personal Data under GDPR. Get this wrong, and the company risks processing sensitive data without the proper Art. 9 safeguards.",
    items: [
      {
        id: "hr_name",
        label: "Full Name",
        description: "Employee's first and last name as printed on the offer letter.",
        correctCategory: "personal",
        explanation: "A full name directly identifies a natural person — classic personal data under Art. 4(1) GDPR.",
      },
      {
        id: "hr_dietary",
        label: "Canteen Dietary Preference",
        description: 'Employee selects "Kosher" for the welcome lunch menu on their first day.',
        correctCategory: "sensitive",
        explanation:
          'Selecting "Kosher" reveals a religious belief. Even though it was collected for catering, data revealing religious beliefs is special-category data under Art. 9(1).',
      },
      {
        id: "hr_company_policy",
        label: "Employee Handbook",
        description: "Standard 40-page company policy document given to all new hires. Identical for everyone.",
        correctCategory: "not_personal",
        explanation: "A generic policy document contains no information relating to any identifiable individual. It's company-level documentation.",
      },
      {
        id: "hr_email",
        label: "Corporate Email Address",
        description: "anna.jones@techcorp.com — auto-generated when the account is created on Day 1.",
        correctCategory: "personal",
        explanation: "An email containing a person's name directly identifies them. Even generic emails (info@) can be personal data if they route to one individual.",
      },
    ],
  },
  {
    id: "hospital_portal",
    title: "Hospital Patient Portal",
    difficultyLabel: "Level 2 · Medium",
    context:
      'City General Hospital in Amsterdam is launching "MijnGezondheid" — a patient-facing web portal where patients can view their medical records, book appointments, download test results, and share reports with their GP. The portal is expected to serve 80,000 patients across the Netherlands.',
    background:
      "Before the portal goes live, the hospital's DPO has flagged six data fields for your review. Some are clearly health-related, but others are trickier — pseudonymised IDs, IP addresses, and aggregate statistics that may or may not fall under GDPR.",
    items: [
      {
        id: "hosp_diagnosis",
        label: "Medical Diagnosis",
        description: 'Patient record reads: "Diagnosis: Stage II hypertension. Prescribed lisinopril 10mg daily."',
        correctCategory: "sensitive",
        explanation: "Health data is special-category data under Art. 9. A medical diagnosis clearly reveals a person's health status and requires explicit consent or another Art. 9(2) basis.",
      },
      {
        id: "hosp_pseudonym_id",
        label: "Pseudonymised Patient ID",
        description: "Patient #K9R21 — the real name is held in a separate secure registry accessible only by the records department.",
        correctCategory: "personal",
        explanation: "Pseudonymised data is still personal data (Recital 26 GDPR). The hospital holds the mapping table and can re-identify the patient. Only truly anonymised data falls outside GDPR scope.",
      },
      {
        id: "hosp_anon_stats",
        label: "Ward Occupancy Statistics",
        description: "78% bed occupancy in ICU this week, 62% in Paediatrics. Published in the hospital's weekly management report.",
        correctCategory: "not_personal",
        explanation: "Aggregate statistics with no link to identifiable individuals are not personal data. These numbers describe the hospital's operations, not patients.",
      },
      {
        id: "hosp_ethnicity",
        label: "Ethnicity Field",
        description: 'Intake form records patient as "South Asian" for health disparity research and treatment protocols.',
        correctCategory: "sensitive",
        explanation: "Racial or ethnic origin is explicitly listed as special-category data in Art. 9(1) GDPR. Even when collected for legitimate medical reasons, it requires extra safeguards.",
      },
      {
        id: "hosp_ip_address",
        label: "Portal Login IP Address",
        description: "84.105.22.17 — logged automatically every time a patient signs in to the portal.",
        correctCategory: "personal",
        explanation: "The CJEU (Breyer v Germany, 2016) confirmed that dynamic IP addresses are personal data when the controller can reasonably identify the user — which a hospital clearly can.",
      },
      {
        id: "hosp_equipment",
        label: "MRI Machine Serial Number",
        description: "Scanner ID: MRI-SN-44821 in Radiology Room B. Scheduled for maintenance on Friday.",
        correctCategory: "not_personal",
        explanation: "A machine identifier describes hospital equipment. It has no connection to any patient or individual.",
      },
    ],
  },
  {
    id: "ecommerce_analytics",
    title: "E-Commerce Analytics Platform",
    difficultyLabel: "Level 3 · Hard",
    context:
      "ShopFast is a fast-growing online retailer with 2 million active customers across the EU. They are implementing a new analytics dashboard called \"InsightEngine\" that will ingest data from their website, mobile app, warehouse operations, and advertising partners.",
    background:
      "The privacy team has flagged 8 data fields that InsightEngine will process. Some are straightforward, but others involve inferred data, tracking technologies, and algorithmic profiling. Some fields look harmless but reveal sensitive information when you think about what they imply.",
    items: [
      {
        id: "shop_cookie",
        label: "Analytics Cookie ID",
        description: "_ga=GA1.2.1234567890 — set by the Google Analytics tracking script on every page visit.",
        correctCategory: "personal",
        explanation: "Recital 30 GDPR: online identifiers like cookie IDs are personal data when they single out a user and enable profiling across sessions.",
      },
      {
        id: "shop_email",
        label: "Customer Email",
        description: "j.doe@mail.com — used for order confirmations, shipping updates, and promotional newsletters.",
        correctCategory: "personal",
        explanation: "An email address directly identifies a natural person — straightforward personal data.",
      },
      {
        id: "shop_location",
        label: "Delivery GPS Coordinates",
        description: "51.5074° N, 0.1278° W — precise latitude/longitude captured from the delivery driver's app at the drop-off point.",
        correctCategory: "personal",
        explanation: "GPS coordinates from a delivery reveal the customer's home or workplace address — personal data that can identify them.",
      },
      {
        id: "shop_product_catalog",
        label: "Product Catalogue",
        description: "12,000 SKU list with product names, prices, descriptions, and stock levels. Updated nightly from the ERP system.",
        correctCategory: "not_personal",
        explanation: "A product catalogue describes merchandise, not people. No link to any identifiable individual.",
      },
      {
        id: "shop_revenue",
        label: "Daily Revenue Total",
        description: "€84,200 in sales yesterday — a single aggregated number shown on the executive dashboard, no customer breakdown.",
        correctCategory: "not_personal",
        explanation: "An aggregate financial figure for the company relates to the business, not to any individual customer.",
      },
      {
        id: "shop_political_ad",
        label: "Political Ad Targeting Segment",
        description: 'User automatically tagged as "interested in left-wing politics" based on browsing patterns and ad clicks.',
        correctCategory: "sensitive",
        explanation: "Data revealing political opinions — even when inferred algorithmically rather than stated by the user — is Art. 9 special-category data. The EDPB has confirmed that inferred sensitive data is still sensitive data.",
      },
      {
        id: "shop_health_search",
        label: "Health Product Browsing History",
        description: 'User searched for "diabetes test kits" and "insulin pumps" 14 times in the last month. Linked to their account profile.',
        correctCategory: "sensitive",
        explanation: "Search patterns that reveal health conditions constitute health-related special-category data when linked to an identifiable user.",
      },
      {
        id: "shop_cctv",
        label: "Warehouse CCTV Footage",
        description: "Security camera recording of the warehouse packing area, showing workers handling parcels. Faces are visible.",
        correctCategory: "personal",
        explanation: "Video footage where individuals can be identified (faces, uniforms, name badges) is personal data of those workers.",
      },
    ],
  },
];

const DESK_POSITION: [number, number] = [990, 580];
const DESK_INTERACT_RADIUS = 100;
const BADGE_STORAGE_KEY = "pv:badge:personal-data-lab";
// Flat payout into questEngine's points/level system (see PLAN.md Phase
// 2, Day 3) — replaces the old totalCorrect*45 flavor number. Tuned to
// 400 (not the spec's original 500) so the demo path (Q1 50 + Q2 150 +
// Trial 400 = 600) lands the level-up moment during the Trial debrief.
const TRIAL_XP = 400;

type Phase = "closed" | "intro" | "item" | "feedback" | "scenario-complete" | "quest-complete";

interface DecisionLogEntry {
  scenarioId: string;
  itemId: string;
  chosen: DataCategory;
  correct: boolean;
}

interface DropZoneView {
  category: DataCategory;
  el: HTMLElement;
}

const CATEGORY_ORDER: DataCategory[] = ["not_personal", "personal", "sensitive"];

export class QuestController {
  private active: boolean;
  private eKey: Phaser.Input.Keyboard.Key;
  private promptText: Phaser.GameObjects.Text;

  private backdropEl: HTMLElement;
  private panelEl: HTMLElement;
  private caseEl: HTMLElement;
  private titleEl: HTMLElement;
  private bodyEl: HTMLElement;
  private metaEl: HTMLElement;
  private hintEl: HTMLElement;
  private continueBtn: HTMLButtonElement;

  private dragAreaEl: HTMLElement;
  private cardEl: HTMLElement;
  private zones: DropZoneView[] = [];
  private dragging = false;

  private badgeEl: HTMLElement;
  private badgeNameEl: HTMLElement;
  private badgeXpEl: HTMLElement;
  private badgeSummaryEl: HTMLElement;

  private phase: Phase = "closed";
  private scenarioIndex = 0;
  private itemIndex = 0;
  private scenarioCorrect = 0;
  private totalCorrect = 0;
  private totalItems = 0;
  private decisionLog: DecisionLogEntry[] = [];

  constructor(scene: Phaser.Scene, roomName: RoomName) {
    this.active = roomName === "courthouse";
    this.eKey = scene.input.keyboard!.addKey("E");

    this.promptText = scene.add
      .text(DESK_POSITION[0], DESK_POSITION[1] - 40, "[E] Examine the case file", {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "14px",
        color: "#f0b429",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(100001)
      .setVisible(false);

    const uiRoot = document.getElementById("ui-root")!;

    this.backdropEl = el("div", { className: "ui-backdrop", style: { pointerEvents: "auto", display: "none" } });
    uiRoot.appendChild(this.backdropEl);

    // --- Quest panel: briefing header + body + drag interaction + footer ---
    this.caseEl = el("span", { className: "briefing__case" });
    this.titleEl = el("h2", { className: "briefing__title" });
    this.bodyEl = el("p", { className: "briefing__body" });
    this.metaEl = el("div", { className: "briefing__meta" });
    this.hintEl = el("span", {
      style: { fontFamily: "var(--font-mono)", fontSize: "12px", letterSpacing: "0.04em", color: "var(--text-muted)" },
    });
    this.continueBtn = el("button", {
      className: "btn btn--gold",
      text: "Continue",
      on: { click: () => this.advance() },
    });

    const { dragAreaEl, cardEl, zones } = this.buildDragArea();
    this.dragAreaEl = dragAreaEl;
    this.cardEl = cardEl;
    this.zones = zones;

    const footer = el("div", { className: "quest-panel__footer", style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "24px" } }, [
      this.hintEl,
      this.continueBtn,
    ]);

    this.panelEl = el(
      "div",
      {
        className: "panel panel--glow",
        style: {
          position: "absolute",
          left: "140px",
          top: "50px",
          width: "1000px",
          pointerEvents: "auto",
          display: "none",
        },
      },
      [
        el("div", { className: "briefing" }, [
          el("div", { className: "briefing__header" }, [this.caseEl, this.titleEl]),
          el("hr", { className: "briefing__divider" }),
          this.bodyEl,
          this.metaEl,
          this.dragAreaEl,
        ]),
        footer,
      ],
    );
    uiRoot.appendChild(this.panelEl);

    // --- Badge popup (quest-complete only) ---
    this.badgeNameEl = el("div", { className: "badge-popup__name" });
    this.badgeXpEl = el("span", { text: "0" });
    this.badgeSummaryEl = el("div", {
      style: { fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-muted)", marginTop: "8px" },
    });
    this.badgeEl = el(
      "div",
      {
        className: "badge-popup",
        style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", pointerEvents: "auto", display: "none" },
      },
      [
        el("div", { className: "badge-popup__icon" }, [this.badgeIconSvg()]),
        el("div", { className: "badge-popup__label", text: "Trial Complete" }),
        this.badgeNameEl,
        el("div", { className: "badge-popup__xp" }, [this.badgeXpEl, el("span", { text: "XP" })]),
        this.badgeSummaryEl,
        el("div", { className: "chip", text: "[E] Close", style: { marginTop: "20px", cursor: "pointer" }, on: { click: () => this.close() } }),
      ],
    );
    uiRoot.appendChild(this.badgeEl);

    scene.input.keyboard!.on("keydown-ONE", () => this.choose("not_personal"));
    scene.input.keyboard!.on("keydown-TWO", () => this.choose("personal"));
    scene.input.keyboard!.on("keydown-THREE", () => this.choose("sensitive"));

    // scene.restart() (room transitions) tears down this controller and
    // builds a fresh one — without this, the old instance's DOM nodes would
    // never be removed from #ui-root and orphaned panels would pile up (and
    // silently eat clicks) on every transition.
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.backdropEl.remove();
      this.panelEl.remove();
      this.badgeEl.remove();
    });
  }

  private badgeIconSvg(): Node {
    const wrapper = el("div");
    wrapper.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 15.27l-5.2 2.74.99-5.79-4.21-4.1 5.82-.85L12 2z" stroke-linejoin="round"/></svg>';
    return wrapper.firstElementChild!;
  }

  private buildDragArea(): { dragAreaEl: HTMLElement; cardEl: HTMLElement; zones: DropZoneView[] } {
    const cardEl = el("div", {
      className: "drag-card",
      style: { left: "50%", top: "40px", transform: "translate(-50%, -50%)", pointerEvents: "auto" },
    });

    const zoneEls = CATEGORY_ORDER.map((category) =>
      el("div", {
        className: `drop-zone drop-zone--${category}`,
        text: CATEGORY_META[category].label,
        style: { flex: "1" },
        attrs: { "data-category": category },
      }),
    );

    const zonesRow = el(
      "div",
      { style: { position: "absolute", left: "0", right: "0", bottom: "0", display: "flex", gap: "16px", height: "120px" } },
      zoneEls,
    );

    const dragAreaEl = el("div", { style: { position: "relative", height: "220px", marginTop: "24px" } }, [cardEl, zonesRow]);

    const zones: DropZoneView[] = CATEGORY_ORDER.map((category, i) => ({ category, el: zoneEls[i] }));

    const endDrag = (clientX: number, clientY: number, pointerId: number) => {
      this.dragging = false;
      if (cardEl.hasPointerCapture(pointerId)) cardEl.releasePointerCapture(pointerId);
      const zone = this.zoneAt(clientX, clientY);
      this.highlightZone(null);
      if (zone) {
        this.choose(zone);
      } else {
        this.resetCardPosition();
      }
    };

    cardEl.addEventListener("pointerdown", (e) => {
      if (this.phase !== "item") return;
      e.preventDefault();
      this.dragging = true;
      cardEl.setPointerCapture(e.pointerId);
    });
    cardEl.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      // Self-heal if the primary button was released without a pointerup
      // ever reaching us (can happen with real mouse input, e.g. the
      // button-up landing outside the window) — without this the card
      // gets stuck following the cursor with no button held.
      if ((e.buttons & 1) === 0) {
        endDrag(e.clientX, e.clientY, e.pointerId);
        return;
      }
      const areaRect = dragAreaEl.getBoundingClientRect();
      cardEl.style.left = `${e.clientX - areaRect.left}px`;
      cardEl.style.top = `${e.clientY - areaRect.top}px`;
      this.highlightZone(this.zoneAt(e.clientX, e.clientY));
    });
    cardEl.addEventListener("pointerup", (e) => {
      if (!this.dragging) return;
      endDrag(e.clientX, e.clientY, e.pointerId);
    });
    // Fired if the browser aborts the gesture (e.g. capture lost, tab
    // loses focus mid-drag) — treat as an interrupted drag, not a drop.
    cardEl.addEventListener("pointercancel", () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.highlightZone(null);
      this.resetCardPosition();
    });

    return { dragAreaEl, cardEl, zones };
  }

  private zoneAt(clientX: number, clientY: number): DataCategory | null {
    for (const zone of this.zones) {
      const rect = zone.el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        return zone.category;
      }
    }
    return null;
  }

  private highlightZone(hovered: DataCategory | null) {
    for (const zone of this.zones) {
      zone.el.classList.toggle("drop-zone--hover", zone.category === hovered);
    }
  }

  private resetCardPosition() {
    this.cardEl.style.left = "50%";
    this.cardEl.style.top = "40px";
  }

  get dialogueOpen(): boolean {
    return this.phase !== "closed";
  }

  update(playerX: number, playerY: number) {
    if (!this.active) return;

    if (this.phase !== "closed") {
      if (Phaser.Input.Keyboard.JustDown(this.eKey)) this.advance();
      return;
    }

    const dist = Phaser.Math.Distance.Between(playerX, playerY, DESK_POSITION[0], DESK_POSITION[1]);
    if (dist < DESK_INTERACT_RADIUS) {
      this.promptText.setVisible(true);
      if (Phaser.Input.Keyboard.JustDown(this.eKey)) this.open();
    } else {
      this.promptText.setVisible(false);
    }
  }

  private open() {
    this.promptText.setVisible(false);
    this.backdropEl.style.display = "block";
    this.panelEl.style.display = "block";
    this.badgeEl.style.display = "none";
    this.scenarioIndex = 0;
    this.itemIndex = 0;
    this.totalCorrect = 0;
    this.totalItems = 0;
    this.decisionLog = [];
    this.showIntro();
  }

  private setChips(labels: string[]) {
    this.metaEl.innerHTML = "";
    for (const label of labels) this.metaEl.appendChild(el("span", { className: "chip", text: label }));
  }

  private showIntro() {
    this.phase = "intro";
    const scenario = SCENARIOS[this.scenarioIndex];
    this.scenarioCorrect = 0;
    this.dragAreaEl.style.display = "none";
    this.titleEl.style.color = "";
    this.caseEl.textContent = `CASE #00${this.scenarioIndex + 1}-GDPR`;
    this.titleEl.textContent = scenario.title;
    this.bodyEl.textContent = `${scenario.context}\n\n${scenario.background}`;
    this.setChips([scenario.difficultyLabel.toUpperCase(), `${scenario.items.length} ITEMS`]);
    this.hintEl.textContent = "[E] Begin";
    this.continueBtn.textContent = "Begin Case";
    this.continueBtn.style.display = "inline-flex";
  }

  private showItem() {
    this.phase = "item";
    const scenario = SCENARIOS[this.scenarioIndex];
    const item = scenario.items[this.itemIndex];
    this.titleEl.style.color = "";
    this.caseEl.textContent = `${scenario.title.toUpperCase()} · ITEM ${this.itemIndex + 1}/${scenario.items.length}`;
    this.titleEl.textContent = item.label;
    this.bodyEl.textContent = item.description;
    this.setChips([]);
    this.hintEl.textContent = "Drag the card to a category, or press 1 / 2 / 3";
    this.continueBtn.style.display = "none";

    this.cardEl.textContent = item.label;
    this.resetCardPosition();
    this.highlightZone(null);
    this.dragAreaEl.style.display = "block";
  }

  private choose(category: DataCategory) {
    if (this.phase !== "item") return;
    const scenario = SCENARIOS[this.scenarioIndex];
    const item = scenario.items[this.itemIndex];
    const correct = item.correctCategory === category;

    this.decisionLog.push({ scenarioId: scenario.id, itemId: item.id, chosen: category, correct });
    if (correct) {
      this.scenarioCorrect++;
      this.totalCorrect++;
    }
    this.totalItems++;

    this.phase = "feedback";
    this.dragAreaEl.style.display = "none";
    const verdict = correct
      ? { text: "Correct.", color: "var(--accent-green)" }
      : { text: `Not quite — the correct answer was "${CATEGORY_META[item.correctCategory].label}".`, color: "var(--accent-red)" };
    this.bodyEl.textContent = `${verdict.text}\n\n${item.explanation}`;
    this.titleEl.style.color = verdict.color;
    this.hintEl.textContent = "[E] Continue";
    this.continueBtn.textContent = "Continue";
    this.continueBtn.style.display = "inline-flex";
  }

  private advance() {
    if (this.phase === "intro") {
      this.showItem();
      return;
    }
    if (this.phase === "feedback") {
      const scenario = SCENARIOS[this.scenarioIndex];
      this.itemIndex++;
      if (this.itemIndex < scenario.items.length) {
        this.showItem();
      } else {
        this.showScenarioComplete();
      }
      return;
    }
    if (this.phase === "scenario-complete") {
      this.scenarioIndex++;
      this.itemIndex = 0;
      if (this.scenarioIndex < SCENARIOS.length) {
        this.showIntro();
      } else {
        this.showQuestComplete();
      }
      return;
    }
    if (this.phase === "quest-complete") {
      this.close();
    }
  }

  private showScenarioComplete() {
    this.phase = "scenario-complete";
    const scenario = SCENARIOS[this.scenarioIndex];
    this.dragAreaEl.style.display = "none";
    this.titleEl.style.color = "";
    this.caseEl.textContent = scenario.title.toUpperCase();
    this.titleEl.textContent = "Case reviewed";
    this.bodyEl.textContent = `You classified ${this.scenarioCorrect}/${scenario.items.length} fields correctly in this case.`;
    this.setChips([]);
    const isLast = this.scenarioIndex === SCENARIOS.length - 1;
    this.hintEl.textContent = isLast ? "[E] Finish" : "[E] Next case";
    this.continueBtn.textContent = isLast ? "Finish" : "Next Case";
    this.continueBtn.style.display = "inline-flex";
  }

  private showQuestComplete() {
    this.phase = "quest-complete";
    this.panelEl.style.display = "none";
    this.badgeEl.style.display = "block";
    this.badgeNameEl.textContent = "Data Classification Novice";
    this.badgeXpEl.textContent = "0";
    countUp(this.badgeXpEl, 0, TRIAL_XP, 900);
    this.badgeSummaryEl.textContent = `${this.totalCorrect}/${this.totalItems} correct across ${SCENARIOS.length} cases — every decision logged.`;

    questEngine.addPoints(TRIAL_XP);
    questEngine.toast(`INTEL FILED — Case closed, Agent. (+${TRIAL_XP} faction points)`);

    localStorage.setItem(
      BADGE_STORAGE_KEY,
      JSON.stringify({ totalCorrect: this.totalCorrect, totalItems: this.totalItems, log: this.decisionLog }),
    );
  }

  private close() {
    this.phase = "closed";
    this.backdropEl.style.display = "none";
    this.panelEl.style.display = "none";
    this.badgeEl.style.display = "none";
  }
}
