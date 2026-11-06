#!/usr/bin/env bash
# End-to-end smoke test of Stages 1-5 on the real Workers runtime (workerd) with a fresh LOCAL D1.
# No Cloudflare account needed. Run: npm run smoke
set -u
cd "$(dirname "$0")/.."
export WRANGLER_SEND_METRICS=false CI=1
PORT="${PORT:-8787}"; BASE="http://localhost:$PORT"; KEY=pk_dev_local
LOG="$(mktemp)"; JAR="$(mktemp)"; pass=0; fail=0

ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1  ${2:-}"; fail=$((fail+1)); }
eq()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "(expected '$3', got '$2')"; fi; }
has()  { if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else bad "$1" "(missing '$3')"; fi; }
sql()  { npx wrangler d1 execute DB --local --json --command "$1" 2>/dev/null | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8'));const x=r[0].results[0];console.log(x?Object.values(x)[0]:'')"; }
post() { curl -s -w ' [%{http_code}]' -X POST "$BASE/api/intake/$KEY" -H 'content-type: application/json' -d "$1"; }

cleanup() { pkill -f "wrangler dev --local --port $PORT" 2>/dev/null; rm -f "$LOG" "$JAR"; }
trap cleanup EXIT

[ -f .dev.vars ] || cp .dev.vars.example .dev.vars
echo "Preparing a fresh local database..."
rm -rf .wrangler
npx wrangler d1 migrations apply DB --local >/dev/null 2>&1 || { echo "migrations failed"; exit 1; }
npx wrangler d1 execute DB --local --file=seed/dev.sql >/dev/null 2>&1 || { echo "seed failed"; exit 1; }
(npx wrangler dev --local --port "$PORT" --test-scheduled >"$LOG" 2>&1 &)
for i in $(seq 1 40); do grep -q "Ready on" "$LOG" 2>/dev/null && break; sleep 1; done
grep -q "Ready on" "$LOG" || { echo "worker did not start"; tail -20 "$LOG"; exit 1; }

echo; echo "Stage 1: intake and spam checks"
eq  "health"                       "$(curl -s -o /dev/null -w '%{http_code}' $BASE/health)" 200
r="$(post '{"name":"Priya Shah","email":"priya@example.com","phone":"98765 43210","message":"I have a broken tooth and need to be seen today","utm_source":"instagram"}')"
eq  "lead accepted"                "$r" '{"ok":true} [200]'
post '{"name":"Priya Shah","email":"priya@example.com","message":"I have a broken tooth and need to be seen today"}' >/dev/null
eq  "duplicate ignored (1 lead)"   "$(sql 'SELECT COUNT(*) FROM leads')" 1
post '{"email":"bot@spam.io","message":"buy","website_hp":"x"}' >/dev/null
eq  "honeypot dropped"             "$(sql 'SELECT COUNT(*) FROM leads')" 1
eq  "bad email -> 422"             "$(post '{"email":"nope"}')" '{"ok":false,"error":"invalid_email","message":"Please enter a valid email address."} [422]'
eq  "unknown key -> 404"           "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/intake/pk_nope_nope -H 'content-type: application/json' -d '{"email":"a@b.co"}')" 404
eq  "25KB body -> 413"             "$(head -c 25000 /dev/zero | tr '\0' x | curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/intake/$KEY" -H 'content-type: application/json' --data-binary @-)" 413
eq  "form post -> 303"             "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/intake/$KEY" -d 'name=Sam&email=sam@example.com&message=Hello')" 303

echo; echo "Stage 2: sorting, emails, outcome links"
sleep 2
eq  "sorted into Emergency / high" "$(sql "SELECT category || '/' || urgency FROM leads WHERE email='priya@example.com'")" "Emergency/high"
has "auto-reply logged"            "$(cat "$LOG")" "subject: Thanks for contacting Dev Client"
has "owner alert logged"           "$(cat "$LOG")" "subject: New enquiry: Priya Shah (Emergency, high urgency)"
has "WhatsApp link in alert"       "$(cat "$LOG")" "https://wa.me/919876543210"
has "unsubscribe header"           "$(cat "$LOG")" "List-Unsubscribe-Post: List-Unsubscribe=One-Click"
BOOKED="$(grep -o "Booked: $BASE/o/[A-Za-z0-9._-]*" "$LOG" | head -1 | sed 's/Booked: //')"
curl -s -o /dev/null "$BOOKED"
eq  "outcome link GET changes nothing" "$(sql "SELECT status FROM leads WHERE email='priya@example.com'")" new
curl -s -o /dev/null -X POST "$BOOKED"
eq  "outcome button POST -> booked"    "$(sql "SELECT status FROM leads WHERE email='priya@example.com'")" booked

echo; echo "Stage 3: sequence and cron"
eq  "5 follow-ups scheduled, then stopped by the outcome" "$(sql "SELECT COUNT(*) FROM sequence_jobs WHERE kind='followup' AND status='skipped'")" 5
eq  "cron endpoint runs"          "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/__scheduled?cron=*/5+*+*+*+*")" 200

echo; echo "Stage 4: dashboard"
eq  "login page"                   "$(curl -s -o /dev/null -w '%{http_code}' $BASE/app/login)" 200
eq  "dashboard needs login"        "$(curl -s -o /dev/null -w '%{http_code}' $BASE/app)" 302
curl -s -o /dev/null -X POST $BASE/app/login -H "origin: $BASE" -d 'email=owner@dev.example'
sleep 1
LINK="$(grep -o "$BASE/app/auth/[0-9a-f]\{64\}" "$LOG" | tail -1)"
has "magic link emailed (dry run)" "$LINK" "/app/auth/"
eq  "magic link GET is a page only" "$(curl -s -o /dev/null -w '%{http_code}' "$LINK")" 200
eq  "magic link POST signs in"     "$(curl -s -o /dev/null -c "$JAR" -w '%{http_code}' -X POST "$LINK" -H "origin: $BASE")" 303
has "overview shows the lead"      "$(curl -s -b "$JAR" $BASE/app?range=all)" "Where leads come from"
has "leads list"                   "$(curl -s -b "$JAR" $BASE/app/leads)" "Priya Shah"
eq  "client user blocked from admin" "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' $BASE/app/admin)" 403

echo; echo "Stage 5: embed, hosted form, export"
has "embed.js served"              "$(curl -s "$BASE/embed.js?key=$KEY")" "data-enquiry"
has "form config (consent text)"   "$(curl -s "$BASE/api/intake/$KEY/config")" "consent_text"
has "hosted form"                  "$(curl -s "$BASE/f/dev?src=qr")" 'name="source" value="qr"'
TOKEN="$(grep '^ADMIN_API_TOKEN=' .dev.vars | cut -d= -f2-)"
eq  "export without token -> 401"  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/export")" 401
has "export with token"            "$(curl -s -H "authorization: Bearer $TOKEN" "$BASE/api/admin/export?since=2026-01-01")" '"count":2'

echo; echo "Result: $pass passed, $fail failed"
[ "$fail" = 0 ]
