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

/**
 * Who a reply to this email should reach, and whose name should be on it —
 * 2026-10-13, "can the email go through the sales rep?" NOT a way to send AS
 * the rep: Graph app-only sending is fenced by an Exchange
 * ApplicationAccessPolicy scoped to `aiodocuments@aioapp.com` alone (see
 * CLAUDE.md's "Transactional email"), and `sendViaGraph`'s own `from` is
 * hardcoded to that same mailbox for exactly that reason — setting `from` to
 * an arbitrary rep's address would 403 `ErrorAccessDenied`, and widening the
 * policy to cover every rep mailbox is a tenant-admin decision (an Exchange
 * `ApplicationAccessPolicy`/Send-As grant), not something this file can do.
 * So the mailbox a merchant's reply actually lands in stays the shared one;
 * this only changes the REPLY-TO header (Graph and Resend both honor it
 * independently of `from`) and the display name, which cost nothing to add
 * and need no tenant change. `email` must already be the rep's VERIFIED
 * address — see `resolveReplyToRep` in actions/prospects.ts, which reuses
 * `resolveSender`'s portal-owner check so a seeded dev row like
 * `rep@aioapp.com` never reaches a real merchant here either.
 */
export type ReplyToRep = { email: string; name?: string };

function senderDisplayName(rep?: ReplyToRep | null): string {
  return rep?.name ? `${rep.name} (AIO Payments)` : MAIL_FROM_NAME;
}

async function sendViaGraph(to: string, subject: string, html: string, rep?: ReplyToRep | null): Promise<void> {
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
          // ADDRESS stays the shared mailbox the request is addressed to —
          // changing it is what would need SendAs rights we don't have. Only
          // the display NAME varies with the rep; see senderDisplayName.
          from: { emailAddress: { address: MAIL_FROM, name: senderDisplayName(rep) } },
          ...(rep ? { replyTo: [{ emailAddress: { address: rep.email, name: rep.name } }] } : {}),
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

// The address half of FROM, reused below so a per-rep display name can be
// substituted without hand-parsing the whole "Name <addr>" string twice.
const FROM_ADDRESS = FROM.match(/<([^>]+)>/)?.[1] ?? FROM;

async function sendViaResend(to: string, subject: string, html: string, rep?: ReplyToRep | null): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${senderDisplayName(rep)} <${FROM_ADDRESS}>`,
      to,
      subject,
      html,
      // Resend's own reply_to param — honored independently of `from`, same
      // as Graph's replyTo above.
      ...(rep ? { reply_to: rep.email } : {}),
    }),
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
async function send(
  to: string, subject: string, html: string, fallbackUrl: string, rep?: ReplyToRep | null
): Promise<SendMagicLinkResult> {
  let graphError: unknown = null;

  if (graphConfigured()) {
    try {
      await sendViaGraph(to, subject, html, rep);
      return { sent: true, devUrl: null };
    } catch (err) {
      graphError = err;
      console.error("Graph send failed:", err instanceof Error ? err.message : err);
    }
  }

  if (process.env.RESEND_API_KEY) {
    try {
      await sendViaResend(to, subject, html, rep);
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
  /**
   * The rep's first name, when `sendLeadLinkEmail` was given a verified one —
   * changes only the closing line's wording (see `render`'s footer below) to
   * say replying reaches them by name, rather than the generic "one of our
   * representatives". The reply-to header itself is set independently in
   * `send`/`sendViaGraph`/`sendViaResend`; this is cosmetic, not what actually
   * routes the reply.
   */
  repName?: string;
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
      ${t.repName
        ? `Sent by AIO Payments on behalf of ${esc(t.repName)}, your AIO representative. Questions? Just reply to this email — it goes straight to them.`
        : "Sent by AIO Payments because you&rsquo;re working with one of our representatives. Questions? Use the link above, or ask your AIO representative."}
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
//
// There is NO "go straight to billing" secondary CTA here any more, and there
// cannot be one (2026-10-15). It carried HubSpot's `hs_quote_link`, which only
// existed because `createProspectAction` published the quote before sending
// this email. The merchant now confirms their own details first and the
// publish happens after that, so at the moment this email is written there is
// no HubSpot document to link to — and offering a route that skipped the
// confirmation step would defeat the point of having one. The primary CTA,
// our own `/lead` page, is where everything starts.
//
// `rep` (10/13/2026, "can the email go through the sales rep?"): the owning
// rep's VERIFIED identity, when `actions/prospects.ts`'s `resolveReplyToRep`
// could establish one. See `ReplyToRep`'s own comment above for why this is a
// reply-to + display name, never a true send-as. Optional — a lookup that
// fails just means this email reads like every one sent before 10/13.
export async function sendLeadLinkEmail(
  to: string, url: string, merchantName?: string, rep?: ReplyToRep | null
): Promise<SendMagicLinkResult> {
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
      repName: rep?.name,
    }),
    url,
    rep
  );
}

// The one-time invoice (2026-10-22): hardware, install and training, billed
// after acceptance on a HubSpot invoice. HubSpot's API has no "send this
// invoice" call EasyOB relies on, so the pay link goes out through the same
// transport as everything else, to the billing contact the confirm form names
// ("This is where your invoices will be emailed to").
export async function sendOneTimeInvoiceEmail(
  to: string, url: string, amount: string, merchantName?: string
): Promise<SendMagicLinkResult> {
  const name = merchantName?.trim();
  return send(
    to,
    "Your AIO hardware & setup invoice",
    render({
      preheader: `${amount} for your hardware, installation and training — due on receipt.`,
      heading: name ? `${name}, your hardware & setup invoice` : "Your hardware & setup invoice",
      body: [
        `Thanks for signing up with AIO. This invoice covers your one-time charges — hardware, installation and training — for ${amount}.`,
        "It's due on receipt and is paid by bank transfer (ACH). Your monthly plan is billed separately, as set out in your quote.",
      ],
      cta: "View and pay your invoice",
      url,
      footnote: "This link opens your invoice on AIO's secure payment page.",
    }),
    url
  );
}
