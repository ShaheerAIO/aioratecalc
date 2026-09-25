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
// The app registration behind these is the EXISTING "AIO Document Send"
// (747446ca-…, the one behind mockusign), using a second client secret minted
// on it — NOT the staff sign-in app (AUTH_MICROSOFT_ENTRA_ID_*), and not a
// registration of its own. Rights live on the registration rather than the
// secret, so the second secret buys independent ROTATION, not independent
// permission. See "Transactional email" in the root CLAUDE.md for why a
// separate identity was tried and abandoned (granting a Graph application
// permission needs Global Administrator).
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

// ── The template ────────────────────────────────────────────────────────────
//
// Hallmark, rendered for email. The app's design system (globals.css,
// design.md) is CSS custom properties in oklch, and email is neither: no
// `var()`, no oklch, no external stylesheet, no flexbox, and Outlook still
// renders through Word. So the tokens are transcribed here as sRGB hex, and
// they are the ONLY place in the codebase allowed to restate them — if a token
// moves in globals.css, move its twin below.
//
//   --paper  #fbf5f4   --ink    #251d1c   --accent      #f26c54
//   --paper-2 #fefbfa  --ink-2  #5f5654   --accent-text #be260b
//   --rule   #e4dcda   --ink-3  #928a88   --accent-2    #767edc
//
// Deliberate omissions, each of which would look right in a browser and wrong
// in an inbox:
//  - No logo IMAGE. Outlook and most Gmail accounts block remote images by
//    default, and the absolute URL would be a localhost one in dev. A type
//    wordmark always renders, everywhere.
//  - No Coolvetica. It is a self-hosted woff2; @font-face in mail is honoured
//    by roughly nobody. Plus Jakarta Sans is linked for the clients that do
//    honour a <style> block, and everything else lands on the system stack.
//  - No gradient. The nav gradient needs VML to survive Outlook, and a header
//    that renders as a grey slab in a third of inboxes is worse than none.
const C = {
  paper: "#fbf5f4",
  card: "#ffffff",
  ink: "#251d1c",
  ink2: "#5f5654",
  ink3: "#928a88",
  rule: "#e4dcda",
  accent: "#f26c54",
} as const;

const FONT =
  "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Attribute- and text-safe. `url` and `merchantName` are both caller-supplied. */
function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type Template = {
  /** The inbox preview line. Without one, clients scrape the first visible text. */
  preheader: string;
  heading: string;
  /** Rendered as one <p> each, in order. Plain text — escaped, no markup. */
  body: string[];
  cta: string;
  url: string;
  /** Small print under the button: what the link is good for. */
  footnote: string;
};

function render(t: Template): string {
  const url = esc(t.url);
  const paragraphs = t.body
    .map(
      line =>
        `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.ink2};">${esc(line)}</p>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(t.heading)}</title>
<style>
  @import url("https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap");
  a { color: #be260b; }
  @media (max-width: 600px) { .card { padding: 28px 22px !important; } }
</style>
</head>
<body style="margin:0;padding:0;background:${C.paper};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(t.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.paper};">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

    <tr><td style="padding:0 4px 18px;font-family:${FONT};font-size:13px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:${C.ink};">
      AIO <span style="color:${C.accent};">Payments</span>
    </td></tr>

    <tr><td class="card" style="background:${C.card};border:1px solid ${C.rule};border-radius:20px;padding:38px 36px;">
      <h1 style="margin:0 0 14px;font-family:${FONT};font-size:23px;line-height:1.25;font-weight:700;color:${C.ink};">${esc(t.heading)}</h1>
      ${paragraphs}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 18px;"><tr>
        <td bgcolor="${C.accent}" style="border-radius:999px;">
          <a href="${url}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:15px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;border-radius:999px;">${esc(t.cta)}</a>
        </td>
      </tr></table>
      <p style="margin:0 0 20px;font-family:${FONT};font-size:13px;line-height:1.6;color:${C.ink3};">${esc(t.footnote)}</p>
      <div style="border-top:1px solid ${C.rule};padding-top:18px;">
        <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.ink3};">Button not working? Paste this into your browser:</p>
        <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.5;word-break:break-all;"><a href="${url}" style="color:#be260b;text-decoration:underline;">${url}</a></p>
      </div>
    </td></tr>

    <tr><td style="padding:20px 4px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.ink3};">
      Sent by AIO Payments because you&rsquo;re working with one of our representatives. Questions? Just reply to this email.
    </td></tr>

  </table>
</td></tr>
</table>
</body></html>`;
}

// ── The two emails ──────────────────────────────────────────────────────────

export async function sendMagicLinkEmail(to: string, url: string): Promise<SendMagicLinkResult> {
  const subject = "Continue your AIO Payments application";
  return send(
    to,
    subject,
    render({
      preheader: "Your secure link is inside — it expires in 30 minutes.",
      heading: "Continue your application",
      body: [
        "Here's your secure link back into your AIO Payments application. It signs you straight in — no password to remember.",
      ],
      cta: "Continue your application",
      url,
      footnote: "This link expires in 30 minutes and can only be used by you. If it runs out, request a new one from the sign-in page.",
    }),
    url
  );
}

// Phase 4 — the prospect-creation link, a 14-day `lead_upload` token, not the
// short-lived KYC-handoff one above. Same transport, different copy/TTL.
export async function sendLeadLinkEmail(to: string, url: string, merchantName?: string): Promise<SendMagicLinkResult> {
  const name = merchantName?.trim();
  return send(
    to,
    "Your AIO Payments quote is ready",
    render({
      preheader: "See your rates and what switching to AIO would save you.",
      heading: name ? `${name}, your quote is ready` : "Your quote is ready",
      body: [
        "Your AIO Payments quote is ready to look at — your rates, your monthly cost, and what switching would save you against what you pay today.",
        "No account and no password needed. The link below opens it directly.",
      ],
      cta: "View your quote",
      url,
      footnote: "This link is valid for 14 days.",
    }),
    url
  );
}
