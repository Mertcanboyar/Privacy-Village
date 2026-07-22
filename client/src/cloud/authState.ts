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

// Which email (if any) already has a magic link in flight this page
// load — Title.ts's low-friction gate (blockOnAuth: false, see
// cloud/emailCapturePanel.ts) never sets isAuthenticated() true, so
// without this, hud.ts's "SAVE YOUR RECORD" button would still show
// right after a player just signed up, inviting a second
// signInWithOtp() call for the same address within Supabase's ~60s
// per-email resend cooldown — a real 429 a player can hit from a
// single genuine signup, not a retry. Tracked by email (not just a
// boolean) so "use a different email" still gets a fresh request.
let otpRequestedForEmail: string | null = null;

export function markOtpRequested(email: string) {
  otpRequestedForEmail = email;
}

export function hasRequestedOtpFor(email: string): boolean {
  return otpRequestedForEmail === email;
}

export function hasPendingOtpRequest(): boolean {
  return otpRequestedForEmail !== null;
}
