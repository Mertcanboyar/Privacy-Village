import { el } from "../ui/dom";
import { playSound } from "../audio";
import { supabase } from "./supabaseClient";
import { logPersistence } from "./log";
import { markOtpRequested, hasRequestedOtpFor } from "./authState";

// Shared by Title.ts's "Become a Founding Privacy Villager" gate and
// hud.ts's mid-session "SAVE YOUR RECORD" upgrade — same panel, same
// submit logic, different surrounding chrome (Title mounts it inline in
// its own layout; the HUD wraps it in a floating modal). Handles its
// own form -> check-inbox -> form-again lifecycle internally so neither
// caller has to.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EmailCapturePanelOptions {
  heading: string;
  subline: string;
  buttonLabel: string;
  showSkipLink?: boolean;
  onSkip?: () => void;
  /** Fired right before the auth email is sent — hud.ts's upgrade flow
   * uses this to snapshot current guest progress into localStorage
   * (see cloud/pendingUpgrade.ts) so it survives the magic-link
   * navigation. Title.ts's first-time signup doesn't need it. */
  beforeAuthSubmit?: (email: string) => void;
  /** Bracket the async submit window (waitlist POST + signInWithOtp) —
   * hud.ts's mid-session modal uses these to lock/unlock player movement
   * (see cloud/uiLock.ts), guaranteed via try/finally below regardless
   * of which way submit() exits. Title.ts's gate has no movement concept
   * to lock, so it leaves these unset. */
  onSubmitStart?: () => void;
  onSubmitEnd?: () => void;
  /** Default true (hud.ts's mid-session upgrade keeps this): wait for
   * signInWithOtp and show "Check your inbox, Agent" on success. Set
   * false for a first-touch gate like Title.ts's — a brand-new player
   * has maybe 30 seconds before they're bored, and a screen telling
   * them to go read their email before they've even seen the village
   * is exactly the kind of friction that loses them. false fires the
   * OTP request in the background (still logged, still arrives, still
   * works whenever they get to it — see Title.ts's boot()) and calls
   * onFallback the moment the (fast, local) waitlist POST settles,
   * without waiting on email infrastructure at all. */
  blockOnAuth?: boolean;
  /** Called when Supabase isn't configured at all, the OTP send itself
   * failed (bad config, rate limit), or — when blockOnAuth is false —
   * unconditionally once the waitlist POST settles, regardless of the
   * (still in-flight or already-failed) auth attempt. waitlistOk always
   * reflects the independent /api/waitlist POST only. */
  onFallback: (email: string, waitlistOk: boolean) => void;
}

async function postWaitlist(email: string): Promise<boolean> {
  try {
    const res = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    return res.ok;
  } catch {
    // Network down, /api unavailable in local dev, etc. — never blocks
    // the rest of the flow (see api/waitlist.ts's own failure policy).
    return false;
  }
}

export function buildEmailCapturePanel(opts: EmailCapturePanelOptions): HTMLElement {
  const container = el("div", { className: "panel", style: { display: "flex", flexDirection: "column", alignItems: "center", padding: "28px 36px 24px" } });
  renderForm(container, opts);
  return container;
}

