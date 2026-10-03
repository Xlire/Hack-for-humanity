"""Fill cache/results/ ahead of a demo, so the chosen floors load instantly in the app.

Run from the modalforge folder:
  .venv\\Scripts\\python scripts/precompute.py                         # every surface, Landing, draft
  .venv\\Scripts\\python scripts/precompute.py --surfaces pine-floor,steel-catwalk --sizes landing,3.0x2.4 --quality draft,standard
  .venv\\Scripts\\python scripts/precompute.py --list                  # show what would run, and what is cached

A project API key owns a single project, which every run clears first, so runs are sequential.
With an organization key each run gets its own project and --jobs N runs N at a time.
Do not run this while the web server is solving with a project key: both would clear the same project.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.model import QUALITY, ROOT, build_spec, load_catalog  # noqa: E402
from backend.settings import credentials, make_client  # noqa: E402


def parse_sizes(text: str, cat: dict) -> list[dict]:
    """Preset ids (landing, room) or free sizes as WIDTHxDEPTH in metres (3.0x2.4)."""
    out = []
    for item in filter(None, (t.strip() for t in text.split(","))):
        if item in cat["floorSizes"]:
            out.append({"floorSize": item, **{k: cat["floorSizes"][item][k] for k in ("Lx", "Ly")}})
        elif "x" in item:
            lx, ly = item.lower().split("x")
            out.append({"Lx": float(lx), "Ly": float(ly)})
        else:
            raise SystemExit(f"Unknown size '{item}'. Use {', '.join(cat['floorSizes'])} or WIDTHxDEPTH, e.g. 3.0x2.4")
    return out


def main() -> None:
    cat = load_catalog()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--surfaces", default="all", help="comma-separated surface ids, or 'all'")
    ap.add_argument("--sizes", default="landing", help="comma-separated: landing, room, or WIDTHxDEPTH")
    ap.add_argument("--quality", default="draft", help=f"comma-separated: {', '.join(QUALITY)}")
    ap.add_argument("--jobs", type=int, default=1, help="parallel runs (organization key only)")
    ap.add_argument("--fresh", action="store_true", help="solve again even when a result is cached")
    ap.add_argument("--list", action="store_true", help="only list the runs and their cache state")
    a = ap.parse_args()

    surfaces = [s["id"] for s in cat["surfaces"]] if a.surfaces == "all" else a.surfaces.split(",")
    qualities = a.quality.split(",")
    specs = []
    for sid in surfaces:
        for size in parse_sizes(a.sizes, cat):
            for q in qualities:
                try:
                    specs.append(build_spec({"surfaceId": sid.strip(), "quality": q.strip(), **size}))
                except ValueError as exc:
                    raise SystemExit(str(exc))

    todo = [s for s in specs if a.fresh or not s.cached_result_file()]
    for s in specs:
        state = "cached" if s.cached_result_file() else "to solve"
        print(f"  {s.surface_id:15s} {s.Lx:.1f} x {s.Ly:.1f} m  {s.quality:9s} {s.cache_key()}  {state}")
    print(f"{len(todo)} of {len(specs)} to solve.")
    if a.list or not todo:
        return
    if not credentials.configured:
        raise SystemExit("No Allsolve key in .env.")

    jobs = max(1, a.jobs)
    if jobs > 1 and make_client().is_project_api_key():
        print("Project API key: one shared project, so runs go one at a time (--jobs ignored).")
        jobs = 1

    from backend.allsolve_runner import run_floor_modes

    def solve(spec):
        tag = f"{spec.surface_id} {spec.Lx:.1f}x{spec.Ly:.1f} {spec.quality}"

        def progress(stage: str, frac: float, line: str | None) -> None:
            if line:
                print(f"[{tag}] {stage}: {line[:150]}", flush=True)

        t0 = time.time()
        result = run_floor_modes(spec, progress, ROOT / "cache")
        spec.result_file().write_text(json.dumps(result), encoding="utf-8")
        return tag, time.time() - t0, result["meta"].get("timings", {})

    failed = 0
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(solve, s): s for s in todo}
        for fut in as_completed(futures):
            try:
                tag, seconds, timings = fut.result()
                print(f"DONE  {tag} in {seconds:.0f} s  " + ", ".join(f"{k} {v:.0f}" for k, v in timings.items()), flush=True)
            except Exception as exc:  # keep going: one failed floor should not stop the batch
                failed += 1
                s = futures[fut]
                print(f"FAIL  {s.surface_id} {s.quality}: {exc}", flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
