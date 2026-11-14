-- Bounce tracking: Resend webhooks are verified and recorded inside the
-- database, so the signing secret never has to live in hosting env vars or
-- in a URL. The app route simply forwards the raw request to this function.

create or replace function public.pr_get_settings() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.pr_authorized() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((select json_object_agg(key, value) from pr_private.settings
                   where key in ('resend_api_key', 'email_from', 'email_reply_to', 'business_name', 'resend_webhook_secret')), '{}'::json);
end $$;

create or replace function public.pr_set_setting(p_key text, p_value text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.pr_authorized() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_key not in ('resend_api_key', 'email_from', 'email_reply_to', 'business_name', 'resend_webhook_secret') then
    raise exception 'unknown setting %', p_key;
  end if;
  if coalesce(p_value, '') = '' then
    delete from pr_private.settings where key = p_key;
  else
    insert into pr_private.settings (key, value) values (p_key, p_value)
      on conflict (key) do update set value = excluded.value;
  end if;
end $$;

-- Verifies a Resend (Svix) webhook signature and records bounces/complaints.
-- Returns a short status string; the app maps it to an HTTP status.
create or replace function public.pr_handle_resend_webhook(
  p_body text, p_svix_id text, p_svix_ts text, p_svix_sig text
) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  secret text;
  key bytea;
  expected text;
  part text;
  ok boolean := false;
  ev jsonb;
  mid text;
  lg record;
  reason text;
begin
  select value into secret from pr_private.settings where key = 'resend_webhook_secret';
  if secret is null then
    return 'not_configured';
  end if;
  if p_svix_id is null or p_svix_ts is null or p_svix_sig is null then
    return 'bad_signature';
  end if;
  if abs(extract(epoch from now()) - p_svix_ts::numeric) > 300 then
    return 'bad_signature';
  end if;

  key := decode(regexp_replace(secret, '^whsec_', ''), 'base64');
  expected := encode(
    extensions.hmac(convert_to(p_svix_id || '.' || p_svix_ts || '.' || p_body, 'UTF8'), key, 'sha256'),
    'base64');
  foreach part in array string_to_array(p_svix_sig, ' ') loop
    if split_part(part, ',', 2) = expected then
      ok := true;
    end if;
  end loop;
  if not ok then
    return 'bad_signature';
  end if;

  ev := p_body::jsonb;
  if ev ->> 'type' not in ('email.bounced', 'email.complained') then
    return 'ignored';
  end if;
  mid := ev -> 'data' ->> 'email_id';
  select * into lg from public.pr_reminder_log where provider_message_id = mid limit 1;
  if not found then
    return 'no_match';
  end if;

  reason := case when ev ->> 'type' = 'email.bounced'
    then 'Bounced: ' || coalesce(ev -> 'data' -> 'bounce' ->> 'message', 'recipient address rejected')
    else 'Recipient marked the email as spam' end;
  update public.pr_reminder_log set status = 'bounced', error = reason where id = lg.id;
  update public.pr_entries
    set status = 'needs_attention', attention_reason = 'send_failed', last_error = reason
    where id = lg.entry_id and status in ('active', 'needs_attention');
  return 'recorded';
exception when others then
  return 'bad_request';
end $$;

revoke all on function public.pr_handle_resend_webhook(text, text, text, text) from public;
grant execute on function public.pr_handle_resend_webhook(text, text, text, text) to anon, authenticated;