function renderForm(container: HTMLElement, opts: EmailCapturePanelOptions) {
  container.innerHTML = "";

  let emailInput!: HTMLInputElement;
  let errorEl!: HTMLElement;
  let submitBtn!: HTMLButtonElement;
  // Reentrancy guard for this one panel instance: submitBtn.disabled
  // gets set synchronously below, but that alone doesn't stop the
  // input's own Enter-triggered submit() (a separate listener,
  // unaffected by the button's disabled state) from firing a second
  // time if Enter and a click land in the same tick. Checked first,
  // before anything else, so a double-fire can never reach
  // signInWithOtp() at all.
  let submitting = false;

  const submit = async () => {
    if (submitting) return;
    const email = emailInput.value.trim();
    if (!EMAIL_RE.test(email)) {
      errorEl.textContent = "That doesn't look like an email address.";
      shake(emailInput);
      return;
    }
    submitting = true;
    errorEl.textContent = "";
    playSound("confirm");
    submitBtn.disabled = true;
    submitBtn.textContent = "Joining…";

    const waitlistPromise = postWaitlist(email);

    if (!supabase) {
      logPersistence({ action: "signInWithOtp", table: "auth", payload: { email }, status: "skip" });
      const waitlistOk = await waitlistPromise;
      opts.onFallback(email, waitlistOk);
      return;
    }

    opts.beforeAuthSubmit?.(email);

    // Supabase enforces a resend cooldown (~60s) per email address —
    // firing a second signInWithOtp() for the SAME address this page
    // load (e.g. a player who signed up via Title's low-friction gate,
    // then also clicks the HUD's "SAVE YOUR RECORD" out of curiosity)
    // is a genuine 429 from a single real signup, not abuse. If this
    // exact email already has a request in flight, skip the network
    // call entirely and just proceed as if it succeeded again — the
    // original magic link is still the one that matters.
    const alreadyRequested = hasRequestedOtpFor(email);
    const signInPromise = alreadyRequested
      ? Promise.resolve(true)
      : supabase.auth
          .signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } })
          .then(({ error }) => {
            if (error) {
              logPersistence({ action: "signInWithOtp", table: "auth", payload: { email }, status: "error", error });
              return false;
            }
            logPersistence({ action: "signInWithOtp", table: "auth", payload: { email }, status: "ok" });
            markOtpRequested(email);
            return true;
          })
          .catch((err: unknown) => {
            logPersistence({ action: "signInWithOtp", table: "auth", payload: { email }, status: "error", error: err });
            return false;
          });
    if (alreadyRequested) {
      logPersistence({ action: "signInWithOtp", table: "auth", payload: { email }, status: "skip" });
    }

    if (opts.blockOnAuth === false) {
      // Don't make a first-touch player wait on email infrastructure —
      // the OTP request is already in flight and keeps running/logging
      // in the background; entry proceeds the moment the fast, local
      // waitlist POST settles. See the option's doc comment.
      opts.onSubmitStart?.();
      void signInPromise.finally(() => opts.onSubmitEnd?.());
      const waitlistOk = await waitlistPromise;
      opts.onFallback(email, waitlistOk);
      return;
    }

    opts.onSubmitStart?.();
    try {
      const [waitlistOk, authOk] = await Promise.all([waitlistPromise, signInPromise]);

      if (authOk) {
        renderCheckInbox(container, opts, email);
      } else {
        // Supabase configured but the OTP call itself failed — a hiccup
        // here must never block entry either, so fall back exactly like
        // the not-configured path. The real error is now in the console
        // (see logPersistence above) instead of silently discarded.
        opts.onFallback(email, waitlistOk);
      }
    } finally {
      opts.onSubmitEnd?.();
    }
  };

  emailInput = el("input", {
    attrs: { type: "email", placeholder: "you@email.com", autocomplete: "email" },
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "15px",
      padding: "10px 14px",
      borderRadius: "var(--radius-sm)",
      border: "2px solid var(--border-strong)",
      background: "var(--bg-raised)",
      color: "var(--text-primary)",
      textAlign: "center",
      width: "260px",
    },
    on: {
      keydown: (e) => {
        if ((e as KeyboardEvent).key === "Enter") submit();
      },
    },
  });

  errorEl = el("div", {
    style: { fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--accent-red)", minHeight: "14px", marginTop: "6px" },
  });

  submitBtn = el("button", {
    className: "btn btn--gold",
    text: opts.buttonLabel,
    style: { marginTop: "14px", fontSize: "15px", padding: "14px 28px" },
    on: { click: submit },
  });

  const children: (Node | string)[] = [
    el("div", {
      text: opts.heading,
      style: {
        fontFamily: "var(--font-display)",
        fontWeight: "700",
        fontSize: "18px",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        fontVariantCaps: "small-caps",
        color: "var(--accent-gold)",
      },
    }),
    el("p", {
      text: opts.subline,
      style: { fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-muted)", margin: "8px 0 18px", textAlign: "center", maxWidth: "320px" },
    }),
    emailInput,
    errorEl,
    submitBtn,
  ];

  if (opts.showSkipLink) {
    children.push(
      el("a", {
        text: "just exploring →",
        attrs: { href: "#" },
        style: {
          display: "inline-block",
          marginTop: "12px",
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
          color: "var(--text-muted)",
          textDecoration: "none",
          cursor: "pointer",
        },
        on: {
          click: (e) => {
            e.preventDefault();
            playSound("select");
            opts.onSkip?.();
          },
        },
      }),
    );
  }

  const consentLine = el("p", {
    style: {
      marginTop: "16px",
      maxWidth: "320px",
      fontFamily: "var(--font-body)",
      fontSize: "11px",
      lineHeight: "1.5",
      color: "var(--text-muted)",
      textAlign: "center",
    },
  });
  consentLine.append(
    "We'll email you about Privacy Village only. No sharing, unsubscribe anytime. ",
    el("a", {
      text: "Privacy Notice",
      attrs: { href: "/privacy", target: "_blank", rel: "noopener noreferrer" },
      style: { color: "var(--text-muted)", textDecoration: "underline" },
    }),
  );
  children.push(consentLine);

  container.append(...children);
}

function renderCheckInbox(container: HTMLElement, opts: EmailCapturePanelOptions, email: string) {
  container.innerHTML = "";
  container.append(
    el("div", {
      text: "Check your inbox, Agent",
      style: {
        fontFamily: "var(--font-display)",
        fontWeight: "700",
        fontSize: "18px",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        fontVariantCaps: "small-caps",
        color: "var(--accent-gold)",
      },
    }),
    el("p", {
      text: `Your enlistment link awaits — we've sent it to ${email}.`,
      style: { fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-muted)", margin: "8px 0 4px", textAlign: "center", maxWidth: "300px" },
    }),
    el("a", {
      text: "use a different email",
      attrs: { href: "#" },
      style: {
        display: "inline-block",
        marginTop: "10px",
        fontFamily: "var(--font-mono)",
        fontSize: "12px",
        color: "var(--text-muted)",
        textDecoration: "none",
        cursor: "pointer",
      },
      on: {
        click: (e) => {
          e.preventDefault();
          renderForm(container, opts);
        },
      },
    }),
  );
}

function shake(target: HTMLElement) {
  target.style.animation = "none";
  void target.offsetWidth; // reflow, so re-triggering the same animation twice in a row still plays
  target.style.animation = "ds-shake 400ms ease-in-out";
}
