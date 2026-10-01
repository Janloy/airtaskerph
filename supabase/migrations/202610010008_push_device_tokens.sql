create table if not exists public.push_device_tokens (
  token text primary key,
  user_id bigint not null references public.user_profiles(id) on delete cascade,
  platform text not null check (platform in ('android', 'ios')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_device_tokens_user_idx on public.push_device_tokens(user_id);
alter table public.push_device_tokens enable row level security;
revoke all on public.push_device_tokens from public, anon, authenticated;
grant all on public.push_device_tokens to service_role;
