# PROGRESS (read this first, nothing else; keep under 60 lines)
## Status
LIVE: https://enquiry-engine.tool-checklist-tracker.workers.dev (D1 enquiry-engine fad4c0fa..., cron */5, [ai], secrets TOKEN_SECRET
 RESEND_API_KEY RESEND_WEBHOOK_SECRET; sender enquiries@mail.atomz.online; Resend domain verified). ATOMZ = client zero + admin login exist.
DEPLOYED 14 Nov 2026: migration 0002 + Payments (/app/payments) + safety layer (EMAIL-SAFETY.md). Backup taken before 0002.
LEFT: after deploy, user does the 2 Resend steps (Enable receiving on mail.atomz.online; add email.received to the webhook), then set
 INBOUND_ENABLED="true" in wrangler.toml and redeploy. Not built (user said later): cold outreach. ADMIN_API_TOKEN unset on purpose.

## Run
- `npm test` (198 tests; Node + node:sqlite D1 double, applies the real /migrations) | `npm run typecheck`
- `npm run smoke` = 30 live checks on real workerd + fresh local D1 (all stages). Embed script also verified in headless Chromium
  from another origin (cross-origin CORS, first-touch utm, default form, allow-list refusal).
- Local dev: `cp .dev.vars.example .dev.vars; npm run db:migrate:local; npm run db:seed:local; npm run dev` (DRY_RUN prints emails and
  magic links). Seed logins owner@dev.example (client), admin@dev.example (admin). Key pk_dev_local.

## Layout (src/)
index.ts app.ts cron.ts intake.ts routes-links.ts (/o/:t outcome, /u/:t unsubscribe) routes-webhooks.ts (Resend)
routes-public.ts (/embed.js, /f/:slug) hosted-form.ts embed-js.ts routes-admin-api.ts (GET /api/admin/export)
dashboard/{routes.tsx,views.tsx,queries.ts,settings-form.ts} (/app)
lib/: settings clients leads status sequence outbox lead-flow compose templates sorting email whatsapp token svix time auth ...

## Decisions (defaults used; change freely)
Stage 1 (intake): only email required; field aliases; source = explicit > utm_source > external referrer > form tag > direct;
 origin allow-list (no Origin header = allowed; "*", "https://*.x.com", "null" supported); rate limit 10/IP+key/10min, 200/key/h;
 honeypot + duplicates answer like success; atomic dedupe insert; consent snapshot = settings.consent_text (placeholder wording).
Emails: every email is a sequence_jobs row (auto_reply|owner_alert|followup); id = idempotency key = Resend Idempotency-Key.
 Lease claim (due_at += 10 min) so request path and cron never double-send. Retry 5/10/20/40/80 min, 6 attempts; 400/422 permanent.
 Intake writes all jobs before answering; sending runs in waitUntil; cron (*/5) is the safety net.
Cap (src/lib/safety.ts): min(DAILY_EMAIL_CAP 95, ramp 25/day wk1, 50 wk2 from first real send); per recipient; received replies count; MONTHLY_EMAIL_CAP 2700. Priority auto_reply > alert > follow-up; follow-ups only
 while sent < cap - FOLLOWUP_RESERVE (default 19). Held jobs stay pending. CRON_BATCH=6 (Workers Free: 50 subrequests/invocation).
Sender: shared DEFAULT_FROM_EMAIL, From-name = business, Reply-To = settings.reply_to. Never send "as" the client's own mailbox.
 settings.from_email (admin-only) switches a client to its own verified domain. Unsubscribe link/headers only on lead-facing mails.
Sorting: rules first; AI (default @cf/meta/llama-3.2-3b-instruct, env AI_MODEL, 4s) only fills gaps + summary; fallback summary =
 first 25 words. NOT testable in the sandbox: check ai_usage + quality at the Stage 5 live test. [ai] binding is commented out in
 wrangler.toml (wrangler dev needs a login for it): uncomment at deploy. ai_usage stores tokens + estimated neurons.
Outcomes: Call later -> status contacted (sequence keeps running); booked/won/lost/not_interested/unsubscribed stop it.
 Unsubscribe: suppresses; blocks follow-ups only. Bounce/complaint (Svix-verified webhook) also block auto-replies.
Links (outcome 14d, unsub 400d, login 15min): GET = confirm page, POST applies (scanner-safe). HMAC key = TOKEN_SECRET.
Follow-up times are fixed at lead creation (day N at the lead's arrival time, clamped into window; 2/day = 25%/75% of window);
 window re-checked at send; templates read at send time. Defaults in lib/templates.ts.
Dashboard: server-rendered Hono JSX, zero JS, CSP script-src none, no caching. Session cookie ee_session (HttpOnly, Lax, 14d,
 hash in DB). Admin "acting as" cookie ee_client. Client users only ever see their client_id; other clients' lead ids = 404.
 Settings use friendly text formats (categories "Name: kw, kw"; follow-ups = blocks split by "---").
Migrations are append-only (0001 deployed). 0002: payment_* tables, system_flags, inbound_events, email_log rebuilt (+recipients, +payment_reminder).

## Safety + Payments (src/lib/safety.ts, src/lib/payments/*, src/dashboard/payments-*.tsx)
Pause flags (system_flags): pause_all stops mail to people (alerts + login still go), pause_automated stops follow-ups + reminders; breaker sets
 pause_automated on any complaint or bounce rate >2% (>=20 sends) after last resume; admin buttons on /app/admin. Resend 429 = wait for reset.
Payments (port of kalakruti/, which stays as reference): stages due-lead, due, +1, +2 then Needs Attention; one per entry per day; claim row
 (payment_sends unique live index) before send; money in minor units; paid/part-paid; import = paste CSV/TSV + attestation tick + saved report;
 >30 days overdue imports PAUSED; /p/:token stop link (GET page, POST acts) suppresses address. Reply detection: Reply-To also lists
 p.<entry>.<hmac>@domain / l.<lead>.<hmac>@domain (needs INBOUND_ENABLED=true + Resend receiving); email.received -> entry Needs Attention
 (replied) or lead sequence stopped. Cron budget CRON_BATCH shared: auto_reply/alert -> payments -> follow-ups.

## Stage 5 notes
- embed.js ES5, config at GET /api/intake/:key/config; hosted form /f/:slug is plain HTML. Export: Bearer ADMIN_API_TOKEN (unset = 503).
- Real mail refuses to send while PUBLIC_BASE_URL is localhost / YOUR-SUBDOMAIN. Deploy with wrangler (CF MCP cannot deploy Workers).
  Account also has D1 tool-checklist-db, cadence-db and Worker tool-checklist-tracker: do not touch.
## Open
Cold outreach (user priority, deferred): separate tables, own domain(s), dry-run default, kill switch. Per-client webhook_url push to Sheets/CRM.
