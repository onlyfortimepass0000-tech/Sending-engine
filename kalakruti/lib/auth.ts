/**
 * Single-owner login, two modes:
 *
 *  - "remote" (Supabase, always on Vercel): the password hash and session
 *    tokens live in the database. The cookie holds a random session token
 *    that the database itself checks on every query (row-level security).
 *  - local demo: ADMIN_PASSWORD env var + an HMAC-signed cookie. With no
 *    password set outside production, the dashboard is open.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSupabase, usingSupabase } from "./store";

export const SESSION_COOKIE = "pr_session";
export const MAX_AGE_S = 60 * 60 * 24 * 30;

export type AuthMode = "remote" | "password" | "open" | "misconfigured";

export function authMode(): AuthMode {
  if (usingSupabase()) return "remote";
  if (process.env.ADMIN_PASSWORD) return "password";
  return process.env.NODE_ENV === "production" ? "misconfigured" : "open";
}

function secret() {
  return process.env.SESSION_SECRET || `pw:${process.env.ADMIN_PASSWORD ?? ""}`;
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Returns a session token to store in the cookie, or null if the password is wrong. */
export async function login(password: string): Promise<string | null> {
  const mode = authMode();
  if (mode === "remote") return getSupabase()!.login(password);
  const pw = process.env.ADMIN_PASSWORD;
  if (mode !== "password" || !pw || !safeEqual(password, pw)) return null;
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
  return `${exp}.${sign(exp)}`;
}

export async function logout(token: string | undefined) {
  if (token && authMode() === "remote") await getSupabase(token)!.logout();
}

export async function isValidSession(token: string | undefined): Promise<boolean> {
  const mode = authMode();
  if (mode === "open") return true;
  if (!token) return false;
  if (mode === "remote") return getSupabase(token)!.isAuthorized();
  if (mode !== "password") return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now() / 1000;
}
