"use client";

import { useActionState } from "react";
import { connectBounceTrackingAction, saveSettings } from "../actions";

export function WebhookPanel({ connected, url }: { connected: boolean; url: string }) {
  const [auto, autoAction, autoPending] = useActionState(connectBounceTrackingAction, undefined);
  const [manual, manualAction, manualPending] = useActionState(saveSettings, undefined);
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="section-head head-wrap" style={{ marginBottom: 6 }}>
        <h3 className="section-title" style={{ fontSize: 15 }}>Bounce tracking</h3>
        <span className={`pill dot ${connected ? "live" : "mock"}`}>{connected ? "Connected" : "Not connected"}</span>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        When an email bounces after Resend accepted it, the customer moves to Needs Attention so you know to fix the address.
      </p>
      <form action={autoAction} style={{ marginTop: 10 }}>
        <button className="btn" disabled={autoPending}>{autoPending ? "Connecting…" : connected ? "Reconnect automatically" : "Connect automatically"}</button>
        {auto?.error && <p className="form-msg err">{auto.error}</p>}
        {auto?.ok && <p className="form-msg ok">{auto.ok}</p>}
      </form>
      <details className="fold" style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--ink-2)" }}>Set up by hand instead</summary>
        <p className="hint">
          In Resend → Webhooks, add URL <code style={{ overflowWrap: "anywhere" }}>{url}</code> with events
          <code> email.bounced</code> and <code>email.complained</code>, then paste its signing secret here.
        </p>
        <form action={manualAction} className="form-grid stack" style={{ maxWidth: 560 }}>
          <div className="field">
            <label htmlFor="s-whsec">Signing secret</label>
            <input id="s-whsec" name="resend_webhook_secret" type="password" autoComplete="off" placeholder="whsec_…" />
          </div>
          <button className="btn btn-primary" disabled={manualPending} style={{ justifyContent: "center" }}>
            {manualPending ? "Saving…" : "Save secret"}
          </button>
          {manual?.error && <p className="form-msg err">{manual.error}</p>}
          {manual?.ok && <p className="form-msg ok">{manual.ok}</p>}
        </form>
      </details>
    </div>
  );
}
