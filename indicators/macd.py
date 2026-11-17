from ._common import macd

NAME = "MACD"
PANE = "macd"

PARAMS = [
    {"key": "fast",   "label": "Fast length",   "type": "int", "default": 12, "min": 1, "max": 1000},
    {"key": "slow",   "label": "Slow length",   "type": "int", "default": 26, "min": 1, "max": 1000},
    {"key": "signal", "label": "Signal length", "type": "int", "default": 9,  "min": 1, "max": 1000},
]


def compute(df, p=None):
    p = p or {}
    f = int(p.get("fast", 12))
    s = int(p.get("slow", 26))
    sig = int(p.get("signal", 9))
    line, signal, hist = macd(df["close"], f, s, sig)
    return {
        "macd":        {"label": f"MACD {f} {s} {sig}", "color": "#4aa3ff", "kind": "line", "width": 1.5, "pane": "macd", "primary": True, "values": line},
        "macd_signal": {"label": "Signal",              "color": "#ff7043", "kind": "line", "width": 1.5, "pane": "macd", "values": signal},
        "macd_hist":   {"label": "Histogram",           "color": "#26a69a", "kind": "hist",               "pane": "macd", "values": hist},
    }
