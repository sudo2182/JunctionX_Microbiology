"""HTTPS requests with certificate checking always on, using certifi's CA bundle when it is installed.

(Some Python installs, e.g. the python.org macOS builds, ship without root certificates.)
"""

from __future__ import annotations

import ssl
import urllib.request

try:
    import certifi

    _CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # fall back to the system store
    _CONTEXT = ssl.create_default_context()


def urlopen(req: urllib.request.Request, timeout: int = 60):
    return urllib.request.urlopen(req, timeout=timeout, context=_CONTEXT)
