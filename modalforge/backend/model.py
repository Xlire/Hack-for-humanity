"""Floor model: turns a user request into a concrete, validated floor specification.

Shared conventions (mirrored in frontend/js/physics.js):
  * Deck occupies x in [0, Lx], y in [0, Ly], z in [0, t]. Boards (wood grain) run along x.
  * Joists run along y under the deck, z in [-h, 0], centred at `joist_positions()`.
  * Joist ends (y = 0 and y = Ly) are the supports. A slab without joists is held on all four edges.
  * Mode shapes are sampled on a cell-centred probe grid (PROBE_NX x PROBE_NY) at mid-thickness.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SURFACES_FILE = ROOT / "frontend" / "data" / "surfaces.json"

PROBE_NX = 12
PROBE_NY = 8
NUM_MODES = 100
F_MAX_HZ = 2500.0  # highest frequency the mesh is sized for
LX_RANGE = (1.0, 6.0)  # floor width (along the boards) [m], same limits as the sliders
LY_RANGE = (1.0, 5.0)  # floor depth (joist span) [m]


def load_catalog() -> dict:
    return json.loads(SURFACES_FILE.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class FloorSpec:
    surface_id: str
    Lx: float
    Ly: float
    deck_material: str
    thickness: float
    joist_material: str | None
    joist_width: float
    joist_height: float
    joist_spacing: float  # requested spacing; actual positions from joist_positions()

    @property
    def has_joists(self) -> bool:
        return self.joist_material is not None

    def cache_key(self) -> str:
        payload = json.dumps(asdict(self), sort_keys=True) + f"|{PROBE_NX}x{PROBE_NY}|{NUM_MODES}|v1"
        return hashlib.sha1(payload.encode()).hexdigest()[:16]


def build_spec(req: dict) -> FloorSpec:
    """Validate a request from the browser against the catalog and clamp to sane ranges."""
    cat = load_catalog()
    surfaces = {s["id"]: s for s in cat["surfaces"]}
    surface = surfaces.get(req.get("surfaceId"))
    if surface is None:
        raise ValueError(f"Unknown surface '{req.get('surfaceId')}'")

    if req.get("Lx") is not None and req.get("Ly") is not None:
        # free size from the sliders, 10 cm steps (keeps the result cache useful)
        size = {
            "Lx": round(min(max(float(req["Lx"]), LX_RANGE[0]), LX_RANGE[1]), 1),
            "Ly": round(min(max(float(req["Ly"]), LY_RANGE[0]), LY_RANGE[1]), 1),
        }
    else:
        size = cat["floorSizes"].get(req.get("floorSize", "landing"))
        if size is None:
            raise ValueError(f"Unknown floor size '{req.get('floorSize')}'")

    deck_mat = req.get("deckMaterial") or surface["deck"]["material"]
    if deck_mat not in cat["materials"]:
        raise ValueError(f"Unknown material '{deck_mat}'")

    thickness = float(req.get("thickness") or surface["deck"]["thickness"])
    thickness = min(max(thickness, 0.004), 0.25)

    joists = surface.get("joists")
    if joists:
        spacing = float(req.get("joistSpacing") or joists["spacing"])
        spacing = min(max(spacing, 0.25), 1.2)
        return FloorSpec(
            surface_id=surface["id"], Lx=size["Lx"], Ly=size["Ly"],
            deck_material=deck_mat, thickness=round(thickness, 4),
            joist_material=joists["material"], joist_width=joists["width"],
            joist_height=joists["height"], joist_spacing=round(spacing, 3),
        )
    return FloorSpec(
        surface_id=surface["id"], Lx=size["Lx"], Ly=size["Ly"],
        deck_material=deck_mat, thickness=round(thickness, 4),
        joist_material=None, joist_width=0.0, joist_height=0.0, joist_spacing=0.0,
    )


def joist_positions(spec: FloorSpec) -> list[float]:
    """Joist centre lines: first and last joist flush with the deck edges, the rest evenly spaced."""
    if not spec.has_joists:
        return []
    half = spec.joist_width / 2
    span = spec.Lx - spec.joist_width
    n_bays = max(1, round(span / spec.joist_spacing))
    return [half + span * i / n_bays for i in range(n_bays + 1)]


def probe_points(spec: FloorSpec) -> list[tuple[int, int, float, float]]:
    pts = []
    for j in range(PROBE_NY):
        for i in range(PROBE_NX):
            pts.append((i, j, (i + 0.5) * spec.Lx / PROBE_NX, (j + 0.5) * spec.Ly / PROBE_NY))
    return pts


def wood_stiffness_matrix(E_L: float, ratios: dict) -> list[list[float]]:
    """6x6 orthotropic stiffness (Voigt order xx, yy, zz, yz, xz, xy) with x = L, y = T, z = R."""
    E1, E2, E3 = E_L, ratios["ET"] * E_L, ratios["ER"] * E_L
    G23, G13, G12 = ratios["GRT"] * E_L, ratios["GLR"] * E_L, ratios["GLT"] * E_L
    nu12, nu13 = ratios["nuLT"], ratios["nuLR"]
    nu32 = ratios["nuRT"]                # R -> T
    nu23 = nu32 * E2 / E3                # T -> R, from reciprocity
    S = np.zeros((6, 6))
    S[0, 0], S[1, 1], S[2, 2] = 1 / E1, 1 / E2, 1 / E3
    S[0, 1] = S[1, 0] = -nu12 / E1
    S[0, 2] = S[2, 0] = -nu13 / E1
    S[1, 2] = S[2, 1] = -nu23 / E2
    S[3, 3], S[4, 4], S[5, 5] = 1 / G23, 1 / G13, 1 / G12
    C = np.linalg.inv(S)
    return [[float(f"{v:.6g}") if abs(v) > 1 else 0.0 for v in row] for row in C]


def mesh_size_max(spec: FloorSpec, cat: dict) -> float:
    """About 6 elements per bending wavelength of the deck at F_MAX_HZ, capped for small decks."""
    m = cat["materials"][spec.deck_material]
    t = spec.thickness
    E = m["E"]
    D = E * t**3 / (12 * (1 - m["nu"] ** 2))
    mass = m["rho"] * t
    omega = 2 * np.pi * F_MAX_HZ
    wavelength = 2 * np.pi / (omega**0.5 * (mass / D) ** 0.25)
    return float(min(max(wavelength / 6, 2 * t, 0.02), 0.12))
