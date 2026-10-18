-- Allow the dashboard to remove entries that were posted through it.
-- Rows that came from the laboratory pipeline are not exposed for deletion anywhere.

create policy "Anyone removes submitted records" on public.record_submissions
  for delete to anon, authenticated
  using (true);

create policy "Anyone removes feed items" on public.news_items
  for delete to anon, authenticated
  using (true);