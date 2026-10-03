// Floor physics in the browser.
//  * analyticModes(): textbook estimate used as instant preview and as the cross-check for Allsolve.
//  * buildModel(): turns modes (from Allsolve or analytic) into what the synthesiser needs:
//    modal mass, damping (Q) and radiation coupling for every mode, plus a fast shape sampler.
// Conventions mirror backend/model.py: deck x∈[0,Lx] (boards along x), y∈[0,Ly]; joists along y.

export const RHO_AIR = 1.21;
export const C_AIR = 343;
const F_MAX_ANALYTIC = 3000;
const MAX_ANALYTIC_MODES = 1500; // the real cap is F_MAX_ANALYTIC; this only bounds render cost

export function joistPositions(Lx, joists) {
  if (!joists) return [];
  const half = joists.width / 2;
  const span = Lx - joists.width;
  const nBays = Math.max(1, Math.round(span / joists.spacing));
  return Array.from({ length: nBays + 1 }, (_, i) => half + (span * i) / nBays);
}

/** Bending stiffness of the deck. Wood is orthotropic (stiff along the grain = x). */
export function plateProps(cat, matId, t) {
  const m = cat.materials[matId];
  const mass = m.rho * t;
  let Dx, Dy, H;
  if (m.kind === "wood") {
    const r = cat.woodRatios;
    const Ex = m.E, Ey = r.ET * m.E, nxy = r.nuLT, nyx = nxy * Ey / Ex, G = r.GLT * m.E;
    const k = t ** 3 / (12 * (1 - nxy * nyx));
    Dx = Ex * k; Dy = Ey * k;
    H = nxy * Dy + 2 * (G * t ** 3 / 12);
  } else {
    Dx = Dy = H = m.E * t ** 3 / (12 * (1 - m.nu ** 2));
  }
  const Dm = Math.sqrt(Dx * Dy);
  const fc = (C_AIR ** 2 / (2 * Math.PI)) * Math.sqrt(mass / Dm); // coincidence frequency
  return { Dx, Dy, H, mass, fc, eta: m.eta, rho: m.rho };
}

/** Instant analytical estimate. Joist floors: each bay between joists is a simply supported
 *  orthotropic plate on rigid joists, plus global "whole floor bounces on the joists" modes.
 *  Slabs: clamped plate (Warburton's approximation). Shapes sampled on a ~10 cm grid (24 x 18 to 48 x 40). */
