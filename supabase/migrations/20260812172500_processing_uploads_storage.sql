-- Private, short-lived uploads for AI photos and supplier import files.
-- Clients may only access paths whose first segment is their own auth.uid().

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'processing-uploads',
  'processing-uploads',
  false,
  26214400,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/csv',
    'text/plain',
    'application/csv'
  ]::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists processing_uploads_insert_own on storage.objects;
create policy processing_uploads_insert_own
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'processing-uploads'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists processing_uploads_select_own on storage.objects;
create policy processing_uploads_select_own
on storage.objects
for select
to authenticated
using (
  bucket_id = 'processing-uploads'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists processing_uploads_delete_own on storage.objects;
create policy processing_uploads_delete_own
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'processing-uploads'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

