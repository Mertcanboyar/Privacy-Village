import { Resend } from "resend";
import type { IncomingMessage, ServerResponse } from "node:http";

// Vercel serverless function — POST { email } to join the Founding Privacy Villager
// waitlist. Wired from Title.ts's soft gate; see this repo's DEPLOY.md
// for the RESEND_API_KEY / OWNER_NOTIFY_EMAIL / RESEND_AUDIENCE_ID env
// vars this depends on.
//
// Not covered by the client build's tsc (tsconfig.json's "include" is
// just ["src"]) and Vercel's own Node runtime provides req.body/
// res.status()/res.json() regardless of what TS types this file
// declares for them — so these are a small local shape rather than a
// dependency on @vercel/node purely for typing.
interface WaitlistRequest extends IncomingMessage {
  method?: string;
  body?: unknown;
}
interface WaitlistResponse extends ServerResponse {
  status(code: number): WaitlistResponse;
  json(body: unknown): void;
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OWNER_NOTIFY_EMAIL = process.env.OWNER_NOTIFY_EMAIL;
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;

const FROM_ADDRESS = "Privacy Village <agents@privacyvillage.org>";
const SITE_URL = "https://play.privacyvillage.org";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_BYTES = 1024;

// Best-effort abuse guard, not real rate limiting: each serverless
// invocation may land on a different warm container with its own copy
// of this Map (or a fresh one on cold start), and Vercel can run many
// containers concurrently — there is no shared state across them without
// an external store (Redis/Upstash/etc). This only blunts a single
// container fielding a dumb retry loop; a determined abuser spread
// across containers or IPs sails right through. Good enough for a
// waitlist form, not a real defense.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const requestLog = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (requestLog.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  requestLog.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

function clientIp(req: WaitlistRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return first?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
}

export function welcomeEmailHtml(): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /></head>
<body style="margin:0;padding:0;background:#0e0f16;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0e0f16;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#1e2130;border:2px solid #3d4257;border-radius:10px;">
      <tr><td style="padding:32px 32px 8px;">
        <div style="font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#f0b429;">Privacy Village</div>
      </td></tr>
      <tr><td style="padding:8px 32px 24px;">
        <p style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.6;color:#f2f0e9;">Enlistment recorded, <strong>Agent</strong> &mdash; your name is now filed in the ledger of Privacy Village's <span style="font-family:'Courier New',monospace;color:#f0b429;">Founding Privacy Villagers</span>.</p>
        <p style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.6;color:#f2f0e9;">Early access to new Trials, the annual festival, and the first credentials will reach you the moment the gates open.</p>
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.6;color:#f2f0e9;">Reply to this dispatch any time &mdash; a human reads every one, not a machine.</p>
      </td></tr>
      <tr><td align="center" style="padding:8px 32px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#f0b429;border-radius:8px;">
          <a href="${SITE_URL}" style="display:inline-block;padding:14px 28px;font-family:'Courier New',monospace;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1a1500;text-decoration:none;">Return to the Village</a>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:20px 32px 28px;border-top:1px solid #3d4257;">
        <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#9aa0b5;">
          Imagine Privacy INC &nbsp;&middot;&nbsp; <a href="${SITE_URL}/privacy" style="color:#9aa0b5;">Privacy Notice</a><br />
          Reply STOP or <a href="mailto:agents@privacyvillage.org?subject=Unsubscribe" style="color:#9aa0b5;">click here</a> to be removed.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export function notifyEmailHtml(email: string, utc: string, istanbul: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#0e0f16;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0e0f16;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#1e2130;border:2px solid #3d4257;border-radius:10px;">
      <tr><td style="padding:24px 28px;">
        <div style="font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#f0b429;margin-bottom:12px;">New Founding Privacy Villager</div>
        <p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#f2f0e9;">Email: <span style="font-family:'Courier New',monospace;">${escapeHtml(email)}</span></p>
        <p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#f2f0e9;">Time: ${escapeHtml(utc)} &middot; ${escapeHtml(istanbul)}</p>
        <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9aa0b5;">Filed from play.privacyvillage.org</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export default async function handler(req: WaitlistRequest, res: WaitlistResponse) {
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

  let email: string;
  try {
    const parsed = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    email = String((parsed as { email?: unknown })?.email ?? "").trim().toLowerCase();
  } catch {
    res.status(400).json({ ok: false, error: "invalid_json" });
    return;
  }

  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ ok: false, error: "invalid_email" });
    return;
  }

  // Past this point the email is well-formed — whatever happens with
  // Resend below, we always resolve {ok:true}. Signup problems must
  // never block entry into the game.
  if (!RESEND_API_KEY) {
    console.error("[waitlist] RESEND_API_KEY not set — skipping email send for", email);
    res.status(200).json({ ok: true });
    return;
  }

  const resend = new Resend(RESEND_API_KEY);
  const now = new Date();
  const utc = `${now.toISOString().replace("T", " ").replace(/\.\d+Z$/, "")} UTC`;
  const istanbul = `${new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", dateStyle: "medium", timeStyle: "short" }).format(now)} Istanbul`;

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: email,
      subject: "Enlistment recorded, Agent",
      html: welcomeEmailHtml(),
    });
  } catch (err) {
    console.error("[waitlist] welcome email failed for", email, err);
  }

  if (OWNER_NOTIFY_EMAIL) {
    try {
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: OWNER_NOTIFY_EMAIL,
        subject: `New Founding Privacy Villager: ${email}`,
        html: notifyEmailHtml(email, utc, istanbul),
      });
    } catch (err) {
      console.error("[waitlist] owner notification failed for", email, err);
    }
  } else {
    console.error("[waitlist] OWNER_NOTIFY_EMAIL not set — skipping owner notification for", email);
  }

  if (RESEND_AUDIENCE_ID) {
    try {
      await resend.contacts.create({ email, audienceId: RESEND_AUDIENCE_ID });
    } catch (err) {
      // "Already exists" is an expected, non-error outcome for a repeat
      // signup — only log genuinely unexpected failures.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) {
        console.error("[waitlist] audience add failed for", email, err);
      }
    }
  }

  res.status(200).json({ ok: true });
}
