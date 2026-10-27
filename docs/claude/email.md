# Transactional email

## Transactional email (2026-09-24)

Merchant email goes through **Microsoft Graph, app-only, from AIO's own M365 tenant** — not Resend.
Resend stays wired as the fallback and is what a local checkout without tenant credentials uses.
**LIVE-VERIFIED 2026-09-24** via `scripts/send-test-email.ts`.

This sidesteps the Phase 4 Resend blocker entirely: a fresh `send.aioapp.com` subdomain would need
SPF/DKIM/DMARC records and would start with zero sending reputation, whereas
`aiodocuments@aioapp.com` already has both.

**EasyOB reuses the EXISTING `AIO Document Send` app registration**
(`747446ca-b3c9-4537-b2b5-066de0264e70` — the one behind "mockusign"), because it already has
everything the hard way costs:

| | |
|---|---|
| `Mail.Send` | already admin-consented |
| Exchange fence | already `RestrictAccess` to `AIO App Senders` → `aiodocuments@aioapp.com` |
| EasyOB's credential | a **separate second client secret** on that same app, minted 2026-09-24, 24 months |

**Rights live on the app registration, not on the secret.** So EasyOB's secret carries the same
authority as mockusign's, and the separation is of *rotation*, not of *permission*: deleting or
rotating EasyOB's secret leaves mockusign running, but revoking the app's `Mail.Send` — or deleting
the app — takes down both. The real cost of sharing is that both products are one identity in
sign-in and audit logs.

**Don't "improve" this into a separate registration.** That was tried first and was a mistake:
creating the app, its service principal and a secret only needs Application Administrator, but
**granting a Graph APPLICATION permission needs Global Administrator or Privileged Role
Administrator** — Application/Cloud Application Administrator is blocked by Microsoft, since an app
admin who could grant app permissions could grant themselves `Directory.ReadWrite.All`. Verified
live: `403 Authorization_RequestDenied`. A separate identity therefore costs a Global Admin and a
second Exchange fence, and buys only cleaner audit attribution.

`scripts/entra-mail-app.ps1` still exists as the escape hatch if that trade is ever worth making;
its header states the privilege cost. It is NOT the live setup.

**`Mail.Send` as an application permission is TENANT-WIDE** — without an Exchange
`ApplicationAccessPolicy` an app can send as *any* mailbox. Anything sending mail here must be
fenced. Tenant audit from the same session, unrelated to EasyOB but worth someone's attention:
**`QA-Automatic Email App` and `Logsign Mail Integration` hold UNFENCED tenant-wide `Mail.Send`.**
`AIO Nexus - Mail` IS fenced, but via the newer RBAC-for-Applications mechanism rather than
`ApplicationAccessPolicy`, so a check reading only the latter misreports it as unfenced.

**`documentsend@aioapp.com` does not exist** in the tenant — not a mailbox, not an alias, not a
proxy address. The real shared mailbox is `aiodocuments@aioapp.com`, and Graph's `sendMail` is
addressed to `/users/{mailbox}`, so it must be a real mailbox rather than an alias.

**It is load-bearing.** `sendMagicLinkEmail` is what creates a merchant's account after they sign
and pay (see the acceptance constraint above). Acceptance is recorded once, so there is no second
attempt — which is why a Graph failure falls through to Resend rather than giving up, accepting a
possible duplicate email as the cheaper failure.

**Both emails render through one template** (`render()` in `adapters/email.ts`): Hallmark, transcribed
for an inbox. The design system is CSS custom properties in oklch and email is none of those, so the
tokens are restated there as sRGB hex — **that block is the only sanctioned copy of them**; if a
token moves in `globals.css`, move its twin. Three things are left out on purpose and each would
look right in a browser and wrong in an inbox: no logo IMAGE (Outlook and most Gmail accounts block
remote images, and the absolute URL is localhost in dev — a type wordmark always renders), no
Coolvetica (self-hosted woff2; `@font-face` in mail is honoured by roughly nobody), and no gradient
(it needs VML to survive Outlook). Every caller-supplied value — the URL, the merchant name — goes
through `esc()`, because a merchant name is rep-entered text landing in an `href` and a heading.

Verify with `npx tsx scripts/send-test-email.ts <address>`, which goes through the shipping
`sendMagicLinkEmail` rather than curling Graph — and loads env with `@next/env`, so the `\$`-escaped
secret takes the same dotenv-expand path it does under `next dev`.

**In Vercel Production since 2026-09-24** (all five, and the project forces type `Sensitive` on
every variable, not just the secret). Two consequences:

- `vercel env pull` can neither read these back nor preserve them — it overwrites `.env.local`
  wholesale, so back it up first. Same hazard already documented for the Entra vars.
- **A production deploy is required for them to take effect** — env changes don't reach existing
  deployments.

On rotation, push the secret with the **raw `$`**, not the `\$` form that goes in `.env.local`:
Vercel stores literally and does not run dotenv-expand. (The 2026-09-24 secret happens to contain
no `$` at all, so this was moot that time — check each new one rather than assuming.)

**Third email, 2026-10-26: `sendFoodbuyEnrollmentEmail`.** It goes to the Foodbuy rep, not to a merchant, and it is the first email with an **attachment** (Graph `fileAttachment` / Resend `attachments`, both base64). It sets Reply-To to the merchant through `SendExtras.replyTo`, which, unlike `rep`, does NOT change the sender display name. `render()` now leaves out the button block when no `url`/`cta` is given, and takes an optional `footer`. Graph's sendMail accepts inline attachments only up to ~3MB, so callers must cap them (`FOODBUY_SEND_MAX_BYTES`).
