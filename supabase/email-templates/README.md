# Auth email templates

Division-voice HTML for Supabase's built-in auth emails. Nothing in
this folder is read by the app or any build step — paste these into
the Supabase dashboard by hand, once.

See [DEPLOY.md](../../DEPLOY.md) section H for the SMTP setup (routing
these through Resend so they send from `noreply@privacyvillage.org`
instead of Supabase's default mailer). These templates work with
Supabase's built-in mailer too — this folder is just the visual
design, independent of which mailer actually sends the email.

## Where each file goes

Open your Supabase project → **Authentication** → **Email Templates**.
For each row in the table below, click that template in the left list,
switch it to a custom template, paste the file's contents into
**Message body**, and set **Subject heading** to the value shown:

| File | Supabase template | Subject heading |
|---|---|---|
| `magic_link.html` | **Magic Link** | Your enlistment link, Agent |
| `confirm_signup.html` | **Confirm signup** | Confirm your enlistment, Agent |

### Why both — this project only calls `signInWithOtp` once

Both templates fire from the same client call
(`client/src/cloud/emailCapturePanel.ts`'s `signInWithOtp`, with
`shouldCreateUser` left at its default of `true`) — Supabase decides
which template to send, not this code:

- First time a given email hits that call → Supabase treats it as a
  new signup → sends **Confirm signup**.
- Every later call for that same (now-registered) email → Supabase
  treats it as a login → sends **Magic Link**.

So in practice, most players see **Confirm signup** exactly once and
**Magic Link** from then on. Leaving either one on Supabase's plain
default template would mean half of real auth emails look unbranded —
both need the real template here.

## Variables used

Both templates use Supabase's standard template variables — don't
rename, remove, or wrap these when pasting:

- `{{ .ConfirmationURL }}` — the actual sign-in link. This is the
  entire point of the email; it's used untouched as the button's
  `href`.
- `{{ .SiteURL }}` — your project's configured Site URL (see
  [DEPLOY.md](../../DEPLOY.md) section F, step 3). Used for the
  footer's Privacy Notice link (`{{ .SiteURL }}/privacy`) so it always
  points at whichever domain is actually live, instead of a domain
  hardcoded into the template.

## Other templates — untouched

Supabase also has **Invite user**, **Change email address**, and
**Reset password** template slots. This project never triggers any of
them (no invite flow, no email-change UI, no password auth at all), so
they're left on Supabase's defaults and have no file here.
