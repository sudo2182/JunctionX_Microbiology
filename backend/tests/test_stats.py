import numpy as np
import pytest

from pipeline.stats import benjamini_hochberg, binom_upper_tail, poisson_upper_tail, wilson


@pytest.mark.parametrize(
    "x,n,low,high",
    [(0, 30, 0.0, 11.35), (15, 30, 33.15, 66.85), (30, 30, 88.65, 100.0), (14, 352, 2.38, 6.56)],
)
def test_wilson_known_values(x, n, low, high):
    lo, hi = wilson(x, n)
    assert float(lo) == pytest.approx(low, abs=0.01)
    assert float(hi) == pytest.approx(high, abs=0.01)


def test_wilson_zero_n_is_nan():
    lo, hi = wilson(0, 0)
    assert np.isnan(lo) and np.isnan(hi)


def test_binomial_and_poisson_tails():
    assert binom_upper_tail(0, 10, 0.1) == pytest.approx(1.0)
    assert binom_upper_tail(10, 10, 0.5) == pytest.approx(0.5**10)
    # P(K >= 3 | lambda = 0.5) = 1 - e^-0.5 (1 + 0.5 + 0.125)
    assert poisson_upper_tail(3, 0.5) == pytest.approx(1 - np.exp(-0.5) * 1.625)


def test_benjamini_hochberg():
    q = benjamini_hochberg([0.01, 0.04, 0.03, 0.005])
    assert q == pytest.approx([0.02, 0.04, 0.04, 0.02])
    assert benjamini_hochberg([]).size == 0
