import Phaser from "phaser";
import { duckAudio } from "./audio";
import { questEngine } from "./questEngine";
import { academy } from "./academy";
import { getCurrentUserId } from "./cloud/authState";
import { fetchDecisions, type DecisionRow } from "./cloud/decisions";

// The Agent Dossier — a three-tab progression page (DOSSIER/CODEX/
// JOURNEY) layered over the village, same framework-free
// Phaser.Events.EventEmitter singleton pattern as questEngine.ts/
// academy.ts, so the Scene-bound DOM UI (dossierOverlay.ts) can react
// without this module depending on any Scene. Mostly a DISPLAY feature
// over quest/academy state that already exists — the only genuinely
// new persisted state this file owns is which Codex concepts/Journey
// titles a player has unlocked, and which title they've chosen to
// wear publicly (see progress.unlocked_concepts/unlocked_titles/
// active_title — supabase/migration_dossier.sql).

export interface CodexConcept {
  id: string;
  name: string;
  citation: string;
  definition: string;
  sourceType: "quest" | "module";
  sourceId: string;
  track: "privacy_ops" | "ai_governance" | "cyber_security_law";
  unlockedAt: string;
}

export interface TitleDef {
  id: string;
  name: string;
  flavor: string;
  earnCondition: string;
}

// One line of the Dossier tab's Decision Record — see
// formatDecisionLog() below. `commendation` drives the gold marker
// (see PLAN.md's framing rule: commendations are highlighted,
// stumbles are stated plainly and neutrally — never a red "wrong").
export interface DecisionLogEntry {
  text: string;
  commendation: boolean;
}

// Serialized shape for progress.unlocked_concepts/unlocked_titles/
// active_title (see cloud/save.ts's flushSaveProgress() and
// cloud/profile.ts's ProgressRow) — same v1 versioning convention as
// questEngine.ts's QuestEngineState/academy.ts's AcademyEngineState.
export interface DossierEngineState {
  v: 1;
  unlockedConcepts: string[];
  unlockedTitles: string[];
  activeTitle: string | null;
}

// The six full-screen minigame quests that log a "clean run" stat
// alongside their completion (see npc.ts's six openXOverlay() methods)
// — every COMMENDATION toast in the game fires from exactly one of
// these checks, reproduced here so the Dossier can mark the same runs
// gold after the fact, whether that's seconds later (live, from
// recordQuestStat()) or a session later (from a fetched decisions row,
// see primeFromDecisions()). Keep this in sync with npc.ts if a
// commendation condition ever changes there.
const COMMENDATION_CHECKS: Record<string, (d: Record<string, unknown>) => boolean> = {
  healers_ledger: (d) => d.breachCount === 0 && d.overClassifyCount === 0,
  post_road_blueprint: (d) => d.slotErrors === 0 && d.arrowErrors === 0 && d.cipherToggleAttempts === 1,
  sealed_letter: (d) => (d.forgeryCaughtSeconds as number) < 30 && d.passwordChoice === "no" && d.wrongSealAttempts === 0,
  treasury_two_keys: (d) => (d.resetCount as number) <= 1 && !d.brokeDefenseInDepth,
  maren_winter_report: (d) => d.overStripAttempts === 0 && (d.resetCount as number) <= 1,
  archivists_desk: (d) => d.integrityLost === 0,
};

// decisions.event -> quest id, for the one mismatch (healers_ledger's
// completion event is "healers_ledger_complete", not "healers_ledger"
// — see npc.ts's logDecision() call sites). Every other commendation-
// eligible quest logs its completion event under its own quest id.
const COMPLETE_EVENT_TO_QUEST: Record<string, string> = {
  healers_ledger_complete: "healers_ledger",
  post_road_blueprint: "post_road_blueprint",
  sealed_letter: "sealed_letter",
  treasury_two_keys: "treasury_two_keys",
  maren_winter_report: "maren_winter_report",
  archivists_desk: "archivists_desk",
};

// Which Codex concepts count toward "Master of the Cabinet" (see
// titles.json) — a dedicated list rather than hardcoding the single
// "pets" id inline, so it stays a one-line edit as the PET catalog
// grows (see module_pets.json's own "extend as new content ships"
// convention).
const PET_CONCEPT_IDS = ["pets"];

class DossierManager extends Phaser.Events.EventEmitter {
  private open_ = false;
  private codex: CodexConcept[] = [];
  private titleDefs: TitleDef[] = [];
  private unlockedConcepts = new Set<string>();
  private unlockedTitles = new Set<string>();
  private activeTitle: string | null = null;

