"""
supertrend_oscillator.py — full port of LuxAlgo's "SuperTrend Oscillator"
(Pine v4, study("[LUX] SuperTrend Oscillator", "SuperOsc [LuxAlgo]")).

Original work by LuxAlgo, licensed CC BY-NC-SA 4.0
(https://creativecommons.org/licenses/by-nc-sa/4.0/). This port keeps the
attribution and the non-commercial license terms.

Engine (all causal — no lookahead):

    atr  = atr(length) * mult
    up   = hl2 + atr,   dn = hl2 - atr
    upper := src[1] < upper[1] ? min(up, upper[1]) : up
    lower := src[1] > lower[1] ? max(dn, lower[1]) : dn
    trend := src > upper[1] ? 1 : src < lower[1] ? 0 : trend[1]
    Spt   = trend * lower + (1 - trend) * upper       # active ST line
    osc   = clamp((src - Spt) / (upper - lower), -1, 1)

    alpha = osc^2 / length                            # Kaufman-style adaptivity
    ama  := nz(ama[1] + alpha * (osc - ama[1]), osc)  # adaptive signal line
    hist  = ema(osc - ama, smooth)                    # gray histogram

Drawing — every plot of the script, in order:
  * Main        — osc*100 columns; per-bar gradient colors by |osc|
                  (solid green/red in "fixed transparency" mode)
  * Histogram   — hist*100, gray area
  * Signal      — ama*100, blue above zero / purple below
  * ±80 hlines  — dashed, with the blue fill between them
  * sig points  — at osc zero-crossings, at osc*-100, inverted colors
  * conn line   — from the last ST cross (at the opposite extreme) to the
                  current bar's osc value (redrawn on the live bar, like Pine)
  * cross labels— ✓/✗ markers at ±80 (✗ = false signal, original valuewhen
                  logic: the trade in the previous direction lost money)
  * % false     — cumulative % of ST crosses that were false (optional line)

The module is DYNAMIC: the frontend recomputes it as-of the current replay
bar, so the connection line and stats behave exactly like the live Pine bar
would. All math is causal — no lookahead.
"""

import numpy as np
import pandas as pd

from ._common import atr

NAME = "SuperTrend Oscillator"
PANE = "stosc"

DYNAMIC = True  # frontend recomputes as-of the replay position (conn line)

PARAMS = [
    {"key": "length",   "label": "ST Length",                  "type": "int",   "default": 10, "min": 1, "max": 1000},
    {"key": "mult",     "label": "ST Multiplier",              "type": "float", "default": 2.0, "min": 1, "max": 20, "step": 0.1},
    {"key": "smooth",   "label": "Histogram Smoothing",        "type": "int",   "default": 72, "min": 1, "max": 1000},
    {"key": "fixed",    "label": "Fixed Transparency (0/1)",   "type": "int",   "default": 0,  "min": 0, "max": 1, "step": 1},
    {"key": "show_ln",  "label": "Show Lines (0/1)",           "type": "int",   "default": 1,  "min": 0, "max": 1, "step": 1},
    {"key": "show_lb",  "label": "Show Labels (0/1)",          "type": "int",   "default": 1,  "min": 0, "max": 1, "step": 1},
    {"key": "show_per", "label": "Show % False Signals (0/1)", "type": "int",   "default": 0,  "min": 0, "max": 1, "step": 1},
]

_UP_RGB = (12, 181, 26)   # #0cb51a
_DN_RGB = (255, 17, 0)    # #ff1100
_UP_COLOR = "#0cb51a"
_DN_COLOR = "#ff1100"
_HIST_RGBA = "rgba(128,128,128,0.60)"       # #808080 @ transp 40
_FILL_RGBA = "rgba(33,87,243,0.10)"         # #2157f3 @ transp 90
_LV_RGBA = "rgba(33,87,243,0.45)"
_GRAY = "#808080"


