from ._common import ema

NAME = "EMA"
PANE = "overlay"

PARAMS = [
    {"key": "len1", "label": "Fast length",   "type": "int", "default": 9,  "min": 2, "max": 1000},
    {"key": "len2", "label": "Middle length", "type": "int", "default": 21, "min": 2, "max": 1000},
    {"key": "len3", "label": "Slow length",   "type": "int", "default": 50, "min": 2, "max": 1000},
]


def compute(df, p=None):
    p = p or {}
    l1 = int(p.get("len1", 9))
    l2 = int(p.get("len2", 21))
    l3 = int(p.get("len3", 50))
    close = df["close"]
    return {
        "ema_fast": {"label": f"EMA {l1}", "color": "#f5c542", "kind": "line", "width": 1.5, "pane": "overlay", "primary": True, "values": ema(close, l1)},
        "ema_mid":  {"label": f"EMA {l2}", "color": "#4aa3ff", "kind": "line", "width": 1.5, "pane": "overlay", "values": ema(close, l2)},
        "ema_slow": {"label": f"EMA {l3}", "color": "#c084fc", "kind": "line", "width": 1.5, "pane": "overlay", "values": ema(close, l3)},
    }
