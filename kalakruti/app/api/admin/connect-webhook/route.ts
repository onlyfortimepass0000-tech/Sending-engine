import { NextResponse, type NextRequest } from "next/server";
import { getStore, getSupabase } from "@/lib/store";
import { connectBounceTracking } from "@/lib/webhook";

export const dynamic = "force-dynamic";

/**
 * Registers the Resend bounce webhook. Needs the scheduler token
 * (`x-app-token`), the same one pg_cron uses.
 */
export async function POST(req: NextRequest) {
  const sb = getSupabase();
  const token = req.headers.get("x-app-token") ?? undefined;
  if (!sb || !token || !(await getSupabase(token)!.isAuthorized())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const host = req.headers.get("host");
  const result = await connectBounceTracking(getStore(token), `https://${host}`);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
