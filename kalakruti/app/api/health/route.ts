import { NextResponse } from "next/server";
import { authMode } from "@/lib/auth";
import { usingSupabase } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Public, secret-free status check for deploy verification. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    storage: usingSupabase() ? "supabase" : "local",
    auth: authMode(),
    resendKeyInEnv: Boolean(process.env.RESEND_API_KEY),
    emailFromInEnv: Boolean(process.env.EMAIL_FROM),
  });
}
