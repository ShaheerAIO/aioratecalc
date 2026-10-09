// Runs the /api/cron/hubspot-links passes now, without a dev server.
//
//   npx tsx scripts/run-hubspot-links.ts
//
// Calls the SHIPPING adapter functions, so this does exactly what the nightly
// cron does: stamp every deal's easyob_link, and empty the company-level one
// it replaced.
//
// NEXT_PUBLIC_BASE_URL is pinned here because .env.local points at
// localhost:5001 and backfillEasyobDealLinks refuses to write a non-public
// link — correctly, since the link is for reps clicking it out of HubSpot.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
process.env.NEXT_PUBLIC_BASE_URL = "https://aioeasyob.vercel.app";

async function main() {
  // Imported AFTER loadEnvConfig — the adapter reads tokens from process.env.
  const { backfillEasyobDealLinks, clearCompanyEasyobLinks } = await import("../src/lib/adapters/hubspot");

  console.log("[deal links] starting");
  console.log("[deal links]", JSON.stringify(await backfillEasyobDealLinks()));

  console.log("[company link clears] starting");
  console.log("[company link clears]", JSON.stringify(await clearCompanyEasyobLinks()));

  const { auditQuoteTemplatePolicy } = await import("../src/lib/actions/quoteTemplates");
  const audit = await auditQuoteTemplatePolicy();
  console.log("[quote templates]", JSON.stringify(audit));
  if (audit.stale.length > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
