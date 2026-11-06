# PROGRESS (read this first, nothing else; keep under 60 lines)

## Status
Stages 1-5 CODE DONE (draft PR #1). Decision: stay on Cloudflare Workers + D1 (Vercel Hobby = daily cron + non-commercial, no Workers AI).
NEXT = human steps in DEPLOY.md (Resend key + domain DNS, wrangler deploy + secrets, first admin, client zero), then the live test.

## Run
- `npm test` (137 tests; Node + node:sqlite D1 double, applies the real /migrations) | `npm run typecheck`
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

## Stage 5 notes
- embed.js: ES5, no build step, reads ?key= from its own URL, config at GET /api/intake/:key/config (business + consent text).
  Hosted form /f/:slug is plain HTML (no JS): ?src= sets the source, utm_* and external Referer pass through.
- Export: Bearer ADMIN_API_TOKEN, ?client=<id|slug>&since&until&limit&offset; wrong tokens throttled (10 / 10 min / IP).
- Safety: real emails refuse to send while PUBLIC_BASE_URL is localhost / YOUR-SUBDOMAIN (falls back to the request origin in the intake path).
- The Cloudflare MCP connector can list/create D1 but cannot deploy Workers, secrets, cron or DNS: deploy = wrangler (DEPLOY.md).
  Account already has D1 tool-checklist-db, cadence-db and Worker tool-checklist-tracker: do not touch.
- NOT verified (needs real accounts): Workers AI output quality, real Resend delivery, Resend webhook payload shape (coded from docs).

## Needs the human (see DEPLOY.md checklist)
Resend account + key + subdomain DNS (not the Instantly warm-up domain); wrangler login/deploy + secrets (or an API token via the credential
form); admin email; client zero details; consent wording sign-off (DEFAULT_CONSENT_TEXT in lib/settings.ts); final product name.
OPEN: Excel/own-database: user wants (1) blank DB filled by form submits = what is built, (2) import contacts and email them = NOT built
(outbound/consent risk). Per-client webhook_url for pushing leads to Sheets/CRM is the suggested post-v1 add-on.
