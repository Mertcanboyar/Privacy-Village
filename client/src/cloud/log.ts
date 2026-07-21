import { isAuthenticated } from "./authState";

// Dev-only visibility into every persistence call this game makes —
// every save.ts/profile.ts/emailCapturePanel.ts operation reports here
// instead of failing silently. Gated on import.meta.env.DEV so none of
// this ships in the production bundle's console output; Vite statically
// strips the whole call in a prod build since the condition is
// build-time-constant-foldable.

export type PersistenceLogStatus = "ok" | "error" | "skip" | "timeout";

export interface PersistenceLogEntry {
  /** What just happened — "signInWithOtp", "fetchProfile", "logDecision", etc. */
  action: string;
  /** Table touched, if any — "profiles" | "progress" | "decisions" | "auth". */
  table?: string;
  /** Whatever's useful to see — kept small; never the anon key or a session token. */
  payload?: unknown;
  status: PersistenceLogStatus;
  error?: unknown;
}

const STATUS_COLOR: Record<PersistenceLogStatus, string> = {
  ok: "#3ddc84",
  error: "#ef476f",
  timeout: "#f5a623",
  skip: "#9aa0b5",
};

const STATUS_ICON: Record<PersistenceLogStatus, string> = {
  ok: "✓",
  error: "✗",
  timeout: "⏱",
  skip: "–",
};

export function logPersistence(entry: PersistenceLogEntry) {
  if (!import.meta.env.DEV) return;

  const authState = isAuthenticated() ? "authenticated" : "guest";
  const label = `%c[persistence] ${STATUS_ICON[entry.status]} ${entry.action}${entry.table ? ` → ${entry.table}` : ""}`;
  console.groupCollapsed(label, `color:${STATUS_COLOR[entry.status]}`);
  console.log("auth state:", authState);
  if (entry.table) console.log("table:", entry.table);
  if (entry.payload !== undefined) console.log("payload:", entry.payload);
  console.log("status:", entry.status);
  if (entry.error !== undefined) console.error("error:", entry.error);
  console.groupEnd();
}
