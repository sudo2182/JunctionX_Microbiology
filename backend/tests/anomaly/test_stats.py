import math

import pytest

from pipeline.anomaly import stats


@pytest.mark.parametrize(
    "x,n,lo,hi",
    [(0, 30, 0.0, 0.1135), (15, 30, 0.3315, 0.6685), (30, 30, 0.8865, 1.0)],
)
def test_wilson_known_values(x, n, lo, hi):
    got = stats.wilson(x, n)
    assert got[0] == pytest.approx(lo, abs=5e-4)
    assert got[1] == pytest.approx(hi, abs=5e-4)


def test_binom_sf_matches_direct_sum():
    assert stats.binom_sf(3, 10, 0.1) == pytest.approx(1 - (0.9**10 + 10 * 0.1 * 0.9**9 + 45 * 0.01 * 0.9**8))
    assert stats.binom_sf(0, 10, 0.3) == 1.0
    assert stats.binom_sf(11, 10, 0.3) == 0.0
    assert stats.binom_sf(10, 10, 0.5) == pytest.approx(0.5**10)


def test_binom_sf_keeps_tiny_p_values():
    p = stats.binom_sf(14, 41, 0.04)
    assert 0 < p < 1e-6


def test_poisson_sf_known_values():
    assert stats.poisson_sf(3, 0.5) == pytest.approx(1 - math.exp(-0.5) * (1 + 0.5 + 0.125))
    assert stats.poisson_sf(0, 2.0) == 1.0
    assert 0 < stats.poisson_sf(13, 0.5) < 1e-12


def test_benjamini_hochberg():
    assert stats.benjamini_hochberg([0.01, 0.04, 0.03, 0.005]) == pytest.approx([0.02, 0.04, 0.04, 0.02])
    assert stats.benjamini_hochberg([]) == []
    assert stats.benjamini_hochberg([0.9, 0.95]) == pytest.approx([0.95, 0.95])


def test_cochran_armitage_trend_direction():
    n = [400] * 8
    rising = [60, 64, 68, 72, 76, 80, 84, 88]
    z, p = stats.cochran_armitage(rising, n)
    assert z > 3 and p < 0.001
    z, p = stats.cochran_armitage(list(reversed(rising)), n)
    assert z < 0 and p > 0.99
    assert stats.cochran_armitage([0, 0], [10, 10]) == (0.0, 1.0)
