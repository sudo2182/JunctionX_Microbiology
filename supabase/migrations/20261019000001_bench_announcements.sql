-- External surveillance announcements & news monitor (ECDC RSS feed checker)
-- Stored under bench schema to keep external public intelligence separate from local clinical data.

create table if not exists bench.announcements (
  announcement_id     bigint generated always as identity primary key,
  source_id           text not null default 'ecdc',
  feed_key            text not null,                       -- e.g. 'surveillance', 'publications', 'threats_cdtr', 'news'
  feed_name           text not null,                       -- e.g. 'Surveillance reports', 'Scientific and technical publications'
  feed_url            text not null,
  guid                text not null,                       -- stable item identifier (source GUID or canonical URL fallback)
  title               text not null,
  article_url         text not null,                       -- direct link to the article/report
  published_at        timestamptz,                         -- normalized publication timestamp
  first_detected_at   timestamptz not null default now(),  -- when our monitor first ingested it
  last_checked_at     timestamptz not null default now(),  -- latest check timestamp
  summary             text,                                -- stripped source summary (no raw HTML blobs)
  relevance_category  text not null check (relevance_category in ('relevant', 'review', 'unrelated')),
  matched_terms       jsonb not null default '[]'::jsonb,  -- list of matched AMR terms/keywords
  status              text not null default 'new' check (status in ('new', 'reviewed', 'archived')),
  raw_metadata        jsonb default '{}'::jsonb,           -- optional lightweight metadata (author, categories)
  constraint uq_bench_announcements_source_guid unique (source_id, guid)
);

create index if not exists idx_bench_announcements_relevance
  on bench.announcements (relevance_category, published_at desc nulls last);

create index if not exists idx_bench_announcements_guid
  on bench.announcements (source_id, guid);

create index if not exists idx_bench_announcements_pubdate
  on bench.announcements (published_at desc nulls last);

-- Read-only API view exposed to the dashboard
create or replace view api.announcements as
select
  announcement_id,
  source_id,
  feed_key,
  feed_name,
  title,
  article_url,
  published_at,
  first_detected_at,
  summary,
  relevance_category,
  matched_terms,
  status
from bench.announcements
order by published_at desc nulls last;

grant select on api.announcements to anon, authenticated;
