FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY eo_bridge/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY eo_bridge ./eo_bridge

EXPOSE 8080
CMD ["uvicorn", "eo_bridge.app:app", "--host", "0.0.0.0", "--port", "8080"]
