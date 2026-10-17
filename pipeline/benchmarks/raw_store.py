"""Fetch a raw manual export from the private Supabase Storage bucket (service role; used by the Action)."""

from __future__ import annotations

import os
import urllib.parse
import urllib.request

from pipeline.benchmarks import net


def download(storage_path: str, timeout: int = 60) -> bytes:
    """`storage_path` is '<bucket>/<object path>'. Uses the documented authenticated Storage download route."""
    base, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not base or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed to read the raw bucket")
    bucket, _, obj = storage_path.partition("/")
    if not bucket or not obj:
        raise ValueError(f"storage path must look like '<bucket>/<file>', got {storage_path!r}")
    url = f"{base.rstrip('/')}/storage/v1/object/authenticated/{urllib.parse.quote(bucket)}/{urllib.parse.quote(obj)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}", "apikey": key})
    with net.urlopen(req, timeout=timeout) as resp:
        return resp.read()
