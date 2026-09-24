// Phase 4: transactional email. TWO transports, chosen by what's configured.
//
// Microsoft Graph is preferred: it sends from AIO's own Microsoft 365 tenant,
// so it inherits the tenant's SPF/DKIM/DMARC alignment and an existing sending
// reputation instead of starting a fresh subdomain from zero. Resend remains
// the fallback, and is still what runs in a local checkout with no tenant
// credentials.
//
// Unlike aioDashboard.ts/hubspot.ts (which throw on missing config, since they
// are only called from authenticated staff flows where a config error is
// actionable), this degrades gracefully — the caller is often an anonymous
// customer who can't see a server error either way, so returning the link
// directly lets the calling code surface it in the UI until a transport is
// configured.
//
// ⚠️ sendMagicLinkEmail is LOAD-BEARING. It is what creates a merchant's
// account after they sign and pay their quote (lib/billing/acceptance.ts), and
// nothing else will send it — there is no second attempt, because acceptance is
// recorded once. That is why a Graph failure falls through to Resend below
// rather than simply giving up.

export interface SendMagicLinkResult {
  sent: boolean;
  devUrl: string | null;
}

// ── Microsoft Graph (app-only, client credentials) ──────────────────────────
// The app registration behind these is EasyOB Mail (scripts/entra-mail-app.ps1),
// which is DELIBERATELY separate from the staff sign-in app
// (AUTH_MICROSOFT_ENTRA_ID_*): different lifecycle, different secret, and
// revoking mail access must never take staff sign-in down with it.
const GRAPH_TENANT = process.env.MAIL_GRAPH_TENANT_ID;
const GRAPH_CLIENT = process.env.MAIL_GRAPH_CLIENT_ID;
const GRAPH_SECRET = process.env.MAIL_GRAPH_CLIENT_SECRET;
// The mailbox mail is sent AS — a real mailbox, not an alias: Graph's sendMail
// is addressed to `/users/{mailbox}`. The app's Exchange ApplicationAccessPolicy
// must list this mailbox, or every send returns 403 ErrorAccessDenied.
const MAIL_FROM = process.env.MAIL_FROM_ADDRESS;
// What recipients see as the sender name. Without it they get the mailbox's own
// Exchange display name, which is rarely something you'd choose.
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || "AIO Payments";

function graphConfigured(): boolean {
  return !!(GRAPH_TENANT && GRAPH_CLIENT && GRAPH_SECRET && MAIL_FROM);
}

// One token serves every send until it expires. Cached at module scope, which
// on Fluid Compute means it survives across invocations on a warm instance —
// the whole point, since a token fetch per email would double the latency of
// every one of them.
let cachedToken: { value: string; expiresAtMs: number } | null = null;

async function graphToken(): Promise<string> {
  // 60s of slack, so a token that expires mid-flight is never used.
  if (cachedToken && Date.now() < cachedToken.expiresAtMs - 60_000) return cachedToken.value;

  const res = await fetch(`https://login.microsoftonline.com/${GRAPH_TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GRAPH_CLIENT!,
      client_secret: GRAPH_SECRET!,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    // The response body carries an AADSTS code that names the actual problem
    // (expired secret, wrong tenant, consent revoked) — worth keeping.
    throw new Error(`Graph token request failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, expiresAtMs: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function sendViaGraph(to: string, subject: string, html: string): Promise<void> {
  const token = await graphToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAIL_FROM!)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: html },
          toRecipients: [{ emailAddress: { address: to } }],
          // Same address the request is addressed to, so this only renames the
          // sender rather than asking for SendAs rights we don't have.
          from: { emailAddress: { address: MAIL_FROM, name: MAIL_FROM_NAME } },
        },
        // These are transactional one-way sends; a copy in the shared mailbox's
        // Sent Items is what makes "did the merchant get their link?" answerable
        // by a human without reading logs.
        saveToSentItems: true,
      }),
    }
  );
  // 202 Accepted is the success case — sendMail returns no body.
  if (!res.ok) throw new Error(`Graph sendMail failed (${res.status}): ${await res.text()}`);
}

// ── Resend ──────────────────────────────────────────────────────────────────

// Falls back to Resend's shared test domain, which only delivers to the
// account owner's own verified address — fine for dev, not for real
// merchants. Set RESEND_FROM_EMAIL once a real sending domain is verified.
const FROM = process.env.RESEND_FROM_EMAIL || "AIO Payments <onboarding@resend.dev>";

async function sendViaResend(to: string, subject: string, html: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${await res.text()}`);
}

// ── Transport selection ─────────────────────────────────────────────────────

/**
 * Graph first, Resend second, and `{ sent: false }` with the raw link if
 * neither is configured.
 *
 * The Resend attempt after a Graph FAILURE (not merely after Graph being
 * unconfigured) is deliberate, and it is the one place this module accepts a
 * risk: if Graph actually delivered but the response was lost, the merchant
 * gets two emails. That is a fine trade here — both links work, each expires
 * on its own, and a duplicate is a far better outcome than a merchant who paid
 * us and never receives the link that creates their account.
 */
async function send(to: string, subject: string, html: string, fallbackUrl: string): Promise<SendMagicLinkResult> {
  let graphError: unknown = null;

  if (graphConfigured()) {
    try {
      await sendViaGraph(to, subject, html);
      return { sent: true, devUrl: null };
    } catch (err) {
      graphError = err;
      console.error("Graph send failed:", err instanceof Error ? err.message : err);
    }
  }

  if (process.env.RESEND_API_KEY) {
    try {
      await sendViaResend(to, subject, html);
      if (graphError) console.warn("Graph send failed; delivered via Resend instead.");
      return { sent: true, devUrl: null };
    } catch (err) {
      console.error("Resend send failed:", err instanceof Error ? err.message : err);
    }
  }

  // Nothing configured, or every transport failed. The caller surfaces the raw
  // link so a rep can hand it over by hand rather than the merchant being stuck.
  return { sent: false, devUrl: fallbackUrl };
}

export async function sendMagicLinkEmail(to: string, url: string): Promise<SendMagicLinkResult> {
  return send(
    to,
    "Continue your AIO Payments application",
    `<p>Click below to continue your application:</p><p><a href="${url}">Continue your application &rarr;</a></p><p>This link expires in 30 minutes.</p>`,
    url
  );
}

// Phase 4 — the prospect-creation link, a 14-day `lead_upload` token, not the
// short-lived KYC-handoff one above. Same transport, different copy/TTL.
export async function sendLeadLinkEmail(to: string, url: string, merchantName?: string): Promise<SendMagicLinkResult> {
  const greeting = merchantName ? `Hi ${merchantName},` : "Hi,";
  return send(
    to,
    "Your AIO Payments quote is ready",
    `<p>${greeting}</p><p>Take a look at your AIO Payments quote — no account needed:</p><p><a href="${url}">View your quote &rarr;</a></p><p>This link is valid for 14 days.</p>`,
    url
  );
}
