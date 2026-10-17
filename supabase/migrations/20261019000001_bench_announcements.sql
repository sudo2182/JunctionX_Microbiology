-- AMR Watch: ECDC RSS announcement monitor (pipeline/announcements).
--
-- Announcements are external public information, kept in bench next to the other external sources and never
-- joined to lab/agg. Each check is logged in bench.import_runs (dataset 'ecdc_rss'), so
-- api.external_sources.last_import_at is the last successful check. RSS items are discovery pointers to ECDC
-- pages, not surveillance data: no rates are derived from them.

alter table bench.sources drop constraint if exists sources_access_method_check;
alter table bench.sources add constraint sources_access_method_check
  check (access_method in ('api', 'manual_export', 'report_table', 'rss'));

insert into bench.sources (source_id, name, publisher, landing_url, access_method, licence, attribution, methodology, update_cadence) values
  ('ecdc_rss',
   'ECDC RSS feeds (publications, surveillance reports, threats reports, news)',
   'European Centre for Disease Prevention and Control (ECDC)',
   'https://www.ecdc.europa.eu/en/rss-feeds',
   'rss',
   'CC BY 4.0 unless otherwise stated (ECDC intellectual property notice, https://www.ecdc.europa.eu/en/ecdc-intellectual-property-notices). Only titles, links, dates and the short feed summary are stored.',
   'Source: © ECDC, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Summaries shortened and stripped of HTML by AMR Watch; links open the original ECDC page.',
   'Each feed lists only its latest items (10 at the time of writing). Items are matched against transparent keyword rules (pipeline/announcements/filter.py); a match is not a confirmed outbreak or clinical alert.',
   'Polled daily by the ecdc_announcements workflow when enabled; ECDC publishes irregularly')
on conflict (source_id) do nothing;

create table if not exists bench.announcements (
  announcement_id     bigint generated always as identity primary key,
  source_id           text not null references bench.sources (source_id),
  feed_key            text not null,                       -- config key of the feed where the item was first seen
  feed_name           text not null,
  feed_url            text not null,
  guid                text not null,                       -- source GUID, or the canonical article URL when there is none
  title               text not null,
  article_url         text not null,                       -- canonical link to the original ECDC page
  published_at        timestamptz,                         -- null when the feed gives no date
  first_detected_at   timestamptz not null default now(),
  last_checked_at     timestamptz not null default now(),  -- last run that still saw the item in a feed
  summary             text,                                -- feed-provided summary, HTML stripped, max 2000 chars
  relevance_category  text not null check (relevance_category in ('relevant', 'review', 'unrelated')),
  matched_terms       jsonb not null default '[]'::jsonb,
  status              text not null default 'new' check (status in ('new', 'reviewed', 'archived')),
  raw_metadata        jsonb not null default '{}'::jsonb,  -- author and categories only
  import_run_id       bigint references bench.import_runs (run_id) on delete set null,  -- run that first stored it
  constraint announcements_source_guid_key unique (source_id, guid)
);

create index if not exists announcements_relevance_published_idx
  on bench.announcements (relevance_category, published_at desc nulls last);

-- Same access model as every other bench table: RLS on, no policies, nothing for anon/authenticated.
alter table bench.announcements enable row level security;
revoke all on bench.announcements from anon, authenticated;

drop view if exists api.announcements;
create view api.announcements as
select
  a.announcement_id, a.source_id, s.name as source_name, a.feed_key, a.feed_name, a.title, a.article_url,
  a.published_at, a.first_detected_at, a.last_checked_at, a.summary, a.relevance_category, a.matched_terms,
  a.status, s.attribution
from bench.announcements a
join bench.sources s using (source_id);

grant select on api.announcements to anon, authenticated, service_role;
