"""Runs the floor vibration (eigenmode) analysis on Quanscient Allsolve.

Pipeline: variables -> geometry -> regions -> materials -> physics -> mesh -> eigenmode simulation
-> outputs (eigenfrequencies + vertical displacement probed on a grid over the deck).
"""

from __future__ import annotations

import io
import json
import math
import time
from pathlib import Path
from typing import Callable

from .model import (
    F_MAX_HZ, NUM_MODES, PROBE_NX, PROBE_NY, ROOT, FloorSpec, joist_positions,
    load_catalog, mesh_size_max, probe_points, wood_stiffness_matrix,
)
from .settings import make_client

Progress = Callable[[str, float, str | None], None]  # (stage, fraction 0..1, log line)
TOL = 1e-4
NODE_TYPE = "CORES_4_64GB"


def _num(v: float) -> str:
    return repr(float(v))


def run_floor_modes(spec: FloorSpec, progress: Progress, debug_dir: Path) -> dict:
    import allsolve

    cat = load_catalog()
    started = time.time()
    progress("Connecting to Allsolve", 0.02, None)
    client = make_client()

    if client.is_project_api_key():
        # Project-scoped key: may not create projects, so reuse the key's project, cleared first.
        project = client.get_project_from_token()
        progress("Clearing the key's project", 0.04, f"Project key: reusing project {project.id}")
        _reset_project(project)
    else:
        project = client.create_project(
            name=f"ModalForge · {spec.surface_id} · {spec.cache_key()[:6]}",
            description="Footstep sound floor: eigenmode analysis (ModalForge hackathon demo)",
        )
    project_url = None
    try:
        project_url = client.get_url(project)
    except Exception:
        pass
    progress("Project created", 0.06, f"Project {project.id}")

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
    progress("Geometry built", 0.16, f"Deck + {len(xs)} joists")

    # ---- regions ---------------------------------------------------------------------------
    Lx, Ly, t, h = spec.Lx, spec.Ly, spec.thickness, spec.joist_height
    deck = project.create_region_rule(
        name="deck", entity_type=allsolve.Region.VOLUME,
        bounding_box=((-TOL, -TOL, -TOL), (Lx + TOL, Ly + TOL, t + TOL)),
    )
    if spec.has_joists:
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
    h_max = mesh_size_max(spec, cat)
    progress("Meshing", 0.26, f"Max element size {h_max * 1000:.0f} mm")
    mesh = project.create_mesh(allsolve.MeshSettings(
        name="Floor mesh",
        mesh_size_max=h_max,
        node_type=getattr(allsolve.CPU, NODE_TYPE).value,
        max_run_time_minutes=20,
    ))
    mesh.start()
    _follow(mesh, progress, "Meshing", 0.26, 0.45)
    if mesh.get_status() != allsolve.Job.SUCCESS:
        reason = _safe(lambda: mesh.get_status_reason())
        raise RuntimeError(f"Meshing failed ({mesh.get_status()}{', ' + str(reason) if reason else ''})")
    metrics = _mesh_metrics(mesh)

    # ---- simulation ------------------------------------------------------------------------
    progress("Setting up eigenmode solve", 0.47, f"{NUM_MODES} modes requested")
    sim = project.create_simulation_eigenmode(
        name="Floor eigenmodes",
        description="Natural frequencies and mode shapes of the floor",
        max_run_time_minutes=30,
        solver_mode=allsolve.SolverMode.DIRECT,
        mesh=mesh.id,
        physics_set=physics_set,
        num_requested_eigenmodes=str(NUM_MODES),
        target_eigenfrequency="0",
    )
    outputs = [
        allsolve.Output.Eigenfrequencies(name="Eigenfrequencies"),
        allsolve.Output.FieldOutput(name="u", expression="u", field_output_skin_only=True),
    ]
    z_mid = t / 2
    for i, j, x, y in probe_points(spec):
        outputs.append(allsolve.Output.ValueOutput(
            name=f"w_{i:02d}_{j:02d}",
            expression=f"interpolate(reg.deck, compz(u), [{_num(x)}, {_num(y)}, {_num(z_mid)}])",
        ))
    sim.add_outputs(outputs)
    _safe(lambda: (sim.set_runtime(allsolve.Runtime(node_type=getattr(allsolve.CPU, NODE_TYPE))), sim.save()))

    progress("Solving on Allsolve cloud", 0.50, None)
    sim.start()
    _follow(sim, progress, "Solving on Allsolve cloud", 0.50, 0.92)
    if sim.get_status() != allsolve.Job.SUCCESS:
        raise RuntimeError(f"Eigenmode solve failed ({sim.get_status()}). See the Allsolve project logs.")

    # ---- results ---------------------------------------------------------------------------
    progress("Reading results", 0.94, None)
    modes = _extract_modes(sim, spec, debug_dir)
    progress("Done", 1.0, f"{len(modes)} modes")

    return {
        "source": "allsolve",
        "spec": _spec_public(spec),
        "grid": {"nx": PROBE_NX, "ny": PROBE_NY, "Lx": spec.Lx, "Ly": spec.Ly, "layout": "cell-centred"},
        "joists": xs,
        "modes": modes,
        "meta": {
            "projectId": project.id,
            "projectUrl": project_url,
            "simulationId": sim.id,
            "meshMaxSize": h_max,
            "mesh": metrics,
            "fMaxHz": F_MAX_HZ,
            "elapsedS": round(time.time() - started, 1),
            "computedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "nodeType": NODE_TYPE,
        },
    }


# ---------------------------------------------------------------------------------------------


def _reset_project(project) -> None:
    """Delete a project's contents in dependency order (Allsolve SDK skill: project workflow)."""
    import allsolve

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


def _follow(job, progress: Progress, stage: str, f0: float, f1: float) -> None:
    """Poll a cloud job, stream new log lines to the UI, and creep the progress bar."""
    t0 = time.time()
    while job.is_running(refresh_delay_s=2):
        buf = io.StringIO()
        _safe(lambda: job.print_new_loglines(buf))
        lines = [ln.strip() for ln in buf.getvalue().splitlines() if ln.strip()]
        frac = f0 + (f1 - f0) * (1 - math.exp(-(time.time() - t0) / 60))
        if lines:
            for ln in lines[-5:]:
                progress(stage, frac, ln)
        else:
            progress(stage, frac, None)
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

    probe_headers = {(i, j): header_for(f"w_{i:02d}_{j:02d}") for j in range(PROBE_NY) for i in range(PROBE_NX)}
    modes = []
    for k, s in enumerate(mode_steps):
        f = freqs[k] if k < len(freqs) else None
        if f is None or not math.isfinite(f) or f < 1.0:
            continue
        shape = []
        for j in range(PROBE_NY):
            for i in range(PROBE_NX):
                v = od.get_value_at(0, s, probe_headers[(i, j)])
                shape.append(float(v) if v is not None else 0.0)
        peak = max((abs(v) for v in shape), default=0.0)
        if peak <= 0:
            continue
        modes.append({"f": f, "shape": [round(v / peak, 5) for v in shape]})
    modes.sort(key=lambda m: m["f"])
    if not modes:
        raise RuntimeError("Simulation finished but no mode data could be read. See cache/last_output_headers.json.")
    _safe(od.clean_cache)
    return modes


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
