"""
run.py — reliable launcher for the bar-replay Flask app.

Some Python distributions (e.g. embedded/safe-path builds) do not put the
script's own directory on sys.path, which breaks `import data_fetcher` when
running `python app.py` directly. This launcher inserts the project directory
explicitly, then runs app.py as __main__ — works with any Python.

Usage:
    python run.py
"""

import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

runpy.run_path(os.path.join(HERE, "app.py"), run_name="__main__")
