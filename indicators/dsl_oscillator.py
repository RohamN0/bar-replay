from ._common import dsl_oscillator

NAME = "DSL Oscillator"
PANE = "dsl"

PARAMS = [
    {"key": "len_dsl", "label": "DSL length", "type": "int",   "default": 10, "min": 2,   "max": 1000, "step": 1},
    {"key": "rsi_len", "label": "RSI length", "type": "int",   "default": 14, "min": 2,   "max": 1000, "step": 1},
    {"key": "mode",    "label": "DSL mode",   "type": "float", "default": 2,  "min": 0.1, "max": 20,  "step": 0.1},
]


def compute(df, p=None):
    p = p or {}
    len_dsl = int(p.get("len_dsl", 10))
    rsi_len = int(p.get("rsi_len", 14))
    mode = float(p.get("mode", 2))
    osc, level_up, level_dn, up_sig, dn_sig = dsl_oscillator(df, len_dsl, rsi_len, mode)
    return {
        "dsl_osc":      {"label": "DSL Osc",  "color": "#26c6da",                "kind": "line",   "width": 2,   "pane": "dsl", "primary": True, "values": osc},
        "dsl_level_up": {"label": "Level Up", "color": "rgba(120,140,255,0.85)", "kind": "line",   "width": 1, "dash": True, "pane": "dsl", "values": level_up},
        "dsl_level_dn": {"label": "Level Dn", "color": "rgba(255,150,60,0.85)",  "kind": "line",   "width": 1, "dash": True, "pane": "dsl", "values": level_dn},
        "dsl_up":       {"label": "Buy",      "color": "#26a69a",                "kind": "marker",             "pane": "dsl", "values": osc.where(up_sig)},
        "dsl_dn":       {"label": "Sell",     "color": "#ef5350",                "kind": "marker",             "pane": "dsl", "values": osc.where(dn_sig)},
    }