  // Per-quest completion stats — populated live the moment a minigame
  // quest completes (recordQuestStat(), called from npc.ts right next
  // to logDecision()) and re-populated from a fetched decisions row on
  // refresh() for a returning player whose run predates this session.
  // Only ever holds the 6 commendation-eligible quests' completion
  // detail — see COMMENDATION_CHECKS.
  private questStats = new Map<string, Record<string, unknown>>();
  private lastDecisionRows: DecisionRow[] = [];

  get isOpen(): boolean {
    return this.open_;
  }

  open() {
    if (this.open_) return;
    this.open_ = true;
    duckAudio(true);
    this.checkRetroactiveConcepts();
    this.checkTitleAwards();
    this.emit("opened");
    void this.refresh();
  }

  close() {
    if (!this.open_) return;
    this.open_ = false;
    duckAudio(false);
    this.emit("closed");
  }

  toggle() {
    if (this.open_) this.close();
    else this.open();
  }

  loadData(codex: CodexConcept[], titles: TitleDef[]) {
    this.codex = codex;
    this.titleDefs = titles;
  }

  getCodex(): CodexConcept[] {
    return this.codex;
  }

  getTitleDefs(): TitleDef[] {
    return this.titleDefs;
  }

  getUnlockedConcepts(): ReadonlySet<string> {
    return this.unlockedConcepts;
  }

  isConceptUnlocked(id: string): boolean {
    return this.unlockedConcepts.has(id);
  }

  getUnlockedTitles(): ReadonlySet<string> {
    return this.unlockedTitles;
  }

  isTitleUnlocked(id: string): boolean {
    return this.unlockedTitles.has(id);
  }

  getActiveTitle(): string | null {
    return this.activeTitle;
  }

  getActiveTitleDef(): TitleDef | null {
    return this.activeTitle ? (this.titleDefs.find((t) => t.id === this.activeTitle) ?? null) : null;
  }

  getDecisionRows(): DecisionRow[] {
    return this.lastDecisionRows;
  }

  /** Reverse-chronological, Ranger-voiced log of this player's real
   * completed runs — see formatDecisionLog() below. Empty for a guest
   * (nothing persists for them — see dossierOverlay.ts's Dossier tab,
   * which shows the "enlist to preserve your record" line instead). */
  getDecisionLog(): DecisionLogEntry[] {
    return formatDecisionLog(this.lastDecisionRows);
  }

  /** Player's own choice of which earned title (if any) to wear
   * publicly — see dossierOverlay.ts's Journey tab. No-ops on an id
   * that isn't actually unlocked (defends against a stale click racing
   * a state reset), silently allows `null` (wear nothing). */
  setActiveTitle(id: string | null) {
    if (id !== null && !this.unlockedTitles.has(id)) return;
    if (this.activeTitle === id) return;
    this.activeTitle = id;
    this.emit("activeTitleChanged", id);
  }

  serializeState(): DossierEngineState {
    return {
      v: 1,
      unlockedConcepts: [...this.unlockedConcepts],
      unlockedTitles: [...this.unlockedTitles],
      activeTitle: this.activeTitle,
    };
  }

  /** Restores previously-saved state — must run after loadData() so
   * concept/title ids exist to hydrate against. Silent, same convention
   * as questEngine.ts/academy.ts's own hydrateState(). */
  hydrateState(saved: DossierEngineState | null | undefined) {
    if (!saved || saved.v !== 1) return;
    this.unlockedConcepts = new Set(saved.unlockedConcepts.filter((id) => this.codex.some((c) => c.id === id)));
    this.unlockedTitles = new Set(saved.unlockedTitles.filter((id) => this.titleDefs.some((t) => t.id === id)));
    this.activeTitle = saved.activeTitle && this.unlockedTitles.has(saved.activeTitle) ? saved.activeTitle : null;
  }

  /** Called from npc.ts right next to logDecision() for each of the six
   * full-screen minigame quests, with the exact same detail object —
   * this is what lets a commendation earned THIS session immediately
   * count toward "The Unerring" etc. without waiting on a network
   * round-trip. See also primeFromDecisions() for the returning-
   * player equivalent. */
  recordQuestStat(questId: string, detail: Record<string, unknown>) {
    this.questStats.set(questId, detail);
  }

  private primeFromDecisions(rows: DecisionRow[]) {
    for (const row of rows) {
      const questId = COMPLETE_EVENT_TO_QUEST[row.event];
      if (questId) this.questStats.set(questId, row.detail);
    }
  }

