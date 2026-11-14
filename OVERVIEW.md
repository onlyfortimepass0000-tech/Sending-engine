# Enquiry Engine: what it does (overview)

Built by ATOMZ. Sold to small businesses, on its own or as an add-on to ATOMZ services. Many clients can use the same system, and each client only ever sees their own data.

## In one sentence

When someone fills in a form on a client's website, the system saves the enquiry, replies to the person straight away, alerts the business owner, follows up for a few days, and shows everything (what came in, where it came from, whether it turned into a sale) in a dashboard.

## The problem it solves

Small businesses lose enquiries because nobody answers fast enough, nobody follows up, and nobody tracks which source (Instagram, Google, a poster) actually brings customers. This does all three automatically.

## What happens, step by step

1. **A visitor submits a form** on the client's website, on a hosted form link (for an Instagram bio or a QR code), or from another system.
2. **It is saved** with the visitor's details, where they came from (campaign, referrer, form), and the consent text they saw.
3. **It is sorted** into a category (for example "Emergency" or "Whitening") and an urgency (low, normal, high). Keyword rules written for each client do this first. A small AI helper can fill gaps and write a one-line summary. The AI never writes emails. If AI is off or fails, the rules still work.
4. **The visitor gets an automatic reply** within seconds, with the business name as the sender and the business owner's inbox as the reply address.
5. **The owner gets an alert** with the summary, category, urgency and source, plus one-tap buttons (**Booked**, **Not interested**, **Call later**) and a **Message on WhatsApp** button. Staff send the WhatsApp message by hand.
6. **Follow-up emails go out** (by default one a day for 5 days, only inside the client's sending hours) until the lead is marked, unsubscribes, or staff stop it.
7. **The dashboard shows the result**: how many leads are new, contacted, booked, won or lost, which sources convert best, and how fast the team responds.

## What each person sees

| Person | What they get |
|---|---|
| **Visitor** | An instant, friendly reply. A clear unsubscribe link in every email. |
| **Business owner** | An alert for every enquiry, outcome buttons that work from the email, and a dashboard login. |
| **ATOMZ (admin)** | A control area to add clients, copy the website code, and watch the daily email limit and AI usage. |

## The dashboard

- **Overview**: counts by status, conversion by source, average first-response time.
- **Leads**: a table you can filter by status, category, source and date.
- **Lead page**: everything about the person, the consent they gave, a timeline of every email and status change, outcome buttons, a WhatsApp button, and a "stop follow-ups" button.
- **Settings**: categories and keywords, urgent words, the follow-up schedule and sending hours, the wording of every email, consent text, business address and sender name. Changing a client's setup means changing settings, never code.
- **Admin** (ATOMZ only): create and edit clients, the website code to copy, users, and the email and AI usage for the day.

Sign-in is by a one-time link sent to your email. There are no passwords.

## Putting it on a website

Paste one line before the end of the page:

```html
<script src="https://YOUR-ADDRESS/embed.js?key=CLIENT_KEY" defer></script>
```

Then either add `data-enquiry` to an existing form, or place `<div data-enquiry-form></div>` where a ready-made form should appear. It also works with a hosted link, `https://YOUR-ADDRESS/f/CLIENT-NAME` (add `?src=instagram-bio` to track where visitors came from).

## Safety and privacy built in

- **Spam**: a hidden trap field for bots, per-visitor and per-client rate limits, an allow-list of websites per client, a size cap, email checks, and no duplicate lead if someone clicks submit twice.
- **Consent**: the consent text and the time are stored with every lead.
- **Unsubscribe**: every email to a visitor has an unsubscribe link and the one-click unsubscribe header mail apps use. Unsubscribed, bounced and spam-complaint addresses stop getting emails.
- **Safe links**: opening an email link never changes anything on its own. Email security scanners open links, so a button press is always a second, deliberate step.
- **Separate clients**: a client's login can only reach that client's data.
- **Secrets**: keys are kept in Cloudflare as hidden secrets, never in the code.

## Payment reminders (second module)

For clients who are owed money. The owner pastes a list (name, email, amount, due date) or adds one entry; four polite reminders go out (3 days before, on the day, 1 day late, 2 days late), one per day at most, inside sending hours. Every email says "If you have already made this payment, thank you. Please ignore this email." and has a "Stop these reminders" link. The owner marks payments **received in full, part paid or not received**; part payments keep reminding for the balance only. After the fourth reminder, or if the customer replies, bounces or asks to stop, the entry moves to **Needs attention** for a human. Every import saves a report (rows received, imported, skipped and why). Rows more than 30 days overdue are imported paused.

## How emails are protected

The free Resend plan allows 100 emails a day and 3,000 a month, so the system stops at 95 a day and 2,700 a month, counts each recipient and each received reply, and starts a new domain slowly (25 a day for a week, 50 for the next). New-enquiry replies and owner alerts go first, then follow-ups and reminders; the rest wait. Any spam complaint, or a bounce rate above 2%, pauses all automatic mail until an admin has looked (red banner, one-tap resume). An admin can also pause everything with one button. Bounces and complaints are picked up automatically. See `EMAIL-SAFETY.md`.

## How it is built (short)

- Runs on **Cloudflare** (a small server program, a database and a scheduler that runs every 5 minutes).
- Sends email through **Resend**, from `enquiries@mail.atomz.online` with the client's name as the sender.
- One system serves every client. Nothing is copied per client.
- Fully tested: 198 automated checks, plus a live test that runs the whole flow.

## Where it stands today

- **Live** at `https://enquiry-engine.tool-checklist-tracker.workers.dev`.
- **ATOMZ** is set up as the first client, with an admin login.
- **Email sending works**: the first real email (the sign-in link) was accepted by Resend.
- **Still to do**: one full real enquiry from a form (reply, alert, Booked button), check that AI sorting works, and place the code on the ATOMZ website.

## What it does not do (yet)

- Cold outreach to people who never dealt with the client (a different product with consent risk; planned separately).
- Push leads into Excel, Google Sheets or a CRM. A simple per-client webhook is the suggested next addition.
- The WhatsApp or Instagram APIs, SMS, billing, or reading customer replies.
- A custom web address (the current one reuses an older project's name). This can be fixed later by moving the `atomz.online` DNS to Cloudflare.

## Files in this repository

| File | What it is |
|---|---|
| `OVERVIEW.md` | This page. |
| `README.md` | Short developer guide. |
| `DEPLOY.md` | Step-by-step go-live guide (accounts, DNS, secrets). |
| `PROGRESS.md` | Decisions made, current status, what is left. |
| `EMAIL-SAFETY.md` | Resend and Gmail limits, flagging rules, our safeguards, and the Resend setup steps for reply detection. |
| `kalakruti/` | The original payment-reminder project, kept untouched as a reference. Its logic now lives in the Payments module. |
