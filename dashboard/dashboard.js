// Static mock — brochure, not a product. Data comes from one hardcoded
// JSON of fake students (data/students.json); nothing here is wired to a
// live backend. Stat cards are always computed from that JSON at render
// time, never hardcoded, so they can't drift out of sync with the roster.

const SEVEN_DAYS_MIN = 7 * 24 * 60;

const FACTION_LABEL = { fundamentalist: "AI Optimist", apocalypse: "AI Skeptic", unknown: "" };
const CAPSTONE_LABEL = { passed: "PASSED", in_progress: "IN PROGRESS", none: "—" };

let DATA = null;
let sortState = { key: "name", dir: "asc" };

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function completedCount(student) {
  return student.moduleStatus.filter((m) => m === "complete").length;
}

function attemptsSortValue(quest) {
  return quest ? quest.attempts : -1;
}

function capstoneRank(capstone) {
  return { none: 0, in_progress: 1, passed: 2 }[capstone];
}

function formatMinutesAgo(minutes) {
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  const days = Math.round(minutes / 1440);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function lastActiveText(student) {
  return student.lastActiveDisplay || formatMinutesAgo(student.lastActiveMinutes);
}

function threatText(quest) {
  if (!quest) return "—";
  return quest.attempts === 1 ? "✓ 1st try" : "✓ 2 attempts";
}

function breachText(hours) {
  return hours == null ? "—" : `${hours} h`;
}

/* ---------------------------------------------------------------------
   Stat cards
--------------------------------------------------------------------- */

function renderStats() {
  const students = DATA.students;
  const avgClearance = students.reduce((a, s) => a + s.clearance, 0) / students.length;

  const totalModuleSlots = students.length * DATA.modules.length;
  const completedModules = students.reduce((a, s) => a + completedCount(s), 0);
  const modulePct = Math.round((completedModules / totalModuleSlots) * 100);

  const breachVals = students.map((s) => s.breachHours).filter((v) => v != null);
  const avgBreach = Math.round(breachVals.reduce((a, b) => a + b, 0) / breachVals.length);

  const needsAttention = students.filter((s) => s.lastActiveMinutes >= SEVEN_DAYS_MIN).length;

  const cards = [
    {
      label: "Avg Clearance",
      value: `C${avgClearance.toFixed(1)}`,
      valueClass: "",
      sub: "",
      bar: "",
    },
    {
      label: "Modules Completed",
      value: `${completedModules} / ${totalModuleSlots}`,
      valueClass: "",
      sub: "",
      bar: `<div class="stat-card__bar"><div class="stat-card__bar-fill" style="width:${modulePct}%"></div></div>`,
    },
    {
      label: "Avg Breach Response",
      value: `${avgBreach} HRS`,
      valueClass: "",
      sub: "The Night the Wall Fell",
      bar: "",
    },
    {
      label: "Needs Attention",
      value: String(needsAttention),
      valueClass: "stat-card__value--amber",
      sub: "no activity in 7+ days",
      bar: "",
    },
  ];

  document.getElementById("stat-grid").innerHTML = cards
    .map(
      (c) => `
      <div class="panel stat-card">
        <div class="stat-card__label">${c.label}</div>
        <div class="stat-card__value ${c.valueClass}">${c.value}</div>
        ${c.sub ? `<div class="stat-card__sub">${c.sub}</div>` : ""}
        ${c.bar}
      </div>`,
    )
    .join("");
}

/* ---------------------------------------------------------------------
   Roster table
--------------------------------------------------------------------- */

const COLUMNS = [
  { key: "name", label: "Student", sortValue: (s) => s.name.toLowerCase() },
  { key: "clearance", label: "Clearance", sortValue: (s) => s.clearance },
  { key: "modules", label: "Modules", sortValue: (s) => completedCount(s) },
  { key: "threat", label: "Threat Model", sortValue: (s) => attemptsSortValue(s.threatModel) },
  { key: "reid", label: "Re-ID Puzzle", sortValue: (s) => attemptsSortValue(s.reidPuzzle) },
  { key: "breach", label: "Breach Response", sortValue: (s) => (s.breachHours == null ? -1 : s.breachHours) },
  { key: "capstone", label: "Capstone", sortValue: (s) => capstoneRank(s.capstone) },
  { key: "lastActive", label: "Last Active", sortValue: (s) => s.lastActiveMinutes },
];

function renderRosterHead() {
  document.getElementById("roster-head").innerHTML = COLUMNS.map((col) => {
    const active = sortState.key === col.key;
    const arrow = active ? (sortState.dir === "asc" ? "▲" : "▼") : "▲";
    return `<th data-key="${col.key}" ${active ? "data-sort-active" : ""}>${col.label}<span class="sort-arrow">${arrow}</span></th>`;
  }).join("");

  document.getElementById("roster-head").querySelectorAll("th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState = { key, dir: "asc" };
      }
      renderRosterHead();
      renderRosterBody();
    });
  });
}

