import { NextResponse, type NextRequest } from "next/server";
import { isValidSession, SESSION_COOKIE } from "./lib/auth";

export async function proxy(request: NextRequest) {
  if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  // Cron, webhook, admin and health routes authenticate (or expose nothing) themselves.
  matcher: ["/((?!login|api/cron|api/webhooks|api/health|api/admin|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
