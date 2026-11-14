"use client";

import { useActionState } from "react";
import { saveSettings } from "../actions";

export function SettingsForm(props: {
  keyHint: string;
  from: string;
  replyTo: string;
  businessName: string;
  fromLocked: boolean;
}) {
  const [state, action, pending] = useActionState(saveSettings, undefined);
  return (
    <form action={action} className="panel">
      <div className="form-grid stack" style={{ maxWidth: 560 }}>
        <div className="field">
          <label htmlFor="s-biz">Business name (used to sign the emails)</label>
          <input id="s-biz" name="business_name" defaultValue={props.businessName} placeholder="Kalakruti" />
        </div>
        <div className="field">
          <label htmlFor="s-key">Resend API key</label>
          <input id="s-key" name="resend_api_key" type="password" autoComplete="off" placeholder="re_…" />
          <p className="hint" style={{ margin: "4px 0 0" }}>{props.keyHint}</p>
        </div>
        <div className="field">
          <label htmlFor="s-from">Send reminders from</label>
          <input
            id="s-from"
            name="email_from"
            defaultValue={props.from}
            placeholder="Accounts <accounts@yourdomain.com>"
            readOnly={props.fromLocked}
          />
        </div>
        <div className="field">
          <label htmlFor="s-reply">Replies go to (optional — separate several with commas)</label>
          <input id="s-reply" name="email_reply_to" type="text" defaultValue={props.replyTo} placeholder="you@gmail.com" />
        </div>
        <button className="btn btn-primary" disabled={pending} style={{ justifyContent: "center" }}>
          {pending ? "Saving…" : "Save settings"}
        </button>
        {state?.error && <p className="form-msg err">{state.error}</p>}
        {state?.ok && <p className="form-msg ok">{state.ok}</p>}
      </div>
    </form>
  );
}
