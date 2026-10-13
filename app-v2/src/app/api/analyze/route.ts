import { NextRequest, NextResponse } from "next/server";
import { analyzeStatement } from "@/lib/claude";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";

// Rep/admin only. middleware.ts's matcher covers /rep, /admin and /customer but
// NOT /api, so the session check has to live in the route itself.
//
// The rep's statement analyzer, and since 2026-10-13 the ONLY one: it returns
// the raw StatementAnalysis (cost/margin internals and all) and every call
// bills the Anthropic API. There used to be a token-gated customer twin at
// /api/lead/[token]/analyze returning a CustomerSafeQuote; the customer is
// never asked for a statement now, so it was deleted rather than left
// reachable. Don't reintroduce a customer-facing analyze route.
export async function POST(req: NextRequest) {
  if (!(await getEffectiveRole())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { fileData, mediaType } = await req.json();
    if (!fileData || !mediaType) {
      return NextResponse.json({ error: "fileData and mediaType are required" }, { status: 400 });
    }
    const analysis = await analyzeStatement(fileData, mediaType);
    return NextResponse.json({ analysis });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
