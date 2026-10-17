-- A signal that resolves and later fires again is a new episode with the same key (BUILD_PLAN.md §7.6), so
-- key cannot be unique across all episodes. The real rule is one active episode per key at a time.
alter table agg.alert_episodes drop constraint if exists alert_episodes_key_key;
create unique index if not exists alert_episodes_one_active_per_key
  on agg.alert_episodes (key) where status in ('open', 'escalated');
