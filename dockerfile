# bar-replay — Flask server + candlestick replay UI
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=5000 \
    FLASK_DEBUG=0

WORKDIR /app

# Dependencies first so code edits don't bust the pip layer cache
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py run.py data_fetcher.py ./
COPY indicators/ indicators/
COPY web/ web/

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/api/indicators', timeout=4)" || exit 1

CMD ["python", "run.py"]
