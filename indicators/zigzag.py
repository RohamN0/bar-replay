"""
zigzag.py — deviation-based ZigZag, an intentional REPAINTING indicator.

Unlike every other indicator in this package (which is causal and never
repaints), a ZigZag is the classic repainting study:

  * A swing pivot is only CONFIRMED once price reverses by `dev` percent
    from the extreme.
  * The developing leg's endpoint keeps moving with every new extreme until
    that confirmation happens.
  * The full-history view therefore shows a "perfect" zigzag whose pivots
    were placed retroactively — a view that never existed in real time.

The bar-replay frontend marks this module DYNAMIC and recomputes it from
bars[0..replay_position] on every replay step, so:

  * during replay  -> the real-time view (pivots pop in late, last leg moves)
  * full history   -> the final, repainted zigzag

which is exactly the replay-vs-long-term difference this indicator exists to
demonstrate.
"""

import numpy as np
import pandas as pd

NAME = "ZigZag (repaints)"
PANE = "overlay"

DYNAMIC = True  # frontend recomputes this on every replay step (as-of view)

PARAMS = [
    {"key": "dev", "label": "Reversal %", "type": "float", "default": 2.0, "min": 0.1, "max": 50, "step": 0.1},
]

_LINE_COLOR = "#ff80ab"
_HIGH_COLOR = "#ef5350"                # swing high markers
_LOW_COLOR = "#26a69a"                 # swing low markers
_PEND_COLOR = "rgba(230,237,243,0.65)"  # developing (unconfirmed) endpoint


def _zigzag_nodes(high, low, dev):
    """Single-pass deviation zigzag.

    Returns (pivots, pending):
      pivots  — list of (index, price, "H"|"L") for confirmed swings
      pending — (index, price, "PH"|"PL") developing (unconfirmed) extreme
    """
    n = len(high)
    pivots = []
    if n == 0:
        return pivots, None

    direction = 0  # 0 undetermined, +1 up leg (tracking high), -1 down leg
    hi, hi_i = float(high.iloc[0]), 0
    lo, lo_i = float(low.iloc[0]), 0

    for i in range(n):
        h, l = float(high.iloc[i]), float(low.iloc[i])
        if direction >= 0 and h >= hi:
            hi, hi_i = h, i
        if direction <= 0 and l <= lo:
            lo, lo_i = l, i
        if direction >= 0 and l <= hi * (1.0 - dev):
            pivots.append((hi_i, hi, "H"))
            direction = -1
            lo, lo_i = l, i
        elif direction <= 0 and h >= lo * (1.0 + dev):
            pivots.append((lo_i, lo, "L"))
            direction = 1
            hi, hi_i = h, i

    pending = None
    if pivots:
        last_kind = pivots[-1][2]
        if direction >= 0 and last_kind == "L":
            pending = (hi_i, hi, "PH")
        elif direction <= 0 and last_kind == "H":
            pending = (lo_i, lo, "PL")
    return pivots, pending


def compute(df, p=None):
    p = p or {}
    dev_pct = float(p.get("dev", 2.0))
    dev = dev_pct / 100.0

    high, low = df["high"], df["low"]
    n = len(df)
    pivots, pending = _zigzag_nodes(high, low, dev)

    zz = np.full(n, np.nan)
    zz_up = np.full(n, np.nan)
    zz_lo = np.full(n, np.nan)
    zz_pend = np.full(n, np.nan)

    for idx, price, kind in pivots:
        if kind == "H":
            zz_up[idx] = price
        else:
            zz_lo[idx] = price
    if pending:
        zz_pend[pending[0]] = pending[1]

    nodes = pivots + ([pending] if pending else [])
    for (a_i, a_p, _), (b_i, b_p, _) in zip(nodes, nodes[1:]):
        if b_i <= a_i:
            continue
        span = np.arange(a_i, b_i + 1)
        t = (span - a_i) / float(b_i - a_i)
        zz[span] = a_p + (b_p - a_p) * t

    return {
        "zz":      {"label": f"ZigZag {dev_pct:g}%", "color": _LINE_COLOR,  "kind": "line",   "width": 2, "pane": "overlay", "primary": True, "values": pd.Series(zz, index=df.index)},
        "zz_up":   {"label": "Swing High",           "color": _HIGH_COLOR,  "kind": "marker",             "pane": "overlay", "values": pd.Series(zz_up, index=df.index)},
        "zz_lo":   {"label": "Swing Low",            "color": _LOW_COLOR,   "kind": "marker",             "pane": "overlay", "values": pd.Series(zz_lo, index=df.index)},
        "zz_pend": {"label": "Developing",           "color": _PEND_COLOR,  "kind": "marker",             "pane": "overlay", "values": pd.Series(zz_pend, index=df.index)},
    }
