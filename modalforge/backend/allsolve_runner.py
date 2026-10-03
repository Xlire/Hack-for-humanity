"""Runs the floor vibration (eigenmode) analysis on Quanscient Allsolve.

Pipeline: variables -> geometry -> regions -> materials -> physics -> mesh -> eigenmode simulation
-> outputs (eigenfrequencies + vertical displacement probed on a grid over the deck).
"""

from __future__ import annotations

import io
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Callable

from .model import (
    ROOT, FloorSpec, joist_positions,
    load_catalog, mesh_size_max, probe_points, wood_stiffness_matrix,
)
from .settings import SDK_VERSION, credentials, make_client

Progress = Callable[[str, float, str | None], None]  # (stage, fraction 0..1, log line)
TOL = 1e-4
DEFAULT_NODE_TYPE = "CORES_4_64GB"
OUTPUT_THREADS = 8  # parallel requests when registering probe outputs


def node_type() -> str:
    """Allsolve CPU node for mesh and solve: MODALFORGE_NODE_TYPE in the environment or .env, e.g. CORES_8_128GB."""
    return credentials.node_type or DEFAULT_NODE_TYPE


class StageClock:
    """Wall time per pipeline stage [s]. The dict is shared with the job panel, so it fills in live."""

    def __init__(self, timings: dict | None = None) -> None:
        self.timings = timings if timings is not None else {}
        self.t0 = time.time()

    def add(self, name: str, seconds: float) -> None:
        self.timings[name] = round(self.timings.get(name, 0.0) + seconds, 1)

    @contextmanager
    def stage(self, name: str):
        start = time.time()
        try:
            yield
        finally:
            self.add(name, time.time() - start)

    def total(self) -> None:
        self.timings["total"] = round(time.time() - self.t0, 1)


def _num(v: float) -> str:
    return repr(float(v))


