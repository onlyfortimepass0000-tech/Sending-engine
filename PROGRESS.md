# PROGRESS (read this first, nothing else; keep under 60 lines)

## Status
Stages 1-4 DONE (draft PR #1). NEXT: Stage 5 = /embed.js, hosted form /f/:slug, deploy to Cloudflare, README polish,
client zero (ATOMZ site), GET /api/admin/export. Acceptance: live end-to-end test from a real form.

## Run
- `npm test` (124 tests; Node + node:sqlite D1 double, applies the real /migrations) | `npm run typecheck`
- Local: `cp .dev.vars.example .dev.vars; npm run db:migrate:local; npm run db:seed:local; npm run dev` (DRY_RUN: emails and
  magic links are printed in the dev log). Seed logins: owner@dev.example (client), admin@dev.example (admin). Key pk_dev_local.
- Stages 2-4 were also run on real workerd + local D1 (curl and headless Chromium): flow, cron, outcome link, login, admin.

## Layout (src/)
index.ts app.ts cron.ts intake.ts routes-links.ts (/o/:t outcome, /u/:t unsubscribe) routes-webhooks.ts (Resend)
dashboard/{routes.tsx,views.tsx,queries.ts,settings-form.ts} (/app)
lib/: settings clients leads status sequence outbox lead-flow compose templates sorting email whatsapp token svix time auth ...

## Decisions (defaults used; change freely)
Stage 1 (intake): only email required; field aliases; source = explicit > utm_source > external referrer > form tag > direct;
 origin allow-list (no Origin header = allowed; "*", "https://*.x.com", "null" supported); rate limit 10/IP+key/10min, 200/key/h;
 honeypot + duplicates answer like success; atomic dedupe insert; consent snapshot = settings.consent_text (placeholder wording).
Emails: every email is a sequence_jobs row (auto_reply|owner_alert|followup); id = idempotency key = Resend Idempotency-Key.
 Lease claim (due_at += 10 min) so request path and cron never double-send. Retry 5/10/20/40/80 min, 6 attempts; 400/422 permanent.
 Intake writes all jobs before answering; sending runs in waitUntil; cron (*/5) is the safety net.
Cap: DAILY_EMAIL_CAP 95 per UTC day (counts sent+dry_run incl. login mails). Priority auto_reply > alert > follow-up; follow-ups only
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
Migration 0001 was amended in place in Stages 2-4 (never deployed). From the first real deploy on, migrations are append-only.

## Stage 5 TODO
- /embed.js?key= (hook forms with data-enquiry or render default form, capture utm_* + referrer + first-touch), /f/:slug hosted form,
  GET /api/admin/export?client=&since= (Bearer ADMIN_API_TOKEN), README, client zero.
- Deploy: `wrangler d1 create enquiry-engine` -> database_id in wrangler.toml; `d1 migrations apply DB --remote`; secrets TOKEN_SECRET,
  RESEND_API_KEY, RESEND_WEBHOOK_SECRET, ADMIN_API_TOKEN; vars PUBLIC_BASE_URL, DEFAULT_FROM_EMAIL (no DRY_RUN); uncomment [ai];
  first admin: INSERT INTO users (id,client_id,email,role,created_at) VALUES (lower(hex(randomblob(16))),NULL,'you@..','admin',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  Resend webhook -> /api/webhooks/resend (email.bounced, email.complained).
- The Cloudflare MCP connector can list/create D1/KV but cannot deploy Workers, set secrets, cron or DNS: use wrangler + API token.
  Account already has D1 tool-checklist-db, cadence-db and Worker tool-checklist-tracker: do not touch.

## Needs the human
Resend account + API key + sending domain DNS (SPF, DKIM, DMARC); Cloudflare API token (or run the deploy commands yourself);
final product name; consent wording sign-off (DEFAULT_CONSENT_TEXT in lib/settings.ts).
OPEN QUESTION: "client has Excel / own database": (a) push each new lead out to their sheet/CRM (suggest per-client webhook_url,
 post-v1) or (b) import and email their existing contacts (out of scope: needs consent proof, bulk-mail risk)? Waiting on the user.
