create table if not exists public.web_push_subscriptions (
  endpoint text primary key,
  user_id bigint not null references public.user_profiles(id) on delete cascade,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists web_push_subscriptions_user_idx
  on public.web_push_subscriptions(user_id);

alter table public.web_push_subscriptions enable row level security;
revoke all on public.web_push_subscriptions from public, anon, authenticated;
grant all on public.web_push_subscriptions to service_role;
