# Enquiry Engine

Website form submits → logged, sorted, enquirer gets an auto-reply, owner gets an alert, a short follow-up
sequence runs, and a dashboard shows outcomes and lead sources. Multi-client. Cloudflare Workers + D1 + Cron + Workers AI, Resend for email.

Build brief and stage plan: see `PROGRESS.md` (current status and next step).

## Develop

```bash
npm install
npm test              # unit/integration tests (no Cloudflare account needed)
npm run typecheck

cp .dev.vars.example .dev.vars
npm run db:migrate:local && npm run db:seed:local
npm run dev           # http://localhost:8787
```

```bash
curl -X POST http://localhost:8787/api/intake/pk_dev_local \
  -H 'content-type: application/json' \
  -d '{"name":"Priya","email":"priya@example.com","phone":"+91 98765 43210","message":"Need a quote"}'
# -> {"ok":true}
```

## Putting it on a website

- `<script src="https://YOUR-WORKER/embed.js?key=PUBLIC_KEY" defer></script>` connects every `<form data-enquiry="name">`
  (JSON post, no reload, consent text shown, honeypot added, utm_* and referrer captured) and renders a ready-made form into
  `<div data-enquiry-form></div>`.
- `https://YOUR-WORKER/f/<slug>?src=instagram-bio` is a hosted form for bios and QR codes.
- Webhooks / other systems: `POST /api/intake/<key>` with JSON.

Going live (accounts, DNS, secrets, deploy): see [DEPLOY.md](DEPLOY.md). Checks: `npm test`, `npm run smoke`.

## Dashboard

`/app` is the dashboard (overview, leads, lead detail, settings; admins also get clients, embed code and the email cap).
Sign-in is a magic link by email. With `DRY_RUN=true` the link is printed in the `npm run dev` log. The seed creates
`owner@dev.example` (client) and `admin@dev.example` (ATOMZ admin).

The first real admin is created once with SQL (then add more from the Admin page):

```bash
wrangler d1 execute DB --remote --command "INSERT INTO users (id, client_id, email, role, created_at) VALUES (lower(hex(randomblob(16))), NULL, 'you@yourdomain.com', 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
```

## How emails go out

Every email (auto-reply, owner alert, each follow-up) is a row in `sequence_jobs`, sent by one idempotent path
and retried by a cron that runs every 5 minutes. `DAILY_EMAIL_CAP` (default 95) protects Resend's free 100/day:
auto-replies first, then owner alerts, then follow-ups. Emails come from one shared ATOMZ sender with the client's
business name as the sender name and the client's inbox as Reply-To.

Secrets never go in the repo: use `wrangler secret put` in production and `.dev.vars` (git-ignored) locally.
