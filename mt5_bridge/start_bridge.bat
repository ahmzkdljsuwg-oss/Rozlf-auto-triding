@echo off
if "%MT5_BRIDGE_TOKEN%"=="" echo MT5_BRIDGE_TOKEN is not set & exit /b 1
if "%MT5_BRIDGE_SECRET%"=="" echo MT5_BRIDGE_SECRET is not set & exit /b 1
.venv\Scripts\python -m uvicorn bridge:app --host 127.0.0.1 --port 8787
