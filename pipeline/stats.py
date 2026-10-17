"""Statistics shared by aggregation and the anomaly engine (BUILD_PLAN.md §4.2, §7.3)."""

from __future__ import annotations

import numpy as np
from scipy import stats as _st

Z95 = 1.96


def wilson(x, n, z: float = Z95):
    """Wilson score interval as percentages (0-100). Returns (low, high); NaN where n == 0.

    centre = (p + z²/2n) / (1 + z²/n)
    half   = z·sqrt(p(1−p)/n + z²/4n²) / (1 + z²/n)
    """
    x = np.asarray(x, dtype=float)
    n = np.asarray(n, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        p = x / n
        denom = 1 + z * z / n
        centre = (p + z * z / (2 * n)) / denom
        half = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
        low = np.where(n > 0, 100 * np.clip(centre - half, 0, 1), np.nan)
        high = np.where(n > 0, 100 * np.clip(centre + half, 0, 1), np.nan)
    return low, high


def binom_upper_tail(x, n, p0):
    """P(X >= x) for X ~ Binomial(n, p0): one-sided 'is resistance higher than baseline?'."""
    return _st.binom.sf(np.asarray(x) - 1, n, p0)


def poisson_upper_tail(k, lam):
    """P(K >= k) for K ~ Poisson(lam)."""
    return _st.poisson.sf(np.asarray(k) - 1, lam)


def benjamini_hochberg(pvalues) -> np.ndarray:
    """Benjamini-Hochberg adjusted q-values, same order as the input."""
    p = np.asarray(pvalues, dtype=float)
    m = p.size
    if m == 0:
        return p
    order = np.argsort(p)
    ranked = p[order] * m / np.arange(1, m + 1)
    q_sorted = np.minimum.accumulate(ranked[::-1])[::-1]
    q = np.empty(m)
    q[order] = np.minimum(q_sorted, 1.0)
    return q
