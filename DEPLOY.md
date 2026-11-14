# Going live (Stage 5): what is needed and how to get it

Everything in the code is built and tested. What is left is accounts, DNS and secrets that only you can create.
Work top to bottom; each step says what to give back to the person doing the deploy.

## 0. What you need to hand over (checklist)

| # | Item | Where it comes from | Used for |
|---|------|---------------------|----------|
| 1 | Resend **API key** ("Sending access") | Step 1 | sending every email |
| 2 | A **sending subdomain** verified in Resend, e.g. `mail.yourdomain.com` | Step 1 | the shared sender address |
| 3 | Resend **webhook signing secret** (`whsec_...`) | Step 3 | bounces and spam complaints stop emails |
| 4 | Cloudflare **D1 database id** | Step 2 | the database |
| 5 | The Worker's public **URL** | Step 2 | links inside emails |
| 6 | Your **admin email** | you | first dashboard login |
| 7 | **Client zero** details: ATOMZ site URL(s), owner email, timezone | you | first real client |
| 8 | **Consent wording** sign-off | you / your lawyer | shown next to every form, stored with every lead |

Not a blocker: the final product name (cosmetic).

## 1. Resend (email sending)

1. Sign up at resend.com (free plan: 100 emails/day, which is what `DAILY_EMAIL_CAP=95` protects).
2. **Domains > Add Domain**: use a *subdomain* such as `mail.yourdomain.com`. Do **not** use the domain you warm up in
   Instantly: keep cold-outreach reputation and auto-replies separate.
3. Resend shows DNS records (SPF, DKIM, and a bounce MX). Add them where the domain's DNS lives
   (Cloudflare: *DNS > Records*). Press *Verify* until it says **Verified** (minutes to a few hours).
4. Add a DMARC record if the domain has none: TXT `_dmarc.mail` = `v=DMARC1; p=none; rua=mailto:you@yourdomain.com`.
5. **API Keys > Create API key**, permission *Sending access*, domain = your subdomain. Copy it now (shown once).

## 2. Cloudflare (run from your own computer, Node 20+)

```bash
git clone <this repo> && cd Sending-engine && npm install
npx wrangler login                                   # opens the browser once
npx wrangler d1 create enquiry-engine                # prints a database_id
```

Edit `wrangler.toml`:
- `database_id = "<the id printed above>"`
- in `[vars]`: `DEFAULT_FROM_EMAIL = "enquiries@mail.yourdomain.com"` (an address on the verified subdomain)
- uncomment the `[ai]` block (Workers AI for sorting; the app also works without it)

```bash
npx wrangler d1 migrations apply DB --remote         # creates all tables
openssl rand -hex 32 | npx wrangler secret put TOKEN_SECRET        # signs outcome/unsubscribe links
openssl rand -hex 32 | npx wrangler secret put ADMIN_API_TOKEN     # export endpoint
npx wrangler secret put RESEND_API_KEY                             # paste the key from step 1
npx wrangler deploy                                  # prints https://enquiry-engine.<you>.workers.dev
```

Put that URL in `wrangler.toml` as `PUBLIC_BASE_URL = "https://enquiry-engine.<you>.workers.dev"` and run
`npx wrangler deploy` again. Until this is set, real emails refuse to send (so no email ever carries a broken link).
Never set `DRY_RUN` in production. A custom domain (Workers > Settings > Domains) is optional; update `PUBLIC_BASE_URL` if you add one.

## 3. Resend webhook (so bounces and complaints stop emails)

Resend > Webhooks > Add endpoint: URL `https://<worker-url>/api/webhooks/resend`, events `email.bounced` and
`email.complained`. Copy the signing secret, then:

```bash
npx wrangler secret put RESEND_WEBHOOK_SECRET        # paste the whsec_... value
```

## 4. First admin and client zero

```bash
npx wrangler d1 execute DB --remote --command "INSERT INTO users (id, client_id, email, role, created_at) VALUES (lower(hex(randomblob(16))), NULL, 'you@yourdomain.com', 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
```

1. Open `https://<worker-url>/app/login`, enter that email, click the link that arrives.
2. **Admin > Add a client**: business name, the websites allowed to send enquiries (`https://atomz.example`, `https://www.atomz.example`),
   timezone, owner's email. Open the client, copy the embed snippet (or use the hosted form link `/f/<slug>`).
3. **Open dashboard > Settings** for that client: categories and keywords, consent text, business address, sender name.

## 5. Live end-to-end test

1. Paste the snippet into the website (or open `/f/<slug>`) and submit a real enquiry with your own email.
2. Expect within about a minute: auto-reply in your inbox (Reply-To = the client's address), owner alert with three buttons.
3. Tap **Booked** > confirm. The lead shows *Booked* in the dashboard and the follow-ups stop.
4. Admin page: "AI calls today" should be at least 1 if Workers AI is on (check the summary and category look sensible).
5. Submit again from a mailbox that does not exist, and check Resend shows a bounce; the address then appears as suppressed.
6. Workers > enquiry-engine > Triggers: the cron `*/5 * * * *` is listed.

## Optional: have Claude deploy it

Create a Cloudflare API token (My Profile > API Tokens > Create > "Edit Cloudflare Workers" template, plus D1 Edit), and save it
through the credential form in the Claude session (never paste it into chat). The sandbox's network must allow `api.cloudflare.com`.

## Monthly report

`GET /api/admin/export?client=<slug>&since=2026-01-01&until=2026-02-01` with `Authorization: Bearer <ADMIN_API_TOKEN>` returns every
lead with its emails and timeline as JSON, for analysis outside the app.

## Checks you can run any time (no Cloudflare account needed)

`npm test` (137 tests) and `npm run smoke` (boots the real Worker runtime with a fresh local database and checks every stage).