  isCommendation(questId: string): boolean {
    const check = COMMENDATION_CHECKS[questId];
    const detail = this.questStats.get(questId);
    return !!check && !!detail && check(detail);
  }

  countCommendations(): number {
    return Object.keys(COMMENDATION_CHECKS).filter((id) => this.isCommendation(id)).length;
  }

  private conceptSourceMet(concept: CodexConcept): boolean {
    if (concept.sourceType === "quest") return questEngine.isComplete(concept.sourceId);
    const progress = academy.getProgress(concept.sourceId);
    return progress.theoryDone && progress.fieldDone;
  }

  unlockConcept(id: string) {
    if (this.unlockedConcepts.has(id)) return;
    const concept = this.codex.find((c) => c.id === id);
    if (!concept) return;
    this.unlockedConcepts.add(id);
    questEngine.toast(`CONCEPT UNLOCKED — ${concept.name}`);
    this.emit("conceptUnlocked", id);
  }

  /** Unlocks every Codex concept whose source quest/module is already
   * complete — run on Dossier open (so a returning player's existing
   * progress isn't an empty Codex) and after every quest/module
   * completion (see initDossierHooks() below) for the live case. Silent
   * for concepts already unlocked (unlockConcept() itself is the
   * idempotent guard) — no toast spam on repeat opens. */
  checkRetroactiveConcepts() {
    for (const concept of this.codex) {
      if (!this.unlockedConcepts.has(concept.id) && this.conceptSourceMet(concept)) this.unlockConcept(concept.id);
    }
  }

  private unlockTitle(id: string) {
    if (this.unlockedTitles.has(id)) return;
    const title = this.titleDefs.find((t) => t.id === id);
    if (!title) return;
    this.unlockedTitles.add(id);
    questEngine.toast(`TITLE EARNED — ${title.name}`);
    this.emit("titleUnlocked", id);
  }

  private titleConditionMet(id: string): boolean {
    switch (id) {
      case "ranger_of_the_wall":
        return questEngine.isComplete("breach_in_the_wall");
      case "the_cartographer":
        return this.isCommendation("post_road_blueprint");
      case "the_unbreached":
        return questEngine.isComplete("night_the_wall_fell") && questEngine.getClockHours() < 72;
      case "keeper_of_purpose":
        return this.isCommendation("archivists_desk");
      case "the_unerring":
        return this.countCommendations() >= 3;
      case "master_of_the_cabinet":
        return PET_CONCEPT_IDS.every((conceptId) => this.unlockedConcepts.has(conceptId));
      case "spymaster":
        return questEngine.getClearance() >= 7;
      default:
        return false;
    }
  }

  /** Same "run on completion + on open" contract as
   * checkRetroactiveConcepts() — see initDossierHooks(). */
  checkTitleAwards() {
    for (const title of this.titleDefs) {
      if (!this.unlockedTitles.has(title.id) && this.titleConditionMet(title.id)) this.unlockTitle(title.id);
    }
  }

  /** Re-syncs from the cloud decisions log (for a returning player
   * whose commendation-eligible runs predate this session — see
   * questStats' doc comment) and re-checks unlocks against the fresh
   * data. Guests and unauthenticated sessions simply skip the fetch and
   * re-check against whatever's already known locally — nothing here
   * ever blocks the overlay from opening on it. Fire-and-forget from
   * open(); dossierOverlay.ts re-renders on the "refreshed" event once
   * this resolves. */
  private async refresh() {
    const userId = getCurrentUserId();
    if (userId) {
      const rows = await fetchDecisions(userId);
      this.lastDecisionRows = rows;
      this.primeFromDecisions(rows);
    } else {
      this.lastDecisionRows = [];
    }
    this.checkRetroactiveConcepts();
    this.checkTitleAwards();
    this.emit("refreshed");
  }
}

export const dossier = new DossierManager();

// --- Decision Record formatting ---------------------------------------
// Turns the raw decisions log into the Ranger's-own-logbook lines the
// Dossier tab renders (see PLAN.md's framing rule: history, not
// judgment — every line states what happened, never a grade). Kept
// here rather than in dossierOverlay.ts because it's genuinely data
// interpretation, not DOM building; the overlay just renders whatever
// this returns.

function lastRowFor(rows: DecisionRow[], event: string): DecisionRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].event === event) return rows[i];
  }
  return undefined;
}

function lastRowWhere(rows: DecisionRow[], event: string, pred: (detail: Record<string, unknown>) => boolean): DecisionRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].event === event && pred(rows[i].detail)) return rows[i];
  }
  return undefined;
}

