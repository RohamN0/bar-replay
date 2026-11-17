from ._common import bollinger

NAME = "Bollinger Bands"
PANE = "overlay"

PARAMS = [
    {"key": "length", "label": "Length",            "type": "int",   "default": 20, "min": 2,   "max": 1000, "step": 1},
    {"key": "mult",   "label": "StdDev multiplier", "type": "float", "default": 2.0, "min": 0.1, "max": 10,  "step": 0.1},
]


def compute(df, p=None):
    p = p or {}
    length = int(p.get("length", 20))
    mult = float(p.get("mult", 2.0))
    mid, upper, lower = bollinger(df["close"], length, mult)
    return {
        "bb_mid":   {"label": f"BB {length}, {mult:g}", "color": "rgba(180,160,255,0.50)", "kind": "line", "width": 1, "dash": True, "pane": "overlay", "primary": True, "values": mid},
        "bb_upper": {"label": "BB Upper",               "color": "rgba(180,160,255,0.75)", "kind": "line", "width": 1, "dash": True, "pane": "overlay", "values": upper},
        "bb_lower": {"label": "BB Lower",               "color": "rgba(180,160,255,0.75)", "kind": "line", "width": 1, "dash": True, "pane": "overlay", "values": lower},
    }
