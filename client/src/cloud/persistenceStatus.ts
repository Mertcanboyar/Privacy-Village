import Phaser from "phaser";

// Drives the HUD's persistence status dot (see hud.ts) — a small
// EventEmitter singleton, same pattern as questEngine.ts/academy.ts, so
// hud.ts can subscribe without this module depending on any Scene.
//
// Three states: "guest" (not authenticated — writes never happen, this
// is expected, not an error), "ok" (authenticated, most recent write
// succeeded or nothing's failed yet), "error" (authenticated, but the
// most recent write failed — lastError holds why, for the dot's
// tooltip). cloud/save.ts and cloud/profile.ts report into this after
// every write; nothing here ever blocks or throws.

export type PersistenceStatus = "guest" | "ok" | "error";

class PersistenceStatusManager extends Phaser.Events.EventEmitter {
  private status: PersistenceStatus = "guest";
  private lastError: string | null = null;

  get(): { status: PersistenceStatus; lastError: string | null } {
    return { status: this.status, lastError: this.lastError };
  }

  reportOk() {
    this.set("ok", null);
  }

  reportError(err: unknown) {
    this.set("error", stringifyError(err));
  }

  private set(status: PersistenceStatus, lastError: string | null) {
    if (this.status === status && this.lastError === lastError) return;
    this.status = status;
    this.lastError = lastError;
    this.emit("changed");
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export const persistenceStatus = new PersistenceStatusManager();
