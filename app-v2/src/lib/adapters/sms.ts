// Phase 4: transactional SMS via Twilio's REST API (no SDK), mirroring
// email.ts's posture — degrades gracefully so an unconfigured or misdialed
// number falls back to the rep's copy-link UI instead of blocking the send.

export interface SendSmsResult {
  sent: boolean;
  devUrl: string | null;
}

// Twilio requires E.164. Reps type US numbers in whatever format they like,
// so a bare 10-digit or leading-1 11-digit number is assumed +1; anything
// already starting with "+" is trusted as-is.
function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export async function sendLeadLinkSms(to: string, url: string): Promise<SendSmsResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return { sent: false, devUrl: url };

  const toNumber = toE164(to);
  if (!toNumber) throw new Error(`"${to}" isn't a number Twilio can text — expected a 10-digit US number or E.164.`);

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const body = new URLSearchParams({ To: toNumber, From: from, Body: `Your AIO Payments quote is ready: ${url}` });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Twilio send failed: ${errBody}`);
  }
  return { sent: true, devUrl: null };
}
