"""Runtime configuration from environment variables (see .env.example)."""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_ROOT.parent
CSV_FILES = ("patients", "cultures", "isolates", "susceptibility")


def data_dir() -> Path:
    """Where the synthetic LIS export CSVs live.

    AMR_DATA_DIR wins; otherwise data/raw/ (git-ignored, the plan's location); otherwise the
    data/tyks/ folder already committed to this repo (paths relative to the repository root).
    """
    env = os.environ.get("AMR_DATA_DIR")
    if env:
        return Path(env)
    for candidate in (REPO_ROOT / "data" / "raw", REPO_ROOT / "data" / "tyks"):
        if (candidate / "cultures.csv").exists():
            return candidate
    raise FileNotFoundError(
        "No dataset found. Put the CSVs in data/raw/ or set AMR_DATA_DIR (see README.md)."
    )


def db_url() -> str:
    url = os.environ.get("SUPABASE_DB_URL")
    if not url:
        raise RuntimeError("SUPABASE_DB_URL is not set (see .env.example).")
    return url


def run_url() -> str | None:
    server, repo, run = (os.environ.get(k) for k in ("GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"))
    return f"{server}/{repo}/actions/runs/{run}" if server and repo and run else None
