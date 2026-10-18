"""Small, dependency-free statistics used by the anomaly engine.

Kept in pure Python (no scipy) so the pipeline image stays small and the
numbers are easy to audit. Every function here is unit-tested against known
values in tests/anomaly/test_stats.py.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

Z95 = 1.959963984540054


def wilson(x: int, n: int, z: float = Z95) -> tuple[float, float]:
    """Wilson score interval for a proportion x/n, returned as fractions (0..1)."""
    if n <= 0:
        return (float("nan"), float("nan"))
    p = x / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def _logsumexp(values: Sequence[float]) -> float:
    m = max(values)
    if m == -math.inf:
        return -math.inf
    return m + math.log(sum(math.exp(v - m) for v in values))


def binom_sf(k: int, n: int, p: float) -> float:
    """Exact one-sided upper tail P[X >= k] for X ~ Binomial(n, p)."""
    if k <= 0:
        return 1.0
    if k > n:
        return 0.0
    if p <= 0:
        return 0.0
    if p >= 1:
        return 1.0
    lp, lq = math.log(p), math.log1p(-p)
    lgn = math.lgamma(n + 1)
    terms = [lgn - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * lp + (n - i) * lq for i in range(k, n + 1)]
    return min(1.0, math.exp(_logsumexp(terms)))


def poisson_sf(k: int, lam: float) -> float:
    """Exact one-sided upper tail P[X >= k] for X ~ Poisson(lam)."""
    if k <= 0:
        return 1.0
    if lam <= 0:
        return 0.0
    # Sum the upper tail directly so very small p-values keep their precision.
    terms = []
    i = k
    while True:
        t = -lam + i * math.log(lam) - math.lgamma(i + 1)
        terms.append(t)
        if i > lam and t < terms[0] - 40:
            break
        i += 1
    return min(1.0, math.exp(_logsumexp(terms)))


def cochran_armitage(x: Sequence[int], n: Sequence[int], scores: Sequence[float] | None = None) -> tuple[float, float]:
    """Cochran-Armitage test for an increasing trend in proportions x[i]/n[i].

    Returns (z, one-sided p for an increase). ``scores`` default to 0, 1, 2, ...
    """
    k = len(n)
    s = list(range(k)) if scores is None else list(scores)
    big_n, big_x = sum(n), sum(x)
    if big_n == 0 or big_x in (0, big_n):
        return (0.0, 1.0)
    p = big_x / big_n
    t = sum(si * (xi - ni * p) for si, xi, ni in zip(s, x, n, strict=True))
    s_bar = sum(si * ni for si, ni in zip(s, n, strict=True)) / big_n
    var = p * (1 - p) * sum(ni * (si - s_bar) ** 2 for si, ni in zip(s, n, strict=True))
    if var <= 0:
        return (0.0, 1.0)
    z = t / math.sqrt(var)
    return (z, 0.5 * math.erfc(z / math.sqrt(2)))


def benjamini_hochberg(pvalues: Sequence[float]) -> list[float]:
    """Benjamini-Hochberg adjusted q-values, in the input order."""
    m = len(pvalues)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: pvalues[i])
    q = [0.0] * m
    running = 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        running = min(running, pvalues[i] * m / rank)
        q[i] = running
    return q