def run_floor_modes(spec: FloorSpec, progress: Progress, debug_dir: Path, timings: dict | None = None) -> dict:
    import allsolve

    cat = load_catalog()
    started = time.time()
    clock = StageClock(timings)
    node = node_type()
    cpu = getattr(allsolve.CPU, node, None)
    if cpu is None:
        raise ValueError(f"Unknown MODALFORGE_NODE_TYPE '{node}'. Options: {', '.join(c.name for c in allsolve.CPU)}")
    nx, ny = spec.probe_grid
    progress("Connecting to Allsolve", 0.02, f"Quality '{spec.quality}': mesh for {spec.f_max:.0f} Hz, "
             f"{spec.num_modes} modes, {nx}x{ny} probes, node {node}")
    with clock.stage("connect"):
        client = make_client()
        project_key = client.is_project_api_key()

    if project_key:
        # Project-scoped key: may not create projects, so reuse the key's project, cleared first.
        with clock.stage("connect"):
            project = client.get_project_from_token()
        progress("Clearing the key's project", 0.04, f"Project key: reusing project {project.id}")
        with clock.stage("reset"):
            _reset_project(project)
    else:
        with clock.stage("connect"):
            project = client.create_project(
                name=f"ModalForge · {spec.surface_id} · {spec.quality} · {spec.cache_key()[:6]}",
                description="Footstep sound floor: eigenmode analysis (ModalForge hackathon demo)",
            )
    project_url = None
    try:
        project_url = client.get_url(project)
    except Exception:
        pass
    progress("Project created", 0.06, f"Project {project.id}")
    setup_t0 = time.time()

    # ---- variables -------------------------------------------------------------------------
    project.create_variables([
        ("Lx", _num(spec.Lx), "Deck length across joists [m]"),
        ("Ly", _num(spec.Ly), "Deck width along joists [m]"),
        ("t", _num(spec.thickness), "Deck thickness [m]"),
    ])

    # ---- geometry --------------------------------------------------------------------------
    progress("Building geometry", 0.10, None)
    gb = project.geometry_builder()
    gb.add_box(name="deck", position=(0, 0, 0), size=("Lx", "Ly", "t"),
               alignment=allsolve.CadAlignment.CORNER)
    xs = joist_positions(spec)
    for i, xc in enumerate(xs):
        gb.add_box(
            name=f"joist_{i}",
            position=(_num(xc - spec.joist_width / 2), 0, _num(-spec.joist_height)),
            size=(_num(spec.joist_width), "Ly", _num(spec.joist_height)),
            alignment=allsolve.CadAlignment.CORNER,
        )
    gb.build(print_logs=False, on_error=allsolve.OnError.RAISE)
    clock.add("geometry", time.time() - setup_t0)
    progress("Geometry built", 0.16, f"Deck + {len(xs)} joists ({clock.timings['geometry']:.0f} s)")
    setup_t0 = time.time()

    # ---- regions ---------------------------------------------------------------------------
    Lx, Ly, t, h = spec.Lx, spec.Ly, spec.thickness, spec.joist_height
    deck = project.create_region_rule(
        name="deck", entity_type=allsolve.Region.VOLUME,
        bounding_box=((-TOL, -TOL, -TOL), (Lx + TOL, Ly + TOL, t + TOL)),
    )
    if spec.variant == "ss-plate":
        # Validation plate: simple support approximated in 3D by pinning the four bottom edges (z = 0).
        # Rotation about the edge stays free, so the plate behaves as simply supported for small t / L.
        edges = []
        for name, lo, hi in [
            ("bottom_edge_x0", (-TOL, -TOL, -TOL), (TOL, Ly + TOL, TOL)),
            ("bottom_edge_x1", (Lx - TOL, -TOL, -TOL), (Lx + TOL, Ly + TOL, TOL)),
            ("bottom_edge_y0", (-TOL, -TOL, -TOL), (Lx + TOL, TOL, TOL)),
            ("bottom_edge_y1", (-TOL, Ly - TOL, -TOL), (Lx + TOL, Ly + TOL, TOL)),
        ]:
            edges.append(project.create_region_rule(
                name=name, entity_type=allsolve.Region.CURVE, bounding_box=(lo, hi)))
        supports = project.create_region_computed(
            name="supports", entity_type=allsolve.Region.CURVE,
            operation=allsolve.RegionOperation.UNION, source_regions=[e.id for e in edges],
        )
        boundary = "Bare deck, simply supported: four bottom edges (z = 0) pinned (u = 0 on the edge lines)"
    elif spec.has_joists:
        joists = project.create_region_rule(
            name="joists", entity_type=allsolve.Region.VOLUME,
            bounding_box=((-TOL, -TOL, -h - TOL), (Lx + TOL, Ly + TOL, TOL)),
        )
        # Joist end faces at y=0 and y=Ly (z range stops below the deck, so deck faces are excluded)
        end0 = project.create_region_rule(
            name="joist_ends_0", entity_type=allsolve.Region.SURFACE,
            bounding_box=((-TOL, -TOL, -h - TOL), (Lx + TOL, TOL, TOL)),
        )
        end1 = project.create_region_rule(
            name="joist_ends_1", entity_type=allsolve.Region.SURFACE,
            bounding_box=((-TOL, Ly - TOL, -h - TOL), (Lx + TOL, Ly + TOL, TOL)),
        )
        supports = project.create_region_computed(
            name="supports", entity_type=allsolve.Region.SURFACE,
            operation=allsolve.RegionOperation.UNION, source_regions=[end0.id, end1.id],
        )
        boundary = "Joist end faces (y = 0 and y = Ly) clamped (u = 0); deck edges free"
    else:
        sides = []
        for name, lo, hi in [
            ("edge_x0", (-TOL, -TOL, -TOL), (TOL, Ly + TOL, t + TOL)),
            ("edge_x1", (Lx - TOL, -TOL, -TOL), (Lx + TOL, Ly + TOL, t + TOL)),
            ("edge_y0", (-TOL, -TOL, -TOL), (Lx + TOL, TOL, t + TOL)),
            ("edge_y1", (-TOL, Ly - TOL, -TOL), (Lx + TOL, Ly + TOL, t + TOL)),
        ]:
            sides.append(project.create_region_rule(
                name=name, entity_type=allsolve.Region.SURFACE, bounding_box=(lo, hi)))
        supports = project.create_region_computed(
            name="supports", entity_type=allsolve.Region.SURFACE,
            operation=allsolve.RegionOperation.UNION, source_regions=[s.id for s in sides],
        )
        boundary = "Slab: all four side faces clamped (u = 0)"

    # ---- materials -------------------------------------------------------------------------
    progress("Assigning materials", 0.20, None)
    deck_mat = cat["materials"][spec.deck_material]
    project.create_material(
        name=deck_mat["name"], target_region=deck, density=deck_mat["rho"],
        elasticity_matrix=_elasticity(allsolve, deck_mat, cat, orthotropic=True),
    )
    if spec.has_joists:
        j_mat = cat["materials"][spec.joist_material]
        project.create_material(
            name=f"{j_mat['name']} (joists)", target_region=joists, density=j_mat["rho"],
            # Joists bend along their length, where wood stiffness is E_L: isotropic approximation.
            elasticity_matrix=_elasticity(allsolve, j_mat, cat, orthotropic=False),
        )

    # ---- physics ---------------------------------------------------------------------------
    physics_set = project.get_default_physics_set()
    solid = physics_set.add_physics(allsolve.Physics.SolidMechanics())
    solid.add_interactions([allsolve.Interaction.SolidMechanicsClamp(name="Supports", target=supports)])

    # ---- mesh ------------------------------------------------------------------------------
    h_max = mesh_size_max(spec, cat) * spec.mesh_scale
    mesh = project.create_mesh(allsolve.MeshSettings(
        name="Floor mesh",
        mesh_size_max=h_max,
        node_type=cpu.value,
        max_run_time_minutes=20,
    ))
    clock.add("setup", time.time() - setup_t0)
    progress("Meshing", 0.26, f"Max element size {h_max * 1000:.0f} mm")
    mesh.start()
    _follow(mesh, progress, "Meshing", 0.26, 0.40, clock, "mesh")
    if mesh.get_status() != allsolve.Job.SUCCESS:
        reason = _safe(lambda: mesh.get_status_reason())
        raise RuntimeError(f"Meshing failed ({mesh.get_status()}{', ' + str(reason) if reason else ''})")
    metrics = _mesh_metrics(mesh)
    if metrics:
        progress("Meshing", 0.40, f"Mesh: {metrics.get('nodes')} nodes, {metrics.get('elements')} elements")

    # ---- simulation ------------------------------------------------------------------------
    setup_t0 = time.time()
    progress("Setting up eigenmode solve", 0.42, f"{spec.num_modes} modes requested")
    sim = project.create_simulation_eigenmode(
        name="Floor eigenmodes",
        description="Natural frequencies and mode shapes of the floor",
        max_run_time_minutes=30,
        solver_mode=allsolve.SolverMode.DIRECT,
        mesh=mesh.id,
        physics_set=physics_set,
        num_requested_eigenmodes=str(spec.num_modes),
        target_eigenfrequency="0",
    )
    # Only the eigenfrequencies and the probe values are read back. A full-field output ("u" on the
    # skin, every mode) cost minutes of output processing and was never used.
    outputs = [allsolve.Output.Eigenfrequencies(name="Eigenfrequencies")]
    z_mid = t / 2
    for i, j, x, y in probe_points(spec):
        outputs.append(allsolve.Output.ValueOutput(
            name=f"w_{i:02d}_{j:02d}",
            expression=f"interpolate(reg.deck, compz(u), [{_num(x)}, {_num(y)}, {_num(z_mid)}])",
        ))
    # add_outputs() makes one HTTP request per output, in sequence (~0.17 s each: 384 probes ≈ 65 s).
    # The outputs are independent, so send them in parallel chunks. A Client serialises its requests
    # behind a lock, so each worker binds its own client to its thread.
    def add_chunk(chunk):
        with make_client().in_thread():
            sim.add_outputs(chunk)

    chunks = [outputs[k::OUTPUT_THREADS] for k in range(OUTPUT_THREADS)]
    with ThreadPoolExecutor(max_workers=OUTPUT_THREADS) as pool:
        list(pool.map(add_chunk, [c for c in chunks if c]))
    _safe(lambda: (sim.set_runtime(allsolve.Runtime(node_type=cpu)), sim.save()))
    clock.add("solve_setup", time.time() - setup_t0)

    progress("Solving on Allsolve cloud", 0.45, None)
    sim.start()
    _follow(sim, progress, "Solving on Allsolve cloud", 0.45, 0.92, clock, "solve")
    if sim.get_status() != allsolve.Job.SUCCESS:
        reason = _safe(lambda: sim.get_status_reason())
        raise RuntimeError(f"Eigenmode solve failed ({sim.get_status()}{', ' + str(reason) if reason else ''}). "
                           "See the Allsolve project logs.")

    # ---- results ---------------------------------------------------------------------------
    progress("Reading results", 0.94, None)
    with clock.stage("extract"):
        modes, raw_freqs = _extract_modes(sim, spec, debug_dir)
    clock.total()
    progress("Done", 1.0, f"{len(modes)} modes · " + ", ".join(f"{k} {v:.0f} s" for k, v in clock.timings.items()))

    return {
        "source": "allsolve",
        "spec": _spec_public(spec),
        "grid": {"nx": nx, "ny": ny, "Lx": spec.Lx, "Ly": spec.Ly, "layout": "cell-centred"},
        "joists": xs,
        "modes": modes,
        "rawEigenfrequencies": raw_freqs,
        "meta": {
            "variant": spec.variant,
            "boundary": boundary,
            "meshScale": spec.mesh_scale,
            "quality": spec.quality,
            "numRequested": spec.num_modes,
            "sdkVersion": SDK_VERSION,
            "simulationName": "Floor eigenmodes",
            "projectId": project.id,
            "projectUrl": project_url,
            "simulationId": sim.id,
            "meshMaxSize": h_max,
            "mesh": metrics,
            "fMaxHz": spec.f_max,
            "elapsedS": round(time.time() - started, 1),
            "timings": dict(clock.timings),
            "computedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "nodeType": node,
        },
    }


