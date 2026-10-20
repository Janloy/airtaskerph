alter type public.task_status add value if not exists 'Expired';

alter table public.tasks
  add column if not exists expired_notified_at timestamptz;

create index if not exists tasks_open_schedule_date_idx
  on public.tasks(schedule_date)
  where status = 'Open' and schedule_date is not null;

create index if not exists tasks_status_schedule_notification_idx
  on public.tasks(status, schedule_date, expired_notified_at);
