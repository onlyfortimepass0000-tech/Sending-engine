import { config } from "@/lib/config";
import { formatDate } from "@/lib/dates";
import { STAGE_LABELS } from "@/lib/schedule";
import { ownerStore } from "@/lib/session";
import { emailSettings } from "@/lib/settings";
import { Header } from "../components/Header";

export const dynamic = "force-dynamic";

const STATUS_TEXT = { sent: "Sent", failed: "Failed", bounced: "Bounced", sending: "Sending / unconfirmed" };

export default async function LogPage() {
  const store = await ownerStore();
  const [sends, entries, email] = await Promise.all([
    store.listSends({ limit: 1000 }),
    store.listEntries(),
    emailSettings(store),
  ]);
  const names = new Map(entries.map((e) => [e.id, e.customer_name]));
  const failures = sends.filter((s) => s.status === "failed" || s.status === "bounced").length;
  const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: config.timezone, dateStyle: "medium", timeStyle: "short" });
  const short = new Intl.DateTimeFormat("en-IN", { timeZone: config.timezone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

  return (
    <main className="wrap">
      <Header mode={email.mode} />
      <div className="section-head head-wrap">
        <h2 className="section-title">
          Send log <span className="count">{sends.length} most recent</span>
        </h2>
        {failures > 0 && <span className="pill alert">{failures} failed</span>}
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        Every reminder attempt is recorded here — use it if a customer says they never got one.
      </p>
      {sends.length === 0 ? (
        <div className="empty">No reminders sent yet.</div>
      ) : (
        <>
        {/* Phones: one card per send */}
        <div className="log-cards">
          {sends.map((s) => (
            <div key={s.id} className={`log-card is-${s.status}`}>
              <div className="log-card-top">
                <b>{names.get(s.entry_id) ?? "(deleted)"}</b>
                <span className={`status-${s.status}`}>{STATUS_TEXT[s.status]}</span>
              </div>
              <div className="log-card-meta">
                Reminder #{s.stage} · {STAGE_LABELS[s.stage]}
              </div>
              <div className="log-card-meta">
                {short.format(new Date(s.created_at))} · to <span className="break">{s.recipient}</span>
              </div>
              {s.error && <div className="log-card-error">{s.error}</div>}
            </div>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Customer</th>
                <th>Reminder</th>
                <th>To</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {sends.map((s) => (
                <tr key={s.id}>
                  <td>
                    {fmt.format(new Date(s.created_at))}
                    <div className="mono">for {formatDate(s.run_date)}</div>
                  </td>
                  <td>{names.get(s.entry_id) ?? "(deleted)"}</td>
                  <td>
                    #{s.stage} · {STAGE_LABELS[s.stage]}
                    <div className="mono">{s.channel}</div>
                  </td>
                  <td style={{ overflowWrap: "anywhere" }}>{s.recipient}</td>
                  <td>
                    <span className={`status-${s.status}`}>{STATUS_TEXT[s.status]}</span>
                    {s.error && <div style={{ color: "var(--alert)", fontSize: 13 }}>{s.error}</div>}
                    {s.provider_message_id && <div className="mono">{s.provider_message_id}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </main>
  );
}
