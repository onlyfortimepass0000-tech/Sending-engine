import type { FC } from 'hono/jsx';
import type { ClientRecord } from '../lib/clients';
import { formatDate, formatMoney } from '../lib/payments/dates';
import type { ImportLine } from '../lib/payments/import';
import { nextReminderDate, STAGE_LABELS, TOTAL_STAGES } from '../lib/payments/schedule';
import type { PaymentEntry, Tab } from '../lib/payments/store';
import { fmtTime, Layout, type Ctx } from './views';

export interface TimelineRow {
  at: string;
  label: string;
  detail?: string;
}

export function entryBadge(e: PaymentEntry): { label: string; cls: string } {
  if (e.status === 'paid') return { label: 'Paid', cls: 's-won' };
  if (e.status === 'paused') return { label: 'Paused', cls: 's-unsubscribed' };
  if (e.status === 'needs_attention') {
    const label = { sequence_complete: 'Needs attention: still unpaid', send_failed: 'Email failed', asked_to_stop: 'Asked to stop', replied: 'Customer replied' }[e.attention_reason ?? 'sequence_complete'];
    return { label, cls: 's-lost' };
  }
  return e.paid_minor > 0 ? { label: 'Part paid', cls: 's-contacted' } : { label: 'Active', cls: 's-new' };
}

const Badge: FC<{ e: PaymentEntry }> = ({ e }) => {
  const b = entryBadge(e);
  return <span class={`chip ${b.cls}`}>{b.label}</span>;
};

const money = (minor: number, e: Pick<PaymentEntry, 'currency'>) => formatMoney(minor, e.currency);

const Input: FC<{ label: string; name: string; value?: string; type?: string; required?: boolean; hint?: string; step?: string; maxlength?: number }> = ({ label, name, value, type = 'text', required, hint, step, maxlength }) => (
  <div>
    <label for={name}>{label}</label>
    <input id={name} type={type} name={name} value={value ?? ''} required={required} step={step} maxlength={maxlength} />
    {hint && <p class="hint">{hint}</p>}
  </div>
);

export const MSG: Record<string, string> = {
  created: 'Entry added.',
  recorded: 'Payment recorded.',
  paid: 'Marked paid in full.',
  undone: 'Last payment undone.',
  paused: 'Paused. No reminders will go out until you resume.',
  resumed: 'Resumed.',
  retried: 'Back on the reminder schedule.',
  handled: 'Marked as handled.',
  saved: 'Saved.',
};
export const ERR: Record<string, string> = {
  invalid_name: 'Enter the customer name.',
  invalid_email: 'Enter a valid email address.',
  invalid_amount: 'Enter an amount greater than 0 (for example 2500 or 2500.50).',
  invalid_date: 'Enter a valid due date.',
  already_paid: 'This entry is already paid in full.',
  amount_below_paid: 'The amount cannot be lower than what has already been received.',
  too_old: 'Only a payment recorded in the last 24 hours can be undone.',
  nothing_to_undo: 'There is no payment to undo.',
  not_possible_now: 'That is not possible right now.',
  changed_meanwhile: 'Something changed in the meantime. Please try again.',
  not_found: 'That entry was not found.',
  attest: 'Please tick the confirmation box: reminders must only go to real customers who owe this business money.',
  empty: 'Paste your list first.',
  nothing_readable: 'No rows could be read. Check the column order: name, email, amount, due date.',
};

const TABS: [Tab, string][] = [['active', 'Active'], ['attention', 'Needs attention'], ['paused', 'Paused'], ['paid', 'Paid'], ['all', 'All']];

