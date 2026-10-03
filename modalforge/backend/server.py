"""ModalForge web server: serves the HTML app and runs Allsolve simulations as background jobs.

Run:  python -m uvicorn backend.server:app --port 8000      (from the modalforge folder)
"""

from __future__ import annotations

import json
import threading
import time
import traceback
import uuid
from dataclasses import replace
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .model import QUALITY, RESULTS_DIR, ROOT, build_spec
from .settings import SDK_AVAILABLE, credentials, make_client

FRONTEND = ROOT / "frontend"
CACHE = ROOT / "cache"
RESULTS = RESULTS_DIR
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
    cached = spec.cached_result_file()
    if cached and not req.get("fresh"):
        return {"status": "done", "key": key, "result": _load(cached)}

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
            "status": "running", "key": key, "stage": "Queued", "progress": 0.0, "quality": spec.quality,
            "logs": [], "startedAt": time.time(), "result": None, "error": None, "timings": {},
        }
    threading.Thread(target=_run_job, args=(job_id, spec), daemon=True).start()
    return {"status": "running", "jobId": job_id, "key": key}


@app.post("/api/lookup")
def lookup(req: dict):
    """Saved Allsolve result for this exact floor, if one exists. Never starts a cloud job.
    With anyQuality, falls back to the most detailed preset saved for the same floor."""
    try:
        spec = build_spec(req)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    order = [spec.quality] + ([q for q in reversed(QUALITY) if q != spec.quality] if req.get("anyQuality") else [])
    for q in order:
        alt = replace(spec, quality=q)
        cached = alt.cached_result_file()
        if cached:
            return {"key": alt.cache_key(), "quality": q, "result": _load(cached)}
    raise HTTPException(404, "No saved result")


def _load(path: Path) -> dict:
    result = json.loads(path.read_text(encoding="utf-8"))
    meta = result.setdefault("meta", {})
    meta["fromCache"] = True
    meta.setdefault("quality", "fine")  # v1 files: 100 modes, mesh for 2.5 kHz, 12 x 8 probes
    return result


@app.get("/api/simulations/{job_id}")
def job_status(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Unknown job")
    return {
        "status": job["status"], "stage": job["stage"], "progress": round(job["progress"], 3),
        "logs": job["logs"][-14:], "elapsedS": round(time.time() - job["startedAt"], 1),
        "timings": job["timings"], "quality": job["quality"],
        "result": job["result"], "error": job["error"],
    }


@app.get("/api/results")
def list_results():
    items = []
    for f in sorted(RESULTS.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:30]:
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
            meta = r.get("meta", {})
            items.append({"key": f.stem, "spec": r.get("spec"), "computedAt": meta.get("computedAt"),
                          "modes": len(r.get("modes", [])), "variant": meta.get("variant", "floor"),
                          "quality": meta.get("quality", "fine"), "timings": meta.get("timings"),
                          "meshScale": meta.get("meshScale", 1.0), "meshMaxSize": meta.get("meshMaxSize"),
                          "simulationId": meta.get("simulationId")})
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
        t_wait = time.time()
        with _run_lock:
            if time.time() - t_wait > 1:
                job["timings"]["wait_local"] = round(time.time() - t_wait, 1)
            result = run_floor_modes(spec, progress, CACHE, job["timings"])
        spec.result_file().write_text(json.dumps(result), encoding="utf-8")
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
