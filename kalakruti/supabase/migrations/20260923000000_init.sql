-- Payment reminder system: schema.
-- Tables are prefixed `pr_` so they can live alongside other apps in a
-- shared Supabase project.
--
-- Access model: the app talks to PostgREST with the project's *publishable*
-- key and sends an `x-app-token` header. RLS only lets a request through if
-- that token is a live login session or the scheduler's token. Secrets
-- (password hash, tokens, Resend key) live in the unexposed `pr_private`
-- schema, so no service-role key or hosting env vars are required.

create extension if not exists pgcrypto with schema extensions;

-- ── Private config & sessions ────────────────────────────────────────────
create schema if not exists pr_private;
revoke all on schema pr_private from public, anon, authenticated;

create table if not exists pr_private.settings (
  key   text primary key,
  value text not null
);

create table if not exists pr_private.sessions (
  token_hash text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create or replace function pr_private.sha(t text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(t, 'sha256'), 'hex')
$$;

-- True when the request carries a valid session or scheduler token.
create or replace function public.pr_authorized() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  tok text := coalesce(current_setting('request.headers', true)::json ->> 'x-app-token', '');
begin
  if length(tok) < 32 then
    return false;
  end if;
  return exists (select 1 from pr_private.sessions
                 where token_hash = pr_private.sha(tok) and expires_at > now())
      or exists (select 1 from pr_private.settings
                 where key = 'cron_token_hash' and value = pr_private.sha(tok));
end $$;

-- Password login → returns a 30-day session token, or null.
create or replace function public.pr_login(p_password text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  h   text;
  tok text;
begin
  select value into h from pr_private.settings where key = 'admin_password_hash';
  if h is null or extensions.crypt(p_password, h) <> h then
    perform pg_sleep(1); -- slow down guessing
    return null;
  end if;
  delete from pr_private.sessions where expires_at < now();
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  insert into pr_private.sessions (token_hash, expires_at)
    values (pr_private.sha(tok), now() + interval '30 days');
  return tok;
end $$;

create or replace function public.pr_logout() returns void
language sql volatile security definer set search_path = '' as $$
  delete from pr_private.sessions
  where token_hash = pr_private.sha(coalesce(current_setting('request.headers', true)::json ->> 'x-app-token', ''))
$$;

-- App settings the owner can edit from the dashboard.
create or replace function public.pr_get_settings() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.pr_authorized() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((select json_object_agg(key, value) from pr_private.settings
                   where key in ('resend_api_key', 'email_from', 'email_reply_to', 'business_name')), '{}'::json);
end $$;

create or replace function public.pr_set_setting(p_key text, p_value text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.pr_authorized() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_key not in ('resend_api_key', 'email_from', 'email_reply_to', 'business_name') then
    raise exception 'unknown setting %', p_key;
  end if;
  if coalesce(p_value, '') = '' then
    delete from pr_private.settings where key = p_key;
  else
    insert into pr_private.settings (key, value) values (p_key, p_value)
      on conflict (key) do update set value = excluded.value;
  end if;
end $$;

revoke all on function pr_private.sha(text) from public, anon, authenticated;
revoke all on function public.pr_authorized(), public.pr_login(text), public.pr_logout(),
  public.pr_get_settings(), public.pr_set_setting(text, text) from public;
grant execute on function public.pr_authorized(), public.pr_login(text), public.pr_logout(),
  public.pr_get_settings(), public.pr_set_setting(text, text) to anon, authenticated;

-- ── Data ─────────────────────────────────────────────────────────────────
create table if not exists public.pr_entries (
  id               uuid primary key default gen_random_uuid(),
  customer_name    text        not null check (length(trim(customer_name)) > 0),
  email            text        not null check (position('@' in email) > 1),
  amount           numeric(14,2) not null check (amount > 0),
  due_date         date        not null,
  status           text        not null default 'active'
                   check (status in ('active', 'paused', 'needs_attention', 'paid')),
  -- how many of the 4 stages have been sent; hard-capped at 4
  stages_sent      smallint    not null default 0 check (stages_sent between 0 and 4),
  last_sent_on     date,
  attention_reason text        check (attention_reason in ('sequence_complete', 'send_failed')),
  last_error       text,
  paid_at          timestamptz,
  paused_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists pr_entries_status_idx on public.pr_entries (status);

create table if not exists public.pr_reminder_log (
  id                  uuid primary key default gen_random_uuid(),
  entry_id            uuid        not null references public.pr_entries (id) on delete cascade,
  stage               smallint    not null check (stage between 1 and 4),
  channel             text        not null default 'email',
  recipient           text        not null,
  status              text        not null check (status in ('sending', 'sent', 'failed', 'bounced')),
  provider_message_id text,
  error               text,
  run_date            date        not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- At most one in-flight or successful send per entry+stage: the
-- database-level guard against double-sending if two runs overlap.
create unique index if not exists pr_reminder_log_one_live_send
  on public.pr_reminder_log (entry_id, stage)
  where status in ('sending', 'sent');

create index if not exists pr_reminder_log_entry_idx on public.pr_reminder_log (entry_id, created_at desc);
create index if not exists pr_reminder_log_provider_idx on public.pr_reminder_log (provider_message_id);

create or replace function public.pr_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists pr_entries_touch on public.pr_entries;
create trigger pr_entries_touch before update on public.pr_entries
  for each row execute function public.pr_touch_updated_at();

drop trigger if exists pr_reminder_log_touch on public.pr_reminder_log;
create trigger pr_reminder_log_touch before update on public.pr_reminder_log
  for each row execute function public.pr_touch_updated_at();

alter table public.pr_entries enable row level security;
alter table public.pr_reminder_log enable row level security;

drop policy if exists pr_entries_app on public.pr_entries;
create policy pr_entries_app on public.pr_entries for all to anon, authenticated
  using ((select public.pr_authorized())) with check ((select public.pr_authorized()));

drop policy if exists pr_reminder_log_app on public.pr_reminder_log;
create policy pr_reminder_log_app on public.pr_reminder_log for all to anon, authenticated
  using ((select public.pr_authorized())) with check ((select public.pr_authorized()));

-- ── Scheduler ────────────────────────────────────────────────────────────
-- The daily job is created separately (it embeds the scheduler token):
--
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--   insert into pr_private.settings values ('cron_token_hash', pr_private.sha('<token>'))
--     on conflict (key) do update set value = excluded.value;
--   select cron.schedule('payment-reminders-daily', '30 3,9 * * *', $$
--     select net.http_get(
--       url := 'https://<your-app>/api/cron/daily',
--       headers := jsonb_build_object('x-app-token', '<token>'),
--       timeout_milliseconds := 60000)
--   $$);
--
-- 03:30 and 09:30 UTC = 09:00 and 15:00 IST. The second run is a safety net:
-- the app never sends more than one reminder per customer per day.
--
-- Set the login password with:
--   insert into pr_private.settings values ('admin_password_hash', extensions.crypt('<password>', extensions.gen_salt('bf')))
--     on conflict (key) do update set value = excluded.value;
