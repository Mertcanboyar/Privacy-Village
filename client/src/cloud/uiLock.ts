// A single, explicit lock Room.ts's uiOpen check reads alongside
// npcController.dialogueOpen/questController.dialogueOpen/academy.isOpen/
// events.isOpen — for UI that isn't any of those but still needs
// movement frozen while it's up, namely hud.ts's mid-session "SAVE YOUR
// RECORD" modal while its async submit (waitlist POST + signInWithOtp)
// is in flight. No counter/nesting support: today there's exactly one
// caller, and only one such modal can ever be open at a time (it's a
// singleton HUD overlay). Always released via try/finally at the call
// site — never left to a success-only code path — so a network error
// or an exception mid-submit can't strand the player frozen.

let locked = false;

export function lockUi() {
  locked = true;
}

export function unlockUi() {
  locked = false;
}

export function isUiLocked(): boolean {
  return locked;
}
