import { ownerStore } from "@/lib/session";
import { emailSettings } from "@/lib/settings";
import { Header } from "../components/Header";
import { headers } from "next/headers";
import { SettingsForm } from "./SettingsForm";
import { WebhookPanel } from "./WebhookPanel";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const store = await ownerStore();
  const email = await emailSettings(store);
  const host = (await headers()).get("host") ?? "";
  const webhookUrl = `${host.startsWith("localhost") ? "http" : "https"}://${host}/api/webhooks/resend`;
  const keyHint =
    email.source.apiKey === "env"
      ? "Set in hosting environment (RESEND_API_KEY) — that value is used."
      : email.apiKey
        ? `Saved (…${email.apiKey.slice(-4)}). Leave blank to keep it.`
        : "Not set — reminders are only logged, not emailed.";

  return (
    <main className="wrap">
      <Header mode={email.mode} />
      <div className="section-head head-wrap">
        <h2 className="section-title">Settings</h2>
        <span className={`pill dot ${email.mode === "live" ? "live" : "mock"}`}>
          {email.mode === "live" ? "Live — emails are being sent" : "Mock — nothing is emailed yet"}
        </span>
      </div>
      <SettingsForm
        keyHint={keyHint}
        from={email.from}
        replyTo={email.replyTo}
        businessName={email.businessName === "Our team" ? "" : email.businessName}
        fromLocked={email.source.from === "env"}
      />
      <WebhookPanel connected={email.webhookConnected} url={webhookUrl} />
      <div className="panel" style={{ marginTop: 16, fontSize: 14, color: "var(--ink-2)" }}>
        <b style={{ color: "var(--ink)" }}>Flag customer replies automatically.</b> Replies already reach the address
        in “Replies go to”. To also get a <b>💬 Replied</b> badge on the dashboard:
        <ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>
          <li>In Resend, turn on <b>Receiving</b> and copy your receiving address (it ends in <code>.resend.app</code>).</li>
          <li>In Resend → Webhooks, edit the webhook above and also tick <code>email.received</code>.</li>
          <li>
            Above, set “Replies go to” to your own email <b>and</b> that address, separated by a comma. A reply then goes to
            both: it lands in your inbox, and the dashboard flags the customer.
          </li>
        </ol>
        <p className="hint">You can always flag a reply by hand: open a customer’s Edit and choose “Mark as replied”.</p>
      </div>
      <div className="panel" style={{ marginTop: 16, fontSize: 14, color: "var(--ink-2)" }}>
        <b style={{ color: "var(--ink)" }}>About the sender address.</b> Resend only delivers to your customers from a
        domain you have verified in Resend (Domains → Add domain, then add the DNS records it shows). Until then you
        can use <code>onboarding@resend.dev</code>, which only delivers to the email address of your own Resend
        account — handy for a test, but reminders to customers will fail and show as “Email failed”.
      </div>
    </main>
  );
}
