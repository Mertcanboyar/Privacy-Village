// Races a Supabase call against a fixed timeout so a stalled network
// request (DNS hang, dead connection, a misconfigured project URL that
// never resolves/responds) can never leave a caller awaiting forever.
// Used for reads on the hydrate-on-load path (Title.ts's getSession()/
// fetchProfile()/fetchProgress()) — a slow or hung read there must
// degrade to "treat this player as a guest for now," never to a frozen
// title screen. The original promise is not cancelled (fetch has no
// cheap abort plumbed through here) — it's just no longer awaited; if
// it resolves later, its result is discarded.
export const HYDRATE_TIMEOUT_MS = 3000;

export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
