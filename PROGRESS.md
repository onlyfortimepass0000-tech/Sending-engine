# PROGRESS (read this first, nothing else; keep under 60 lines)

## Status
Stage 1 of 5 DONE. NEXT: Stage 2 = sorting (rules + Workers AI helper), templates, Resend sending,
auto-reply, owner alert, outcome links (HMAC), unsubscribe. Acceptance: full flow in DRY_RUN; AI-off fallback tested.

## Run
- `npm test` (41 tests, Node + node:sqlite D1 double in test/helpers/d1.ts; applies real /migrations)
- `npm run typecheck`
- Local Worker: `cp .dev.vars.example .dev.vars; npm run db:migrate:local; npm run db:seed:local; npm run dev`
  then `curl -X POST localhost:8787/api/intake/pk_dev_local -H 'content-type: application/json' -d '{"email":"a@b.co","message":"hi"}'`
- Verified on real workerd + local D1 with curl: lead created, dup ignored, honeypot dropped, 422/404/413/preflight OK.

## Layout
src/index.ts (export default {fetch}) | app.ts createApp({now}) | intake.ts route | env.ts
src/lib: settings.ts (zod schema = all client config) clients.ts origin.ts ratelimit.ts body.ts
         submission.ts (field mapping/validation) leads.ts (atomic dedupe insert) pages.ts crypto.ts
migrations/0001_init.sql (whole data model) | seed/dev.sql (client pk_dev_local) | wrangler.toml

## Decisions (defaults used; change freely)
- Tests use a node:sqlite D1 double, not vitest-pool-workers (fewer deps, fast). Time is injected: createApp({now}), c.get('now')().
- Timestamps = ISO-8601 UTC text; booleans = 0/1. urgency in {low,normal,high}; category/urgency/summary NULL until sorted.
- Added vs brief: leads.extras + leads.source_meta (JSON), client_id on sequence_jobs/email_log, rate_limits table.
  sessions/magic_links carry user_id only (tenant derived from users.client_id; NULL = ATOMZ admin).
- Only `email` is required. name/phone/message optional. Aliases accepted (your-name, mobile, comments ...); first_name+last_name joined.
  Bad phone -> phone NULL, raw kept in extras.phone_raw. Message truncated at 5000. Control chars stripped from name.
- Phone stored normalised (digits, optional +), NO country code added. Stage 2 builds wa.me using settings.default_country_code (91).
- source label precedence: explicit `source` > utm_source > external referrer host > form tag > "direct". Full utm/referrer/page in source_meta.
- Origin: no Origin header = allowed (webhooks/curl). Present = must be in allowed_origins or the Worker's own origin.
  Entries: exact origin, `https://*.x.com`, `null`, `*`. Empty list = server-to-server + hosted form only.
- Rate limit (D1 fixed window): 10 per IP+key per 10 min, 200 per key per hour. Env overrides RATE_LIMIT_IP_MAX / RATE_LIMIT_KEY_MAX. IP is hashed.
- Honeypot `website_hp` and duplicates return the same success as a real lead. Dedupe = one atomic INSERT..WHERE NOT EXISTS (race-safe).
- Form posts: 303 to settings.thank_you_url else /thanks; errors render a small HTML page. JSON/Accept:application/json get JSON.
- consent_text = snapshot of settings.consent_text (placeholder default wording) + consent_at, stored on every lead.
- wrangler.toml: compatibility_date 2025-09-01, D1 database_id is a placeholder (local dev ignores it).

## Seams for Stage 2
- src/intake.ts: insertLead() returns {created,id}; the result is currently ignored. Only when created, run sort + emails via c.executionCtx.waitUntil.
- settings.templates.{auto_reply,owner_alert,followups} exist with NO defaults yet; Stage 2 supplies default templates.
- Needs: [ai] binding in wrangler.toml, RESEND_API_KEY + TOKEN_SECRET via `wrangler secret put` (.dev.vars locally), DRY_RUN, add to src/env.ts.
- Lead text is untrusted: escape on every output (emails, dashboard); block CR/LF in anything used as an email header.

## Open / needs human (not blocking before Stage 5)
- Cloudflare API token, Resend account + key + DNS for sending domain, final product name.
- Consent wording sign-off (placeholder = DEFAULT_CONSENT_TEXT in src/lib/settings.ts).
- Client sites with `Referrer-Policy: no-referrer` post `Origin: null`; add "null" to that client's allowed_origins if so.
