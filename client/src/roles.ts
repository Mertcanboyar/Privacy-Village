import { getCurrentUserEmail } from "./cloud/authState";

// §3 "Visible Identity" (see PLAN.md) — a hand-edited allowlist, not an
// admin UI. Keyed by email (see data/roles.json's own header comment
// and authState.ts's getCurrentUserEmail() for why email, not user id).
// Guests and unlisted emails simply get no role, same "no special case"
// treatment as everything else in this file.

export type Role = "speaker" | "host" | "founding";

class RolesManager {
  private roles: Record<string, Role> = {};

  loadData(roles: Record<string, Role>) {
    this.roles = roles;
  }

  getMyRole(): Role | null {
    const email = getCurrentUserEmail();
    if (!email) return null;
    return this.roles[email] ?? null;
  }
}

export const roles = new RolesManager();
