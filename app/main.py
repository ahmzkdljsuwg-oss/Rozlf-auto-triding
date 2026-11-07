from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .api import engine, router
from .db import db


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.add_log("info", "app", f"{config.APP_NAME} {config.APP_VERSION} started")
    yield
    try:
        engine.stop()
    finally:
        db.add_log("info", "app", "application shutdown")


app = FastAPI(title=config.APP_NAME, version=config.APP_VERSION, lifespan=lifespan)
app.include_router(router)
app.mount("/static", StaticFiles(directory=str(config.BASE_DIR / "app" / "static")), name="static")


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def index():
    return FileResponse(config.BASE_DIR / "app" / "static" / "index.html")


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(config.BASE_DIR / "app" / "static" / "manifest.webmanifest")


@app.get("/favicon.svg")
def favicon():
    return FileResponse(config.BASE_DIR / "app" / "static" / "favicon.svg")
