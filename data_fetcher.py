"""
data_fetcher.py — pull OHLCV candles from crypto exchanges via ccxt.

ccxt (https://github.com/ccxt/ccxt) is the standard Python library for
crypto market data: one API for 100+ exchanges (Binance, Coinbase, Bybit,
Kraken, OKX, ...). Binance is tried first because public OHLCV needs no key;
if it is unreachable (geo-block, DNS, firewall) we automatically fall back
to other exchanges, so the chart still gets live data.

Also provides a deterministic offline generator so the replay tool works
even with no internet / no ccxt installed. The generated data varies by
symbol + timeframe so switching inputs always visibly changes the chart.
"""

import json
import os
import time
import zlib

import numpy as np
import pandas as pd

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
CACHE_TTL_SECONDS = 60  # re-fetch live data after this many seconds

# Tried in order; first exchange that answers wins. The tail of the list
# holds smaller exchanges that are often reachable even when the majors are
# geo-blocked (bigone/gateio/bitmart answered from restricted networks).
DEFAULT_EXCHANGES = [
    "binance", "okx", "kraken", "bybit", "coinbase",
    "bigone", "gateio", "bitmart",
]
EXCHANGE_TIMEOUT_MS = 8000  # per-attempt ceiling (8 s); failures usually return faster

# Smart-fallback state: exchanges that failed recently are skipped for a
# while, and the last exchange that actually served data is tried first.
# This keeps repeat loads fast on networks where only some exchanges work.
_FAIL_COOLDOWN = {}   # exchange_id -> timestamp of last failure
_SUCCESS_ORDER = []   # recently successful exchanges, tried first
_FAIL_COOLDOWN_SECONDS = 300


def _ranked_candidates(requested):
    if requested not in (None, "", "auto"):
        return [requested]
    ranked = [e for e in _SUCCESS_ORDER if e in DEFAULT_EXCHANGES]
    ranked += [e for e in DEFAULT_EXCHANGES if e not in ranked]
    now = time.time()
    active = [e for e in ranked if now - _FAIL_COOLDOWN.get(e, 0) > _FAIL_COOLDOWN_SECONDS]
    return active or ranked


def _cache_path(exchange_id, symbol, timeframe, limit):
    os.makedirs(CACHE_DIR, exist_ok=True)
    sym = symbol.replace("/", "").replace(":", "")
    return os.path.join(CACHE_DIR, f"{exchange_id}_{sym}_{timeframe}_{limit}.json")


def _load_cache(path):
    if not os.path.exists(path):
        return None
    if time.time() - os.path.getmtime(path) > CACHE_TTL_SECONDS:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _save_cache(path, records):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(records, f)
    except Exception:
        pass


def fetch_ohlcv(symbol="BTC/USDT", timeframe="1h", limit=500, exchange_id="auto"):
    """Return (DataFrame, error_message, used_exchange_id).

    DataFrame columns: timestamp(ms), open, high, low, close, volume.
    exchange_id="auto" tries DEFAULT_EXCHANGES in order; the first one that
    returns data wins. On total failure returns (None, error_message, "none").
    """
    try:
        import ccxt
    except ImportError:
        return None, "ccxt is not installed — run: pip install ccxt", "none"

    last_err = None
    for eid in _ranked_candidates(exchange_id):
        path = _cache_path(eid, symbol, timeframe, limit)
        cached = _load_cache(path)
        if cached is not None:
            if eid not in _SUCCESS_ORDER:
                _SUCCESS_ORDER.insert(0, eid)
            return pd.DataFrame(cached), None, eid

        try:
            exchange = getattr(ccxt, eid)({
                "enableRateLimit": True,
                "timeout": EXCHANGE_TIMEOUT_MS,
            })
            raw = exchange.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
        except Exception as e:  # try the next exchange
            _FAIL_COOLDOWN[eid] = time.time()
            last_err = f"{type(e).__name__} on {eid}: {e}"
            continue

        if not raw:
            _FAIL_COOLDOWN[eid] = time.time()
            last_err = f"{eid}: exchange returned no data"
            continue

        if eid in _SUCCESS_ORDER:
            _SUCCESS_ORDER.remove(eid)
        _SUCCESS_ORDER.insert(0, eid)
        df = pd.DataFrame(raw, columns=["timestamp", "open", "high", "low", "close", "volume"])
        _save_cache(path, df.to_dict(orient="records"))
        return df, None, eid

    return None, last_err or "all exchanges failed", "none"


def _timeframe_seconds(timeframe):
    """'1m'->60, '15m'->900, '1h'->3600, '4h'->14400, '1d'->86400, '1w'->604800."""
    tf = str(timeframe).lower().strip()
    try:
        if tf.endswith("m"):
            return max(60, int(tf[:-1]) * 60)
        if tf.endswith("h"):
            return max(3600, int(tf[:-1]) * 3600)
        if tf.endswith("d"):
            return max(86400, int(tf[:-1]) * 86400)
        if tf.endswith("w"):
            return max(604800, int(tf[:-1]) * 604800)
    except ValueError:
        pass
    return 3600  # default: 1h candles


def synthetic_ohlcv(limit=500, symbol="BTC/USDT", timeframe="1h"):
    """Deterministic offline demo data — random walk with volatility
    clustering. The seed derives from symbol + timeframe, so different
    symbols/timeframes produce visibly different candles (and the same
    input always produces the same series, so replay stays stable)."""
    seed = zlib.crc32(f"{symbol}:{timeframe}".encode("utf-8"))
    rng = np.random.default_rng(seed)
    step = _timeframe_seconds(timeframe)
    now = int(time.time()) // step * step
    start_price = 1000.0 + (seed % 200000)  # symbol-dependent base price

    price = start_price
    vol_state = 1.0
    rows = []
    for i in range(limit):
        vol_state = 0.95 * vol_state + 0.05 * rng.uniform(0.4, 2.4)
        drift = np.sin(i / 37.0 + (seed % 10)) * 0.0012
        ret = rng.normal(drift, 0.008 * vol_state)
        open_ = price
        close = max(0.01, price * (1.0 + ret))
        hi = max(open_, close) * (1.0 + abs(rng.normal(0, 0.004 * vol_state)))
        lo = min(open_, close) * (1.0 - abs(rng.normal(0, 0.004 * vol_state)))
        volume = abs(rng.normal(1.0, 0.35 * vol_state)) * 1000.0
        ts = (now - (limit - i) * step) * 1000
        rows.append([ts, open_, hi, lo, close, volume])
        price = close

    return pd.DataFrame(rows, columns=["timestamp", "open", "high", "low", "close", "volume"])
