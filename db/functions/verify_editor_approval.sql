-- ---------------------------------------------------------------------------
-- EDITOR APPROVAL (second factor for edit / delete / cancel)
-- ---------------------------------------------------------------------------
-- edit_order_item(), delete_order_item() and cancel_order() each require the
-- username (email) + password of a DIFFERENT account whose profile role is
-- 'editor' (same outlet, active) on EVERY call — there is no remembered
-- approval. The check lives here, inside the same transaction as the change,
-- so it cannot be skipped by calling the RPCs directly.
--
-- Passwords are verified against auth.users.encrypted_password with
-- pgcrypto's crypt() (Supabase stores bcrypt there). This never creates a
-- session or touches the signed-in user's login.
--
-- Failed attempts are logged and throttled: 5 failures for the same username
-- in 10 minutes locks that editor account out of approvals for the rest of
-- the window. A wrong/locked/unknown credential RETURNS an error object
-- instead of raising — raising would roll back the very row that records the
-- failed attempt, defeating the throttle. Callers therefore return jsonb
-- {ok:false,error} for credential problems (and still raise for
-- authorization problems, which are checked BEFORE credentials so an
-- unauthorized caller can't use this to guess editor passwords).
--
-- Internal helper: EXECUTE is revoked from everyone; only the security-
-- definer RPCs below call it.
drop function if exists verify_editor_approval(uuid, text, text);

create or replace function verify_editor_approval(
  p_outlet_id uuid,
  p_username text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user text := lower(trim(coalesce(p_username, '')));
  v_id uuid;
  v_email text;
  v_hash text;
  v_failures integer;
begin
  if v_user = '' or p_password is null or p_password = '' then
    return jsonb_build_object('error', 'Editor username and password are required');
  end if;

  select count(*) into v_failures
  from editor_approval_attempts a
  where a.outlet_id = p_outlet_id
    and lower(a.username) = v_user
    and not a.succeeded
    and a.attempted_at > now() - interval '10 minutes';

  if v_failures >= 5 then
    return jsonb_build_object('error',
      'Too many failed attempts for this editor account. Try again in a few minutes.');
  end if;

  select u.id, u.email, u.encrypted_password
    into v_id, v_email, v_hash
  from auth.users u
  join profiles pr on pr.user_id = u.id
  where lower(u.email) = v_user
    and pr.role = 'editor'
    and pr.is_active
    and pr.outlet_id = p_outlet_id;

  if v_id is not null and v_hash is not null and crypt(p_password, v_hash) = v_hash then
    delete from editor_approval_attempts
     where outlet_id = p_outlet_id and lower(username) = v_user and not succeeded;
    insert into editor_approval_attempts (outlet_id, username, requested_by, succeeded)
    values (p_outlet_id, v_user, auth.uid(), true);
    return jsonb_build_object('editor_id', v_id, 'editor_email', v_email);
  end if;

  -- Unknown user / not an editor / wrong password all look identical to the
  -- caller. Burn a comparable amount of time when the user wasn't found so
  -- response timing doesn't reveal which usernames exist.
  if v_id is null then
    perform crypt(p_password, gen_salt('bf'));
  end if;

  insert into editor_approval_attempts (outlet_id, username, requested_by, succeeded)
  values (p_outlet_id, v_user, auth.uid(), false);
  return jsonb_build_object('error', 'Invalid editor username or password');
end;
$$;

revoke execute on function verify_editor_approval(uuid, text, text) from public;
revoke execute on function verify_editor_approval(uuid, text, text) from authenticated;