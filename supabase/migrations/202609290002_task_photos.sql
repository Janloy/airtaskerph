-- Allow task posters to attach up to three public task photos.
alter table public.tasks
  add column if not exists image_urls text[] not null default '{}'::text[];

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('task-photos', 'task-photos', true, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "Public task photo reads" on storage.objects;
create policy "Public task photo reads" on storage.objects
  for select using (bucket_id = 'task-photos');
