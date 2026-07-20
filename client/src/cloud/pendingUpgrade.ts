import type { Faction } from "../session";
import type { QuestEngineState } from "../questEngine";
import type { AcademyEngineState } from "../academy";

// A magic link is a real page navigation (new tab or a reload of the
// current one), which wipes every in-memory module singleton
// (questEngine, academy, session). hud.ts's "SAVE YOUR RECORD" upgrade
// needs the guest's CURRENT progress to survive that round-trip, so it
// gets snapshotted here into localStorage right before the OTP email is
// sent, and claimed back by Title.ts's boot() the next time the page
// loads with a fresh authenticated session and no profile row yet —
// see cloud/emailCapturePanel.ts's beforeAuthSubmit hook.
const KEY = "pv_pending_upgrade";

export interface PendingUpgradeSnapshot {
  v: 1;
  name: string;
  spriteId: string;
  faction: Faction | null;
  questState: QuestEngineState;
  moduleState: AcademyEngineState;
}

export function savePendingUpgrade(snapshot: PendingUpgradeSnapshot) {
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    // Private browsing / storage disabled — the upgrade just won't carry
    // progress over this one time; not worth surfacing to the player.
  }
}

/** Reads and clears the pending snapshot in one step — it's meant to be
 * consumed exactly once, right after the magic-link round-trip. */
export function takePendingUpgrade(): PendingUpgradeSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as PendingUpgradeSnapshot;
    return parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}