export function analyticModes(cat, spec) {
  const { Lx, Ly } = spec;
  // ~10 cm cells (at least 24 x 18): big floors keep enough resolution for their higher modes
  const NX = Math.min(48, Math.max(24, Math.round(Lx / 0.1))), NY = Math.min(40, Math.max(18, Math.round(Ly / 0.1)));
  const P = plateProps(cat, spec.deckMaterial, spec.thickness);
  const modes = [];
  const gx = (i) => (i + 0.5) * Lx / NX, gy = (j) => (j + 0.5) * Ly / NY;
  const push = (f, fn, tag) => {
    if (!(f > 1 && f < F_MAX_ANALYTIC)) return;
    const shape = new Array(NX * NY);
    let peak = 0;
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const v = fn(gx(i), gy(j)); shape[j * NX + i] = v; peak = Math.max(peak, Math.abs(v));
    }
    if (peak > 0) modes.push({ f, shape: shape.map((v) => +(v / peak).toFixed(5)), tag });
  };

  const xs = joistPositions(Lx, spec.joists);
  if (spec.joists) {
    // bay modes
    for (let b = 0; b < xs.length - 1; b++) {
      const x0 = xs[b], a = xs[b + 1] - xs[b];
      const fBay = (m, n) => {
        const km = m / a, kn = n / Ly;
        return Math.PI * Math.sqrt((P.Dx * km ** 4 + 2 * P.H * km ** 2 * kn ** 2 + P.Dy * kn ** 4) / P.mass) / 2;
      };
      // every (m, n) up to F_MAX_ANALYTIC, however large the floor
      for (let m = 1; m <= 60 && fBay(m, 1) < F_MAX_ANALYTIC; m++) for (let n = 1; n <= 60 && fBay(m, n) < F_MAX_ANALYTIC; n++) {
        push(fBay(m, n), (x, y) => (x < x0 || x > x0 + a) ? 0 :
          Math.sin(m * Math.PI * (x - x0) / a) * Math.sin(n * Math.PI * y / Ly), "bay");
      }
    }
    // global joist modes: joist beams carrying their share of deck. Ends clamped, matching the
    // Allsolve model (joist end faces fixed): clamped-clamped beam roots βL = 4.730, 7.853, 10.996.
    const J = cat.materials[spec.joists.material];
    const s = Lx / Math.max(1, xs.length - 1);
    const EI = J.E * spec.joists.width * spec.joists.height ** 3 / 12;
    const mj = J.rho * spec.joists.width * spec.joists.height + P.mass * s;
    const betaL = [4.730, 7.853, 10.996];
    for (let n = 1; n <= 3; n++) {
      const fj = (betaL[n - 1] ** 2 / (2 * Math.PI * Ly * Ly)) * Math.sqrt(EI / mj);
      for (let k = 1; k <= Math.min(4, xs.length); k++) {
        const wx = k === 1 ? 0 : Math.PI ** 2 * ((k - 1) / Lx) ** 2 * Math.sqrt(P.Dx / P.mass);
        const f = Math.hypot(fj, wx / (2 * Math.PI));
        push(f, (x, y) => Math.sin(n * Math.PI * y / Ly) * Math.sin(Math.PI * y / Ly) * Math.cos((k - 1) * Math.PI * x / Lx), "global");
      }
    }
  } else {
    // clamped slab, Warburton: G, H coefficients per half-wave count
    const G = (m) => (m === 1 ? 1.506 : m + 0.5);
    const Hc = (m) => (m === 1 ? 1.248 : (m + 0.5) ** 2 * (1 - 2 / ((m + 0.5) * Math.PI)));
    const nu = cat.materials[spec.deckMaterial].nu;
    const r = Lx / Ly;
    const fSlab = (m, n) => Math.sqrt((Math.PI ** 4 * P.Dx / (P.mass * Lx ** 4)) *
      (G(m) ** 4 + G(n) ** 4 * r ** 4 + 2 * r * r * (nu * Hc(m) * Hc(n) + (1 - nu) * Hc(m) * Hc(n)))) / (2 * Math.PI);
    for (let m = 1; m <= 40 && fSlab(m, 1) < F_MAX_ANALYTIC; m++) for (let n = 1; n <= 40 && fSlab(m, n) < F_MAX_ANALYTIC; n++) {
      const f = fSlab(m, n);
      push(f, (x, y) => Math.sin(m * Math.PI * x / Lx) * Math.sin(Math.PI * x / Lx) *
        Math.sin(n * Math.PI * y / Ly) * Math.sin(Math.PI * y / Ly), "slab");
    }
  }
  modes.sort((a, b) => a.f - b.f);
  return {
    source: "analytic",
    spec,
    grid: { nx: NX, ny: NY, Lx, Ly, layout: "cell-centred" },
    joists: xs,
    modes: modes.slice(0, MAX_ANALYTIC_MODES),
    meta: { note: spec.joists ? "Rigid-joist bays + global joist modes" : "Clamped plate (Warburton)" },
  };
}

