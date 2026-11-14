import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runDailyCheck } from "@/lib/runner";
import { getStore, getSupabase, usingSupabase } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function bearerMatches(req: NextRequest, secret: string) {
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * Runs the daily reminder check. Triggered by Supabase pg_cron (with an
 * `x-app-token` scheduler token the database verifies), or by any scheduler
 * sending `Authorization: Bearer $CRON_SECRET`. Safe to call repeatedly —
 * extra calls on the same day send nothing new.
 */
export async function GET(req: NextRequest) {
  let token: string | undefined;
  if (usingSupabase()) {
    token = req.headers.get("x-app-token") ?? undefined;
    if (!token || !(await getSupabase(token)!.isAuthorized())) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else {
    const secret = process.env.CRON_SECRET;
    const ok = secret ? bearerMatches(req, secret) : process.env.NODE_ENV !== "production";
    if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const summary = await runDailyCheck({ store: getStore(token) });
  const failed = summary.outcomes.filter((o) => o.action === "failed");
  if (failed.length) console.error(`[cron] ${failed.length} reminder(s) failed`, failed);
  return NextResponse.json(summary);
}

export const POST = GET;
