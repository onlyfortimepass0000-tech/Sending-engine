-- Customer replies: flag an entry when its customer replies to a reminder.
-- Replies are detected from Resend "email.received" webhook events (the
-- sender address is matched to entries), and can also be flagged by hand.

alter table public.pr_entries add column if not exists replied_at timestamptz;
alter table public.pr_entries add column if not exists reply_note text;

create or replace function public.pr_handle_resend_webhook(
  p_body text, p_svix_id text, p_svix_ts text, p_svix_sig text
) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_secret text;
  v_key bytea;
  v_expected text;
  v_part text;
  v_ok boolean := false;
  v_ev jsonb;
  v_type text;
  v_mid text;
  v_from text;
  v_n integer;
  v_log record;
  v_reason text;
begin
  select s.value into v_secret from pr_private.settings s where s.key = 'resend_webhook_secret';
  if v_secret is null then
    return 'not_configured';
  end if;
  if p_svix_id is null or p_svix_ts is null or p_svix_sig is null then
    return 'bad_signature';
  end if;
  if abs(extract(epoch from now()) - p_svix_ts::numeric) > 300 then
    return 'bad_signature';
  end if;

  v_key := decode(regexp_replace(v_secret, '^whsec_', ''), 'base64');
  v_expected := encode(
    extensions.hmac(convert_to(p_svix_id || '.' || p_svix_ts || '.' || p_body, 'UTF8'), v_key, 'sha256'),
    'base64');
  foreach v_part in array string_to_array(p_svix_sig, ' ') loop
    if split_part(v_part, ',', 2) = v_expected then
      v_ok := true;
    end if;
  end loop;
  if not v_ok then
    return 'bad_signature';
  end if;

  v_ev := p_body::jsonb;
  v_type := v_ev ->> 'type';

  -- A customer replied: flag every open entry for that sender address.
  if v_type = 'email.received' then
    v_from := lower(coalesce(
      substring(v_ev -> 'data' ->> 'from' from '<([^>]+)>'),
      trim(v_ev -> 'data' ->> 'from')));
    update public.pr_entries e
      set replied_at = now(), reply_note = left(coalesce(v_ev -> 'data' ->> 'subject', ''), 200)
      where lower(e.email) = v_from and e.status <> 'paid';
    get diagnostics v_n = row_count;
    return case when v_n > 0 then 'recorded' else 'no_match' end;
  end if;

  if v_type not in ('email.bounced', 'email.complained') then
    return 'ignored';
  end if;
  v_mid := v_ev -> 'data' ->> 'email_id';
  select * into v_log from public.pr_reminder_log l where l.provider_message_id = v_mid limit 1;
  if not found then
    return 'no_match';
  end if;

  v_reason := case when v_type = 'email.bounced'
    then 'Bounced: ' || coalesce(v_ev -> 'data' -> 'bounce' ->> 'message', 'recipient address rejected')
    else 'Recipient marked the email as spam' end;
  update public.pr_reminder_log l set status = 'bounced', error = v_reason where l.id = v_log.id;
  update public.pr_entries e
    set status = 'needs_attention', attention_reason = 'send_failed', last_error = v_reason
    where e.id = v_log.entry_id and e.status in ('active', 'needs_attention');
  return 'recorded';
exception when others then
  return 'bad_request';
end $$;
