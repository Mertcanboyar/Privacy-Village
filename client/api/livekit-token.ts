import { AccessToken } from "livekit-server-sdk";
import type { IncomingMessage, ServerResponse } from "node:http";

// Vercel serverless function — POST { sessionId, name, sceneId } to mint a
// short-lived LiveKit token scoped to the room named after the current
// scene. Wired from client/src/voice.ts's connectToScene(); see this
// repo's DEPLOY.md for the LIVEKIT_API_KEY / LIVEKIT_API_SECRET /
// LIVEKIT_URL env vars this depends on. The secret never leaves this
// function — the client only ever receives the minted JWT.
//
// Not covered by the client build's tsc (tsconfig.json's "include" is
// just ["src"]) and Vercel's own Node runtime provides req.body/
// res.status()/res.json() regardless of what TS types this file
// declares for them — same shape as api/waitlist.ts, for the same reason
// (avoids a needless @vercel/node dependency purely for typing).
interface TokenRequest extends IncomingMessage {
  method?: string;
  body?: unknown;
}
interface TokenResponse extends ServerResponse {
  status(code: number): TokenResponse;
  json(body: unknown): void;
}

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

// Doubles as the LiveKit room-name allowlist — a client can only ever
// mint a token for one of the game's real scenes, never an arbitrary
// room name. Mirrors client/src/rooms.ts's ROOMS list; duplicated here
// rather than imported since this file isn't part of the client's src/
// build graph.
const VALID_SCENE_IDS = new Set(["village", "tavern", "courthouse", "great_hall"]);

// Colyseus session ids are short alphanumeric tokens (colyseus.js's own
// id generator) — this is a shape check, not an identity check. See the
// header comment on the handler below for what this endpoint can and
// cannot actually verify.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LEN = 40;
const MAX_BODY_BYTES = 512;

// Same best-effort, non-durable-across-containers abuse guard as
// api/waitlist.ts — see that file's identical comment. Good enough at
// this trust level, not a real defense.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const requestLog = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (requestLog.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  requestLog.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

function clientIp(req: TokenRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return first?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
}

export default async function handler(req: TokenRequest, res: TokenResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  if (isRateLimited(clientIp(req))) {
    res.status(429).json({ ok: false, error: "rate_limited" });
    return;
  }

  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    res.status(413).json({ ok: false, error: "payload_too_large" });
    return;
  }

  let sessionId: string;
  let name: string;
  let sceneId: string;
  try {
    const parsed = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as {
      sessionId?: unknown;
      name?: unknown;
      sceneId?: unknown;
    };
    sessionId = String(parsed?.sessionId ?? "");
    name = String(parsed?.name ?? "").trim().slice(0, MAX_NAME_LEN);
    sceneId = String(parsed?.sceneId ?? "");
  } catch {
    res.status(400).json({ ok: false, error: "invalid_json" });
    return;
  }

  if (!SESSION_ID_RE.test(sessionId)) {
    res.status(400).json({ ok: false, error: "invalid_session_id" });
    return;
  }
  if (!name) {
    res.status(400).json({ ok: false, error: "missing_name" });
    return;
  }
  if (!VALID_SCENE_IDS.has(sceneId)) {
    res.status(400).json({ ok: false, error: "invalid_scene_id" });
    return;
  }

  // What "verify they're a real session" can honestly mean here: this
  // codebase has no session-auth boundary anywhere, guest or
  // authenticated (see client/src/cloud/authState.ts — Supabase login is
  // optional and skippable; server/src/rooms/SceneRoom.ts's own comments
  // already state its join options are "not a privilege boundary"). There
  // is no shared secret between SceneRoom.ts and this function, so this
  // endpoint cannot cryptographically prove sessionId belongs to a real
  // Colyseus participant — only that it's plausibly shaped, alongside the
  // IP rate limit above. That's the ceiling of what's honestly available
  // without adding a real auth system elsewhere in the stack first, which
  // is out of scope for this feature.
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
    console.error("[livekit-token] LIVEKIT_API_KEY/LIVEKIT_API_SECRET/LIVEKIT_URL not fully set");
    res.status(500).json({ ok: false, error: "server_misconfigured" });
    return;
  }

  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: sessionId, name });
    at.addGrant({ room: sceneId, roomJoin: true, canPublish: true, canSubscribe: true });
    const token = await at.toJwt();
    res.status(200).json({ ok: true, token, url: LIVEKIT_URL });
  } catch (err) {
    console.error("[livekit-token] token mint failed", err);
    res.status(500).json({ ok: false, error: "mint_failed" });
  }
}
