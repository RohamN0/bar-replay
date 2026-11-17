from ._common import supertrend

NAME = "SuperTrend"
PANE = "overlay"

PARAMS = [
    {"key": "length", "label": "ATR length", "type": "int",   "default": 10, "min": 1,   "max": 1000, "step": 1},
    {"key": "mult",   "label": "Multiplier", "type": "float", "default": 3.0, "min": 0.1, "max": 20,  "step": 0.1},
]


def compute(df, p=None):
    p = p or {}
    length = int(p.get("length", 10))
    mult = float(p.get("mult", 3.0))
    st_line, _direction = supertrend(df["high"], df["low"], df["close"], length, mult)
    return {
        "supertrend": {"label": f"SuperTrend {length},{mult:g}", "color": "#ff9800", "kind": "line", "width": 1.5, "pane": "overlay", "primary": True, "values": st_line},
    }
