"""Load alerts, render every feed, record agg.feed_log and upload to Storage (BUILD_PLAN 8.4).

Tables read (owned by the foundation migrations, shapes from BUILD_PLAN 7.6 / 8.4):
  agg.alert_episodes(episode_id, key, opened_week, last_fired_week, status, severity, confidence, rank)
  agg.alert_firings(episode_id, week_idx, evidence jsonb)
  lab.replay_state(cursor_week_idx)
  ref.wards(ward_code, ward_en)                    optional, falls back to labels.WARDS
  agg.feed_log(item_guid, feed, published_at)      written here; needs a unique key on (item_guid, feed)
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import urllib.error
import urllib.request
from pathlib import Path

from pipeline.feeds.events import events_from_episodes
from pipeline.feeds.render import render_feed
from pipeline.feeds.select import build_feeds

log = logging.getLogger(__name__)

BUCKET = "feeds"
CACHE_CONTROL = "max-age=60"


# --------------------------------------------------------------------------- loading


def load_episodes_json(path: str | Path) -> tuple[list[dict], int | None]:
    """Fixture / offline input: {"cursor_week_idx": 94, "episodes": [...]} or a bare list."""
    data = json.loads(Path(path).read_text())
    if isinstance(data, list):
        return data, None
    return data["episodes"], data.get("cursor_week_idx")


def load_episodes_db(conn) -> tuple[list[dict], int | None]:
    with conn.cursor() as cur:
        cur.execute("select cursor_week_idx from lab.replay_state where id = 1")
        row = cur.fetchone()
        cursor = row[0] if row else None
        cur.execute("select episode_id, status, severity, confidence, last_fired_week from agg.alert_episodes")
        episodes = {
            str(r[0]): {
                "episode_id": str(r[0]),
                "status": r[1],
                "severity": r[2],
                "confidence": r[3],
                "last_fired_week": r[4],
                "firings": [],
            }
            for r in cur.fetchall()
        }
        cur.execute("select episode_id, week_idx, evidence from agg.alert_firings order by episode_id, week_idx")
        for ep_id, week_idx, evidence in cur.fetchall():
            ep = episodes.get(str(ep_id))
            if ep is not None:
                if isinstance(evidence, str):
                    evidence = json.loads(evidence)
                ep["firings"].append({"week_idx": week_idx, "evidence": evidence or {}})
    return list(episodes.values()), cursor


def load_wards_db(conn) -> dict[str, str] | None:
    try:
        with conn.cursor() as cur:
            cur.execute("select ward_code, ward_en from ref.wards order by ward_code")
            rows = cur.fetchall()
        return {code: name for code, name in rows} or None
    except Exception as exc:  # noqa: BLE001  table missing or named differently: fall back to defaults
        conn.rollback()
        log.warning("ref.wards not readable (%s); using built-in ward names", exc)
        return None


def load_feed_log(conn) -> dict[str, dt.datetime]:
    with conn.cursor() as cur:
        cur.execute("select item_guid, min(published_at) from agg.feed_log group by item_guid")
        return {guid: ts for guid, ts in cur.fetchall()}


def record_feed_log(conn, rows: list[tuple[str, str, dt.datetime]]) -> int:
    """Insert (item_guid, feed, published_at); existing pairs keep their original time."""
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.executemany(
            "insert into agg.feed_log (item_guid, feed, published_at) values (%s, %s, %s) on conflict do nothing",
            rows,
        )
    conn.commit()
    return len(rows)


# --------------------------------------------------------------------------- upload


def upload_to_storage(name: str, body: bytes, supabase_url: str, service_key: str, bucket: str = BUCKET) -> None:
    """Upsert one object into a Supabase Storage bucket via the REST API."""
    url = f"{supabase_url.rstrip('/')}/storage/v1/object/{bucket}/{name}"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
            "Content-Type": "application/rss+xml; charset=utf-8",
            "Cache-Control": CACHE_CONTROL,
            "x-upsert": "true",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        if resp.status >= 300:
            raise RuntimeError(f"upload {name}: HTTP {resp.status}")


def ensure_public_bucket(supabase_url: str, service_key: str, bucket: str = BUCKET) -> None:
    req = urllib.request.Request(
        f"{supabase_url.rstrip('/')}/storage/v1/bucket",
        data=json.dumps({"id": bucket, "name": bucket, "public": True}).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {service_key}", "apikey": service_key, "Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=30).close()
        log.info("created public bucket %s", bucket)
    except urllib.error.HTTPError as exc:
        if exc.code not in (400, 409):  # 400/409: already exists
            raise


# --------------------------------------------------------------------------- orchestration


def generate(
    episodes: list[dict],
    *,
    base_url: str,
    through_week: int | None = None,
    published_at: dict[str, dt.datetime] | None = None,
    wards: dict[str, str] | None = None,
    now: dt.datetime | None = None,
) -> dict[str, bytes]:
    """Render every feed. Returns {"alerts.xml": b"...", ...}."""
    now = now or dt.datetime.now(dt.UTC).replace(microsecond=0)
    events = events_from_episodes(episodes, through_week)
    out: dict[str, bytes] = {}
    for spec in build_feeds(events, wards=wards):
        out[f"{spec.name}.xml"] = render_feed(
            name=spec.name,
            title=spec.title,
            description=spec.description,
            events=spec.events,
            base_url=base_url,
            channel_path=spec.channel_path,
            build_time=now,
            published_at=published_at,
            wards=wards,
        )
    return out


def feed_log_rows(files: dict[str, bytes], published_at: dict[str, dt.datetime], now: dt.datetime):
    import xml.etree.ElementTree as ET

    rows = []
    for filename, body in files.items():
        feed = filename.removesuffix(".xml")
        for guid in ET.fromstring(body).iter("guid"):
            rows.append((guid.text, feed, published_at.get(guid.text, now)))
    return rows


def run(
    *,
    conn=None,
    json_path: str | None = None,
    out_dir: str | None = None,
    upload: bool = False,
    base_url: str | None = None,
    supabase_url: str | None = None,
    service_key: str | None = None,
    now: dt.datetime | None = None,
) -> dict[str, bytes]:
    """Entry point for the replay job's last step (pass an open psycopg connection)."""
    now = now or dt.datetime.now(dt.UTC).replace(microsecond=0)
    base_url = base_url or os.environ.get("APP_BASE_URL") or "https://amr-watch.vercel.app"
    wards = None
    published_at: dict[str, dt.datetime] = {}
    if conn is not None:
        episodes, cursor = load_episodes_db(conn)
        wards = load_wards_db(conn)
        published_at = load_feed_log(conn)
    elif json_path:
        episodes, cursor = load_episodes_json(json_path)
    else:
        raise ValueError("need a database connection or a JSON input")

    files = generate(episodes, base_url=base_url, through_week=cursor, published_at=published_at, wards=wards, now=now)
    log.info("rendered %d feeds from %d episodes (cursor %s)", len(files), len(episodes), cursor)

    if out_dir:
        path = Path(out_dir)
        path.mkdir(parents=True, exist_ok=True)
        for name, body in files.items():
            (path / name).write_bytes(body)

    if upload:
        supabase_url = supabase_url or os.environ["SUPABASE_URL"]
        service_key = service_key or os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        ensure_public_bucket(supabase_url, service_key)
        for name, body in files.items():
            upload_to_storage(name, body, supabase_url, service_key)
        log.info("uploaded %d feeds to bucket %s", len(files), BUCKET)

    if conn is not None:
        rows = feed_log_rows(files, published_at, now)
        record_feed_log(conn, rows)
        log.info("feed_log: %d item placements recorded (existing ones unchanged)", len(rows))
    return files
