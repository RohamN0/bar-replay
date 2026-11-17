"""
app.py — Flask server for the bar-replay platform.

Run:
    pip install -r requirements.txt
    python app.py
then open http://127.0.0.1:5000

Endpoints:
    GET /                -> replay UI (web/index.html)
    GET /api/indicators  -> list of available indicators (discovered from indicators/)
    GET /api/ohlcv       -> OHLCV candles + computed indicator series as JSON
        ?symbol=BTC/USDT&timeframe=1h&limit=500&exchange=auto
        (exchange=auto tries binance, okx, kraken, bybit, coinbase in order)
"""

import json
import math
import os

import numpy as np
from flask import Flask, jsonify, request, send_from_directory

from data_fetcher import fetch_ohlcv, synthetic_ohlcv
from indicators import available, clean_params, compute_all

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")

# static_url_path="" serves web/style.css & web/app.js at the site root,
# which matches the relative references used inside index.html.
app = Flask(__name__, static_folder=WEB_DIR, static_url_path="")


def _clean(series):
    """Series -> list of floats, NaN/inf -> None (null in JSON)."""
    v = series.replace([np.inf, -np.inf], np.nan)
    out = []
    for x in v:
        if x is None or (isinstance(x, float) and math.isnan(x)):
            out.append(None)
        else:
            out.append(round(float(x), 8))
    return out


def _to_payload(df, params_by_id=None):
    computed = compute_all(df, params_by_id)  # {series_key: {label,color,kind,width,dash,pane,group,values}}
    df = df.reset_index(drop=True)

    bars = []
    for i in range(len(df)):
        bars.append({
            "time": int(df.loc[i, "timestamp"]) // 1000,  # seconds (chart convention)
            "open": round(float(df.loc[i, "open"]), 8),
            "high": round(float(df.loc[i, "high"]), 8),
            "low": round(float(df.loc[i, "low"]), 8),
            "close": round(float(df.loc[i, "close"]), 8),
            "volume": round(float(df.loc[i, "volume"]), 8),
        })

    indicators = {}
    for key, meta in computed.items():
        indicators[key] = {
            "group": meta["group"],
            "label": meta["label"],
            "color": meta["color"],
            "kind": meta["kind"],
            "width": meta.get("width", 1.5),
            "dash": bool(meta.get("dash", False)),
            "pane": meta["pane"],
            "primary": bool(meta.get("primary", False)),
            "colw": meta.get("colw", 0.7),
            "colors": meta.get("colors"),
            "y1": meta.get("y1"),
            "y2": meta.get("y2"),
            "values": _clean(meta["values"].reset_index(drop=True)),
        }

    return {
        "bars": bars,
        "indicators": indicators,
        "indicator_list": available(),
        "count": len(bars),
    }


@app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/api/indicators")
def api_indicators():
    return jsonify({"indicators": available()})


def _parse_params_arg(raw):
    """?params=<urlencoded JSON> -> safe {indicator_id: {key: number}} or {}.

    Anything malformed is ignored (the frontend only ever sends well-formed
    JSON; the server clamps every value to the indicator's declared range
    in clean_params, so this just needs to be crash-proof).
    """
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    out = {}
    for ind_id, pdict in data.items():
        if isinstance(pdict, dict):
            out[str(ind_id)] = pdict
    return out


@app.route("/api/ohlcv")
def api_ohlcv():
    symbol = request.args.get("symbol", "BTC/USDT")
    timeframe = request.args.get("timeframe", "1h")
    limit = max(20, min(int(request.args.get("limit", 500)), 3000))
    exchange = request.args.get("exchange", "auto")
    params_by_id = _parse_params_arg(request.args.get("params"))

    df, err, used_exchange = fetch_ohlcv(symbol, timeframe, limit, exchange)
    if df is None:
        df = synthetic_ohlcv(limit, symbol=symbol, timeframe=timeframe)
        source = "synthetic-fallback"
        note = err
    else:
        source = f"ccxt:{used_exchange}"
        note = None

    payload = _to_payload(df, params_by_id)
    payload["source"] = source
    payload["error"] = note
    payload["symbol"] = symbol
    payload["timeframe"] = timeframe
    return jsonify(payload)


if __name__ == "__main__":
    # HOST / PORT / FLASK_DEBUG env vars let the same file run unchanged in
    # Docker (HOST=0.0.0.0, FLASK_DEBUG=0) while keeping the local defaults.
    app.run(
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "5000")),
        debug=os.getenv("FLASK_DEBUG", "1").lower() not in ("0", "false", "no"),
    )
