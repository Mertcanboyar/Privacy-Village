import Phaser from "phaser";

// §2 "The Gathering" (see PLAN.md) — framework-free module singleton,
// same shape as events.ts/academy.ts. Data lives in
// client/public/data/gathering.json, NOT data/events.json — that name
// is already taken by events.ts's unrelated video-panel feature (see
// Preload.ts).

export interface GatheringEvent {
  title: string;
  host: string;
  startsAt: string;
  durationMin: number;
  description: string;
  externalLink: string;
}

class GatheringManager extends Phaser.Events.EventEmitter {
  private events: GatheringEvent[] = [];

  loadData(events: GatheringEvent[]) {
    this.events = events;
  }

  /** The soonest event that hasn't ended yet (live or upcoming), or null
   * if nothing's scheduled — this is both "the event board's current/next
   * gathering" and "the countdown banner's target" in one lookup. */
  getCurrent(): GatheringEvent | null {
    const now = Date.now();
    let best: GatheringEvent | null = null;
    let bestEnd = Infinity;
    for (const ev of this.events) {
      const end = new Date(ev.startsAt).getTime() + ev.durationMin * 60000;
      if (end < now) continue;
      if (end < bestEnd) {
        best = ev;
        bestEnd = end;
      }
    }
    return best;
  }

  /** Minutes until getCurrent() starts — 0 or negative once it's live.
   * Null if nothing's scheduled. */
  getMinutesUntilStart(): number | null {
    const current = this.getCurrent();
    if (!current) return null;
    return Math.round((new Date(current.startsAt).getTime() - Date.now()) / 60000);
  }
}

export const gathering = new GatheringManager();
