"""
dynamic_deviation_levels.py — port of the "Dynamic Deviation Levels"
PineScript (v6, overlay=true) to the bar-replay indicator framework.

Original math:

    atr_dlevel = ta.atr(200)
    mid_dlevel = ta.hma(ta.median(hl2, len*2), 10)

    midN  = mid_dlevel + atr_dlevel * mult * N      # upper levels, N = 1..3
    mid_N = mid_dlevel - atr_dlevel * mult * N      # lower levels, N = 1..3

where hl2 = (high + low) / 2. The Pine script plots only the mid line by
default (its "Deviation Levels" input reveals the bands), and so does this
port: the mid line always renders, the six deviation levels render when the
`show_dev` parameter is set to 1 in the ⚙ settings dialog.
"""

from ._common import atr, hma, median

NAME = "Dynamic Deviation Levels"
PANE = "overlay"

PARAMS = [
    {"key": "len",      "label": "Length",                       "type": "int",   "default": 50,  "min": 2,   "max": 500},
    {"key": "mult",     "label": "Multiplier",                   "type": "float", "default": 3.0, "min": 0.1, "max": 20,  "step": 0.1},
    {"key": "show_dev", "label": "Show deviation levels (0/1)",  "type": "int",   "default": 0,   "min": 0,   "max": 1,   "step": 1},
]

_DEV_COLOR = "rgba(230,237,243,0.30)"  # chart foreground, faded (like chart.fg_color @ 70 transp)


def compute(df, p=None):
    p = p or {}
    length = int(p.get("len", 50))
    mult = float(p.get("mult", 3.0))
    show_dev = int(p.get("show_dev", 0)) >= 1

    high, low = df["high"], df["low"]
    close = df["close"]
    hl2 = (high + low) / 2.0

    atr_dlevel = atr(high, low, close, 200)
    mid_dlevel = hma(median(hl2, length * 2), 10)

    out = {
        "ddl_mid": {
            "label": f"DDL mid ({length}, {mult:g})",
            "color": "#02ffff",  # color.rgb(2, 255, 255) from the Pine source
            "kind": "line",
            "width": 2,
            "pane": "overlay",
            "primary": True,
            "values": mid_dlevel,
        },
    }

    if show_dev:
        for k in (1, 2, 3):
            out[f"ddl_up{k}"] = {
                "label": f"Level +{k}",
                "color": _DEV_COLOR,
                "kind": "line",
                "width": 1,
                "dash": True,
                "pane": "overlay",
                "values": mid_dlevel + atr_dlevel * mult * k,
            }
            out[f"ddl_dn{k}"] = {
                "label": f"Level -{k}",
                "color": _DEV_COLOR,
                "kind": "line",
                "width": 1,
                "dash": True,
                "pane": "overlay",
                "values": mid_dlevel - atr_dlevel * mult * k,
            }

    return out
