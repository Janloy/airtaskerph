alter table public.user_profiles
  add column if not exists mfa_enabled boolean not null default false;

create table if not exists public.superadmin_mfa (
  user_id bigint primary key references public.user_profiles(id) on delete cascade,
  secret_ciphertext text not null,
  recovery_code_hashes jsonb not null default '[]'::jsonb,
  enabled_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.superadmin_mfa enable row level security;
revoke all on public.superadmin_mfa from public, anon, authenticated;
grant all on public.superadmin_mfa to service_role;

create or replace function public.consume_superadmin_recovery_code(
  p_user_id bigint,
  p_code_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_consumed integer;
begin
  update public.superadmin_mfa m
  set recovery_code_hashes = (
    select coalesce(jsonb_agg(code_hash), '[]'::jsonb)
    from jsonb_array_elements_text(m.recovery_code_hashes) as codes(code_hash)
    where code_hash <> p_code_hash
  ),
  updated_at = now()
  where m.user_id = p_user_id
    and m.enabled_at is not null
    and m.recovery_code_hashes @> jsonb_build_array(p_code_hash);

  get diagnostics v_consumed = row_count;
  return v_consumed > 0;
end;
$$;
revoke all on function public.consume_superadmin_recovery_code(bigint,text) from public, anon, authenticated;
grant execute on function public.consume_superadmin_recovery_code(bigint,text) to service_role;

create or replace function public.enable_superadmin_mfa(
  p_user_id bigint,
  p_recovery_code_hashes jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_recovery_code_hashes is null or jsonb_typeof(p_recovery_code_hashes) <> 'array' then
    raise exception 'Exactly 10 recovery codes are required.';
  end if;
  if jsonb_array_length(p_recovery_code_hashes) <> 10
     or exists (
       select 1 from jsonb_array_elements_text(p_recovery_code_hashes) as hashes(value)
       where value !~ '^[a-f0-9]{64}$'
     ) then
    raise exception 'Exactly 10 recovery codes are required.';
  end if;

  update public.superadmin_mfa
  set enabled_at = now(),
      recovery_code_hashes = p_recovery_code_hashes,
      updated_at = now()
  where user_id = p_user_id
    and enabled_at is null;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'Authenticator setup changed or is already enabled.';
  end if;

  update public.user_profiles
  set mfa_enabled = true
  where id = p_user_id
    and role = 'superadmin';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'Only an existing Superadmin account can enable MFA.';
  end if;
  return true;
end;
$$;
revoke all on function public.enable_superadmin_mfa(bigint,jsonb) from public, anon, authenticated;
grant execute on function public.enable_superadmin_mfa(bigint,jsonb) to service_role;

create or replace function public.disable_superadmin_mfa(p_user_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.superadmin_mfa where user_id = p_user_id and enabled_at is not null;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception 'Authenticator MFA is not enabled.';
  end if;

  update public.user_profiles
  set mfa_enabled = false
  where id = p_user_id
    and role = 'superadmin';
  if not found then
    raise exception 'Only an existing Superadmin account can disable MFA.';
  end if;
  return true;
end;
$$;
revoke all on function public.disable_superadmin_mfa(bigint) from public, anon, authenticated;
grant execute on function public.disable_superadmin_mfa(bigint) to service_role;

create table if not exists public.superadmin_mfa_login_challenges (
  challenge_hash text primary key,
  user_id bigint not null references public.user_profiles(id) on delete cascade,
  refresh_token_ciphertext text not null,
  attempts integer not null default 0 check (attempts between 0 and 5),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists superadmin_mfa_login_challenges_expiry_idx
  on public.superadmin_mfa_login_challenges(expires_at);
alter table public.superadmin_mfa_login_challenges enable row level security;
revoke all on public.superadmin_mfa_login_challenges from public, anon, authenticated;
grant all on public.superadmin_mfa_login_challenges to service_role;

alter table public.task_reports
  add column if not exists assigned_to bigint references public.user_profiles(id) on delete set null,
  add column if not exists priority varchar(12) not null default 'normal'
    check (priority in ('low','normal','high','urgent')),
  add column if not exists sla_due_at timestamptz not null default (now() + interval '24 hours');

alter table public.task_disputes
  add column if not exists assigned_to bigint references public.user_profiles(id) on delete set null,
  add column if not exists priority varchar(12) not null default 'normal'
    check (priority in ('low','normal','high','urgent')),
  add column if not exists sla_due_at timestamptz not null default (now() + interval '24 hours');

create index if not exists task_reports_queue_idx
  on public.task_reports(status, priority, sla_due_at, created_at desc);
create index if not exists task_reports_assigned_idx
  on public.task_reports(assigned_to, status, sla_due_at);
create index if not exists task_disputes_queue_idx
  on public.task_disputes(status, priority, sla_due_at, created_at desc);
create index if not exists task_disputes_assigned_idx
  on public.task_disputes(assigned_to, status, sla_due_at);

create table if not exists public.moderation_case_notes (
  id bigint generated by default as identity primary key,
  case_type varchar(12) not null check (case_type in ('report','dispute')),
  case_id bigint not null,
  author_id bigint references public.user_profiles(id) on delete set null,
  author_name text not null,
  note varchar(2000) not null check (length(note) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists moderation_case_notes_case_idx
  on public.moderation_case_notes(case_type, case_id, created_at desc, id desc);
alter table public.moderation_case_notes enable row level security;
revoke all on public.moderation_case_notes from public, anon, authenticated;
grant all on public.moderation_case_notes to service_role;
grant usage, select on sequence public.moderation_case_notes_id_seq to service_role;

create or replace function public.admin_bulk_suspend_members(
  p_actor_id bigint,
  p_user_ids bigint[],
  p_reason text,
  p_duration text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.user_profiles%rowtype;
  v_count integer;
  v_until timestamptz;
begin
  select * into v_actor from public.user_profiles where id = p_actor_id for share;
  if not found or v_actor.role not in ('superadmin','admin') then
    raise exception 'Only authorized administrators can bulk suspend accounts.';
  end if;
  if v_actor.role = 'admin' and not coalesce((
    select sp.can_view_users from public.staff_permissions sp where sp.user_id = p_actor_id
  ), false) then
    raise exception 'User-record permission is required for bulk suspension.';
  end if;
  if p_user_ids is null or cardinality(p_user_ids) < 1 or cardinality(p_user_ids) > 50
     or cardinality(p_user_ids) <> (select count(distinct selected.user_id) from unnest(p_user_ids) as selected(user_id))
     or p_actor_id = any(p_user_ids) then
    raise exception 'Choose between 1 and 50 distinct member accounts.';
  end if;
  if length(trim(coalesce(p_reason,''))) < 3 or length(p_reason) > 1000 then
    raise exception 'A suspension reason between 3 and 1000 characters is required.';
  end if;
  if p_duration is null or p_duration not in ('24h','7d','30d','permanent') then
    raise exception 'Choose a valid suspension duration.';
  end if;
  if v_actor.role = 'admin' and exists (
    select 1 from public.user_profiles
    where id = any(p_user_ids) and role <> 'user'
  ) then
    raise exception 'Admins may bulk suspend member accounts only.';
  end if;
  if exists (
    select 1 from public.user_profiles
    where id = any(p_user_ids) and role = 'superadmin'
  ) or (select count(*) from public.user_profiles where id = any(p_user_ids)) <> cardinality(p_user_ids) then
    raise exception 'Every selected account must exist and be eligible for suspension.';
  end if;
  v_until := case p_duration
    when '24h' then now() + interval '24 hours'
    when '7d' then now() + interval '7 days'
    when '30d' then now() + interval '30 days'
    else null
  end;

  with targets as materialized (
    select p.id, trim(concat_ws(' ',p.first_name,p.last_name)) as label,
      p.is_suspended, p.suspension_reason, p.suspended_until
    from public.user_profiles p
    where p.id = any(p_user_ids)
    for update
  ), changed as (
    update public.user_profiles p
    set is_suspended = true, suspension_reason = trim(p_reason), suspended_until = v_until
    from targets t where p.id = t.id
    returning p.id, p.first_name, p.last_name
  )
  insert into public.admin_audit_events
    (actor_id,actor_name,actor_email,action,target_type,target_id,target_label,reason,before_state,after_state)
  select p_actor_id, trim(concat_ws(' ',v_actor.first_name,v_actor.last_name)), v_actor.email,
    'account_suspended', 'user', c.id::text, trim(concat_ws(' ',c.first_name,c.last_name)), trim(p_reason),
    jsonb_build_object('is_suspended',t.is_suspended,'suspension_reason',t.suspension_reason,'suspended_until',t.suspended_until),
    jsonb_build_object('is_suspended',true,'suspended_until',v_until,'bulk_action',true)
  from changed c
  join targets t on t.id = c.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.admin_bulk_suspend_members(bigint,bigint[],text,text) from public, anon, authenticated;
grant execute on function public.admin_bulk_suspend_members(bigint,bigint[],text,text) to service_role;

create or replace function public.admin_staff_activity_summary(p_days integer default 30)
returns table (
  user_id bigint,
  first_name text,
  last_name text,
  email text,
  role text,
  action_count bigint,
  last_action_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select p.id, p.first_name, p.last_name, p.email, p.role::text,
    count(e.id) as action_count, max(e.created_at) as last_action_at
  from public.user_profiles p
  left join public.admin_audit_events e
    on e.actor_id = p.id
    and e.created_at >= now() - make_interval(days => greatest(1, least(p_days, 90)))
  where p.role in ('admin','moderator','support')
  group by p.id, p.first_name, p.last_name, p.email, p.role
  order by action_count desc, last_action_at desc nulls last, p.first_name, p.last_name;
$$;
revoke all on function public.admin_staff_activity_summary(integer) from public, anon, authenticated;
grant execute on function public.admin_staff_activity_summary(integer) to service_role;