# ---------------------------------------------------------------------------------------------


def _reset_project(project) -> None:
    """Delete a project's contents in dependency order (Allsolve SDK skill: project workflow)."""
    import allsolve

    # A job left running (server restarted mid-solve) blocks deletion: abort it and wait.
    jobs = list(project.get_simulations()) + list(project.get_meshes())
    for job in jobs:
        if _safe(lambda: job.is_running(refresh_delay_s=0)):
            _safe(job.abort)
    deadline = time.time() + 90
    while time.time() < deadline and any(_safe(lambda: j.is_running(refresh_delay_s=0)) for j in jobs):
        time.sleep(3)
    for sim in project.get_simulations():
        sim.delete()
    for mesh in project.get_meshes():
        mesh.delete()
    for physic in project.get_physics():
        for interaction in physic.interactions:
            interaction.delete()
        physic.delete()
    for material in project.get_materials():
        material.delete()
    for region in project.get_regions():
        region.delete()
    _safe(lambda: project.geometry_builder().delete())
    for fn in _safe(project.get_interpolated_functions) or []:
        fn.delete()
    for fn in _safe(project.get_functions) or []:
        fn.delete()
    for var in reversed(project.get_variables()):
        var.delete()
    for f in _safe(project.get_files) or []:
        _safe(lambda: allsolve.delete_file(f, project.id))


