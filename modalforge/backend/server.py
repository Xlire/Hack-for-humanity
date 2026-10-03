"""ModalForge web server: serves the HTML app and runs Allsolve simulations as background jobs.

Run:  python -m uvicorn backend.server:app --port 8000      (from the modalforge folder)
"""

from __future__ import annotations

import json
import threading
import time
import traceback
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .model import ROOT, build_spec
from .settings import SDK_AVAILABLE, credentials, make_client

FRONTEND = ROOT / "frontend"
CACHE = ROOT / "cache"
RESULTS = CACHE / "results"
RESULTS.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="ModalForge", docs_url="/api/docs")

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_run_lock = threading.Lock()  # one cloud run at a time (a project key shares one project)


# ---------------------------------------------------------------- status & API key -----------

@app.get("/api/status")
def status():
    return credentials.public_status()


@app.post("/api/status/reload")
def reload_keys():
    credentials.reload()
    return credentials.public_status()


@app.post("/api/status/test")
def test_connection():
    credentials.reload()
    if not SDK_AVAILABLE:
        return {"ok": False, "message": "The allsolve Python package is not installed. Run: pip install -r requirements.txt"}
    if not credentials.configured:
        return {"ok": False, "message": "No API key in .env yet."}
    try:
        client = make_client()
        kind = "project key (reuses one project)" if client.is_project_api_key() else "organization key"
        quota = None
        try:
            import allsolve

            quota = str(allsolve.get_quota())[:300]
        except Exception:
            pass
        return {"ok": True, "message": f"Connected to Allsolve with a {kind}.", "keyType": kind, "quota": quota}
    except Exception as exc:
        return {"ok": False, "message": f"Allsolve rejected the connection: {exc}"}


# ---------------------------------------------------------------- simulations ---------------

@app.post("/api/simulations")
def start_simulation(req: dict):
    try:
        spec = build_spec(req)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    key = spec.cache_key()
    cached = RESULTS / f"{key}.json"
    if cached.exists() and not req.get("fresh"):
        result = json.loads(cached.read_text(encoding="utf-8"))
        result.setdefault("meta", {})["fromCache"] = True
        return {"status": "done", "key": key, "result": result}

    if not SDK_AVAILABLE:
        raise HTTPException(503, "The allsolve Python package is not installed on the server.")
    if not credentials.configured:
        raise HTTPException(401, "Allsolve API key missing. Add it to .env and press Reload keys.")

    with _lock:  # one live cloud job per configuration
        for jid, job in _jobs.items():
            if job["key"] == key and job["status"] == "running":
                return {"status": "running", "jobId": jid, "key": key}
        job_id = uuid.uuid4().hex[:10]
        _jobs[job_id] = {
            "status": "running", "key": key, "stage": "Queued", "progress": 0.0,
            "logs": [], "startedAt": time.time(), "result": None, "error": None,
        }
    threading.Thread(target=_run_job, args=(job_id, spec), daemon=True).start()
    return {"status": "running", "jobId": job_id, "key": key}


@app.post("/api/lookup")
def lookup(req: dict):
    """Saved Allsolve result for this exact floor, if one exists. Never starts a cloud job."""
    try:
        spec = build_spec(req)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    cached = RESULTS / f"{spec.cache_key()}.json"
    if not cached.exists():
        raise HTTPException(404, "No saved result")
    result = json.loads(cached.read_text(encoding="utf-8"))
    result.setdefault("meta", {})["fromCache"] = True
    return {"key": spec.cache_key(), "result": result}


@app.get("/api/simulations/{job_id}")
def job_status(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Unknown job")
    return {
        "status": job["status"], "stage": job["stage"], "progress": round(job["progress"], 3),
        "logs": job["logs"][-14:], "elapsedS": round(time.time() - job["startedAt"], 1),
        "result": job["result"], "error": job["error"],
    }


@app.get("/api/results")
def list_results():
    items = []
    for f in sorted(RESULTS.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:30]:
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
            items.append({"key": f.stem, "spec": r.get("spec"), "computedAt": r.get("meta", {}).get("computedAt"),
                          "modes": len(r.get("modes", []))})
        except Exception:
            continue
    return items


def _run_job(job_id: str, spec) -> None:
    from .allsolve_runner import run_floor_modes

    job = _jobs[job_id]

    def progress(stage: str, frac: float, line: str | None) -> None:
        job["stage"] = stage
        job["progress"] = max(job["progress"], min(frac, 1.0))
        if line:
            job["logs"].append(f"{time.strftime('%H:%M:%S')}  {line[:180]}")

    try:
        if _run_lock.locked():
            progress("Waiting for the previous run to finish", 0.0, None)
        with _run_lock:
            result = run_floor_modes(spec, progress, CACHE)
        (RESULTS / f"{spec.cache_key()}.json").write_text(json.dumps(result), encoding="utf-8")
        job["result"] = result
        job["status"] = "done"
    except Exception as exc:
        job["error"] = str(exc)
        job["logs"].append(traceback.format_exc().splitlines()[-1][:200])
        job["status"] = "error"


# ---------------------------------------------------------------- static app -----------------

@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND), name="static")
