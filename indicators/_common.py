"""
_common.py — shared indicator building blocks (pure Python + pandas).

These are the low-level helpers that the indicator modules in this package
import. Each indicator lives in its own file (e.g. ema.py, rsi.py) and exposes
NAME / PANE / compute(df); the registry in __init__.py discovers them all.

Everything is causal (no lookahead) so the bar-replay reveals each value
correctly bar by bar.
"""

import math

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Basic building blocks (same semantics as PineScript built-ins)
# ---------------------------------------------------------------------------

def sma(series, length):
    """PineScript: ta.sma(src, length)."""
    return series.rolling(length).mean()


def ema(series, length):
    """PineScript: ta.ema(src, length)."""
    return series.ewm(span=length, adjust=False).mean()


def rma(series, length):
    """Wilder's moving average — PineScript's ta.rma(src, length)."""
    return series.ewm(alpha=1.0 / length, adjust=False).mean()


def highest(series, length):
    return series.rolling(length).max()


def lowest(series, length):
    return series.rolling(length).min()


def stdev(series, length):
    return series.rolling(length).std(ddof=0)


def median(series, length):
    """PineScript: ta.median(src, length) — rolling median."""
    return series.rolling(int(length)).median()


def wma(series, length):
    """Linearly weighted MA — PineScript ta.wma(src, length).

    Weights are 1..length, the most recent bar gets the largest weight.
    """
    length = int(length)
    weights = np.arange(1.0, length + 1.0)

    def _weighted(window):
        return float(np.dot(window, weights) / weights.sum())

    return series.rolling(length).apply(_weighted, raw=True)


def hma(series, length):
    """Hull MA — PineScript ta.hma(src, length):
    wma(2*wma(src, length/2) - wma(src, length), round(sqrt(length))).
    """
    length = int(length)
    half = max(1, length // 2)
    sq = max(1, int(round(math.sqrt(length))))
    return wma(2.0 * wma(series, half) - wma(series, length), sq)


# ---------------------------------------------------------------------------
# Oscillators / overlays — common PineScript ports
# ---------------------------------------------------------------------------

def rsi(close, length=14):
    """PineScript: ta.rsi(close, length)."""
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = rma(gain, length)
    avg_loss = rma(loss, length)
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    out = 100.0 - (100.0 / (1.0 + rs))
    return out.fillna(50.0)  # PineScript shows 50 while undefined at the start


def macd(close, fast=12, slow=26, signal=9):
    """PineScript: [macdLine, signalLine, histLine] = ta.macd(close, f, s, sig)."""
    macd_line = ema(close, fast) - ema(close, slow)
    signal_line = ema(macd_line, signal)
    hist = macd_line - signal_line
    return macd_line, signal_line, hist


def bollinger(close, length=20, mult=2.0):
    """PineScript: ta.sma(close, 20) with ta.stdev band of `mult`."""
    basis = sma(close, length)
    dev = mult * stdev(close, length)
    return basis, basis + dev, basis - dev


def atr(high, low, close, length=14):
    """PineScript: ta.atr(length)."""
    prev_close = close.shift(1)
    tr = pd.concat(
        [
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return rma(tr, length)


def supertrend(high, low, close, length=10, mult=3.0):
    """PineScript port of the popular SuperTrend indicator.

    Returns (st_line, direction).  direction: +1 up / -1 down.
    Included as an example of a *stateful* PineScript port (uses a loop,
    which is how TradingView evaluates such indicators bar by bar).
    """
    hl2 = (high + low) / 2.0
    atr_ = atr(high, low, close, length)
    upper = hl2 + mult * atr_
    lower = hl2 - mult * atr_

    n = len(close)
    final_upper = np.full(n, np.nan)
    final_lower = np.full(n, np.nan)
    trend = np.zeros(n)
    direction = np.zeros(n)

    # seed with the first band values (NaN seeds would propagate forever —
    # every comparison against NaN is False, so the else-branch keeps NaN)
    final_upper[0] = upper.iloc[0]
    final_lower[0] = lower.iloc[0]

    for i in range(1, n):
        prev_up = final_upper[i - 1]
        prev_lo = final_lower[i - 1]
        final_upper[i] = (
            upper.iloc[i]
            if (upper.iloc[i] < prev_up or close.iloc[i - 1] > prev_up)
            else prev_up
        )
        final_lower[i] = (
            lower.iloc[i]
            if (lower.iloc[i] > prev_lo or close.iloc[i - 1] < prev_lo)
            else prev_lo
        )

        if close.iloc[i] > final_upper[i - 1]:
            trend[i] = 1
        elif close.iloc[i] < final_lower[i - 1]:
            trend[i] = -1
        else:
            trend[i] = trend[i - 1]

        if trend[i] == 1 and trend[i - 1] == -1:
            direction[i] = 1
        elif trend[i] == -1 and trend[i - 1] == 1:
            direction[i] = -1
        else:
            direction[i] = direction[i - 1]

    st_line = pd.Series(np.where(direction == 1, final_lower, final_upper), index=close.index)
    return st_line, pd.Series(direction, index=close.index)


# ---------------------------------------------------------------------------
# DSL Oscillator (Discontinued Signal Lines) — port of dsl-osc PineScript.
# Canonical/faithful version lives in dsl_oscillator.py (PyneCore); this is a
# pandas mirror so the same values can be plotted in the bar-replay chart.
# ---------------------------------------------------------------------------

def _zlema(src, length):
    """Zero-Lag EMA: ta.ema(2*src - src[lag], length)."""
    lag = int(math.floor((length - 1) / 2))
    return ema(2.0 * src - src.shift(lag), length)


def _dsl_lines(src, length, mode):
    """Discontinued Signal Lines (recursive smoothing).

    up := (src > sma) ? nz(up[1]) + mode/length*(src - nz(up[1])) : nz(up[1])
    dn := (src < sma) ? nz(dn[1]) + mode/length*(src - nz(dn[1])) : nz(dn[1])
    """
    sma_ = sma(src, length)
    k = mode / length
    n = len(src)
    up = np.zeros(n)
    dn = np.zeros(n)
    prev_up = 0.0
    prev_dn = 0.0
    for i in range(n):
        s = src.iloc[i]
        sm = sma_.iloc[i]
        if not np.isnan(sm):
            if s > sm:
                prev_up = prev_up + k * (s - prev_up)
            if s < sm:
                prev_dn = prev_dn + k * (s - prev_dn)
        up[i] = prev_up
        dn[i] = prev_dn
    return pd.Series(up, index=src.index), pd.Series(dn, index=src.index)


def _crossover(a, b):
    return (a > b) & (a.shift(1) <= b.shift(1))


def _crossunder(a, b):
    return (a < b) & (a.shift(1) >= b.shift(1))


def dsl_oscillator(df, len_dsl=10, rsi_len=14, mode=2):
    """DSL Oscillator: RSI -> DSL lines -> ZLEMA(+75) -> DSL lines -> signals."""
    close = df["close"]
    r = rsi(close, rsi_len)
    lvlu, lvld = _dsl_lines(r, len_dsl, mode)
    osc = _zlema((lvlu + lvld) / 2.0, 10) + 75.0
    level_up, level_dn = _dsl_lines(osc, 10, mode)
    up_sig = _crossover(osc, level_dn) & (osc < 130.0)
    dn_sig = _crossunder(osc, level_up) & (osc > 125.0)
    return osc, level_up, level_dn, up_sig, dn_sig