/** Bilinear sampler over a cell-centred grid (clamped at the borders). */
export function makeSampler(grid) {
  const { nx, ny, Lx, Ly } = grid;
  return (shape, x, y) => {
    const fx = Math.min(Math.max(x / Lx * nx - 0.5, 0), nx - 1);
    const fy = Math.min(Math.max(y / Ly * ny - 0.5, 0), ny - 1);
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const i1 = Math.min(i0 + 1, nx - 1), j1 = Math.min(j0 + 1, ny - 1);
    const tx = fx - i0, ty = fy - j0;
    const a = shape[j0 * nx + i0], b = shape[j0 * nx + i1], c = shape[j1 * nx + i0], d = shape[j1 * nx + i1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

/** A solve returns a fixed number of modes. For thin, stiff, lightly damped decks (steel) those can all sit
 *  below ~600 Hz, which leaves out the metallic ring entirely. Above the highest solved mode the
 *  analytic modes fill the band up to F_MAX_ANALYTIC. Each one carries its own (finer) grid. */
function extendModes(cat, result) {
  if (result.source !== "allsolve" || !result.modes.length) return result;
  const fTop = result.modes[result.modes.length - 1].f;
  if (fTop >= 0.8 * F_MAX_ANALYTIC) return result;
  const a = analyticModes(cat, result.spec);
  const extra = a.modes.filter((m) => m.f > fTop).map((m) => ({ ...m, grid: a.grid, tag: "analytic-ext" }));
  return { ...result, modes: [...result.modes, ...extra], meta: { ...result.meta, extendedFrom: fTop, extendedModes: extra.length } };
}

/** Everything the synthesiser and the visuals need, derived from a mode set. */
export function buildModel(cat, solved) {
  const result = extendModes(cat, solved);
  const spec = result.spec;
  const P = plateProps(cat, spec.deckMaterial, spec.thickness);
  const { Lx, Ly } = result.grid;
  const A = Lx * Ly;
  // Shapes from different grids (FEM probe grid, analytic grid) are told apart by their length.
  const samplers = new Map();
  for (const g of [result.grid, ...result.modes.map((m) => m.grid).filter(Boolean)]) {
    if (!samplers.has(g.nx * g.ny)) samplers.set(g.nx * g.ny, { s: makeSampler(g), dA: (g.Lx * g.Ly) / (g.nx * g.ny) });
  }
  const sample = (shape, x, y) => samplers.get(shape.length).s(shape, x, y);
  const J = spec.joists ? cat.materials[spec.joists.material] : null;
  const joistLineMass = J ? J.rho * spec.joists.width * spec.joists.height : 0;

  const modes = result.modes.map((m) => {
    let V = 0, S = 0;
    const { dA } = samplers.get(m.shape.length);
    for (const v of m.shape) { V += v * dA; S += v * v * dA; }
    // kinetic-energy weights of deck and joists (shapes are normalised to peak = 1)
    const deckMass = P.mass * S;
    let joistMass = 0;
    if (J) {
      const dy = Ly / 40;
      for (const xj of result.joists) for (let k = 0; k < 40; k++) {
        const v = sample(m.shape, xj, (k + 0.5) * dy); joistMass += joistLineMass * v * v * dy;
      }
    }
    const mk = Math.max(deckMass + joistMass, 1e-6);
    const eta = J ? (deckMass * P.eta + joistMass * J.eta) / mk : P.eta;
    const fr = m.f / P.fc;
    const s = (fr * fr) / (1 + fr * fr) + 0.02; // radiation efficiency ramp toward coincidence
    const R = Math.sqrt(V * V + s * S * A);    // effective radiating area [m²]
    // Share of the mode's kinetic energy carried by the joists. The analytic model holds bay modes on
    // rigid joists (share 0); a FEM mode with a large share is deck and joists moving together.
    const joistShare = joistMass / mk;
    return { f: m.f, shape: m.shape, Q: 1 / eta, mass: mk, R, tag: m.tag, grid: m.grid, joistShare };
  });

  return {
    source: result.source, spec, grid: result.grid, joists: result.joists, meta: result.meta || {},
    plate: P, modes, sample,
    contact: cat.materials[spec.deckMaterial].contact,
    raw: result,
  };
}

export const COUPLED_SHARE = 0.2; // joist energy share above which a mode counts as deck + joists together
export const DIVERGE = 0.15;      // |FEM / analytic − 1| above which a mode pair is marked as diverging

/** Physics check: the active result against the textbook estimate for the same floor, mode by mode.
 *  Pairs are by rank (k-th solved mode with k-th analytic mode). Rank pairing tolerates the
 *  degenerate bay modes of the rigid-joist model, which a 3D solve splits into close neighbours.
 *  Analytic modes appended above the solved band are left out: they would compare with themselves.
 *  fem / analytic / diff keep describing the lowest mode, as before. */
export function crossCheck(cat, model, est = analyticModes(cat, model.spec)) {
  const solved = model.modes.filter((m) => m.tag !== "analytic-ext");
  const pairs = solved.slice(0, est.modes.length).map((m, k) => ({
    k: k + 1, fem: m.f, analytic: est.modes[k].f, diff: m.f / est.modes[k].f - 1,
    joistShare: m.joistShare ?? 0, coupled: (m.joistShare ?? 0) > COUPLED_SHARE,
  }));
  const f1 = solved.length ? solved[0].f : NaN;
  const a1 = est.modes.length ? est.modes[0].f : NaN;
  const absDiffs = pairs.map((p) => Math.abs(p.diff)).sort((a, b) => a - b);
  // Mode density: how many modes each model puts below the top of the solved band. Rigid-joist bays
  // repeat every bay mode once per bay, so the textbook model can be far denser than the coupled 3D floor.
  const fTop = solved.length ? solved[solved.length - 1].f : NaN;
  return {
    fem: f1, analytic: a1, diff: (f1 - a1) / a1, pairs,
    fTop, femBelowTop: solved.length, analyticBelowTop: est.modes.filter((m) => m.f <= fTop).length,
    medianAbsDiff: absDiffs.length ? absDiffs[absDiffs.length >> 1] : NaN,
    diverging: pairs.filter((p) => Math.abs(p.diff) > DIVERGE).length,
    coupled: pairs.filter((p) => p.coupled).length,
  };
}
