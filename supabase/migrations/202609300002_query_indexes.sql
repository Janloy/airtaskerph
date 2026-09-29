-- Apply once to existing Supabase projects to speed up marketplace ordering,
-- task filters, and unread-message lookups.
create index if not exists tasks_created_at_idx on public.tasks(created_at desc, id desc);
create index if not exists tasks_status_created_at_idx on public.tasks(status, created_at desc, id desc);
create index if not exists tasks_category_created_at_idx on public.tasks(category, created_at desc, id desc);
create index if not exists bids_status_task_idx on public.bids(status, task_id);
create index if not exists bids_task_created_idx on public.bids(task_id, created_at desc);
create index if not exists bids_bidder_created_idx on public.bids(bidder_id, created_at desc);
create index if not exists messages_task_recipient_read_idx on public.messages(task_id, recipient_id, read_at);
