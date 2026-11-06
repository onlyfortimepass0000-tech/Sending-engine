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

Secrets never go in the repo: use `wrangler secret put` in production and `.dev.vars` (git-ignored) locally.