function sortedStudents() {
  const col = COLUMNS.find((c) => c.key === sortState.key);
  const dir = sortState.dir === "asc" ? 1 : -1;
  return [...DATA.students].sort((a, b) => {
    const av = col.sortValue(a);
    const bv = col.sortValue(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function moduleSegmentsHtml(student) {
  return `<div class="module-segments">${student.moduleStatus
    .map((status, i) => {
      const cls = status === "none" ? "" : ` module-segment--${status}`;
      const label = status === "complete" ? "Complete" : status === "partial" ? "In progress" : "Not started";
      return `<div class="module-segment${cls}" title="${escapeHtml(DATA.modules[i])}: ${label}"></div>`;
    })
    .join("")}</div>`;
}

function breachCellHtml(student) {
  if (student.breachHours == null) return `<span class="breach-cell breach-cell--empty">—</span>`;
  const cls = student.breachHours < 72 ? "gold" : "red";
  return `<span class="breach-cell breach-cell--${cls}">${student.breachHours} h</span>`;
}

function capstoneCellHtml(student) {
  if (student.capstone === "none") return `<span class="quest-cell quest-cell--empty">—</span>`;
  const cls = student.capstone === "passed" ? "passed" : "progress";
  return `<span class="chip capstone-chip--${cls}">${CAPSTONE_LABEL[student.capstone]}</span>`;
}

function questCellHtml(quest) {
  const cls = quest ? "" : " quest-cell--empty";
  return `<span class="quest-cell${cls}">${threatText(quest)}</span>`;
}

function renderRosterBody() {
  document.getElementById("roster-body").innerHTML = sortedStudents()
    .map(
      (s) => `
    <tr data-id="${s.id}">
      <td>
        <div class="student-cell">
          <span class="faction-dot faction-dot--${s.faction}"></span>
          <span>${escapeHtml(s.name)}</span>
        </div>
      </td>
      <td><span class="clearance-badge">C${s.clearance}</span></td>
      <td>${moduleSegmentsHtml(s)}</td>
      <td>${questCellHtml(s.threatModel)}</td>
      <td>${questCellHtml(s.reidPuzzle)}</td>
      <td>${breachCellHtml(s)}</td>
      <td>${capstoneCellHtml(s)}</td>
      <td><span class="last-active ${s.lastActiveMinutes >= SEVEN_DAYS_MIN ? "last-active--stale" : ""}">${lastActiveText(s)}</span></td>
    </tr>`,
    )
    .join("");

  document.getElementById("roster-body").querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => openDrawer(tr.dataset.id));
  });
}

/* ---------------------------------------------------------------------
   Student detail drawer
--------------------------------------------------------------------- */

function openDrawer(id) {
  const student = DATA.students.find((s) => s.id === id);
  if (!student) return;

  const factionLabel = FACTION_LABEL[student.faction] || "";

  document.getElementById("drawer-body").innerHTML = `
    <div class="drawer__name">${escapeHtml(student.name)}</div>
    <div class="drawer__meta">
      <span class="clearance-badge">C${student.clearance}</span>
      ${
        factionLabel
          ? `<span class="drawer__faction"><span class="faction-dot faction-dot--${student.faction}"></span>${factionLabel}</span>`
          : `<span class="drawer__faction"><span class="faction-dot faction-dot--${student.faction}"></span></span>`
      }
    </div>
    <div class="drawer__enrolled">Enrolled ${escapeHtml(student.enrolled)}</div>
    <div class="drawer__section-title">Decision Log</div>
    <div class="timeline">
      ${student.decisionLog
        .map(
          (entry) => `
        <div class="timeline-entry">
          <div class="timeline-entry__date">${escapeHtml(entry.date)}</div>
          <div class="timeline-entry__text">${escapeHtml(entry.text)}</div>
        </div>`,
        )
        .join("")}
    </div>
    <p class="drawer__closing-line">Every decision is logged with reasoning context. Grade the thinking, not the attendance.</p>
  `;

  document.getElementById("drawer").classList.add("drawer--open");
  document.getElementById("drawer-backdrop").classList.add("drawer-backdrop--open");
}

function closeDrawer() {
  document.getElementById("drawer").classList.remove("drawer--open");
  document.getElementById("drawer-backdrop").classList.remove("drawer-backdrop--open");
}

/* ---------------------------------------------------------------------
   CSV export
--------------------------------------------------------------------- */

function exportCsv() {
  const header = [
    "Student",
    "Faction",
    "Clearance",
    "Modules Completed",
    "Threat Model",
    "Re-ID Puzzle",
    "Breach Response (h)",
    "Capstone",
    "Last Active",
  ];

  const rows = sortedStudents().map((s) => [
    s.name,
    FACTION_LABEL[s.faction] || "—",
    `C${s.clearance}`,
    `${completedCount(s)}/${DATA.modules.length}`,
    threatText(s.threatModel),
    threatText(s.reidPuzzle),
    s.breachHours == null ? "—" : s.breachHours,
    CAPSTONE_LABEL[s.capstone],
    lastActiveText(s),
  ]);

  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");

  // BOM so Excel (which otherwise assumes the system codepage, not UTF-8)
  // renders the accented names and ✓/— glyphs correctly instead of mojibake.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "privacy-village-grades.csv";
  link.click();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------------
   Boot
--------------------------------------------------------------------- */

fetch("data/students.json")
  .then((res) => res.json())
  .then((data) => {
    DATA = data;
    document.getElementById("course-chip").textContent = DATA.course;
    renderStats();
    renderRosterHead();
    renderRosterBody();
  });

document.getElementById("export-btn").addEventListener("click", exportCsv);
document.getElementById("drawer-close").addEventListener("click", closeDrawer);
document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});