def compute(df, p=None):
    p = p or {}
    length = int(p.get("length", 10))
    mult = float(p.get("mult", 2.0))
    smooth = int(p.get("smooth", 72))
    fixed = int(p.get("fixed", 0)) >= 1
    show_ln = int(p.get("show_ln", 1)) >= 1
    show_lb = int(p.get("show_lb", 1)) >= 1
    show_per = int(p.get("show_per", 0)) >= 1

    src_v = df["close"].to_numpy(dtype=float)
    n = len(df)

    atr_mult = atr(df["high"], df["low"], df["close"], length).to_numpy(dtype=float) * mult
    hl2 = (df["high"].to_numpy(dtype=float) + df["low"].to_numpy(dtype=float)) / 2.0
    up_v = hl2 + atr_mult
    dn_v = hl2 - atr_mult

    upper = np.full(n, np.nan)
    lower = np.full(n, np.nan)
    trend = np.full(n, np.nan)  # nan until the first band cross (Pine v4 na)
    for i in range(n):
        if i == 0:
            upper[0] = up_v[0]
            lower[0] = dn_v[0]
            continue
        prev_up, prev_lo, prev_src = upper[i - 1], lower[i - 1], src_v[i - 1]
        upper[i] = min(up_v[i], prev_up) if prev_src < prev_up else up_v[i]
        lower[i] = max(dn_v[i], prev_lo) if prev_src > prev_lo else dn_v[i]
        if src_v[i] > prev_up:
            trend[i] = 1.0
        elif src_v[i] < prev_lo:
            trend[i] = 0.0
        else:
            trend[i] = trend[i - 1]

    spt = trend * lower + (1.0 - trend) * upper  # nan propagates like Pine na
    with np.errstate(invalid="ignore", divide="ignore"):
        osc = np.clip((src_v - spt) / (upper - lower), -1.0, 1.0)

    # adaptive signal line
    ama = np.full(n, np.nan)
    prev_ama = np.nan
    for i in range(n):
        o = osc[i]
        if np.isnan(o):
            continue
        alpha = (o * o) / length
        prev_ama = o if np.isnan(prev_ama) else prev_ama + alpha * (o - prev_ama)
        ama[i] = prev_ama

    # histogram: ema(osc - ama), seeded on first valid value like ta.ema
    hist = np.full(n, np.nan)
    k = 2.0 / (smooth + 1.0)
    prev_h = np.nan
    for i in range(n):
        v = osc[i] - ama[i]
        if np.isnan(v):
            continue
        prev_h = v if np.isnan(prev_h) else v * k + prev_h * (1.0 - k)
        hist[i] = prev_h

    # ST cross events, false-signal stats, labels
    lab_bull_ok = np.full(n, np.nan)
    lab_bull_x = np.full(n, np.nan)
    lab_bear_ok = np.full(n, np.nan)
    lab_bear_x = np.full(n, np.nan)
    per = np.full(n, np.nan)
    last_co = np.nan
    last_cu = np.nan
    num = 0
    den = 0
    x2 = None  # bar index of the most recent ST cross
    for i in range(1, n):
        if not (np.isnan(spt[i]) or np.isnan(spt[i - 1])):
            co = src_v[i - 1] <= spt[i - 1] and src_v[i] > spt[i]
            cu = src_v[i - 1] >= spt[i - 1] and src_v[i] < spt[i]
            if co:
                last_co = src_v[i]
            if cu:
                last_cu = src_v[i]
            if co or cu:
                both = (not np.isnan(last_co)) and (not np.isnan(last_cu))
                false_buy = both and last_cu < last_co
                false_sell = both and last_co > last_cu
                den += 1
                if false_buy or false_sell:
                    num += 1
                x2 = i
                if show_lb:
                    if co:
                        if false_sell:
                            lab_bull_x[i] = -80.0
                        else:
                            lab_bull_ok[i] = -80.0
                    if cu:
                        if false_buy:
                            lab_bear_x[i] = 80.0
                        else:
                            lab_bear_ok[i] = 80.0
        per[i] = (num / den * 100.0) if den > 0 else np.nan

    # sig plot: osc zero-crossings, at osc*-100, inverted colors
    sig_up = np.full(n, np.nan)  # osc crossed below 0 -> green, positive y
    sig_dn = np.full(n, np.nan)  # osc crossed above 0 -> red, negative y
    if show_ln:
        for i in range(1, n):
            if np.isnan(osc[i]) or np.isnan(osc[i - 1]):
                continue
            s_prev = 0.0 if osc[i - 1] == 0 else (1.0 if osc[i - 1] > 0 else -1.0)
            s_cur = 0.0 if osc[i] == 0 else (1.0 if osc[i] > 0 else -1.0)
            if s_cur != s_prev:
                if osc[i] > 0:
                    sig_dn[i] = osc[i] * -100.0
                elif osc[i] < 0:
                    sig_up[i] = osc[i] * -100.0

    # connection line: last ST cross -> current bar (redrawn live in Pine)
    conn = np.full(n, np.nan)
    conn_color = "#0cb51a"
    if show_ln and x2 is not None and x2 < n - 1 and not np.isnan(osc[-1]):
        s_last = 0.0 if osc[-1] == 0 else (1.0 if osc[-1] > 0 else -1.0)
        y1 = -s_last * 100.0
        y2 = osc[-1] * 100.0
        for i in range(x2, n):
            t = (i - x2) / float(n - 1 - x2)
            conn[i] = y1 + (y2 - y1) * t
        conn_color = _DN_COLOR if osc[-1] < 0 else _UP_COLOR

    # per-bar colors for the main columns (gradient by |osc|, or solid when fixed)
    colors = []
    for i in range(n):
        o = osc[i]
        if np.isnan(o):
            colors.append(None)
        elif fixed:
            colors.append("#0cb51a" if o > 0 else "#ff1100")
        else:
            q = min(99, max(0, int(round(abs(o) * 99))))
            a = q / 100.0
            rgb = _UP_RGB if o > 0 else _DN_RGB
            colors.append(f"rgba({rgb[0]},{rgb[1]},{rgb[2]},{a:.2f})")

    # signal line split by sign so each segment keeps its Pine color
    ama_pos = np.full(n, np.nan)
    ama_neg = np.full(n, np.nan)
    for i in range(n):
        a = ama[i]
        if np.isnan(a):
            continue
        if a > 0:
            ama_pos[i] = a * 100.0
        else:
            ama_neg[i] = a * 100.0
    for i in range(1, n):  # bridge sign flips so the line stays continuous
        a, prev = ama[i], ama[i - 1]
        if np.isnan(a) or np.isnan(prev):
            continue
        if a > 0 and prev <= 0:
            ama_pos[i - 1] = prev * 100.0
        elif a <= 0 and prev > 0:
            ama_neg[i - 1] = prev * 100.0

    idx = df.index
    out = {
        "sto":        {"label": "SuperOsc",    "color": "#0cb51a", "kind": "hist",  "colw": 1.0, "pane": PANE, "primary": True, "values": pd.Series(osc * 100.0, index=idx), "colors": colors},
        "sto_hist":   {"label": "Histogram",   "color": "#808080", "kind": "hist",  "colw": 1.0, "pane": PANE, "values": pd.Series(hist * 100.0, index=idx), "colors": [_HIST_RGBA if not np.isnan(hist[i]) else None for i in range(n)]},
        "sto_ama_up": {"label": "Signal",      "color": "#2157f3", "kind": "line",  "width": 1.5, "pane": PANE, "values": pd.Series(ama_pos, index=idx)},
        "sto_ama_dn": {"label": "Signal",      "color": "#673ab7", "kind": "line",  "width": 1.5, "pane": PANE, "values": pd.Series(ama_neg, index=idx)},
        "sto_fill":   {"label": "80 Fill",     "color": _FILL_RGBA, "kind": "hfill", "y1": 80.0, "y2": -80.0, "pane": PANE, "values": pd.Series(np.full(n, np.nan), index=idx)},
        "sto_lv80":   {"label": "+80",         "color": _LV_RGBA,  "kind": "line",  "width": 1, "dash": True, "pane": PANE, "values": pd.Series(80.0, index=idx)},
        "sto_lvm80":  {"label": "-80",         "color": _LV_RGBA,  "kind": "line",  "width": 1, "dash": True, "pane": PANE, "values": pd.Series(-80.0, index=idx)},
        "sto_sig_up": {"label": "Zero Cross",  "color": "#0cb51a", "kind": "marker", "pane": PANE, "values": pd.Series(sig_up, index=idx)},
        "sto_sig_dn": {"label": "Zero Cross",  "color": "#ff1100", "kind": "marker", "pane": PANE, "values": pd.Series(sig_dn, index=idx)},
        "sto_conn":   {"label": "Trend Line",  "color": conn_color, "kind": "line",  "width": 1, "pane": PANE, "values": pd.Series(conn, index=idx)},
        "sto_lab_bull_ok": {"label": "Cross \u2713",         "color": _GRAY, "kind": "marker", "pane": PANE, "values": pd.Series(lab_bull_ok, index=idx)},
        "sto_lab_bull_x":  {"label": "Cross \u2717 (false)", "color": _GRAY, "kind": "marker", "pane": PANE, "values": pd.Series(lab_bull_x, index=idx)},
        "sto_lab_bear_ok": {"label": "Cross \u2713",         "color": _GRAY, "kind": "marker", "pane": PANE, "values": pd.Series(lab_bear_ok, index=idx)},
        "sto_lab_bear_x":  {"label": "Cross \u2717 (false)", "color": _GRAY, "kind": "marker", "pane": PANE, "values": pd.Series(lab_bear_x, index=idx)},
    }
    if show_per:
        out["sto_per"] = {"label": "False Signals %", "color": _GRAY, "kind": "line", "width": 1, "dash": True, "pane": PANE, "values": pd.Series(per, index=idx)}
    return out
