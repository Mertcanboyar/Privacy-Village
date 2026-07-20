// Tiny module singleton for "which authenticated player is this,
// if any" — separate from session.ts's identity (name/avatar/faction),
// which guests have too. Plain in-memory state, same style as
// session.ts/questEngine.ts: set once Title.ts's boot() resolves the
// Supabase session, read by cloud/save.ts to decide whether (and where)
// to write, and by hud.ts to decide whether to show "SAVE YOUR RECORD".

let currentUserId: string | null = null;

export function setCurrentUserId(id: string | null) {
  currentUserId = id;
}

export function getCurrentUserId(): string | null {
  return currentUserId;
}

export function isAuthenticated(): boolean {
  return currentUserId !== null;
}
