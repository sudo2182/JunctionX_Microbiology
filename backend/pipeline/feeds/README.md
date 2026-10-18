# RSS alert feeds

Implements BUILD_PLAN section 8. Runs as the last step of every replay run and on demand
(`feeds.yml`).

```
python -m pipeline.feeds --db --upload                    # replay / Actions
python -m pipeline.feeds --json tests/feeds/fixtures/episodes.json --out-dir build/feeds
```

From Python (inside the replay job, with its open psycopg connection):

```python
from pipeline.feeds.publish import run as publish_feeds

publish_feeds(conn=conn, upload=True)
```

Env: `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (upload only),
`APP_BASE_URL` (deep links; defaults to https://amr-watch.vercel.app).

## Feeds (bucket `feeds`, public, `Cache-Control: max-age=60`)

| File | Contents |
|---|---|
| `alerts.xml` | every open, escalation and resolve event |
| `alerts-high.xml` | High and Critical opens and escalations; no resolves |
| `ward-<CODE>.xml` | alerts scoped to that ward plus hospital-wide Critical |
| `esbl.xml`, `mrsa.xml`, `vre.xml`, `cpe.xml` | by phenotype |
| `organism-<slug>.xml` | by organism, e.g. `organism-escherichia-coli.xml` |

Every feed is written even when empty, so subscribe URLs always resolve. Newest 50 items
per feed, newest week first, then by rank. Each item's `<link>` is
`{APP_BASE_URL}/alerts/{alert_id}?week=YYYY-Www`; the self link is
`{APP_BASE_URL}/feed/{name}.xml`, which the web app should redirect to
`{SUPABASE_URL}/storage/v1/object/public/feeds/{name}.xml`.

## What it reads

- `agg.alert_episodes(episode_id, status, severity, confidence, last_fired_week)`
- `agg.alert_firings(episode_id, week_idx, evidence jsonb)`; evidence is the section 7.4 JSON.
  The feed uses `alert_id, type (rate|count|sentinel|drift), organism, marker or
  antibiotic_code, specimen, scope{type,value}, current{weeks,n,x,pct,ci | k},
  baseline{n,x,pct}, expected{count}, effect{abs_pp,ratio}, test{p,q}, distinct_patients,
  breakdown.onset.hospital`, and per firing `severity` (band string or `{band, points}`),
  `confidence`, optional `rank`. Missing per-firing severity / confidence fall back to the
  episode row.
- `lab.replay_state.cursor_week_idx`: nothing after the cursor is published.
- `ref.wards(ward_code, ward_en)` if present, for ward names.

It writes `agg.feed_log(item_guid, feed, published_at)` and needs a unique key on
`(item_guid, feed)`. A guid's first `published_at` is reused as its `pubDate` forever.

## Events

An episode publishes one item when it opens (`:r1`), one per escalation, i.e. when a
firing's severity band or confidence is above every earlier firing (`:r2`, `:r3`…), and one
when its status is `resolved` (`:resolved`, two weeks after the last firing). Repeat firings
at the same level publish nothing.

## Privacy

Only aggregate fields are rendered, and every feed is checked before writing: patient,
culture or isolate ids, exact dates (YYYY-MM-DD) or patient-level field names make the run
fail with `PrivacyError`. The smallest time unit is the ISO week.