// "WEST GATE" -> "West Gate" — matches how a Ranger would write a
// place name in their own log, not the button's all-caps UI casing.
function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function pluralAttempts(n: number): string {
  return `${n} attempt${n === 1 ? "" : "s"}`;
}

const MINIGAME_FORMATTERS: Record<string, (d: Record<string, unknown>, commended: boolean) => string> = {
  healers_ledger_complete: (d, commended) =>
    commended
      ? "The Healer's Ledger — sorted clean. Commendation earned."
      : `The Healer's Ledger — sorted. (${d.breachCount} exposure(s), ${d.overClassifyCount} overclassification(s) noted along the way.)`,
  post_road_blueprint: (d, commended) =>
    commended
      ? "The Blueprint of the Post Road — mapped clean, first try. Commendation earned."
      : `The Blueprint of the Post Road — mapped. (${d.slotErrors} slot correction(s), ${d.arrowErrors} redrawn arrow(s).)`,
  sealed_letter: (d, commended) =>
    commended ? "The Sealed Letter — the forgery never fooled you. Commendation earned." : `The Sealed Letter — the forgery caught in ${d.forgeryCaughtSeconds}s.`,
  treasury_two_keys: (d, commended) =>
    commended
      ? "The Treasury's Two Keys — secured, interlocked on the first true try. Commendation earned."
      : `The Treasury's Two Keys — secured. (${d.resetCount} reset(s) along the way.)`,
  maren_winter_report: (d, commended) =>
    commended ? "Maren's Winter Report — filed clean, first run. Commendation earned." : `Maren's Winter Report — filed. (Config: ${d.chosenConfig}.)`,
  archivists_desk: (d, commended) =>
    commended
      ? "The Archivist's Desk — six rulings filed, ledger balanced true. Commendation earned."
      : `The Archivist's Desk — six rulings filed. (Integrity dipped ${d.integrityLost} time(s) along the way.)`,
};

function formatDecisionLog(rows: DecisionRow[]): DecisionLogEntry[] {
  const entries: (DecisionLogEntry & { ts: string })[] = [];

  const breachM1 = lastRowFor(rows, "breach_m1_answer");
  if (breachM1) {
    const attempt = Number(breachM1.detail.attempt ?? 1);
    const label = toTitleCase(String(breachM1.detail.label ?? "the gate"));
    entries.push({ text: `The Breach in the Wall — solved. (${pluralAttempts(attempt)} on the ${label}.)`, commendation: false, ts: breachM1.created_at });
  }

  const shardsStep1 = lastRowWhere(rows, "innkeepers_shards_answer", (d) => d.step === 1);
  if (shardsStep1) {
    const attempt = Number(shardsStep1.detail.attempt ?? 1);
    const found = attempt === 1 ? "found first try" : `found on attempt ${attempt}`;
    entries.push({ text: `The Innkeeper's Shards — S-08 ${found}.`, commendation: false, ts: shardsStep1.created_at });
  }

  const clockRows = rows.filter((r) => r.event === "wallfell_clock_choice");
  if (clockRows.length && questEngine.isComplete("night_the_wall_fell")) {
    const last = clockRows[clockRows.length - 1];
    const hours = Number(last.detail.totalClockHours ?? 0);
    const flavor = hours < 48 ? "Time to spare." : hours < 72 ? "Under the wire." : "Past the window — but the wall held anyway.";
    entries.push({ text: `The Night the Wall Fell — village warned in ${hours} hours. ${flavor}`, commendation: false, ts: last.created_at });
  }

  for (const event of Object.keys(MINIGAME_FORMATTERS)) {
    const row = lastRowFor(rows, event);
    if (!row) continue;
    const questId = COMPLETE_EVENT_TO_QUEST[event] ?? event;
    const commended = dossier.isCommendation(questId);
    entries.push({ text: MINIGAME_FORMATTERS[event](row.detail, commended), commendation: commended, ts: row.created_at });
  }

  entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return entries.map(({ text, commendation }) => ({ text, commendation }));
}

/** Subscribes concept/title checks to the same live triggers
 * questEngine.ts/academy.ts already expose — call once at boot
 * (main.ts), same convention as cloud/save.ts's initAutoSave(). Keeps
 * dossier.ts itself free of any direct wiring into those two modules
 * beyond reading their public getters. */
export function initDossierHooks() {
  questEngine.on("questCompleted", () => {
    dossier.checkRetroactiveConcepts();
    dossier.checkTitleAwards();
  });
  academy.on("moduleCompleted", () => {
    dossier.checkRetroactiveConcepts();
    dossier.checkTitleAwards();
  });
}