def _elasticity(allsolve, mat: dict, cat: dict, orthotropic: bool):
    if mat["kind"] == "wood" and orthotropic:
        return allsolve.MaterialProperty.ElasticityMatrix(value=wood_stiffness_matrix(mat["E"], cat["woodRatios"]))
    return allsolve.MaterialProperty.ElasticityMatrixYoungsModulusPoissonsRatio(
        f"{mat['E']:.6g}", f"{(0.3 if mat['kind'] == 'wood' else mat['nu']):.3g}"
    )


# Job states, grouped into what the user waits for: a free node, the computation, the output files.
_PHASE = {"submitted": "queue", "starting": "queue", "queued": "queue", "running": "run",
          "processing_output": "output", "aborting": "run", "failing": "run"}
_PHASE_SHARE = {"queue": (0.0, 0.15), "run": (0.15, 0.85), "output": (0.85, 1.0)}


def _follow(job, progress: Progress, stage: str, f0: float, f1: float, clock: StageClock, prefix: str) -> None:
    """Poll a cloud job and stream its log lines. Time per job state goes to the clock as
    <prefix>_queue / _run / _output. The bar moves by state and creeps within each one."""
    t_phase, phase = time.time(), "queue"
    while job.is_running(refresh_delay_s=2):
        status = job.get_status()
        status = str(getattr(status, "value", status) or "submitted").lower()
        now_phase = _PHASE.get(status, phase)
        now = time.time()
        if now_phase != phase:
            clock.add(f"{prefix}_{phase}", now - t_phase)
            progress(stage, f0, f"{prefix}: {phase} took {clock.timings[prefix + '_' + phase]:.0f} s, now {now_phase}")
            t_phase, phase = now, now_phase
        buf = io.StringIO()
        _safe(lambda: job.print_new_loglines(buf))
        lines = [ln.strip() for ln in buf.getvalue().splitlines() if ln.strip()]
        a, b = _PHASE_SHARE[phase]
        frac = f0 + (f1 - f0) * (a + (b - a) * (1 - math.exp(-(now - t_phase) / 60)))
        if lines:
            for ln in lines[-5:]:
                progress(stage, frac, ln)
        else:
            progress(stage, frac, None)
    clock.add(f"{prefix}_{phase}", time.time() - t_phase)  # the state the job finished in
    buf = io.StringIO()
    _safe(lambda: job.print_new_loglines(buf))
    for ln in buf.getvalue().splitlines()[-5:]:
        if ln.strip():
            progress(stage, f1, ln.strip())