export const PaymentsPage: FC<{
  ctx: Ctx;
  client: ClientRecord;
  entries: PaymentEntry[];
  sum: { active: number; attention: number; paused: number; paid: number; outstandingMinor: number };
  tab: Tab;
  q: string;
  msg?: string;
  err?: string;
}> = ({ ctx, client, entries, sum, tab, q, msg, err }) => {
  const cur = client.settings.payments.currency;
  const replied = entries.filter((e) => e.replied_at && e.status !== 'paid').length;
  return (
    <Layout title="Payments" ctx={ctx} active="payments">
      <h1>Payment reminders</h1>
      {msg && MSG[msg] && <div class="okmsg">{MSG[msg]}</div>}
      {err && ERR[err] && <div class="err">{ERR[err]}</div>}
      <div class="grid">
        <div class="stat"><b>{formatMoney(sum.outstandingMinor, cur)}</b><span>Still to collect</span></div>
        <div class="stat"><b>{sum.active}</b><span>Active</span></div>
        <div class="stat"><b>{sum.attention}</b><span>Needs attention</span></div>
        <div class="stat"><b>{sum.paused}</b><span>Paused</span></div>
        <div class="stat"><b>{sum.paid}</b><span>Paid</span></div>
      </div>
      {replied > 0 && (
        <div class="okmsg" style="margin-top:12px">💬 <b>{replied} customer{replied === 1 ? '' : 's'} replied.</b> Reminders to them have stopped until you mark the reply as handled.</div>
      )}
      <div class="row" style="margin:14px 0">
        <a class="btn fit" href="/app/payments/import">Import a list</a>
        <form method="get" class="row" style="flex:1">
          <input type="hidden" name="tab" value={tab} />
          <input type="text" name="q" value={q} placeholder="Search name or email" />
          <div class="fit"><button class="alt" type="submit">Search</button></div>
        </form>
      </div>
      <p>
        {TABS.map(([t, label]) => (
          <a class={`btn fit ${t === tab ? '' : 'alt'}`} style="margin-right:6px" href={`/app/payments?tab=${t}`}>{label}</a>
        ))}
      </p>
      <div class="card scroll">
        {entries.length === 0 ? (
          <p class="mute">Nothing here yet.</p>
        ) : (
          <table>
            <thead><tr><th>Customer</th><th>Balance</th><th>Due</th><th>Reminders</th><th>Status</th></tr></thead>
            <tbody>
              {entries.map((e) => {
                const next = nextReminderDate(e, client.settings.payments.lead_days);
                return (
                  <tr>
                    <td><a href={`/app/payments/${e.id}`}>{e.customer_name}</a>{e.replied_at && e.status !== 'paid' ? ' 💬' : ''}<div class="small mute">{e.email}</div></td>
                    <td><b>{money(e.amount_minor - e.paid_minor, e)}</b>{e.paid_minor > 0 && <div class="small mute">of {money(e.amount_minor, e)}</div>}</td>
                    <td class="small">{formatDate(e.due_date)}</td>
                    <td class="small">{e.stages_sent} / {TOTAL_STAGES}{next ? <div class="mute">next {formatDate(next)}</div> : null}</td>
                    <td><Badge e={e} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <details class="card">
        <summary><b>Add one entry by hand</b></summary>
        <form method="post" action="/app/payments/new">
          <div class="row">
            <Input label="Customer name" name="customer_name" required maxlength={100} />
            <Input label="Email" name="email" type="email" required />
          </div>
          <div class="row">
            <Input label={`Amount (${cur})`} name="amount" required hint="e.g. 2500 or 2500.50" />
            <Input label="Due date" name="due_date" type="date" required />
            <Input label="Phone (optional)" name="phone" type="tel" />
          </div>
          <Input label="Note (optional)" name="note" maxlength={200} hint="Invoice number or what it is for" />
          <p><button type="submit">Add entry</button></p>
        </form>
      </details>
    </Layout>
  );
};

export const PaymentDetailPage: FC<{
  ctx: Ctx;
  client: ClientRecord;
  e: PaymentEntry;
  timeline: TimelineRow[];
  canUndo: boolean;
  msg?: string;
  err?: string;
}> = ({ ctx, client, e, timeline, canUndo, msg, err }) => {
  const tz = client.timezone;
  const remaining = e.amount_minor - e.paid_minor;
  const next = nextReminderDate(e, client.settings.payments.lead_days);
  const post = (action: string) => `/app/payments/${e.id}/${action}`;
  return (
    <Layout title={e.customer_name} ctx={ctx} active="payments">
      <p class="small"><a href="/app/payments">← All payments</a></p>
      <h1>{e.customer_name} <Badge e={e} /></h1>
      {msg && MSG[msg] && <div class="okmsg">{MSG[msg]}</div>}
      {err && ERR[err] && <div class="err">{ERR[err]}</div>}
      {e.replied_at && e.status !== 'paid' && (
        <div class="okmsg">
          💬 <b>The customer replied</b> {fmtTime(e.replied_at, tz)}{e.reply_note ? `: "${e.reply_note}"` : ''}. Their reply is in your inbox. Reminders are stopped until you mark it handled.
          <form method="post" action={post('handled')} class="inline" style="margin-left:8px"><button class="alt" type="submit">Mark as handled</button></form>
        </div>
      )}
      {e.status === 'needs_attention' && e.attention_reason === 'send_failed' && (
        <div class="err">The reminder could not be delivered{e.last_error ? ` (${e.last_error})` : ''}. Fix the email address below, then press Retry.
          <form method="post" action={post('retry')} class="inline" style="margin-left:8px"><button type="submit">Retry</button></form></div>
      )}
      {e.status === 'needs_attention' && e.attention_reason === 'asked_to_stop' && (
        <div class="err">This customer asked to stop the reminders, so nothing more will be sent automatically. Please follow up with them yourself.</div>
      )}
      {e.status === 'needs_attention' && e.attention_reason === 'sequence_complete' && (
        <div class="err">All 4 reminders were sent and it is still unpaid. Please follow up with the customer yourself.</div>
      )}

      <div class="grid">
        <div class="stat"><b>{money(remaining, e)}</b><span>Balance to collect</span></div>
        <div class="stat"><b>{money(e.paid_minor, e)}</b><span>Received of {money(e.amount_minor, e)}</span></div>
        <div class="stat"><b>{formatDate(e.due_date)}</b><span>Due date</span></div>
        <div class="stat"><b>{e.stages_sent} / {TOTAL_STAGES}</b><span>{next ? `Next reminder ${formatDate(next)}` : 'No more reminders scheduled'}</span></div>
      </div>

      <h2>Payment received?</h2>
      <div class="card">
        {e.status === 'paid' ? (
          <p style="margin:0">Paid in full{e.paid_at ? ` on ${fmtTime(e.paid_at, tz)}` : ''}. No more reminders.</p>
        ) : (
          <div class="row">
            <form method="post" action={post('record')} class="row" style="flex:2">
              <div><label for="amount">Amount received ({e.currency})</label><input id="amount" name="amount" required placeholder="e.g. 1000" /></div>
              <div class="fit"><button type="submit">Record part or full payment</button></div>
            </form>
            <form method="post" action={post('paid')} class="fit"><button class="ok" type="submit">Mark paid in full</button></form>
          </div>
        )}
        {canUndo && <form method="post" action={post('undo')} style="margin-top:10px"><button class="alt" type="submit">Undo last payment</button></form>}
        <p class="small mute" style="margin-bottom:0">Part payments keep reminding for the balance only. Paid in full stops all reminders.</p>
      </div>

      <h2>Reminders</h2>
      <div class="card">
        <div class="row">
          {e.status === 'active' && <form method="post" action={post('pause')} class="fit"><button class="alt" type="submit">Pause reminders</button></form>}
          {e.status === 'paused' && <form method="post" action={post('resume')} class="fit"><button type="submit">Resume reminders</button></form>}
        </div>
        <p class="small mute" style="margin-bottom:0">Pause during a negotiation or when a new date is agreed. A paused entry sends nothing, and is not marked paid.</p>
      </div>

      <h2>Details</h2>
      <form method="post" action={post('edit')} class="card">
        <div class="row">
          <Input label="Customer name" name="customer_name" value={e.customer_name} required maxlength={100} />
          <Input label="Email" name="email" type="email" value={e.email} required />
        </div>
        <div class="row">
          <Input label={`Total amount (${e.currency})`} name="amount" value={String(e.amount_minor / 100)} required />
          <Input label="Due date" name="due_date" type="date" value={e.due_date} required />
          <Input label="Phone" name="phone" value={e.phone ?? ''} />
        </div>
        <Input label="Note" name="note" value={e.note ?? ''} maxlength={200} />
        <p><button type="submit">Save changes</button></p>
      </form>

      <h2>Timeline</h2>
      <div class="card">
        <ul class="tl">
          {timeline.map((t) => (
            <li><b>{t.label}</b> <span class="small mute">{fmtTime(t.at, tz)}{t.detail ? ` · ${t.detail}` : ''}</span></li>
          ))}
        </ul>
      </div>
    </Layout>
  );
};

export const stageLabel = (n: number) => STAGE_LABELS[n] ?? `Stage ${n}`;

export const ImportPage: FC<{
  ctx: Ctx;
  history: { id: string; created_at: string; rows_total: number; imported: number; skipped: number }[];
  tz: string;
  err?: string;
  text?: string;
}> = ({ ctx, history, tz, err, text }) => (
  <Layout title="Import payments" ctx={ctx} active="payments">
    <p class="small"><a href="/app/payments">← All payments</a></p>
    <h1>Import a list</h1>
    {err && ERR[err] && <div class="err">{ERR[err]}</div>}
    <form method="post" action="/app/payments/import" class="card">
      <p style="margin-top:0">Copy the rows from Excel or Google Sheets and paste them here. Columns, in this order (or with these headings): <b>name, email, amount, due date</b>, then optionally phone and note. Up to 500 rows at a time.</p>
      <textarea name="list" rows={12} placeholder={'name\temail\tamount\tdue date\nAsha Patel\tasha@example.com\t25000\t15/12/2026\nRavi Shah\travi@example.com\t₹12,500\t2026-12-20'}>{text ?? ''}</textarea>
      <p class="hint">Dates like 15/12/2026, 15-Dec-2026 or 2026-12-15 all work (day first). Amounts can have ₹ or commas.</p>
      <label style="font-weight:400"><input type="checkbox" name="attest" required /> I confirm these are <b>existing customers who owe this business money</b>. Reminders are for real customers only.</label>
      <p><button type="submit">Check and import</button></p>
    </form>
    {history.length > 0 && (
      <>
        <h2>Earlier imports</h2>
        <div class="card scroll">
          <table>
            <thead><tr><th>When</th><th>Rows received</th><th>Imported</th><th>Skipped</th><th></th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr><td class="small">{fmtTime(h.created_at, tz)}</td><td>{h.rows_total}</td><td>{h.imported}</td><td>{h.skipped}</td><td><a href={`/app/payments/imports/${h.id}`}>Report</a></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    )}
  </Layout>
);

export const ImportReportPage: FC<{
  ctx: Ctx;
  tz: string;
  imp: { created_at: string; rows_total: number; imported: number; skipped: number; warnings: number };
  lines: Pick<ImportLine, 'row' | 'name' | 'email' | 'outcome' | 'reason' | 'paused'>[];
}> = ({ ctx, tz, imp, lines }) => {
  const clean = lines.filter((l) => l.outcome === 'imported' && !l.reason).length;
  const look = lines.filter((l) => l.outcome === 'skipped' || l.reason);
  return (
    <Layout title="Import report" ctx={ctx} active="payments">
      <p class="small"><a href="/app/payments">← All payments</a> · <a href="/app/payments/import">Import another list</a></p>
      <h1>Import report</h1>
      <p class="mute small">{fmtTime(imp.created_at, tz)}</p>
      <div class="grid">
        <div class="stat"><b>{imp.rows_total}</b><span>Rows received</span></div>
        <div class="stat"><b>{clean}</b><span>Imported, all good</span></div>
        <div class="stat"><b>{imp.imported - clean}</b><span>Imported, check the note</span></div>
        <div class="stat"><b>{imp.skipped}</b><span>Not imported</span></div>
      </div>
      <h2>{look.length === 0 ? 'Everything was imported cleanly' : 'Rows that need a look'}</h2>
      {look.length > 0 && (
        <div class="card scroll">
          <table>
            <thead><tr><th>Row</th><th>Customer</th><th>Result</th><th>Why</th></tr></thead>
            <tbody>
              {look.map((l) => (
                <tr>
                  <td>{l.row}</td>
                  <td>{l.name || '–'}<div class="small mute">{l.email || '–'}</div></td>
                  <td>{l.outcome === 'skipped' ? <span class="chip s-lost">Not imported</span> : l.paused ? <span class="chip s-unsubscribed">Imported, paused</span> : <span class="chip s-contacted">Imported, check</span>}</td>
                  <td class="small">{l.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p class="small mute">Rows not imported were not saved anywhere, and nobody was emailed. Fix them in your sheet and import just those rows again.</p>
    </Layout>
  );
};
