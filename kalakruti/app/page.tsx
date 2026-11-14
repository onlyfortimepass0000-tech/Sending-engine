import { config } from "@/lib/config";
import { formatMoney, todayIn } from "@/lib/dates";
import { ownerStore } from "@/lib/session";
import { emailSettings } from "@/lib/settings";
import { AddEntryForm } from "./components/AddEntryForm";
import { EntryCard } from "./components/EntryCard";
import { Header, SetupBanners } from "./components/Header";
import { RunPanel } from "./components/RunPanel";
import { ToastProvider } from "./components/Toast";
import { toView, type EntryView } from "./components/view";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const store = await ownerStore();
  const today = todayIn(config.timezone);
  const [entries, sends, email] = await Promise.all([
    store.listEntries(),
    store.listSends({ limit: 5000 }),
    emailSettings(store),
  ]);
  const withSends = new Set(sends.map((s) => s.entry_id));
  const views = entries.map((e) => toView(e, today, withSends.has(e.id)));

  const attention = views.filter((e) => e.status === "needs_attention");
  const active = views.filter((e) => e.status === "active").sort((a, b) => a.due_date.localeCompare(b.due_date));
  const paused = views.filter((e) => e.status === "paused");
  const paid = views
    .filter((e) => e.status === "paid")
    .sort((a, b) => (b.paid_at ?? "").localeCompare(a.paid_at ?? ""));

  const sum = (list: EntryView[]) => formatMoney(list.reduce((t, e) => t + e.amount, 0), config.currency);
  const outstanding = [...attention, ...active, ...paused];
  const replied = outstanding.filter((e) => e.replied_at);

  return (
    <ToastProvider>
      <main className="wrap">
        <Header mode={email.mode} />
        <SetupBanners email={email} />

        {replied.length > 0 && (
          <div className="reply-banner" role="status">
            💬 {replied.length === 1 ? "1 customer has" : `${replied.length} customers have`} replied:{" "}
            {replied.map((e) => e.customer_name).join(", ")}
          </div>
        )}

        <div className="stats">
          <a href="#attention" className={`stat ${attention.length ? "alert" : ""}`}>
            <div className="stat-label">Needs attention</div>
            <div className="stat-value">{attention.length}</div>
            <div className="stat-sub">{attention.length ? sum(attention) : "All clear"}</div>
          </a>
          <a href="#active" className="stat">
            <div className="stat-label">Reminders running</div>
            <div className="stat-value">{active.length}</div>
            <div className="stat-sub">{sum(active)}</div>
          </a>
          <a href="#paused" className="stat">
            <div className="stat-label">Paused</div>
            <div className="stat-value">{paused.length}</div>
            <div className="stat-sub">{sum(paused)}</div>
          </a>
          <div className="stat">
            <div className="stat-label">Total outstanding</div>
            <div className="stat-value" style={{ fontSize: 22 }}>{sum(outstanding)}</div>
            <div className="stat-sub">{outstanding.length} unpaid</div>
          </div>
        </div>

        {attention.length > 0 ? (
          <section id="attention" className="attention">
            <div className="section-head">
              <h2 className="section-title">⚠ Needs attention <span className="pill alert">{attention.length}</span></h2>
            </div>
            <p className="attention-note">
              Automatic reminders have stopped for these. Follow up personally, then mark paid.
            </p>
            <div className="list">
              {attention.map((e) => (
                <EntryCard key={e.id} e={e} />
              ))}
            </div>
          </section>
        ) : (
          <div id="attention" className="all-clear">
            <b>✓</b> Nothing needs your attention right now.
          </div>
        )}

        <section className="section">
          <div className="section-head hide-mobile">
            <h2 className="section-title">Add outstanding payment</h2>
          </div>
          <AddEntryForm today={today} />
        </section>

        <section id="active" className="section">
          <div className="section-head head-wrap">
            <h2 className="section-title">Reminders running <span className="count">{active.length}</span></h2>
            <span className="count rule">
              #1 {config.leadDays} days before · #2 on due date · #3, #4 the next two days
            </span>
          </div>
          {active.length ? (
            <div className="list">
              {active.map((e) => (
                <EntryCard key={e.id} e={e} />
              ))}
            </div>
          ) : (
            <div className="empty">No active reminders. Add an outstanding payment above.</div>
          )}
        </section>

        <section id="paused" className="section">
          <div className="section-head">
            <h2 className="section-title">Paused <span className="count">{paused.length}</span></h2>
          </div>
          {paused.length ? (
            <div className="list">
              {paused.map((e) => (
                <EntryCard key={e.id} e={e} />
              ))}
            </div>
          ) : (
            <div className="empty">Nothing paused. Use Pause when you're negotiating or have agreed a new date.</div>
          )}
        </section>

        <section className="section">
          <details className="fold">
            <summary className="section-head">
              <h2 className="section-title">
                <svg className="chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg> Paid <span className="count">{paid.length}</span>
              </h2>
            </summary>
            {paid.length ? (
              <div className="list">
                {paid.map((e) => (
                  <EntryCard key={e.id} e={e} />
                ))}
              </div>
            ) : (
              <div className="empty">No paid entries yet.</div>
            )}
          </details>
        </section>

        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Daily check</h2>
          </div>
          <RunPanel mock={email.mode === "mock"} today={today} />
        </section>
      </main>
    </ToastProvider>
  );
}
