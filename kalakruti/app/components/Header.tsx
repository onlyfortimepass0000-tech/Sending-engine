import Link from "next/link";
import { logout } from "../actions";
import { authMode } from "@/lib/auth";
import type { EmailSettings } from "@/lib/settings";
import { usingSupabase } from "@/lib/store";
import { Nav } from "./Nav";

export function Header({ mode }: { mode: EmailSettings["mode"] }) {
  const live = mode === "live";
  const canLogout = authMode() === "remote" || authMode() === "password";
  return (
    <header className="top">
      <Link href="/" className="brand">
        <span className="brand-mark">₹</span>
        <span className="brand-full">Payment Reminders</span>
        <span className="brand-short">Reminders</span>
      </Link>
      <div className="top-right">
        <Link
          href="/settings"
          className={`pill dot ${live ? "live" : "mock"}`}
          title={live ? "Emails go out via Resend" : "Log-only: no real emails are sent"}
          style={{ textDecoration: "none" }}
        >
          {live ? "Live email" : "Mock mode"}
        </Link>
        <Nav />
        {canLogout && (
          <form action={logout}>
            <button className="btn btn-ghost signout">Sign out</button>
          </form>
        )}
      </div>
    </header>
  );
}

export function SetupBanners({ email }: { email: EmailSettings }) {
  const notes: React.ReactNode[] = [];
  if (authMode() === "open") notes.push("No ADMIN_PASSWORD set — the dashboard is open. Fine locally; set one before deploying.");
  if (!usingSupabase()) notes.push("Using the local demo data file (no Supabase configured).");
  if (email.mode === "mock") {
    notes.push(
      <>
        Mock mode: reminders are logged but <b>not emailed</b>.{" "}
        {!email.apiKey ? "Add your Resend API key" : "Add your verified sender address"} in{" "}
        <Link href="/settings">Settings</Link> to go live.
      </>,
    );
  }
  if (!notes.length) return null;
  return (
    <div className="banner">
      {notes.map((n, i) => (
        <div key={i}>{n}</div>
      ))}
    </div>
  );
}
