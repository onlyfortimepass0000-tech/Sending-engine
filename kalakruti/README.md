# Payment Reminders

Track customers who owe you money. The app emails them reminders on a fixed schedule, and flags anyone still unpaid after the last reminder so you can follow up yourself.

Built with Next.js 16, Supabase and Resend. It uses no AI APIs.

## How it works

| Reminder | When | 
|---|---|
| #1 | `REMINDER_LEAD_DAYS` before the due date (default 3) |
| #2 | On the due date |
| #3 | Due date + 1 |
| #4 | Due date + 2 |
| After #4 | Automatic reminders stop. The entry moves to **Needs Attention** |

- **Mark Paid** (the big green button on every entry) cancels all remaining reminders immediately. An *Undo* toast covers mis-taps.
- **Pause** is a one-tap switch that stops reminders for one entry without marking it paid. Use it during a negotiation or dispute, or when you've agreed a new date.
- **Catch-up:** a daily run sends at most one reminder per entry, and only the next unsent one. If a run is missed, the next run sends the stage that was skipped, and the rest of the sequence moves back by the same number of days. No stage is ever skipped, and no customer gets several reminders at once.
- **No double sends:** every attempt first claims a row in `reminder_log`. A unique index allows only one live send per entry and stage, so overlapping runs can't send the same reminder twice.
- **Failures are recorded:**
  - Every attempt is written to the **Send log** page.
  - An invalid address (Resend 4xx), or a bounce reported by webhook, moves the entry to Needs Attention and labels it **Email failed**. Fix the address and press **Retry**.
  - Temporary errors (network, 5xx) leave the entry active and are retried on the next run.

## Run locally (no keys needed)

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # schedule + runner tests
```

With no env vars set, data goes to `.data/db.json` and emails are only logged (mock mode). In mock mode you can use the **Pretend today is** date field next to *Run daily check now* to step through the whole sequence.

## Production setup (how it is deployed)

- **Hosting:** Vercel (`kalakruti-seven.vercel.app`), auto-deployed from `main`. No Vercel env vars are needed.
- **Database:** tables `pr_entries` and `pr_reminder_log` in a shared Supabase project (see `supabase/migrations/`). The app uses the project's *publishable* key (in `lib/config.ts`). Every query must also carry a login or scheduler token in an `x-app-token` header, and row-level security checks it. Without a valid token a request sees nothing.
- **Login:** the owner password is stored as a bcrypt hash in `pr_private.settings`. To change it, run in the Supabase SQL editor:
  `update pr_private.settings set value = extensions.crypt('NEW-PASSWORD', extensions.gen_salt('bf')) where key = 'admin_password_hash';`
- **Scheduler:** Supabase `pg_cron` calls `/api/cron/daily` at 09:00 and 15:00 IST with the scheduler token. The 15:00 run is a safety net: nobody gets more than one reminder a day.
- **Email:** paste the Resend API key and sender address on the **Settings** page (they are stored in the database). Env vars `RESEND_API_KEY` / `EMAIL_FROM` override them if set.

Env vars still work for self-hosting elsewhere; see `.env.example`.

## Customer replies

Reminders carry a Reply-To (Settings → "Replies go to"; several addresses can be comma-separated). A customer's reply flags their entry with a **💬 Replied** badge and a dashboard banner. Detection uses Resend's `email.received` webhook event (matches the sender to an entry); you can also flag by hand from a customer's Edit panel, and tap **Handled** to clear it. Setup steps are on the Settings page.

## Adding WhatsApp later

All sending goes through `sendReminder(entry, stage)` in `lib/channels/index.ts`. To add WhatsApp:

1. Add a `phone` column.
2. Write `lib/channels/whatsapp.ts` so it returns the same `SendResult` shape.
3. Decide in `sendReminder` whether to send on both channels, or WhatsApp first with email as a fallback.

`reminder_log` already has a `channel` column.

## Layout

```
lib/schedule.ts        pure schedule rules (tested)
lib/runner.ts          the daily check
lib/channels/          sendReminder abstraction + Resend email sender
lib/store/             Supabase store + local JSON demo store
app/                   dashboard, send log, login, cron + webhook routes
supabase/migrations/   database schema
```
