// Phase 4: transactional email via Resend's HTTP API (no SDK/nodemailer needed).
// Unlike adyen.ts/hubspot.ts (which throw on missing config since they're only
// called from authenticated staff flows where a config error is actionable),
// this degrades gracefully — the caller is an anonymous customer who can't see
// a server error either way, so returning the link directly lets the calling
// code surface it in the UI until RESEND_API_KEY is configured.

export interface SendMagicLinkResult {
  sent: boolean;
  devUrl: string | null;
}

// Falls back to Resend's shared test domain, which only delivers to the
// account owner's own verified address — fine for dev, not for real
// merchants. Set RESEND_FROM_EMAIL once a real sending domain is verified.
const FROM = process.env.RESEND_FROM_EMAIL || "AIO Payments <onboarding@resend.dev>";

async function sendViaResend(to: string, subject: string, html: string, fallbackUrl: string): Promise<SendMagicLinkResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, devUrl: fallbackUrl };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend send failed: ${body}`);
  }
  return { sent: true, devUrl: null };
}

export async function sendMagicLinkEmail(to: string, url: string): Promise<SendMagicLinkResult> {
  return sendViaResend(
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
  return sendViaResend(
    to,
    "Your AIO Payments quote is ready",
    `<p>${greeting}</p><p>Take a look at your AIO Payments quote — no account needed:</p><p><a href="${url}">View your quote &rarr;</a></p><p>This link is valid for 14 days.</p>`,
    url
  );
}
