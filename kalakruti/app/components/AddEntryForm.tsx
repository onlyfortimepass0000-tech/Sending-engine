"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { addEntry } from "../actions";

export function AddEntryForm({ today }: { today: string }) {
  const [state, action, pending] = useActionState(addEntry, undefined);
  const form = useRef<HTMLFormElement>(null);
  // Phones show a single button until tapped; desktop always shows the form.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (state?.ok) {
      form.current?.reset();
      form.current?.querySelector<HTMLInputElement>("input[name=customer_name]")?.focus();
    }
  }, [state]);

  return (
    <>
      <button type="button" className="btn btn-primary add-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Close" : "+ Add outstanding payment"}
      </button>
    <form ref={form} action={action} className={`panel add-body${open ? " open" : ""}`}>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="f-name">Customer / business</label>
          <input id="f-name" name="customer_name" required placeholder="Sharma Traders" />
        </div>
        <div className="field">
          <label htmlFor="f-email">Email</label>
          <input id="f-email" name="email" type="email" required placeholder="accounts@sharma.in" />
        </div>
        <div className="field">
          <label htmlFor="f-amount">Amount owed</label>
          <input id="f-amount" name="amount" type="number" step="0.01" min="0.01" required placeholder="25000" inputMode="decimal" />
        </div>
        <div className="field">
          <label htmlFor="f-due">Due date</label>
          <input id="f-due" name="due_date" type="date" required defaultValue={today} />
        </div>
        <button className="btn btn-primary" disabled={pending}>
          {pending ? "Adding…" : "+ Add"}
        </button>
      </div>
      {state?.error && <p className="form-msg err">{state.error}</p>}
      {state?.ok && <p className="form-msg ok">{state.ok} Reminders are scheduled automatically.</p>}
    </form>
    </>
  );
}
