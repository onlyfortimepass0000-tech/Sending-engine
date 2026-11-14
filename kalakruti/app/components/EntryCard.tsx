"use client";

import { useActionState, useRef, useTransition } from "react";
import { deleteEntry, editEntry, markPaid, resumeAfterFailure, setReplied, togglePause, undoPaid } from "../actions";
import { useToast } from "./Toast";
import type { EntryView } from "./view";

export function EntryCard({ e }: { e: EntryView }) {
  const [pending, start] = useTransition();
  const toast = useToast();

  const onPaid = () =>
    start(async () => {
      await markPaid(e.id);
      toast({ message: `${e.customer_name} marked as paid — reminders stopped.`, undo: () => undoPaid(e.id) });
    });

  if (e.status === "paid") {
    return (
      <div className="card is-paid">
        <div className="who">
          <div className="who-name">
            {e.customer_name} <span className="amount" style={{ fontSize: 15 }}>{e.amountLabel}</span>
          </div>
          <div className="who-email">
            Due {e.dueLabel} · Paid {e.paidLabel} · {e.stages_sent} of 4 reminders sent
          </div>
        </div>
        <div className="actions">
          <button className="btn btn-ghost" disabled={pending} onClick={() => start(() => undoPaid(e.id))}>
            Undo paid
          </button>
        </div>
      </div>
    );
  }

  const cls = e.status === "needs_attention" ? "is-attention" : e.status === "paused" ? "is-paused" : "";

  return (
    <div className={`card ${cls}`}>
      <div className="who">
        <div className="who-name">
          {e.customer_name}
          {e.status === "needs_attention" && (
            <span className="pill alert">{e.attention_reason === "send_failed" ? "Email failed" : "All 4 sent · unpaid"}</span>
          )}
          {e.status === "paused" && <span className="pill">Paused</span>}
          {e.replied_at && <span className="pill info">💬 Replied</span>}
        </div>
        <div className="who-email">{e.email}</div>
        <div className="facts">
          <span className="amount">{e.amountLabel}</span>
          <span>
            Due <b>{e.dueLabel}</b> ({e.dueRelative})
          </span>
          <span className="stages" title={`${e.stages_sent} of 4 reminders sent`}>
            {[1, 2, 3, 4].map((s) => (
              <span
                key={s}
                className={`stage ${s <= e.stages_sent ? "done" : s === e.stages_sent + 1 && e.status === "active" ? "next" : ""}`}
              />
            ))}
            <span style={{ marginLeft: 6 }}>{e.stages_sent}/4 sent</span>
          </span>
          {e.nextLabel && <span className="next">Next: {e.nextLabel}</span>}
        </div>
      </div>

      <div className="actions">
        {e.status !== "needs_attention" && (
          <button
            className="switch"
            role="switch"
            aria-checked={e.status === "paused"}
            disabled={pending}
            onClick={() => start(() => togglePause(e.id))}
            title="Pause stops automatic reminders for this customer without marking paid"
          >
            <span className="switch-track" /> <span className="switch-label">{e.status === "paused" ? "Paused" : "Pause"}</span>
          </button>
        )}
        {e.status === "needs_attention" && e.attention_reason === "send_failed" && (
          <button className="btn" disabled={pending} onClick={() => start(() => resumeAfterFailure(e.id))}>
            Retry
          </button>
        )}
        <MoreMenu e={e} />
        <button className="btn btn-paid" disabled={pending} onClick={onPaid}>
          ✓ Mark Paid
        </button>
      </div>

      {e.replied_at && (
        <div className="reply-line">
          <span>
            💬 Replied {e.repliedLabel}
            {e.reply_note ? ` — “${e.reply_note}”` : ""}. Check your reply inbox, then mark it handled.
          </span>
          <button className="btn" disabled={pending} onClick={() => start(() => setReplied(e.id, false))}>
            Handled
          </button>
        </div>
      )}

      {e.last_error && <div className="error-line">⚠ Last send failed: {e.last_error}</div>}
    </div>
  );
}

function MoreMenu({ e }: { e: EntryView }) {
  const [state, action, pending] = useActionState(editEntry, undefined);
  const [deleting, start] = useTransition();
  const details = useRef<HTMLDetailsElement>(null);
  return (
    <details className="more" ref={details}>
      <summary className="btn btn-ghost" aria-label="More options">
        Edit
      </summary>
      <div className="more-panel">
        <div className="sheet-head">
          <b>Edit {e.customer_name}</b>
          <button type="button" className="btn btn-ghost" onClick={() => details.current?.removeAttribute("open")}>
            ✕ Close
          </button>
        </div>
        {!e.replied_at && (
          <button
            type="button"
            className="btn"
            style={{ marginBottom: 10 }}
            onClick={() => {
              details.current?.removeAttribute("open");
              void setReplied(e.id, true);
            }}
          >
            💬 Mark as replied
          </button>
        )}
        <form action={action} className="form-grid stack">
          <input type="hidden" name="id" value={e.id} />
          <div className="field">
            <label>Customer name</label>
            <input name="customer_name" defaultValue={e.customer_name} required />
          </div>
          <div className="field">
            <label>Email</label>
            <input name="email" type="email" defaultValue={e.email} required />
          </div>
          <div className="field">
            <label>Amount</label>
            <input name="amount" type="number" step="0.01" min="0.01" defaultValue={e.amount} required />
          </div>
          <div className="field">
            <label>Due date</label>
            <input name="due_date" type="date" defaultValue={e.due_date} required readOnly={e.stages_sent > 0} />
          </div>
          {e.stages_sent > 0 && <p className="hint" style={{ margin: 0 }}>Due date is locked once reminders have started.</p>}
          <button className="btn btn-primary" disabled={pending} style={{ justifyContent: "center" }}>
            Save changes
          </button>
          {state?.error && <p className="form-msg err">{state.error}</p>}
          {state?.ok && <p className="form-msg ok">{state.ok}</p>}
        </form>
        {!e.hasSends && (
          <button
            className="btn btn-ghost btn-danger"
            style={{ marginTop: 8 }}
            disabled={deleting}
            onClick={() => {
              if (confirm(`Delete ${e.customer_name}? This can't be undone.`)) start(() => deleteEntry(e.id));
            }}
          >
            Delete entry
          </button>
        )}
      </div>
    </details>
  );
}
