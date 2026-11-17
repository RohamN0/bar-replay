"""
Indicator registry — discovers every indicator module in this package.

Each indicator module exposes:
    NAME : str              — display name in the chart's indicator picker
    PANE : str              — "overlay" (price pane) or a named pane key
    PARAMS : list           — OPTIONAL parameter spec for the settings dialog:
                              [{"key": "length", "label": "Length", "type": "int",
                                "default": 14, "min": 2, "max": 1000, "step": 1}, ...]
    compute(df) -> dict     — modules without PARAMS
    compute(df, p) -> dict  — modules with PARAMS; p is a clean {key: value} dict
                              (defaults filled, values clamped to [min, max])
                          series key -> metadata dict:
        {
          "label":  str,            # legend / tooltip label
          "color":  str,            # CSS color
          "kind":   "line"|"hist"|"marker",
          "width":  float,          # line width (default 1.5)
          "dash":   bool,           # dashed line (default False)
          "pane":   str,            # "overlay" or pane key
          "primary": bool,          # OPTIONAL — the series shown in the legend readout
          "values": pd.Series,      # aligned to df
        }

To add a new indicator: drop a file here that follows that contract and
restart the server — it is discovered and listed automatically. Declaring a
PARAMS list is enough for the browser's ⚙ settings dialog to appear on the
indicator's chip; parameters then recompute server-side on every change.
"""

import importlib
import os
import pkgutil

_INDICATORS = {}  # id -> module


def discover():
    """Import all indicator modules in this package. Returns sorted ids."""
    if _INDICATORS:
        return sorted(_INDICATORS)
    pkg_dir = os.path.dirname(os.path.abspath(__file__))
    for mod in pkgutil.iter_modules([pkg_dir]):
        if mod.name.startswith("_"):
            continue
        m = importlib.import_module(f"{__name__}.{mod.name}")
        if hasattr(m, "NAME") and callable(getattr(m, "compute", None)):
            _INDICATORS[mod.name] = m
    return sorted(_INDICATORS)


def _param_spec(mod):
    """Sanitize a module's PARAMS into JSON-safe dicts (defaults filled)."""
    spec = getattr(mod, "PARAMS", None) or []
    out = []
    for p in spec:
        ptype = p.get("type", "int")
        if ptype not in ("int", "float"):
            ptype = "int"
        try:
            default = int(p["default"]) if ptype == "int" else float(p["default"])
        except (KeyError, TypeError, ValueError):
            continue  # malformed param entry — skip rather than break the API
        step = p.get("step", 1 if ptype == "int" else 0.1)
        out.append({
            "key": str(p.get("key", "")),
            "label": str(p.get("label", p.get("key", ""))),
            "type": ptype,
            "default": default,
            "min": p.get("min"),
            "max": p.get("max"),
            "step": step,
        })
    return out


def clean_params(mod, raw):
    """Merge user params onto the defaults, clamping to [min, max].

    `raw` may be anything that arrived over the wire; values that cannot be
    interpreted as numbers fall back to the default.
    """
    spec = _param_spec(mod)
    if not spec:
        return {}
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for p in spec:
        v = p["default"]
        if p["key"] in raw:
            try:
                x = float(raw[p["key"]])
                if p["min"] is not None:
                    x = max(p["min"], x)
                if p["max"] is not None:
                    x = min(p["max"], x)
                v = int(round(x)) if p["type"] == "int" else float(x)
            except (TypeError, ValueError):
                pass
        out[p["key"]] = v
    return out


def available():
    """Metadata for the UI picker: [{id, name, pane, params, dynamic}]."""
    discover()
    return [
        {
            "id": i,
            "name": _INDICATORS[i].NAME,
            "pane": _INDICATORS[i].PANE,
            "params": _param_spec(_INDICATORS[i]),
            # DYNAMIC modules repaint: the frontend recomputes them as-of the
            # current replay bar so replay differs from the long-term view.
            "dynamic": bool(getattr(_INDICATORS[i], "DYNAMIC", False)),
        }
        for i in sorted(_INDICATORS)
    ]


def compute_all(df, params_by_id=None):
    """Run every indicator; return flattened {series_key: meta} (with values).

    params_by_id: {indicator_id: {param_key: value}} — user overrides coming
    from the browser settings dialog. Indicators without PARAMS ignore it;
    unknown indicator ids and out-of-range values are safely ignored/clamped.
    """
    discover()
    params_by_id = params_by_id if isinstance(params_by_id, dict) else {}
    out = {}
    for ind_id in sorted(_INDICATORS):
        m = _INDICATORS[ind_id]
        if _param_spec(m):
            res = m.compute(df, clean_params(m, params_by_id.get(ind_id)))
        else:
            res = m.compute(df)
        for key, meta in res.items():
            item = dict(meta)
            item["group"] = ind_id  # which indicator this series belongs to
            out[key] = item
    return out
