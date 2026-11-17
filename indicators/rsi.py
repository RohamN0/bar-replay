import pandas as pd

from ._common import rsi

NAME = "RSI"
PANE = "rsi"

PARAMS = [
    {"key": "length", "label": "RSI length", "type": "int",   "default": 14, "min": 2, "max": 1000},
    {"key": "ob",     "label": "Overbought", "type": "float", "default": 70, "min": 50, "max": 100, "step": 1},
    {"key": "os",     "label": "Oversold",   "type": "float", "default": 30, "min": 0,  "max": 50,  "step": 1},
]


def compute(df, p=None):
    p = p or {}
    length = int(p.get("length", 14))
    ob = float(p.get("ob", 70))
    os_ = float(p.get("os", 30))
    idx = df.index
    return {
        "rsi":    {"label": f"RSI {length}",       "color": "#ffb74d",                "kind": "line", "width": 1.5, "pane": "rsi", "primary": True, "values": rsi(df["close"], length)},
        "rsi_ob": {"label": f"Overbought {ob:g}",  "color": "rgba(139,152,169,0.55)", "kind": "line", "width": 1,   "dash": True, "pane": "rsi", "values": pd.Series(ob, index=idx)},
        "rsi_os": {"label": f"Oversold {os_:g}",   "color": "rgba(139,152,169,0.55)", "kind": "line", "width": 1,   "dash": True, "pane": "rsi", "values": pd.Series(os_, index=idx)},
    }
