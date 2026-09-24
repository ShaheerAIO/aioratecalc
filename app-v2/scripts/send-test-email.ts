// Verifies transactional email end to end, through the SHIPPING code path.
//
//   npx tsx scripts/send-test-email.ts you@aioapp.com
//
// Deliberately calls sendMagicLinkEmail() rather than curling Graph directly:
// the thing worth testing is what `applyDetectedAcceptance` actually invokes
// when a merchant finishes checkout, including the transport selection and the
// Resend fallback. A hand-rolled curl can pass while the app is still broken.
//
// Env is loaded with @next/env, not dotenv, on purpose. @next/env runs
// dotenv-expand, which is what un-escapes the `\$` that the registration script
// writes into MAIL_GRAPH_CLIENT_SECRET — so this exercises the exact escaping
// round-trip that has silently corrupted API keys in this repo before. Plain
// dotenv would hand the code a literal backslash and "work" differently here
// than in `next dev`.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error("usage: npx tsx scripts/send-test-email.ts <recipient@example.com>");
    process.exit(1);
  }

  // Imported AFTER loadEnvConfig: email.ts reads process.env at module scope,
  // so a top-level import would capture the values before the file is read.
  const { sendMagicLinkEmail } = await import("../src/lib/adapters/email");

  const graph = ["MAIL_GRAPH_TENANT_ID", "MAIL_GRAPH_CLIENT_ID", "MAIL_GRAPH_CLIENT_SECRET", "MAIL_FROM_ADDRESS"]
    .every(k => !!process.env[k]);
  console.log(`transport : ${graph ? "Microsoft Graph" : process.env.RESEND_API_KEY ? "Resend" : "NONE CONFIGURED"}`);
  console.log(`from      : ${process.env.MAIL_FROM_NAME} <${process.env.MAIL_FROM_ADDRESS}>`);
  console.log(`to        : ${to}\n`);

  const result = await sendMagicLinkEmail(to, "https://example.invalid/test-link-not-real");

  if (result.sent) {
    console.log("SENT. Check the inbox — and the shared mailbox's Sent Items.");
  } else {
    // Not a throw: this is exactly what a merchant-facing caller sees, and the
    // whole point of the degrade-gracefully contract is that it returns the
    // link instead of exploding. The console.error above it carries the reason.
    console.log("NOT SENT — every configured transport failed (see the error above).");
    console.log(`The caller would fall back to showing this link: ${result.devUrl}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
