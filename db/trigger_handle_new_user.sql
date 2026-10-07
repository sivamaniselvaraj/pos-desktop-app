-- 1. Create a function that inserts a new row into public.profiles
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (user_id, first_name, last_name, email, user_role, is_active)
  values (new.id, '', '', new.email, 'staff', TRUE)
  ON CONFLICT (user_id) DO NOTHING;
  return new;
end;
$$;

-- 2. Create the trigger that runs after a user is inserted into auth.users
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();