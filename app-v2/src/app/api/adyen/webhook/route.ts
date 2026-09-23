import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { verifyBalancePlatformHmac, stageFromEvent } from "@/lib/adapters/adyenWebhook";
import { shouldAdvance } from "@/lib/stages";

// Public — Adyen calls this from the internet (no user session). Security is the
// HMAC signature over the raw body; we verify BEFORE parsing. Balance Platform
// webhooks acknowledge with any 2xx (no "[accepted]" body); Adyen retries if it
// doesn't get one within ~10s, so keep the work fast.
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const hmacKey = process.env.ADYEN_WEBHOOK_HMAC_KEY;

  if (!hmacKey) {
    console.error("[adyen webhook] ADYEN_WEBHOOK_HMAC_KEY not set");
    return new NextResponse("not configured", { status: 500 });
  }
  if (!verifyBalancePlatformHmac(rawBody, hmacKey, req.headers.get("hmacsignature"))) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new NextResponse("bad request", { status: 400 });
  }

  // Don't let a test webhook move a live deal (or vice versa).
  const expectedEnv = process.env.ADYEN_ENVIRONMENT || "test";
  if (event.environment && event.environment !== expectedEnv) {
    return NextResponse.json({ status: "ignored-env" }, { status: 202 });
  }

  const { legalEntityId, nextStage } = stageFromEvent(event);
  if (legalEntityId && nextStage) {
    const [row] = await db
      .select({ id: merchantApplications.id, stage: merchantApplications.stage })
      .from(merchantApplications)
      .where(sql`${merchantApplications.adyenIds}->>'legalEntityId' = ${legalEntityId}`)
      .limit(1);

    // Unknown entity → ack and ignore (retrying won't help). Only advance forward.
    if (row && shouldAdvance(row.stage, nextStage)) {
      await db
        .update(merchantApplications)
        .set({ stage: nextStage, updatedAt: new Date() })
        .where(eq(merchantApplications.id, row.id));
    }
  }

  return NextResponse.json({ status: "received" }, { status: 202 });
}
