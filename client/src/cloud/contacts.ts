import { supabase } from "./supabaseClient";
import { logPersistence } from "./log";
import { persistenceStatus } from "./persistenceStatus";
import { withTimeout, HYDRATE_TIMEOUT_MS } from "./withTimeout";

// §4 "Contact Exchange" (see PLAN.md) — one row per completed
// handshake, one row per direction (each side writes their own). Same
// null-safe/timeout-raced read convention as decisions.ts; saveContact()
// mirrors logDecision()'s fire-and-forget write shape.

export interface ContactRow {
  id: number;
  owner_id: string;
  other_id: string | null;
  other_name: string;
  other_contact: string;
  created_at: string;
}

export async function fetchContacts(userId: string): Promise<ContactRow[]> {
  if (!supabase) return [];
  let timedOut = false;
  try {
    const { data, error } = await withTimeout<{ data: ContactRow[] | null; error: unknown }>(
      Promise.resolve(supabase.from("contacts").select("*").eq("owner_id", userId).order("created_at", { ascending: false })),
      HYDRATE_TIMEOUT_MS,
      { data: null, error: null },
      () => (timedOut = true),
    );
    if (timedOut) {
      logPersistence({ action: "fetchContacts", table: "contacts", status: "timeout" });
      persistenceStatus.reportError("fetchContacts timed out");
      return [];
    }
    if (error) {
      logPersistence({ action: "fetchContacts", table: "contacts", status: "error", error });
      persistenceStatus.reportError(error);
      return [];
    }
    logPersistence({ action: "fetchContacts", table: "contacts", payload: { userId, count: data?.length ?? 0 }, status: "ok" });
    persistenceStatus.reportOk();
    return data ?? [];
  } catch (err) {
    logPersistence({ action: "fetchContacts", table: "contacts", status: "error", error: err });
    persistenceStatus.reportError(err);
    return [];
  }
}

/** One insert per completed exchange, called by the client that just
 * finalized its side of the handshake (see net/NetClient.ts's
 * contact*() methods) — never a shared transaction, each side's own
 * insert is independent. Fire-and-forget, same try/catch-around-a-
 * fire-and-forget-promise shape as save.ts's logDecision(), for the
 * same reason: this fires from the middle of handling a network
 * message, and an uncaught throw there must not abort that handler. */
export function saveContact(ownerId: string, otherId: string | null, otherName: string, otherContact: string) {
  if (!supabase) return;
  try {
    void Promise.resolve(supabase.from("contacts").insert({ owner_id: ownerId, other_id: otherId, other_name: otherName, other_contact: otherContact }))
      .then(({ error }) => {
        if (error) {
          logPersistence({ action: "saveContact", table: "contacts", payload: { ownerId, otherName }, status: "error", error });
          persistenceStatus.reportError(error);
          return;
        }
        logPersistence({ action: "saveContact", table: "contacts", payload: { ownerId, otherName }, status: "ok" });
        persistenceStatus.reportOk();
      })
      .catch((err: unknown) => {
        logPersistence({ action: "saveContact", table: "contacts", payload: { ownerId, otherName }, status: "error", error: err });
        persistenceStatus.reportError(err);
      });
  } catch (err) {
    logPersistence({ action: "saveContact", table: "contacts", payload: { ownerId, otherName }, status: "error", error: err });
    persistenceStatus.reportError(err);
  }
}
