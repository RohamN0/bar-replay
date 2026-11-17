# Bar Replay — Crypto Candlestick Replay Tool

A platform for turning PineScript indicators into Python and replaying crypto
candles **bar by bar** (like TradingView's Bar Replay) without seeing the future.

## How it works

```
┌─────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│  data_fetcher.py    │ ──► │  indicators/          │ ──► │  app.py (Flask)      │
│  ccxt → OHLCV       │     │  one file per signal  │     │  /api/ohlcv JSON     │
│                     │     │  (auto-discovered)    │     │  /api/indicators     │
└─────────────────────┘     └──────────────────────┘     └──────────┬───────────┘
                                                                     │
                                              ┌──────────────────────▼───────────┐
                                              │  web/ (index.html + app.js)      │
                                              │  custom canvas candlestick chart  │
                                              │  + indicator picker + bar-replay │
                                              └──────────────────────────────────┘
```

1. **Fetch** — `ccxt` pulls OHLCV candles from Binance (or any of 100+ exchanges)
   with a 60-second local cache.
2. **Indicators** — each indicator lives as its own file in `indicators/` and is
   **auto-discovered** (pandas/numpy, causal — no lookahead).
3. **Replay + picker** — the browser lists every discovered indicator as a
   toggle chip; tick the ones you want and they render (candles, EMA,
   Bollinger, RSI, MACD, your **DSL Oscillator** with buy/sell signals, and
   more). Then step or auto-play through the bars one at a time.

## Your PineScript indicator — already converted

Your `dsl-osc.txt` (DSL Oscillator) is converted in
**`indicators/dsl_oscillator.py`** — a pandas port (helpers in
`indicators/_common.py`) registered as one of the auto-discovered indicators,
so the oscillator + signals render live in the chart's DSL pane.

It implements the same math: `ta.rsi` → recursive DSL lines → ZLEMA (+75) → a
second pair of DSL lines → `color.from_gradient` + `ta.crossover`/`ta.crossunder`
signals (up when `dsl_osc < 130`, down when `dsl_osc > 125`).

## Install & run

```bash
cd bar-replay
python -m venv .venv
# Windows: .venv\Scripts\activate     macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open **http://127.0.0.1:5000**

> `python run.py` does the same thing as `python app.py` but also works with
> Python builds that don't put the script's folder on `sys.path` (embedded /
> safe-path distributions).

> No internet or no `ccxt`? The tool automatically falls back to deterministic
> offline demo data, so it works out of the box.

## Replay controls

| Control            | Action                                    |
|--------------------|-------------------------------------------|
| **▶ Play / ⏸ Pause** | Auto-advance bars at the selected speed |
| **⏮ / ⏭**         | Jump to bar 1 / jump to the latest bar    |
| **◀ / ▶**         | Step back / forward one bar               |
| **Slider**          | Scrub to any position                     |
| **Speed**           | 0.25× – 4×                                |
| **⚙ (on a chip)**   | Open the indicator's settings dialog      |
| **Space** / **←→**  | Keyboard: play/pause / step               |

The gold dashed line marks the current replay bar; only bars up to it are
revealed. Hover any candle for a crosshair + full OHLCV/indicator readout.

## Indicator settings (⚙) — TradingView-style parameters

Every indicator chip has a **⚙ gear**. Click it to open a settings dialog with
that indicator's adjustable parameters:

| Indicator        | Parameters                                    |
|------------------|-----------------------------------------------|
| EMA              | fast / middle / slow lengths                  |
| Bollinger Bands  | length, StdDev multiplier                     |
| RSI              | length, overbought / oversold levels          |
| MACD             | fast / slow / signal lengths                  |
| SuperTrend       | ATR length, multiplier                        |
| DSL Oscillator   | DSL length, RSI length, DSL mode              |
| Dynamic Deviation Levels | length, multiplier, show levels (0/1) |
| ZigZag (repaints) | reversal %                                   |
| SuperTrend Oscillator | ST length/multiplier, histogram smoothing, fixed transparency, show lines/labels, % false signals |

- **OK** applies and recomputes — server-side via
  `/api/ohlcv?...&params={"rsi":{"length":7}}` when the Python backend is
  running, or through the JS mirror in offline static-preview mode. Your
  replay position is preserved through the recompute.
- **Defaults** restores the built-in values (then press OK).
- Values are clamped to each indicator's valid range (min/max per param).
- Settings are remembered in the browser (localStorage) and re-sent on every
  fetch, so they survive reloads — like TradingView.
- Series labels follow the parameters ("RSI 14" → "RSI 7", "EMA 9" → "EMA 55", ...).

### Repainting vs non-repainting — why replay ≡ long-term (mostly)

Every indicator except the ZigZag is **causal**: bar N's value is computed
only from data up to bar N, so its bar-replay view and its long-term view are
identical — that is the non-repainting ideal.

The **ZigZag is a repainting indicator on purpose**. A swing pivot only
exists once price has reversed `dev`% from the extreme, and the developing
leg's endpoint moves with every new extreme until then. The frontend treats
it as a **dynamic** indicator (`DYNAMIC = True` in its module) and recomputes
it from `bars[0..replay_position]` at every replay step, so:

- **During replay** you see the real-time view: pivots pop in only after the
  reversal confirms, and the last leg redraws as the extreme moves.
- **The long-term view** (replay parked at the last bar, or a fresh page
  load) shows the final zigzag with every pivot placed retroactively — the
  "perfect" look that never existed in real time.

Scrub the replay back and forth and watch pivots appear/disappear: that's
repainting, and it's why live trading with such tools feels different from
reading their history.

## Run with Docker

```bash
docker compose up --build
```

then open http://localhost:5000. The compose file maps port 5000, persists
the OHLCV cache via a `./cache` volume, and runs with the debugger off
(`FLASK_DEBUG=0`, bound to `0.0.0.0`). Plain Docker works too:

```bash
docker build -t bar-replay .
docker run --rm -p 5000:5000 -v ./cache:/app/cache bar-replay
```

The container reads `HOST`, `PORT` and `FLASK_DEBUG` env vars, so you can
remap the port (`-p 8080:5000`) or put it behind a reverse proxy without
changing any code.

## Adding YOUR PineScript indicator

Drop a new file into `indicators/`. Each file declares a display `NAME`, a
`PANE` (`"overlay"` for the price pane, or any pane key for its own pane), and
a `compute(df)` that returns the series to plot:

```python
# indicators/my_indicator.py
from ._common import ema

NAME = "EMA Spread"
PANE = "overlay"

def compute(df):
    close = df["close"]
    spread = ema(close, 9) - ema(close, 21)
    return {
        "spread": {
            "label": "Spread", "color": "#7ee787",
            "kind": "line", "width": 1.5, "pane": "overlay",
            "values": spread,
        },
    }
```

Restart the server — the indicator is **discovered automatically** and appears
as a toggle chip in the chart. `kind` can be `"line"`, `"hist"`, or `"marker"`
(for signals); add `"dash": True` for a dashed line; add `"primary": True` to
the series that should show in the legend readout. Shared helpers (`ema`,
`sma`, `rma`, `rsi`, `macd`, `atr`, `bollinger`, `supertrend`, ...) live in
`indicators/_common.py` — stateful ones (SuperTrend) use an explicit loop.

#### Making it user-configurable (⚙ settings dialog)

Add a `PARAMS` list and accept a params dict in `compute` — the browser then
shows a gear on the chip and recomputes server-side when the user changes a
value:

```python
PARAMS = [
    {"key": "fast", "label": "Fast length", "type": "int", "default": 9,  "min": 2, "max": 1000},
    {"key": "slow", "label": "Slow length", "type": "int", "default": 21, "min": 2, "max": 1000},
]

def compute(df, p=None):
    p = p or {}                      # p has defaults filled + user values clamped
    fast = int(p.get("fast", 9))
    slow = int(p.get("slow", 21))
    ...
```

`type` is `"int"` or `"float"`; `min`/`max`/`step` are optional. The registry
(`indicators/__init__.py`) sanitizes everything (defaults, clamping, int/float
coercion) before it reaches `compute`.

Mapping cheat-sheet (PineScript → Python):

| PineScript                  | This project               |
|-----------------------------|----------------------------|
| `ta.sma(src, n)`            | `sma(src, n)`              |
| `ta.ema(src, n)`            | `ema(src, n)`              |
| `ta.rma(src, n)`            | `rma(src, n)`              |
| `ta.rsi(src, n)`            | `rsi(src, n)`              |
| `ta.macd(c, f, s, sig)`     | `macd(c, f, s, sig)`       |
| `ta.atr(n)`                 | `atr(h, l, c, n)`          |
| `ta.highest` / `ta.lowest`  | `highest` / `lowest`       |
| `ta.stdev(src, n)`          | `stdev(src, n)`            |

Only use **past data** (`.rolling`, `.ewm`, `.shift`) so the replay doesn't
"peek" ahead.

## Data library — why `ccxt`

`ccxt` is the de-facto standard Python library for crypto data: a single
`fetch_ohlcv(symbol, timeframe, limit)` works across Binance, Coinbase, Bybit,
Kraken, OKX, etc. Alternatives (`python-binance`, `cryptofeed`, `yfinance`)
are more limited — `ccxt` gives you every exchange from one dependency.

## Files

| File               | Purpose                                          |
|--------------------|--------------------------------------------------|
| `app.py`           | Flask server + `/api/ohlcv` + `/api/indicators` (+ `params` support) |
| `run.py`           | Launcher that works with any Python (safe-path builds included) |
| `data_fetcher.py`  | ccxt OHLCV fetch + cache + offline generator     |
| `indicators/`      | One file per indicator with `PARAMS` spec, auto-discovered (registry in `__init__.py`) |
| `web/index.html`   | Replay UI shell + settings dialog                |
| `web/app.js`       | Chart renderer + picker + replay + ⚙ settings logic |
| `web/style.css`    | Dark trading theme                               |
| `Dockerfile`       | Container image (python:3.12-slim, deps cached, healthcheck) |
| `docker-compose.yml` | One-command run with cache volume + port mapping |

## Static preview

`web/` is fully self-contained — opening `web/index.html` directly (or serving
it from any static host) works too: it falls back to synthetic data and
JS-computed indicators when the Python backend isn't reachable.
