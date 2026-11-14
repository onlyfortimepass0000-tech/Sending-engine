# Email limits and flagging rules (so our domain never gets banned)

Researched 14 Nov 2026 from Resend's and Google's own pages (sources at the bottom). Plans and rules change, so recheck before big decisions.

## 1. What Resend's free plan allows

| Item | Free plan |
|---|---|
| Emails per day | **100** (the day is a UTC day, it resets at 00:00 UTC, which is 5:30 am IST) |
| Emails per month | **3,000** |
| Verified domains | **3** (older pages say 1; the current quota page says 3) |
| Do received (inbound) emails count? | **Yes.** Each received email counts as 1 toward the same daily and monthly quota |
| Several recipients on one email | Each recipient counts as a **separate email** |
| When you go over | Resend returns error 429 (`daily_quota_exceeded` / `monthly_quota_exceeded`). It does **not** queue or retry the email |
| API speed | 10 requests per second per account |
| Expiry | No end date was found for the free plan. It is a standing monthly plan. Which day the monthly count resets was not stated, so check your Resend dashboard |
| Paid (Pro) | About $20 a month for 50,000 emails, no daily cap, 10 domains. Extra emails cost about $0.90 per 1,000 |

## 2. What gets an account flagged, paused or banned

**Resend (their rule for every account):**
- Bounce rate must stay **under 4%**.
- Spam-complaint rate must stay **under 0.08%** (that is 1 complaint in every 1,250 emails).
- If you go over, Resend "may" pause sending until it is fixed. Their Acceptable Use Policy says the account may be shut down **without warning**. The pages disagree on how fast, and no measuring window is stated.
- Consent: people must have clearly agreed to get the kind of email you send. Assuming consent until someone unsubscribes is not valid. If complaints or bounces stay high with no consent, Resend may pause or terminate the account.

**Gmail, Yahoo and Outlook (the receivers):**
- Spam rate: aim for **under 0.1%**, and never reach **0.3%**.
- Every sender needs SPF or DKIM, bulk senders need SPF, DKIM and DMARC. DMARC can be the gentlest setting, `p=none`.
- One-click unsubscribe is required for **marketing** mail. Transactional mail is exempt.
- Honour unsubscribes quickly (Gmail lists 48 hours).

**Why this matters for us:** our volume is small. With about 300 emails a month, **one single spam complaint is 0.33%**, far above Resend's 0.08% limit. At our size one angry recipient matters, so we have to prevent complaints rather than hope they stay rare.

## 3. The biggest risks, and our answer

| Risk | Why it is dangerous | What we do |
|---|---|---|
| A new domain suddenly sending a lot | New domains look suspicious to Gmail and others | Start small and ramp up (see section 4) |
| Emailing people who don't expect it | Spam complaints, then a pause | Payment reminders go only to customers a client says really owe them. Enquiry emails go only to people who filled in the form. Never a bought or cold list |
| Reminders feel like harassment | People hit "Report spam" instead of paying | Clear sender name, amount and due date, a polite "If you have already paid, please ignore this email", and a one-click stop link |
| Bad addresses in a client's list | Bounces over 4% | Check every row on import, flag odd addresses, send a small first batch |
| Going over 100 emails a day | The rest are dropped, not queued | Our own daily cap sits below the limit, the extras wait until the next day |
| Replies (inbound) counting toward the quota | A flood of junk to the reply address could use up the day's sending | Use a hard-to-guess reply address, keep headroom, and move to the paid plan once volume grows |
| One complaint going unnoticed | The next emails make it worse | Automatic pause of reminders and follow-ups, with a red banner for the admin |

## 4. Safeguards

**Already built and live:**
- Daily cap of 95, with new-enquiry replies and owner alerts sent before follow-ups.
- Hard bounces and spam complaints (from Resend's webhook) stop all further email to that address.
- Unsubscribe link and one-click header on emails to people.
- Consent text and time stored with every enquiry.
- Each email is sent only once, even if two jobs run at the same moment.
- Follow-ups only go out inside the client's sending hours.
- SPF, DKIM and the bounce route for `mail.atomz.online` are verified.

**Built with the Payments module (now in the code):**
1. **Ramp-up for the new domain:** about 25 emails a day for the first week, 50 for the second, then the normal cap. All settings can be changed.
2. **Monthly guard** below 3,000, counting each recipient and each received reply.
3. **Quota-aware retries:** if Resend says the daily quota is used up, wait until the next UTC midnight (the monthly one: until next month) instead of retrying uselessly.
4. **Automatic pause** of follow-ups and reminders if there is a spam complaint, or the bounce rate passes 2%. The admin reviews, then resumes.
5. **Import checks:** bad syntax, duplicates, and role addresses (like `info@` or `noreply@`) are flagged in an import report.
6. **Payment email rules:** plain subject lines (no all caps or "URGENT"), business name and address in the footer, the "if you have already paid, please ignore" line, and a stop link that moves the entry to Needs Attention and tells the owner.
7. **Reply detection:** a hard-to-guess reply address on `mail.atomz.online`, with the owner's own inbox still receiving the reply.

## 5. Resend edits for automatic reply detection (do these AFTER I tell you the code is live)

Doing them later avoids counting junk inbound mail before it is useful.

**A. Turn on receiving for the sending subdomain**
1. Open https://resend.com/domains and tap `mail.atomz.online`.
2. On the Records tab find **Enable receiving** and switch it **on**.
3. A new row appears: type **MX**, name `mail`, value like `receive-...`, priority **10**.
4. Tap **Auto configure** (it adds the record in Vercel for you). If that fails, add it by hand in Vercel: Domains, `atomz.online`, DNS Records, Add: Type MX, Name `mail`, Value (copy from Resend), Priority 10.
5. Tap **restart verification** and wait until the MX row says **Verified**.
This only affects mail sent to `@mail.atomz.online`. Your website and any normal email on `atomz.online` are not touched.

**B. Tell the webhook to send us received mail**
1. Open https://resend.com/webhooks and tap our endpoint (it ends in `/api/webhooks/resend`).
2. Tap **Edit**.
3. Under events keep `email.bounced` and `email.complained`, and also tick **`email.received`**.
4. Save. The signing secret does not change, so nothing else needs updating.

**C. Optional, harmless: a DMARC record**
In Vercel DNS add Type TXT, Name `_dmarc.mail`, Value `v=DMARC1; p=none;`. It only tells receivers we use SPF and DKIM and asks them not to reject anything. Resend's domain page may show its own suggested value. Either is fine.

**D. Watch it:** in Resend, open the **Metrics** page weekly and check the bounce and complaint rates.

## 6. What we could not confirm

- The time window Resend uses to measure bounce and complaint rates, and exactly when a pause starts.
- Whether Resend warns before suspending (their policy page says it may not).
- Receiving limits for the webhook beyond the shared daily and monthly quota.
- The exact day the monthly count resets.

## Sources

- Resend, account quotas and limits: https://resend.com/docs/knowledge-base/account-quotas-and-limits
- Resend pricing: https://resend.com/pricing
- Resend acceptable use policy: https://resend.com/legal/acceptable-use
- Resend, what counts as email consent: https://resend.com/docs/knowledge-base/what-counts-as-email-consent
- Resend inbound email: https://resend.com/docs/knowledge-base/forward-emails-with-resend-inbound
- Gmail sender guidelines: https://support.google.com/mail/answer/81126
- Gmail sender guidelines FAQ: https://support.google.com/mail/answer/14229414