def _extract_modes(sim, spec: FloorSpec, debug_dir: Path) -> list[dict]:
    od = sim.get_output_data(refresh=True)
    headers = od.get_value_headers()
    labels = od.get_step_labels()
    NO_STEP = getattr(od, "NO_STEP", "nostep")
    _safe(lambda: (debug_dir / "last_output_headers.json").write_text(
        json.dumps({"headers": headers, "labels": labels}, indent=1)))

    freq_header = next((h for h in headers if h.lower().startswith("eigenfreq")), None)
    mode_steps = [i for i, lab in enumerate(labels) if lab != NO_STEP]

    # Eigenfrequencies may be stored per mode step, or as one array at NO_STEP: support both.
    freqs: list[float | None] = []
    if freq_header:
        for s in mode_steps:
            v = od.get_values_at(0, s, freq_header)
            freqs.append(float(v[0]) if v else None)
        if not any(freqs) and NO_STEP in labels:
            arr = od.get_values_at(0, labels.index(NO_STEP), freq_header) or []
            freqs = [float(a) for a in arr][: len(mode_steps)]
    if not any(f is not None for f in freqs):
        freqs = [_to_float(labels[s]) for s in mode_steps]

    # Value outputs may carry a specifier: "w_00_00 (real)" / "w_00_00 (imag)".
    def header_for(name: str) -> str:
        for cand in (name, f"{name} (real)"):
            if cand in headers:
                return cand
        return name

    nx, ny = spec.probe_grid
    probe_headers = {(i, j): header_for(f"w_{i:02d}_{j:02d}") for j in range(ny) for i in range(nx)}
    modes = []
    raw: list[dict] = []  # every returned eigenfrequency, with the reason it was dropped (if it was)
    for k, s in enumerate(mode_steps):
        f = freqs[k] if k < len(freqs) else None
        entry = {"index": k, "f": f if (f is not None and math.isfinite(f)) else None, "kept": False}
        raw.append(entry)
        if f is None or not math.isfinite(f):
            entry["dropped"] = "no frequency value returned"
            continue
        if f < 1.0:
            entry["dropped"] = "below 1 Hz: rigid-body / zero-energy mode"
            continue
        shape = []
        for j in range(ny):
            for i in range(nx):
                v = od.get_value_at(0, s, probe_headers[(i, j)])
                shape.append(float(v) if v is not None else 0.0)
        peak = max((abs(v) for v in shape), default=0.0)
        if peak <= 0:
            entry["dropped"] = "zero vertical displacement at every probe point (in-plane mode)"
            continue
        entry["kept"] = True
        modes.append({"f": f, "shape": [round(v / peak, 5) for v in shape]})
    modes.sort(key=lambda m: m["f"])
    if not modes:
        raise RuntimeError("Simulation finished but no mode data could be read. See cache/last_output_headers.json.")
    _safe(od.clean_cache)
    return modes, raw


def _mesh_metrics(mesh) -> dict | None:
    m = _safe(lambda: mesh.get_metrics())
    if m is None:
        return None
    return {"nodes": getattr(m, "nodes", None), "elements": getattr(m, "elements", None)}


def _spec_public(spec: FloorSpec) -> dict:
    from dataclasses import asdict

    return asdict(spec)


def _to_float(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _safe(fn):
    try:
        return fn()
    except Exception:
        return None
