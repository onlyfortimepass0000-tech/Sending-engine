"use client";

import { useActionState } from "react";
import { runNow } from "../actions";

const LABEL = { sent: "Sent", failed: "FAILED", flagged: "Flagged", reconciled: "Reconciled", in_flight: "Skipped" };

export function RunPanel({ mock, today }: { mock: boolean; today: string }) {
  const [state, action, pending] = useActionState(runNow, {});
  const s = state.summary;
  return (
    <form action={action} className="panel">
      <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
        {mock && (
          <div className="field">
            <label htmlFor="sim">Pretend today is (demo)</label>
            <input id="sim" name="simulate_date" type="date" defaultValue={today} />
          </div>
        )}
        <button className="btn" disabled={pending}>
          {pending ? "Checking…" : "▶ Run daily check now"}
        </button>
      </div>
      <p className="hint">
        The check also runs automatically once a day. Running it again the same day is safe — nobody gets a
        duplicate reminder.
      </p>
      {state.error && <p className="form-msg err">{state.error}</p>}
      {s && (
        <div className="run-results">
          <b>
            Checked {s.checked} active {s.checked === 1 ? "entry" : "entries"} for {s.today}
            {s.mode === "mock" ? " (mock mode — nothing actually emailed)" : ""}.
          </b>
          {s.outcomes.length === 0 ? (
            <div>Nothing due today.</div>
          ) : (
            <ul>
              {s.outcomes.map((o, i) => (
                <li key={i} className={o.action === "failed" ? "failed" : ""}>
                  {LABEL[o.action]} — {o.customer}
                  {o.stage ? ` · reminder #${o.stage}` : ""}
                  {o.detail ? ` · ${o.detail}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
