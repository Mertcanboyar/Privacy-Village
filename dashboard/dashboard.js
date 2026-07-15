// Static mock data — nothing here is wired to a live backend (see
// PLAN.md Week 4, D22-23). Numbers are fixed rather than randomized so
// the page looks identical across reloads/rehearsal recordings.

const STUDENTS = [
  { name: "Anna Jones", completion: 100, quality: 94, capstone: "complete", lastActive: "2 hours ago" },
  { name: "Marcus Tran", completion: 100, quality: 91, capstone: "complete", lastActive: "1 day ago" },
  { name: "Priya Kapoor", completion: 100, quality: 88, capstone: "complete", lastActive: "3 hours ago" },
  { name: "Jonas Weber", completion: 100, quality: 85, capstone: "complete", lastActive: "5 hours ago" },
  { name: "Sofia Ricci", completion: 90, quality: 89, capstone: "in_progress", lastActive: "1 hour ago" },
  { name: "Kwame Mensah", completion: 90, quality: 82, capstone: "in_progress", lastActive: "6 hours ago" },
  { name: "Elena Petrova", completion: 85, quality: 79, capstone: "in_progress", lastActive: "2 days ago" },
  { name: "Liam O'Connor", completion: 80, quality: 91, capstone: "in_progress", lastActive: "4 hours ago" },
  { name: "Yuki Tanaka", completion: 80, quality: 76, capstone: "in_progress", lastActive: "1 day ago" },
  { name: "Fatima Al-Sayed", completion: 75, quality: 84, capstone: "in_progress", lastActive: "3 hours ago" },
  { name: "Noah Kim", completion: 75, quality: 68, capstone: "in_progress", lastActive: "2 days ago" },
  { name: "Isabella Costa", completion: 70, quality: 88, capstone: "in_progress", lastActive: "5 hours ago" },
  { name: "Deshawn Carter", completion: 65, quality: 73, capstone: "not_started", lastActive: "1 day ago" },
  { name: "Mei Lin", completion: 65, quality: 92, capstone: "not_started", lastActive: "8 hours ago" },
  { name: "Oskar Nowak", completion: 60, quality: 65, capstone: "not_started", lastActive: "3 days ago" },
  { name: "Camila Reyes", completion: 60, quality: 77, capstone: "not_started", lastActive: "2 hours ago" },
  { name: "Ravi Shankar", completion: 55, quality: 71, capstone: "not_started", lastActive: "1 day ago" },
  { name: "Grace Mensah", completion: 55, quality: 63, capstone: "not_started", lastActive: "4 days ago" },
  { name: "Tobias Berg", completion: 50, quality: 58, capstone: "not_started", lastActive: "2 days ago" },
  { name: "Amara Okafor", completion: 50, quality: 80, capstone: "not_started", lastActive: "6 hours ago" },
  { name: "Lucas Ferreira", completion: 45, quality: 61, capstone: "not_started", lastActive: "3 days ago" },
  { name: "Hana Suzuki", completion: 40, quality: 55, capstone: "not_started", lastActive: "5 days ago" },
  { name: "Ethan Walsh", completion: 35, quality: 66, capstone: "not_started", lastActive: "1 week ago" },
  { name: "Zara Ahmed", completion: 30, quality: 59, capstone: "not_started", lastActive: "4 days ago" },
  { name: "Milo Jansen", completion: 20, quality: 50, capstone: "not_started", lastActive: "2 weeks ago" },
];

function initials(name) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function qualityChipClass(quality) {
  if (quality >= 85) return "chip--good";
  if (quality >= 70) return "chip--ok";
  return "chip--risk";
}

const CAPSTONE_LABEL = { complete: "Complete", in_progress: "In Progress", not_started: "Not Started" };
const CAPSTONE_CLASS = { complete: "chip--gold", in_progress: "chip--progress", not_started: "" };

function average(nums) {
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function renderStats() {
  const avgCompletion = average(STUDENTS.map((s) => s.completion));
  const avgQuality = average(STUDENTS.map((s) => s.quality));
  const capstoneReady = STUDENTS.filter((s) => s.capstone === "complete").length;

  const stats = [
    { label: "Students", value: STUDENTS.length, variant: "" },
    { label: "Avg completion", value: `${avgCompletion}%`, variant: "stat-card__value--blue" },
    { label: "Avg decision quality", value: `${avgQuality}%`, variant: "stat-card__value--green" },
    { label: "Capstone ready", value: capstoneReady, variant: "stat-card__value--gold" },
  ];

  document.getElementById("stat-grid").innerHTML = stats
    .map(
      (s) => `
      <div class="panel stat-card">
        <div class="stat-card__label">${s.label}</div>
        <div class="stat-card__value ${s.variant}">${s.value}</div>
      </div>`,
    )
    .join("");
}

function renderRoster() {
  document.getElementById("roster-count").textContent = `${STUDENTS.length} students`;

  document.getElementById("roster-body").innerHTML = STUDENTS.map(
    (s) => `
    <tr>
      <td>
        <div class="student-cell">
          <div class="student-avatar">${initials(s.name)}</div>
          <span>${s.name}</span>
        </div>
      </td>
      <td>
        <div class="completion-cell">
          <div class="completion-track"><div class="completion-fill" style="width:${s.completion}%"></div></div>
          <span class="completion-value">${s.completion}%</span>
        </div>
      </td>
      <td><span class="chip ${qualityChipClass(s.quality)}">${s.quality}%</span></td>
      <td><span class="chip ${CAPSTONE_CLASS[s.capstone]}">${CAPSTONE_LABEL[s.capstone]}</span></td>
      <td class="last-active">${s.lastActive}</td>
    </tr>`,
  ).join("");
}

function exportCsv() {
  const header = ["Name", "Module Completion (%)", "Decision Quality (%)", "Capstone Status", "Last Active"];
  const rows = STUDENTS.map((s) => [s.name, s.completion, s.quality, CAPSTONE_LABEL[s.capstone], s.lastActive]);
  const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "privacy-village-grades.csv";
  link.click();
  URL.revokeObjectURL(url);
}

renderStats();
renderRoster();
document.getElementById("export-btn").addEventListener("click", exportCsv);
