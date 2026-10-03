// Math & provenance: how one footstep becomes sound, with every number tagged by where it came from.
//   ALLSOLVE  returned by an Allsolve job (simulation id given)
//   LOCAL     computed in this app (formula given)
//   ASSUMED   a value we chose: catalog data, model constants, UI settings
// buildReport() runs the same code paths as the sound (footForce, renderStep, buildModel). Nothing here
// is a hand-typed result. Missing data shows as "not available" with the reason.
// renderHtml() / renderMarkdown() turn the one report object into the screen and the export.

import { RHO_AIR, C_AIR, plateProps, crossCheck } from "./physics.js";
import { FS, EAR_HEIGHT, footForce, renderStep, mulberry32, dbSPL } from "./synth.js";

const G = 9.81;              // mirrors synth.js
const PASS_TOL = 0.05;       // validation pass band (our choice)
const N_ANALYTIC = 8;        // analytic (m, n) modes compared
const N_CONV = 10;           // modes compared for mesh convergence / sensitivity

export const TAGS = {
  ALLSOLVE: "Returned by an Allsolve cloud job",
  LOCAL: "Computed in this app",
  ASSUMED: "A value we chose (catalog data, model constant or UI setting)",
};

// ------------------------------------------------------------------------------- glossary (the "?" pop-ups)
// Keyed by the symbol shown next to a value; "col:<key>" for table columns; "label:<text>" for rows without a symbol.
export const HELP = {
  // materials
  "E": "Young's modulus: how stiff the deck material is. A higher E means a stiffer floor and higher pitched modes. For wood this is the stiffness along the grain (E_L).",
  "ρ": "Density of the deck material. A heavier floor rings at lower frequencies and is harder to set moving.",
  "ν": "Poisson's ratio: how much the material narrows sideways when it is stretched. It slightly changes the plate's bending stiffness.",
  "η": "Loss factor: the fraction of vibration energy lost per cycle (×2π). It sets how quickly the sound dies away. Allsolve does not compute it; it is our catalog value for a built floor (joints, screws, friction).",
  "ET": "Wood stiffness across the grain (tangential), as a fraction of E_L. Boards are about 20× softer across the grain.",
  "ER": "Wood stiffness through the board thickness (radial), as a fraction of E_L.",
  "GLT": "Wood shear stiffness in the board plane, as a fraction of E_L. It affects twisting modes of the boards.",
  "GLR": "Wood shear stiffness between the grain and the thickness direction, as a fraction of E_L.",
  "GRT": "Wood shear stiffness across the grain (rolling shear), as a fraction of E_L. Very small in wood.",
  "nuLT": "Wood Poisson's ratio: stretching along the grain makes the board narrower across it.",
  "nuLR": "Wood Poisson's ratio: stretching along the grain makes the board thinner.",
  "nuRT": "Wood Poisson's ratio between the thickness and across-grain directions.",
  "E_j": "Young's modulus of the joists (the beams under the deck).",
  "ρ_j": "Density of the joist material.",
  "ν_j": "Poisson's ratio given to the joists in the 3D model. Wood joists are modelled as isotropic, with ν = 0.3.",
  "η_j": "Loss factor of the joists. It is mixed with the deck's loss factor for each mode, depending on how much the joists move in that mode.",
  "b_j": "Width of one joist.",
  "h_j": "Height of one joist. Taller joists are much stiffer (stiffness grows with height³).",
  "s": "Requested distance between joist centres. The real positions are spread evenly so the first and last joist sit flush with the deck edges.",
  "n_j": "Number of joists the app placed under the deck.",
  // geometry & model
  "Lx = a": "Floor width, along the boards. In the plate formula this is the side length a.",
  "Ly = b": "Floor depth: the distance the joists span, support to support. In the plate formula this is the side length b.",
  "h": "Deck thickness. Bending frequencies grow roughly in proportion to thickness.",
  "BC": "Boundary conditions: where and how the floor is held. They change every frequency, so the formula is only exact for the supports it was derived for.",
  "–": "The brief asked about free (unsupported) edges. This app never models a floor that way, so no value exists.",
  "h_mesh": "Largest element size in the finite element mesh Allsolve solves on. Smaller elements give more accurate high modes but take longer. It is sized for about 6 elements per bending wave at 2.5 kHz.",
  "N_nodes": "Number of mesh nodes in the Allsolve model. More nodes mean more unknowns and a finer solution.",
  "N_el": "Number of mesh elements (tetrahedra and similar) in the Allsolve model.",
  "N_req": "How many vibration modes we ask Allsolve for, starting from 0 Hz.",
  "label:Mode shape probe grid": "Allsolve reports the vertical motion of every mode at these points, a regular grid over the deck. The app interpolates between them to get the motion at the exact step position.",
  // walker
  "T_h,0": "Heel contact time of this shoe: how long the hard heel takes to stop. A short time (hard heel) means a sharper click with more high frequencies.",
  "I_0": "Momentum the heel delivers in the click, for a 75 kg walker at normal pace. The ISO standard tapping machine, built to imitate heels, delivers 0.44 N·s.",
  "r_toe": "How strong the forefoot click is compared with the heel click.",
  "k_h": "Sole hardness. It only sets the level of the contact click noise, not the floor vibration.",
  "m": "Body mass of the walker.",
  "c": "Cadence: steps per minute for this pace.",
  "ℓ": "Step length, derived from the cadence.",
  "v": "Walking speed = step length × steps per second.",
  "k_dyn": "Dynamic load factor: the peak of the slow body-weight loading divided by body weight. Running gives values above 1. It mainly affects frequencies below about 50 Hz.",
  "x": "Where the foot landed, across the floor (along the boards).",
  "y": "Where the foot landed, along the joists.",
  "seed": "Random seed of this step. Real steps vary a little in timing and force; the seed makes this exact step reproducible.",
  "s_foot": "Strike strength of this foot. People rarely step equally hard with both feet, so each foot gets a small random factor.",
  "(x_L, y_L)": "Position of the listener (the headphones icon) on the floor plan.",
  "z_L": "Height of the listener's ears above the floor.",
  "r": "Straight-line distance from the step to the listener's ears. The sound pressure falls in proportion to 1/r.",
  "g": "Gravitational acceleration, used to turn body mass into body weight.",
  "ρ0": "Density of air. The sound pressure a vibrating floor makes is proportional to it.",
  "c0": "Speed of sound in air. It sets the coincidence frequency, above which the floor radiates sound efficiently.",
  "fs": "Sample rate of the synthesised audio (samples per second).",
  // force
  "BW": "Body weight: mass × gravity × this foot's strike strength.",
  "T_h": "Heel contact time of this particular step: the preset value with a small random variation.",
  "I": "Heel click momentum, nominal: the shoe value scaled by pace and body mass, before random variation.",
  "I'": "Heel click momentum of this particular step, after random variation (±15 %).",
  "F_h": "Peak force of the heel click. A half-sine pulse that delivers momentum I' in time T_h peaks at I'·π/(2·T_h).",
  "t_toe": "Time between the heel click and the forefoot click.",
  "F_toe": "Peak force of the forefoot click.",
  "F_load": "Peak of the smooth body-weight loading as the heel takes the weight. It is large but slow, so it adds mostly sub-audible thump.",
  "T_load": "Duration of the heel loading pulse.",
  "F_toeload": "Peak of the smooth loading when the weight rolls onto the forefoot.",
  "max F": "Highest value of the total force over time.",
  "∫F dt": "Total momentum of the step: the area under the force curve. Most of it comes from the slow loading, not the click.",
  "T_end": "Time when the force has ended. After this, every mode rings freely, which is when the sum-of-decaying-sines formula is exact.",
  "f_null": "First frequency where the heel click has (almost) no energy. Modes near it are barely excited. Harder heels (shorter T_h) push it up and sound brighter.",
  // eigen
  "N_FEM": "How many vibration modes came from the Allsolve solve and are used for the sound.",
  "f_1 … f_N": "Frequency range covered by the Allsolve modes, lowest to highest.",
  "N_ext": "Modes the app adds with a textbook formula above the highest Allsolve mode, so the sound has content up to 3 kHz. These are NOT from Allsolve.",
  "N_raw": "Total number of eigenmodes Allsolve returned, before any were filtered out.",
  "N_rigid": "Modes near 0 Hz: the whole floor moving as a solid block. They only appear if the floor is not held, and they make no sound, so they are excluded.",
  "N_inplane": "Modes where the floor only moves sideways (in its own plane) at the probe points. They push very little air, so they are excluded.",
  // validation
  "f_11": "Lowest mode of the deck if it were one simply supported plate. This is a textbook number for comparison.",
  "f_1": "Lowest mode of the floor the app is actually using.",
  "f_est": "Lowest mode from the app's own textbook model of this floor (deck bays between rigid joists, or a clamped slab).",
  "Δ": "Difference between the solved floor and the textbook estimate, in percent.",
  "max |Δ|": "Largest change in any of the first modes when the mesh is refined. A small value (about 1 % or less) means the mesh is fine enough.",
  "N": "Mesh nodes in the base run → the refined run.",
  "label:Frequencies at two mesh sizes": "Mesh convergence: solve the same floor with smaller elements. If the frequencies barely change, the original mesh was accurate enough.",
  "label:Expected vs actual": "Sensitivity check: change one input in a known way and see whether the frequencies change by the amount the theory predicts.",
  // synthesis
  "p_peak": "Highest sound pressure of this step at the listener, including every mode, the contact click and the high-frequency fill.",
  "L_peak": "The same peak pressure in decibels (dB SPL, relative to 20 µPa).",
  "contact": "How loud the shoe-on-surface contact click is for this material (catalog value).",
  // meta
  "label:Report generated": "When this report was built, by your browser clock.",
  "label:Allsolve SDK on the server now": "Version of the allsolve Python package installed on the server right now.",
  "label:Allsolve SDK that produced the active result": "Version of the allsolve package that ran the job. Results cached before this was recorded show 'not available'.",
  // table columns
  "col:k": "Mode number, counted from the lowest frequency.",
  "col:index": "Position in the list Allsolve returned.",
  "col:f": "Natural frequency of the mode: the pitch at which this vibration pattern rings.",
  "col:status": "Whether the mode is used for the sound, or why it was excluded.",
  "col:origin": "Where the mode comes from: the Allsolve 3D solve, or the app's textbook formula.",
  "col:phi": "Mode shape value at the step position: how much this mode moves there, from −1 to 1. Near 0 means stepping there hardly excites this mode.",
  "col:Fhat": "How much of the step's force falls at this mode's frequency (the force spectrum). A larger value drives the mode harder.",
  "col:mass": "Modal mass: how much mass effectively takes part in this mode. A heavier mode is harder to set moving.",
  "col:R": "Effective radiating area: how well this mode pushes air. Patterns where neighbouring areas move in opposite directions cancel out and radiate less.",
  "col:eta": "Loss factor of this mode: the deck and joist loss factors, weighted by how much each one moves.",
  "col:Q": "Quality factor = 1/η. A high Q means a long, ringing tone; a low Q means a dull thud.",
  "col:sigma": "Decay rate: the mode's amplitude falls as e^(−σ·t). σ = π·f·η, so high modes die faster.",
  "col:T60": "Time for this mode to fade by 60 dB (to one thousandth of its amplitude).",
  "col:A": "Starting amplitude of this mode in the sum of decaying sines, in pascals at the listener, from the closed-form formula.",
  "col:measured": "Peak pressure this mode actually reached in the app's real sound renderer, for comparison with A_k.",
  "col:mn": "Mode numbers: m half-waves across the width, n half-waves across the depth.",
  "col:fa": "Frequency from the textbook simply supported plate formula.",
  "col:ff": "Frequency Allsolve computed for the same simply supported plate.",
  "col:err": "How far Allsolve is from the formula, in percent.",
  "col:pass": "Whether the difference is inside our chosen ±5 % band.",
  "col:f0": "Frequency with the normal mesh.",
  "col:f1": "Frequency with the refined (smaller element) mesh.",
  "col:d": "Change caused by refining the mesh, in percent.",
  "col:base": "Frequency of the reference SS plate.",
  "col:changed": "Frequency after changing one input (thickness or material).",
  "col:exp": "Ratio the theory predicts: changed / base.",
  "col:act": "Ratio Allsolve actually gave: changed / base.",
  "col:dev": "How far the actual ratio is from the predicted one, in percent.",
  "col:role": "What this Allsolve run was for.",
  "col:simulationId": "Allsolve's id for the simulation. You can find it in the Allsolve web app.",
  "col:projectId": "Allsolve project that holds the simulation.",
  "col:computedAt": "When the cloud job actually ran.",
  "col:cache": "Whether this run was loaded from the local cache or solved just now.",
  "col:boundary": "How the model was held in that run.",
  "col:mesh": "Largest mesh element size of that run.",
};

const helpOf = (key) => HELP[key] || null;

/** Attach the explanation to every row and column, so the JSON export carries it too. */
function attachHelp(sections) {
  for (const s of sections) for (const b of s.blocks) {
    if (b.type === "kv") for (const r of b.rows) r.help = helpOf(r.sym) || helpOf(`label:${r.label}`);
    if (b.type === "table") b.columns = b.columns.map(([k, label, hk]) => [k, label, helpOf(hk || `col:${k}`)]);
  }
}

// ------------------------------------------------------------------------------- tagged values
const tv = (value, unit, tag, source, extra = {}) => ({ value, unit, tag, source, ...extra });
const na = (reason, unit = "") => ({ value: null, unit, tag: null, na: reason });

export function fmt(v, digits = 4) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (typeof v !== "number") return String(v);
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (Number.isInteger(v) && a < 1e9) return String(v); // ids, seeds, counts: never rounded
  if (a >= 1e5 || a < 1e-3) return v.toExponential(digits - 1).replace("e+", "e");
  return String(+v.toPrecision(digits));
}

function meshCounts(meta) {
  const m = meta?.mesh;
  if (!m) return null;
  if (m.nodes) return { nodes: m.nodes, elements: m.elements };
  const nodes = /Nodes:\s*(\d+)/.exec(m.raw || ""), el = /Elements:\s*(\d+)/.exec(m.raw || "");
  return nodes ? { nodes: +nodes[1], elements: el ? +el[1] : null } : null;
}

/** Boundary text as built by backend/allsolve_runner.py (used when an older cached result did not record it). */
function boundaryOf(spec, variant = "floor") {
  if (variant === "ss-plate") return "Bare deck, simply supported: four bottom edges (z = 0) pinned (u = 0 on the edge lines)";
  return spec.joists ? "Joist end faces (y = 0 and y = Ly) clamped (u = 0); deck edges free" : "Slab: all four side faces clamped (u = 0)";
}

function runInfo(role, r) {
  const m = r.meta || {};
  return {
    role, variant: m.variant || "floor", projectId: m.projectId ?? null, projectUrl: m.projectUrl ?? null,
    simulationId: m.simulationId ?? null, simulationName: m.simulationName || "Floor eigenmodes",
    computedAt: m.computedAt ?? null, fromCache: !!m.fromCache, elapsedS: m.elapsedS ?? null,
    sdkVersion: m.sdkVersion ?? null, meshMaxSize: m.meshMaxSize ?? null, meshScale: m.meshScale ?? 1,
    mesh: meshCounts(m), boundary: m.boundary || boundaryOf(specOf(r), m.variant), nodeType: m.nodeType ?? null,
  };
}

/** Allsolve source string for one run, with cache state. */
function asSrc(run) {
  const id = run.simulationId ? `simulation ${run.simulationId}` : "simulation id not recorded";
  const cache = run.fromCache ? `; cached, job ran ${run.computedAt || "at an unrecorded time"}` : `; solved ${run.computedAt || ""}`;
  return `Allsolve ${id} "${run.simulationName}", project ${run.projectId || "?"}${cache}`;
}

/** Backend results carry a snake_case spec; the active model a camelCase one. */
function specOf(r) {
  const s = r.spec || {};
  if ("deckMaterial" in s) return s;
  return {
    Lx: s.Lx, Ly: s.Ly, deckMaterial: s.deck_material, thickness: s.thickness,
    joists: s.joist_material ? { material: s.joist_material, width: s.joist_width, height: s.joist_height, spacing: s.joist_spacing } : null,
  };
}

/** Pulse "spectrum" at one mode: C = Σ F[n]·Δt·e^{(σ − iω_d)·t_n}. With σ = 0 this is the plain Fourier
 *  transform |F̂(f)| [N·s]; with the mode's σ it gives the exact free-vibration amplitude after the pulse. */
function pulseCoef(F, f, sigma) {
  const wd = 2 * Math.PI * f, dt = 1 / FS;
  let re = 0, im = 0, plainRe = 0, plainIm = 0;
  const cr = Math.cos(wd * dt), ci = -Math.sin(wd * dt), g = Math.exp(sigma * dt);
  let zr = 1, zi = 0, amp = 1; // e^{-iω t_n} and e^{σ t_n}
  for (let n = 0; n < F.length; n++) {
    const x = F[n] * dt;
    if (x !== 0) { plainRe += x * zr; plainIm += x * zi; re += x * amp * zr; im += x * amp * zi; }
    const nr = zr * cr - zi * ci; zi = zr * ci + zi * cr; zr = nr; amp *= g;
  }
  return { plain: Math.hypot(plainRe, plainIm), damped: Math.hypot(re, im) };
}

/** Lowest analytic simply supported plate modes: f_mn = (π/2)·√((Dx(m/a)⁴ + 2H(m/a)²(n/b)² + Dy(n/b)⁴)/(ρh)).
 *  For an isotropic plate Dx = Dy = H = D and this is (π/2)·√(D/ρh)·((m/a)² + (n/b)²). */
function ssPlateModes(P, a, b, n = N_ANALYTIC) {
  const out = [];
  for (let m = 1; m <= 8; m++) for (let k = 1; k <= 8; k++) {
    const p = m / a, q = k / b;
    out.push({ m, n: k, f: (Math.PI / 2) * Math.sqrt((P.Dx * p ** 4 + 2 * P.H * p * p * q * q + P.Dy * q ** 4) / P.mass) });
  }
  return out.sort((x, y) => x.f - y.f).slice(0, n);
}

// ------------------------------------------------------------------------------- build
/**
 * cat      surfaces.json        model   buildModel() output (active floor)
 * walker   { shoe, shoeId, pace, paceId, massKg, listener, run }
 * hit      { x, y, seed, force, origin } or null (then floor centre, seed 1)
 * related  { ssPlate, ssHalf, ssAlt, altMaterialId, meshFine }: raw backend results or null
 * status   /api/status payload or null
 */
export function buildReport({ cat, model, walker, hit, related = {}, status = null, surfaceName = "" }) {
  const spec = model.spec;
  const isFem = model.source === "allsolve";
  const meta = model.meta || {};
  const active = isFem ? runInfo("Active floor", model.raw) : null;
  const femSrc = active ? asSrc(active) : null;
  const deckId = spec.deckMaterial, deck = cat.materials[deckId];
  const J = spec.joists ? cat.materials[spec.joists.material] : null;
  const surface = cat.surfaces.find((s) => s.id === spec.surfaceId);
  const sections = [];

  // ---- hit point & listener --------------------------------------------------------------
  const h = hit || { x: spec.Lx / 2, y: spec.Ly / 2, seed: 1, force: 1, origin: null };
  const hitOrigin = h.origin || "no step played yet: floor centre, chosen by the report";
  const L = walker.listener;
  const r = Math.hypot(h.x - L.x, h.y - L.y, EAR_HEIGHT);
  const radiation = RHO_AIR / (2 * Math.PI * r);

  // ---- 1. inputs -------------------------------------------------------------------------
  const cs = (k) => `surfaces.json › ${k}`;
  const ui = (what) => `UI setting: ${what}`;
  const inputs = [];
  const add = (group, label, sym, v) => inputs.push({ group, label, sym, ...v });
  const sentToAllsolve = isFem ? "; sent to Allsolve as material data" : "";
  add("Deck material", `${deck.name}: Young's modulus${deck.kind === "wood" ? " along grain E_L" : ""}`, "E", tv(deck.E, "Pa", "ASSUMED", cs(`materials.${deckId}.E`) + sentToAllsolve));
  add("Deck material", "Density", "ρ", tv(deck.rho, "kg/m³", "ASSUMED", cs(`materials.${deckId}.rho`) + sentToAllsolve));
  add("Deck material", "Poisson ratio", "ν", tv(deck.nu, "–", "ASSUMED", cs(`materials.${deckId}.nu`) + (deck.kind === "wood" ? " (wood: the 3D model uses ν_LT, ν_LR, ν_RT below)" : sentToAllsolve)));
  add("Deck material", "Loss factor (damping, used only in this app)", "η", tv(deck.eta, "–", "ASSUMED", cs(`materials.${deckId}.eta`)));
  const woodUsed = deck.kind === "wood" || J?.kind === "wood";
  if (woodUsed) {
    const R = cat.woodRatios;
    for (const k of ["ET", "ER", "GLT", "GLR", "GRT"]) add("Wood orthotropy (ratio to E_L)", k.replace(/^E/, "E_").replace(/^G/, "G_"), k, tv(R[k], "–", "ASSUMED", cs(`woodRatios.${k}`) + " (USDA Wood Handbook typical)"));
    for (const k of ["nuLT", "nuLR", "nuRT"]) add("Wood orthotropy (ratio to E_L)", k.replace("nu", "ν_"), k, tv(R[k], "–", "ASSUMED", cs(`woodRatios.${k}`)));
  }
  if (J) {
    const jid = spec.joists.material;
    add("Joists", `${J.name}: Young's modulus`, "E_j", tv(J.E, "Pa", "ASSUMED", cs(`materials.${jid}.E`)));
    add("Joists", "Density", "ρ_j", tv(J.rho, "kg/m³", "ASSUMED", cs(`materials.${jid}.rho`)));
    add("Joists", "Poisson ratio used in the 3D model", "ν_j", tv(J.kind === "wood" ? 0.3 : J.nu, "–", "ASSUMED",
      J.kind === "wood" ? "backend/allsolve_runner.py _elasticity(): wood joists modelled isotropic with ν = 0.3" : cs(`materials.${jid}.nu`)));
    add("Joists", "Loss factor", "η_j", tv(J.eta, "–", "ASSUMED", cs(`materials.${jid}.eta`)));
    add("Joists", "Width", "b_j", tv(spec.joists.width, "m", "ASSUMED", cs(`surfaces.${spec.surfaceId}.joists.width`)));
    add("Joists", "Height", "h_j", tv(spec.joists.height, "m", "ASSUMED", cs(`surfaces.${spec.surfaceId}.joists.height`)));
    add("Joists", "Requested spacing", "s", tv(spec.joists.spacing, "m", "ASSUMED", ui("Joist spacing slider")));
    add("Joists", "Number of joists", "n_j", tv(model.joists.length, "–", "LOCAL", "joistPositions(): n_bays = round((Lx − b_j)/s), first and last flush with the deck edges"));
  }
  add("Plate geometry", "Width (along boards)", "Lx = a", tv(spec.Lx, "m", "ASSUMED", ui("Width slider / size preset")));
  add("Plate geometry", "Depth (joist span)", "Ly = b", tv(spec.Ly, "m", "ASSUMED", ui("Depth slider / size preset")));
  add("Plate geometry", "Deck thickness", "h", tv(spec.thickness, "m", "ASSUMED", ui("Deck thickness slider")));
  add("Boundary conditions", isFem ? active.boundary : boundaryOf(spec), "BC", { value: null, unit: "", tag: "ASSUMED", source: "Modelling choice in backend/allsolve_runner.py (support regions + SolidMechanicsClamp)", text: true });
  add("Boundary conditions", "Edge type requested in the brief: free edges", "–", { value: null, unit: "", tag: null, na: "not used: this app never solves a plate with free edges. Validation below uses a simply supported plate instead." });
  if (isFem) {
    add("Allsolve model", "Max element size", "h_mesh", tv(active.meshMaxSize, "m", "LOCAL", `mesh_size_max(): λ_b(${fmt(meta.fMaxHz ?? 2500)} Hz)/6 clamped to [max(2h, 0.02), 0.12] m, × mesh scale ${fmt(active.meshScale)}; sent to Allsolve`));
    if (active.mesh) {
      add("Allsolve model", "Mesh nodes", "N_nodes", tv(active.mesh.nodes, "–", "ALLSOLVE", `${asSrc(active)} (mesh metrics)`));
      if (active.mesh.elements) add("Allsolve model", "Mesh elements", "N_el", tv(active.mesh.elements, "–", "ALLSOLVE", `${asSrc(active)} (mesh metrics)`));
    } else add("Allsolve model", "Mesh nodes", "N_nodes", na("mesh metrics were not returned for this run"));
    add("Allsolve model", "Eigenmodes requested", "N_req", tv(meta.numRequested ?? 100, "–", "ASSUMED", `backend/model.py QUALITY["${meta.quality ?? "fine"}"].modes`));
    add("Allsolve model", "Mode shape probe grid", "", tv(`${model.grid.nx} × ${model.grid.ny}`, "points", "ASSUMED", `backend/model.py QUALITY["${meta.quality ?? "fine"}"].probe, cell-centred at mid-thickness`));
  }
  const shoe = walker.shoe, pace = walker.pace;
  add("Walker", `Shoe preset: ${shoe.name}, heel contact time`, "T_h,0", tv(shoe.heelMs / 1000, "s", "ASSUMED", cs(`shoes.${walker.shoeId}.heelMs`)));
  add("Walker", "Heel click impulse at 75 kg, walk", "I_0", tv(shoe.impulse, "N·s", "ASSUMED", cs(`shoes.${walker.shoeId}.impulse`) + " (ISO 10140 tapping hammer: 0.44 N·s)"));
  add("Walker", "Forefoot / heel click ratio", "r_toe", tv(shoe.toeRatio, "–", "ASSUMED", cs(`shoes.${walker.shoeId}.toeRatio`)));
  add("Walker", "Sole hardness (contact click level)", "k_h", tv(shoe.hardness, "–", "ASSUMED", cs(`shoes.${walker.shoeId}.hardness`)));
  add("Walker", "Walker mass", "m", tv(walker.massKg, "kg", "ASSUMED", ui("Body mass slider")));
  add("Walker", `Pace: ${pace.name}, cadence`, "c", tv(pace.cadence, "steps/min", "ASSUMED", cs(`paces.${walker.paceId}.cadence`)));
  const stepLen = pace.cadence > 150 ? 1.0 : 0.62 + (pace.cadence - 90) * 0.004;
  add("Walker", "Step length", "ℓ", tv(stepLen, "m", "LOCAL", pace.cadence > 150 ? "planSteps(): 1.0 m when cadence > 150" : `planSteps(): ℓ = 0.62 + (c − 90)·0.004 = 0.62 + (${pace.cadence} − 90)·0.004`));
  add("Walker", "Walking speed", "v", tv(stepLen * pace.cadence / 60, "m/s", "LOCAL", `v = ℓ·c/60 = ${fmt(stepLen)}·${pace.cadence}/60`));
  add("Walker", "Dynamic load factor (heel loading peak / body weight)", "k_dyn", tv(pace.impact, "–", "ASSUMED", cs(`paces.${walker.paceId}.impact`)));
  add("Hit position", "x", "x", tv(h.x, "m", "LOCAL", hitOrigin));
  add("Hit position", "y", "y", tv(h.y, "m", "LOCAL", hitOrigin));
  add("Hit position", "Random seed of this step (timing / force jitter)", "seed", tv(h.seed, "–", "LOCAL", h.origin ? "drawn when the step was played" : "renderStep() default seed"));
  add("Hit position", "Per-foot strike strength", "s_foot", tv(h.force, "–", "LOCAL", h.force === 1 ? "single click: 1" : "planSteps(): ±10 % per foot, ±5 % per step"));
  add("Listener", "Listener position", "(x_L, y_L)", tv(`(${fmt(L.x, 3)}, ${fmt(L.y, 3)})`, "m", "ASSUMED", ui("listener dot on the floor plan")));
  add("Listener", "Ear height above the floor", "z_L", tv(EAR_HEIGHT, "m", "ASSUMED", "synth.js EAR_HEIGHT"));
  add("Listener", "Distance hit point → ear", "r", tv(r, "m", "LOCAL", `r = √((x − x_L)² + (y − y_L)² + z_L²) = √((${fmt(h.x - L.x, 3)})² + (${fmt(h.y - L.y, 3)})² + ${EAR_HEIGHT}²)`));
  add("Constants", "Gravity", "g", tv(G, "m/s²", "ASSUMED", "synth.js"));
  add("Constants", "Air density", "ρ0", tv(RHO_AIR, "kg/m³", "ASSUMED", "physics.js RHO_AIR"));
  add("Constants", "Speed of sound", "c0", tv(C_AIR, "m/s", "ASSUMED", "physics.js C_AIR"));
  add("Constants", "Sample rate", "fs", tv(FS, "Hz", "ASSUMED", "synth.js FS"));
  sections.push({ id: "inputs", title: "1 · Inputs", blocks: [{ type: "kv", rows: inputs, grouped: true }] });

  // ---- 2a. force pulse ---------------------------------------------------------------------
  const ff = footForce(shoe, pace, walker.massKg, mulberry32(h.seed), walker.run, h.force);
  const p = ff.parts, F = ff.F;
  let lastNz = 0, peakF = 0, impulseTot = 0;
  for (let i = 0; i < F.length; i++) { if (F[i] !== 0) lastNz = i; peakF = Math.max(peakF, F[i]); impulseTot += F[i] / FS; }
  const Tend = (lastNz + 1) / FS;
  const Inom = shoe.impulse * (pace.impact / 0.75) * (pace.click ?? 1) * Math.sqrt(walker.massKg / 75) * h.force;
  const fNull = 1.5 / ff.Th;
  const force = [
    { label: "Body weight × foot strength", sym: "BW", ...tv(p.BW, "N", "LOCAL", `BW = m·g·s_foot = ${walker.massKg}·${G}·${fmt(h.force)}`) },
    { label: "Heel contact time (this step)", sym: "T_h", ...tv(ff.Th, "s", "LOCAL", `T_h = T_h,0·(1 ± 12 % jitter, seed ${h.seed}) from ${fmt(shoe.heelMs / 1000)} s`) },
    { label: "Heel click impulse, nominal", sym: "I", ...tv(Inom, "N·s", "LOCAL", `I = I_0·(k_dyn/0.75)·√(m/75)·s_foot = ${shoe.impulse}·(${pace.impact}/0.75)·√(${walker.massKg}/75)·${fmt(h.force)}`) },
    { label: "Heel click impulse, this step", sym: "I'", ...tv(p.impulse, "N·s", "LOCAL", "I·(1 ± 15 % jitter)") },
    { label: "Heel click peak force (half-sine)", sym: "F_h", ...tv(ff.Fh, "N", "LOCAL", `F_h = I'·π/(2·T_h) = ${fmt(p.impulse)}·π/(2·${fmt(ff.Th)})`) },
    { label: "Forefoot click delay", sym: "t_toe", ...tv(p.toeDelay, "s", "LOCAL", `${walker.run ? "0.03" : "0.085"} s·(1 ± 15 %)`) },
    { label: "Forefoot click peak (half-sine, length 1.6·T_h)", sym: "F_toe", ...tv(p.toeClick, "N", "LOCAL", `F_toe = F_h·r_toe·(1 ± 15 %) ≈ ${fmt(ff.Fh)}·${shoe.toeRatio}`) },
    { label: "Heel loading peak (Hann pulse)", sym: "F_load", ...tv(p.heelLoad, "N", "LOCAL", `F_load = k_dyn·BW·(1 ± 8 %) ≈ ${pace.impact}·${fmt(p.BW)}`) },
    { label: "Heel loading duration", sym: "T_load", ...tv(p.heelLoadT, "s", "ASSUMED", "synth.js footForce(): 0.06 s walk, 0.05 s run") },
    { label: "Forefoot loading peak (Hann, 0.09 s)", sym: "F_toeload", ...tv(p.toeLoad, "N", "LOCAL", `0.3·BW·(1 ± 10 %) ≈ 0.3·${fmt(p.BW)}`) },
    { label: "Peak of the summed force", sym: "max F", ...tv(peakF, "N", "LOCAL", "max of the sampled F(t)") },
    { label: "Total impulse", sym: "∫F dt", ...tv(impulseTot, "N·s", "LOCAL", "Σ F[n]/fs over the sampled F(t)") },
    { label: "End of force pulse", sym: "T_end", ...tv(Tend, "s", "LOCAL", "last non-zero sample of F(t)") },
    { label: "First spectral null of the heel click", sym: "f_null", ...tv(fNull, "Hz", "LOCAL", `half-sine of length T_h: nulls at (k + ½)/T_h, k ≥ 1; f_null = 1.5/T_h = 1.5/${fmt(ff.Th)}`) },
  ];
  sections.push({ id: "force", title: "2a · Force pulse", blocks: [
    { type: "note", text: "The brief describes one half-sine with peak m·g·(dynamic factor). The app uses the four-part ground reaction force below (synth.js footForce). The dynamic factor k_dyn only scales the slow heel loading, which is mostly below 50 Hz. The audible part is the heel click. Its size is set by the shoe's impulse, not by m·g." },
    { type: "formula", text: "F(t) = F_h·sin(πt/T_h)|₀^{T_h} + F_toe·sin(π(t−t_toe)/(1.6T_h)) + F_load·½(1−cos(2πt/T_load)) + F_toeload·½(1−cos(2π(t−t_toe)/0.09 s))" },
    { type: "kv", rows: force },
    { type: "note", text: `Pulse shape: half-sine clicks and Hann loading pulses are a modelling choice [ASSUMED]. Above about 1/T_h = ${fmt(1 / ff.Th)} Hz the click spectrum falls about 12 dB per octave. The pulse spectrum |F̂(f)| at each mode frequency is in table 2c. It is a direct DFT of the sampled F(t) above, not an idealised formula.` },
  ] });

  // ---- per-mode chain ---------------------------------------------------------------------
  const rs = renderStep(model, { ...walker, x: h.x, y: h.y, seed: h.seed, force: h.force });
  const peakByF = new Map(rs.contrib.map((c) => [c.f, c.peak]));
  const modeRows = model.modes.map((m, k) => {
    const origin = !isFem ? "analytic" : m.tag === "analytic-ext" ? "analytic-ext" : "allsolve";
    const fTag = origin === "allsolve" ? "ALLSOLVE" : "LOCAL";
    const fSrc = origin === "allsolve" ? femSrc
      : origin === "analytic-ext" ? `physics.js extendModes(): analytic mode above the highest FEM mode (${fmt(meta.extendedFrom)} Hz)`
      : `physics.js analyticModes(): ${meta.note || "analytic estimate"}`;
    const phi = model.sample(m.shape, h.x, h.y);
    const w = 2 * Math.PI * m.f, zeta = 1 / (2 * m.Q), wd = w * Math.sqrt(1 - zeta * zeta);
    const sigma = zeta * w;
    const used = Math.abs(phi) >= 1e-4 && w / FS <= 2.6;
    const c = pulseCoef(F, m.f, sigma);
    const gain = (phi / m.mass) * m.R * radiation;
    const A = Math.abs(gain) * (w * w / wd) * c.damped;
    const eta = 1 / m.Q;
    return {
      k: k + 1, origin, used,
      f: tv(m.f, "Hz", fTag, fSrc),
      phi: tv(phi, "–", "LOCAL", origin === "allsolve" ? "bilinear interpolation of Allsolve probe values w_ij (12 × 8 grid, peak-normalised) at (x, y)" : "analytic shape at (x, y)", { derivedFrom: origin === "allsolve" ? "ALLSOLVE" : undefined }),
      Fhat: tv(c.plain, "N·s", "LOCAL", "|Σ F[n]·Δt·e^{−iωt_n}|"),
      mass: tv(m.mass, "kg", "LOCAL", "m_k = ρh·Σφ²ΔA + Σ_joists ρ_j b_j h_j ∫φ² dy (physics.js buildModel)"),
      R: tv(m.R, "m²", "LOCAL", "R_k = √(V² + s·S·A), V = Σφ ΔA, S = Σφ² ΔA, s = (f/f_c)²/(1+(f/f_c)²) + 0.02"),
      eta: tv(eta, "–", "LOCAL", J ? "η_k = (E_deck·η_deck + E_joists·η_j)/(E_deck + E_joists), kinetic-energy weights" : `η_k = η_deck = ${deck.eta}`),
      Q: tv(m.Q, "–", "LOCAL", "Q_k = 1/η_k"),
      sigma: tv(sigma, "1/s", "LOCAL", "σ_k = ω_k/(2Q_k) = π·f_k·η_k"),
      T60: tv(6.91 / sigma, "s", "LOCAL", "T60 = ln(1000)/σ_k = 6.91/σ_k (render caps each mode at 3.2 s)"),
      A: tv(used ? A : 0, "Pa", "LOCAL", "A_k = ρ0/(2πr)·R_k·|φ_k|/m_k·(ω_k²/ω_d,k)·|Σ F[n]Δt e^{(σ_k−iω_d,k)t_n}|"),
      measured: peakByF.has(m.f) ? tv(peakByF.get(m.f), "Pa", "LOCAL", "peak of this mode's pressure in renderStep() (the real synthesis)") : na(used ? "not rendered" : "skipped by renderStep: |φ| < 1e-4 at the hit point or above the Nyquist guard", "Pa"),
      raw: { f: m.f, phi, Fhat: c.plain, mass: m.mass, R: m.R, eta, Q: m.Q, sigma, A: used ? A : 0, wd },
    };
  });
  const audible = modeRows.filter((x) => x.used);
  const byLoud = [...audible].sort((a, b) => (b.measured.value ?? 0) - (a.measured.value ?? 0));
  const topN = byLoud.slice(0, 20).sort((a, b) => a.k - b.k);

  // ---- 2b. eigenfrequencies ---------------------------------------------------------------
  const eigBlocks = [];
  const nFem = modeRows.filter((x) => x.origin === "allsolve").length;
  const nExt = modeRows.filter((x) => x.origin === "analytic-ext").length;
  const rawList = isFem ? model.raw.rawEigenfrequencies : null;
  if (!isFem) {
    eigBlocks.push({ type: "note", kind: "warn", text: `No Allsolve result is active. All ${modeRows.length} modes are the instant analytical preview [LOCAL] (${meta.note || ""}). Press "Simulate with Allsolve" to replace them with FEM modes.` });
  } else {
    const summary = [
      { label: "Modes kept from Allsolve", sym: "N_FEM", ...tv(nFem, "–", "ALLSOLVE", femSrc) },
      { label: "Kept FEM band", sym: "f_1 … f_N", ...tv(`${fmt(modeRows[0].f.value)} … ${fmt(meta.extendedFrom ?? modeRows[nFem - 1].f.value)}`, "Hz", "ALLSOLVE", femSrc) },
      nExt ? { label: "Analytic modes added above the FEM band (up to 3 kHz)", sym: "N_ext", ...tv(nExt, "–", "LOCAL", "physics.js extendModes(): a solve returns a fixed number of modes; the band above is filled analytically") }
        : { label: "Analytic modes added above the FEM band", sym: "N_ext", ...tv(0, "–", "LOCAL", "physics.js extendModes(): FEM band already reaches 2.4 kHz") },
    ];
    eigBlocks.push({ type: "kv", rows: summary });
    if (rawList) {
      const rigid = rawList.filter((e) => /rigid/.test(e.dropped || ""));
      eigBlocks.push({ type: "kv", rows: [
        { label: "Eigenpairs returned by Allsolve", sym: "N_raw", ...tv(rawList.length, "–", "ALLSOLVE", femSrc) },
        { label: "Rigid-body modes (f < 1 Hz), excluded", sym: "N_rigid", ...tv(rigid.length, "–", "LOCAL", "allsolve_runner._extract_modes(): f < 1 Hz dropped") },
        { label: "Dropped: no vertical motion at any probe (in-plane)", sym: "N_inplane", ...tv(rawList.filter((e) => /in-plane/.test(e.dropped || "")).length, "–", "LOCAL", "allsolve_runner._extract_modes()") },
      ] });
      eigBlocks.push({ type: "table", title: "Every eigenfrequency Allsolve returned", collapsed: true,
        columns: [["index", "#"], ["f", "f"], ["status", "status"]],
        rows: rawList.map((e) => ({ index: e.index + 1, f: e.f == null ? na("no value") : tv(e.f, "Hz", "ALLSOLVE", femSrc), status: e.kept ? "kept" : `excluded: ${e.dropped}` })) });
    } else {
      eigBlocks.push({ type: "note", kind: "warn", text: `The full list of returned eigenfrequencies (including any rigid-body modes) is not available. This result was cached on ${active.computedAt || "an unrecorded date"}, before the runner stored that list. The runner drops f < 1 Hz (rigid-body) and modes with no vertical motion at the probes. With clamped supports no rigid-body modes are expected. Press "Solve again" with "Ignore saved result" to record it.` });
    }
    eigBlocks.push({ type: "table", title: `Kept modes (${nFem} Allsolve${nExt ? ` + ${nExt} analytic` : ""})`, collapsed: true,
      columns: [["k", "#"], ["f", "f"], ["origin", "origin"]],
      rows: modeRows.map((x) => ({ k: x.k, f: x.f, origin: x.origin === "allsolve" ? "Allsolve FEM" : x.origin === "analytic-ext" ? "analytic extension" : "analytic preview" })) });
  }
  sections.push({ id: "eigen", title: "2b · Eigenfrequencies", blocks: eigBlocks });

  // ---- 2c. mode weighting -----------------------------------------------------------------
  sections.push({ id: "weighting", title: "2c · Mode weighting at the hit point", blocks: [
    { type: "note", text: `Hit point (${fmt(h.x, 3)} m, ${fmt(h.y, 3)} m): ${hitOrigin}. φ_k is the peak-normalised vertical mode shape there. ${isFem ? "For FEM modes it is interpolated from the 12 × 8 probe values Allsolve returned. The interpolation is LOCAL; the probe values are ALLSOLVE." : ""} ${audible.length} of ${modeRows.length} modes move at this point (|φ| ≥ 1e-4). The table shows the 20 loudest; the export has all of them.` },
    { type: "table", columns: [["k", "#"], ["f", "f_k"], ["phi", "φ_k(x,y)"], ["Fhat", "|F̂(f_k)|"], ["mass", "m_k"], ["R", "R_k"]], rows: topN },
  ] });

  // ---- 2d. damping ------------------------------------------------------------------------
  sections.push({ id: "damping", title: "2d · Damping", blocks: [
    { type: "note", kind: "warn", text: `No damping comes from Allsolve. The eigenmode solve is undamped. Every mode gets a loss factor from surfaces.json [ASSUMED]: ${deck.name} η = ${deck.eta}${J ? `, ${J.name} joists η = ${J.eta}` : ""}. These are loss factors for built-up structures (joints, fixings), not for the clear material. Model: constant loss factor per material (hysteretic), so σ_k grows in proportion to f_k.` },
    { type: "formula", text: "η_k = (T_deck,k·η_deck + T_joist,k·η_joist)/(T_deck,k + T_joist,k)   Q_k = 1/η_k   σ_k = π·f_k·η_k   T60_k = 6.91/σ_k" },
    { type: "table", columns: [["k", "#"], ["f", "f_k"], ["eta", "η_k"], ["Q", "Q_k"], ["sigma", "σ_k"], ["T60", "T60_k"]], rows: topN },
  ] });

  // ---- 2e. synthesis ----------------------------------------------------------------------
  const top5 = byLoud.slice(0, 5);
  const synthLines = top5.map((x) => {
    const R = x.raw;
    return `${fmt(R.A, 3)} Pa · e^(−${fmt(R.sigma, 3)}·t) · sin(2π·${fmt(R.wd / (2 * Math.PI), 5)}·t + θ${x.k})`;
  });
  sections.push({ id: "synthesis", title: "2e · Final synthesis", blocks: [
    { type: "formula", text: "Each mode:  q̈_k + (ω_k/Q_k)·q̇_k + ω_k²·q_k = φ_k(x,y)·F(t)/m_k        Pressure at the ear:  p(t) = ρ0/(2πr)·Σ_k R_k·q̈_k(t)" },
    { type: "note", text: `After the pulse (t ≥ T_end = ${fmt(Tend)} s) every mode rings freely, so the same thing is a sum of decaying sines: p(t) = Σ_k A_k·e^(−σ_k t)·sin(ω_d,k t + θ_k), with ω_d,k = ω_k·√(1 − 1/(4Q_k²)) and A_k = ρ0/(2πr)·R_k·|φ_k|/m_k·(ω_k²/ω_d,k)·|Σ_n F[n]Δt·e^((σ_k − iω_d,k)t_n)|. This uses r = ${fmt(r)} m and ρ0/(2πr) = ${fmt(radiation)} kg/m⁴. The phases θ_k come from the same complex sum. The 5 modes below are the loudest ones in the real render.` },
    { type: "formula", text: top5.length ? `p(t) ≈ ${synthLines.join("\n     + ")}\n     + (${Math.max(0, audible.length - 5)} more modes) + contact click + high-frequency fill,   t ≥ ${fmt(Tend)} s` : "No mode moves at this point." },
    { type: "table", columns: [["k", "#"], ["f", "f_k"], ["A", "A_k (closed form)"], ["measured", "peak in renderStep()"], ["sigma", "σ_k"]], rows: top5 },
    { type: "note", text: "A_k is the amplitude extrapolated back to t = 0. The measured peak is what the real synthesis produced. It can be lower than A_k when the mode decays while the pulse is still acting. It can be higher when the heel click rings the mode first and the forefoot click, about 85 ms later, partly cancels it. Matching orders of magnitude confirm that the closed form describes the code. The output also contains two parts that are not modal: (1) a contact click, filtered noise with amplitude 2.2e-4·F_h·k_h·contact/r, all coefficients [ASSUMED]; (2) statistical high-frequency noise above the highest mode [LOCAL/ASSUMED]." },
    { type: "kv", rows: [
      { label: "Peak pressure of this step (all parts)", sym: "p_peak", ...tv(rs.peakPa, "Pa", "LOCAL", "renderStep()") },
      { label: "Peak level", sym: "L_peak", ...tv(dbSPL(rs.peakPa), "dB SPL", "LOCAL", "20·log10(p_peak / 20 µPa)") },
      { label: "Material contact factor", sym: "contact", ...tv(deck.contact, "–", "ASSUMED", cs(`materials.${deckId}.contact`)) },
    ] },
  ] });

  // ---- 3. validation ----------------------------------------------------------------------
  const P = plateProps(cat, deckId, spec.thickness);
  const ana = ssPlateModes(P, spec.Lx, spec.Ly);
  const Dsrc = deck.kind === "wood"
    ? `orthotropic (Huber): D_x = E_L h³/(12(1−ν_LTν_TL)) = ${fmt(P.Dx)} N·m, D_y = ${fmt(P.Dy)} N·m, H = ν_LT D_y + 2·G_LT h³/12 = ${fmt(P.H)} N·m`
    : `D = E h³/(12(1−ν²)) = ${fmt(deck.E)}·${fmt(spec.thickness)}³/(12·(1−${deck.nu}²)) = ${fmt(P.Dx)} N·m`;
  const valBlocks = [
    { type: "formula", text: deck.kind === "wood"
      ? "f_mn = (π/2)·√[(D_x(m/a)⁴ + 2H(m/a)²(n/b)² + D_y(n/b)⁴)/(ρh)]   (reduces to (π/2)·√(D/ρh)·((m/a)²+(n/b)²) when isotropic)"
      : "f_mn = (π/2)·√(D/(ρh))·((m/a)² + (n/b)²),   D = E h³/(12(1 − ν²))" },
    { type: "note", text: `${Dsrc}; ρh = ${fmt(P.mass)} kg/m²; a = ${spec.Lx} m, b = ${spec.Ly} m. Thin-plate theory: h/b = ${fmt(spec.thickness / Math.min(spec.Lx, spec.Ly), 2)}${spec.thickness / Math.min(spec.Lx, spec.Ly) > 0.05 ? ". At this ratio, shear and rotary inertia make the true (and FEM) frequencies lower than the formula. Expect negative errors that grow with m and n." : "."}` },
  ];
  const ss = related.ssPlate;
  const ssRun = ss && !ss.error ? runInfo("SS validation plate", ss) : null;
  const ssF = ssRun ? ss.modes.map((m) => m.f).sort((a, b) => a - b) : null;
  valBlocks.push({ type: "table", title: "(a) Simply supported plate: analytic vs Allsolve",
    columns: [["mn", "(m,n)"], ["fa", "f_mn analytic"], ["ff", "f Allsolve (SS plate)"], ["err", "error"], ["pass", `within ±${PASS_TOL * 100} %`]],
    rows: ana.map((a, i) => {
      const fem = ssF ? ssF[i] : undefined;
      const err = fem !== undefined ? (fem - a.f) / a.f : null;
      return {
        mn: `(${a.m},${a.n})`,
        fa: tv(a.f, "Hz", "LOCAL", "f_mn formula above"),
        ff: fem !== undefined ? tv(fem, "Hz", "ALLSOLVE", asSrc(ssRun)) : na(ss?.error ? `run failed: ${ss.error}` : "not run yet: press \"Run SS-plate check\"", "Hz"),
        err: err !== null ? tv(err * 100, "%", "LOCAL", "(f_FEM − f_mn)/f_mn") : na("needs the SS-plate run", "%"),
        pass: err !== null ? (Math.abs(err) <= PASS_TOL ? "pass" : "fail") : "–",
      };
    }) });
  if (ssRun) valBlocks.push({ type: "note", text: `Modes are matched by order (the i-th FEM frequency against the i-th analytic one), so nearly coincident pairs can swap. SS-plate supports in Allsolve: "${ssRun.boundary}". Pinning the bottom edges of a 3D solid approximates simple support for a thin plate. Pass band ±${PASS_TOL * 100} % [ASSUMED].` });

  const cc = crossCheck(cat, model);
  valBlocks.push({ type: "kv", title: "Active floor against textbook references (approximate only, not pass/fail)", rows: [
    { label: "f_11 of the whole deck as an SS plate", sym: "f_11", ...tv(ana[0].f, "Hz", "LOCAL", "f_mn formula above") },
    { label: `Lowest mode of the active floor (${isFem ? "Allsolve" : "analytic"})`, sym: "f_1", ...(isFem ? tv(modeRows[0].f.value, "Hz", "ALLSOLVE", femSrc) : tv(modeRows[0].f.value, "Hz", "LOCAL", "analytic preview")) },
    { label: "Textbook estimate of the active floor (rigid-joist bays / clamped slab)", sym: "f_est", ...tv(cc.analytic, "Hz", "LOCAL", "physics.js analyticModes(): the existing Physics check") },
    { label: "Floor vs textbook estimate", sym: "Δ", ...tv(cc.diff * 100, "%", "LOCAL", "(f_1 − f_est)/f_est") },
  ] });
  valBlocks.push({ type: "note", kind: "warn", text: `The active floor is "${isFem ? active.boundary : boundaryOf(spec)}". That is not a simply supported plate, and not a free-edged one. These comparisons only show whether the result is in the expected range. They are not pass/fail.` });

  // (b) mesh convergence
  const fine = related.meshFine;
  if (isFem && fine && !fine.error) {
    const fr = runInfo("Refined mesh", fine);
    const f0 = modeRows.filter((x) => x.origin === "allsolve").map((x) => x.f.value), f1 = fine.modes.map((m) => m.f).sort((a, b) => a - b);
    const n = Math.min(N_CONV, f0.length, f1.length);
    const rows = [];
    let worst = 0;
    for (let i = 0; i < n; i++) { const d = (f1[i] - f0[i]) / f0[i]; worst = Math.max(worst, Math.abs(d)); rows.push({ k: i + 1, f0: tv(f0[i], "Hz", "ALLSOLVE", femSrc), f1: tv(f1[i], "Hz", "ALLSOLVE", asSrc(fr)), d: tv(d * 100, "%", "LOCAL", "(f_fine − f_base)/f_base") }); }
    valBlocks.push({ type: "table", title: `(b) Mesh convergence: h_mesh ${fmt(active.meshMaxSize * 1000)} mm → ${fmt(fr.meshMaxSize * 1000)} mm`,
      columns: [["k", "#"], ["f0", `f (h = ${fmt(active.meshMaxSize * 1000)} mm)`], ["f1", `f (h = ${fmt(fr.meshMaxSize * 1000)} mm)`], ["d", "change"]], rows });
    valBlocks.push({ type: "kv", rows: [{ label: `Largest change over the first ${n} modes`, sym: "max |Δ|", ...tv(worst * 100, "%", "LOCAL", "max over the table") },
      { label: "Nodes, base → refined", sym: "N", ...tv(`${active.mesh?.nodes ?? "?"} → ${fr.mesh?.nodes ?? "?"}`, "–", "ALLSOLVE", "mesh metrics of both runs") }] });
  } else {
    valBlocks.push({ type: "kv", title: "(b) Mesh convergence", rows: [{ label: "Frequencies at two mesh sizes", sym: "", ...na(!isFem ? "needs an Allsolve result" : fine?.error ? `refined run failed: ${fine.error}` : "only one mesh size solved for this floor: press \"Refine mesh\"") }] });
  }

  // (c) sensitivity on the SS plate
  const sens = [];
  const sensCase = (label, res, expected, expectedSrc) => {
    if (!ssRun || !res || res.error) {
      sens.push({ title: label, rows: [{ label: "Expected vs actual", sym: "", ...na(!ssRun ? "needs the SS-plate run" : res?.error ? `run failed: ${res.error}` : "not run yet: press \"Run sensitivity\"") }] });
      return;
    }
    const run = runInfo(label, res);
    const f1 = res.modes.map((m) => m.f).sort((a, b) => a - b);
    const n = Math.min(6, ssF.length, f1.length);
    const rows = [];
    for (let i = 0; i < n; i++) {
      const ratio = f1[i] / ssF[i];
      rows.push({ k: i + 1, base: tv(ssF[i], "Hz", "ALLSOLVE", asSrc(ssRun)), changed: tv(f1[i], "Hz", "ALLSOLVE", asSrc(run)),
        exp: tv(expected, "–", "LOCAL", expectedSrc), act: tv(ratio, "–", "LOCAL", "f_changed/f_base"), err: tv((ratio / expected - 1) * 100, "%", "LOCAL", "actual/expected − 1") });
    }
    sens.push({ title: label, table: rows });
  };
  if (related.ssHalf && !related.ssHalf.error) {
    const t2 = specOf(related.ssHalf).thickness;
    sensCase(`(c1) Half thickness: h ${spec.thickness} → ${t2} m`, related.ssHalf, t2 / spec.thickness, `bending f ∝ h (D ∝ h³, ρh ∝ h): ${t2}/${spec.thickness}`);
  } else sensCase("(c1) Half thickness", related.ssHalf, 0.5, "");
  const altId = related.altMaterialId, alt = altId ? cat.materials[altId] : null;
  if (alt && related.ssAlt && !related.ssAlt.error) {
    const iso = deck.kind !== "wood";
    const e = Math.sqrt((alt.E / alt.rho) / (deck.E / deck.rho)) * (iso ? Math.sqrt((1 - deck.nu ** 2) / (1 - alt.nu ** 2)) : 1);
    sensCase(`(c2) Material: ${deck.name} → ${alt.name}`, related.ssAlt, e,
      `√((E₂/ρ₂)/(E₁/ρ₁))${iso ? "·√((1−ν₁²)/(1−ν₂²))" : " (same wood ratios)"} = √((${fmt(alt.E)}/${alt.rho})/(${fmt(deck.E)}/${deck.rho}))${iso ? `·√((1−${deck.nu}²)/(1−${alt.nu}²))` : ""}`);
  } else sensCase(`(c2) Material swap${alt ? `: ${deck.name} → ${alt.name}` : ""}`, related.ssAlt, 1, "");
  for (const s of sens) {
    if (s.table) valBlocks.push({ type: "table", title: s.title, columns: [["k", "#"], ["base", "f base"], ["changed", "f changed"], ["exp", "expected ratio"], ["act", "actual ratio"], ["err", "deviation", "col:dev"]], rows: s.table });
    else valBlocks.push({ type: "kv", title: s.title, rows: s.rows });
  }
  sections.push({ id: "validation", title: "3 · Validation", blocks: valBlocks });

  // ---- 4. runs & meta ---------------------------------------------------------------------
  const runs = [active, ssRun, ...["ssHalf", "ssAlt", "meshFine"].map((k) => related[k] && !related[k].error ? runInfo({ ssHalf: "SS plate, half thickness", ssAlt: "SS plate, other material", meshFine: "Refined mesh" }[k], related[k]) : null)].filter(Boolean);
  const metaRows = [
    { label: "Report generated", sym: "", ...tv(new Date().toISOString(), "", "LOCAL", "browser clock") },
    { label: "Allsolve SDK on the server now", sym: "", ...(status?.sdkVersion ? tv(status.sdkVersion, "", "LOCAL", "GET /api/status (allsolve.__version__)") : na("server offline or SDK not installed")) },
    { label: "Allsolve SDK that produced the active result", sym: "", ...(active?.sdkVersion ? tv(active.sdkVersion, "", "ALLSOLVE", "recorded in the result at solve time") : na(isFem ? "not recorded: result cached before the version was stored" : "no Allsolve result active")) },
  ];
  sections.push({ id: "runs", title: "4 · Jobs & provenance", blocks: [
    { type: "kv", rows: metaRows },
    runs.length ? { type: "table", columns: [["role", "run"], ["simulationId", "simulation id"], ["projectId", "project"], ["computedAt", "job ran"], ["cache", "cache"], ["mesh", "h_mesh"], ["boundary", "supports"]],
      rows: runs.map((x) => ({ role: x.role, simulationId: x.simulationId || "not recorded", projectId: x.projectId || "–", computedAt: x.computedAt || "–",
        cache: x.fromCache ? "loaded from cache" : "fresh", mesh: x.meshMaxSize ? tv(x.meshMaxSize * 1000, "mm", "LOCAL", "mesh_size_max() × scale") : na("–"), boundary: x.boundary })) }
      : { type: "note", kind: "warn", text: "No Allsolve job is behind the current sound. It comes from the analytical preview." },
  ] });

  attachHelp(sections);
  return {
    generator: "ModalForge · Math & provenance",
    generatedAt: new Date().toISOString(),
    surface: surfaceName || surface?.name || spec.surfaceId,
    source: model.source,
    banner: isFem ? null : "No Allsolve result active: the modes come from the analytical preview.",
    tags: TAGS,
    runs,
    sections,
    data: {
      hit: { x: h.x, y: h.y, seed: h.seed, force: h.force, origin: hitOrigin, r, units: { x: "m", y: "m", r: "m" } },
      modes: modeRows.map(({ raw, used, ...x }) => ({ ...x, contributes: used })),
      rawEigenfrequencies: rawList || null,
      analyticSS: ana.map((a) => ({ m: a.m, n: a.n, f: tv(a.f, "Hz", "LOCAL", "f_mn formula") })),
    },
  };
}

// ------------------------------------------------------------------------------- render: HTML
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pill = (tag) => tag ? `<span class="tag tag-${tag.toLowerCase()}" title="${esc(TAGS[tag])}">${tag}</span>` : "";
const helpBtn = (text, what) => text ? `<button type="button" class="help-q" data-help="${esc(text)}" data-what="${esc(what)}" aria-label="What is ${esc(what)}?">?</button>` : "";
const isTv = (v) => v && typeof v === "object" && ("tag" in v || "na" in v);

function valHtml(v, withTag = true) {
  if (!isTv(v)) return esc(v);
  if (v.na) return `<span class="na" title="${esc(v.na)}">not available</span> <span class="na-why">${esc(v.na)}</span>`;
  if (v.text) return `${withTag ? pill(v.tag) : ""}`;
  const num = typeof v.value === "number" ? fmt(v.value) : esc(v.value);
  return `<span class="num" title="${esc(v.source)}">${num}${v.unit && v.unit !== "–" ? ` <i>${esc(v.unit)}</i>` : ""}</span>${withTag ? " " + pill(v.tag) : ""}`;
}

/** Column tag shown once in the header when every cell in it shares it (and a cell source tooltip stays). */
function columnTag(rows, key) {
  const tags = new Set(rows.map((r) => (isTv(r[key]) ? (r[key].na ? "NA" : r[key].tag) : "TXT")));
  tags.delete("NA");
  return tags.size === 1 && !tags.has("TXT") ? [...tags][0] : null;
}

function blockHtml(b) {
  const title = b.title ? `<h4>${esc(b.title)}</h4>` : "";
  if (b.type === "note") return `<p class="mp-note${b.kind ? " " + b.kind : ""}">${esc(b.text)}</p>`;
  if (b.type === "formula") return `${title}<pre class="mp-formula">${esc(b.text)}</pre>`;
  if (b.type === "kv") {
    let group = null, out = "";
    for (const r of b.rows) {
      if (b.grouped && r.group !== group) { group = r.group; out += `<tr class="grp"><th colspan="3">${esc(group)}</th></tr>`; }
      out += `<tr><td>${esc(r.label)}${r.sym ? ` <code>${esc(r.sym)}</code>` : ""} ${helpBtn(r.help, r.sym || r.label)}</td><td>${valHtml(r)}</td><td class="src">${esc(r.na ? "" : r.source)}</td></tr>`;
    }
    return `${title}<table class="mp-kv">${out}</table>`;
  }
  if (b.type === "table") {
    const ctag = Object.fromEntries(b.columns.map(([k]) => [k, columnTag(b.rows, k)]));
    const head = b.columns.map(([k, label, help]) => `<th>${esc(label)} ${helpBtn(help, label)} ${pill(ctag[k])}</th>`).join("");
    const body = b.rows.map((r) => `<tr>${b.columns.map(([k]) => `<td>${valHtml(r[k], !ctag[k])}</td>`).join("")}</tr>`).join("");
    const t = `<div class="mp-scroll"><table class="mp-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    return b.collapsed ? `<details class="mp-sub"><summary>${esc(b.title)} · ${b.rows.length} rows</summary>${t}</details>` : `${title}${t}`;
  }
  return "";
}

export function renderHtml(rep) {
  const legend = Object.entries(TAGS).map(([k, v]) => `<span>${pill(k)} ${esc(v)}</span>`).join("");
  return `${rep.banner ? `<p class="mp-note warn">${esc(rep.banner)}</p>` : ""}
    <p class="mp-legend">${legend}<span class="hint">Hover a number to see its formula or job id.</span></p>
    ${rep.sections.map((s, i) => `<details class="mp-sec" ${i < 1 || s.id === "synthesis" ? "open" : ""}><summary>${esc(s.title)}</summary>${s.blocks.map(blockHtml).join("")}</details>`).join("")}`;
}

// ------------------------------------------------------------------------------- render: Markdown
const mdEsc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
function valMd(v, withTag = true) {
  if (!isTv(v)) return mdEsc(v);
  if (v.na) return `not available (${mdEsc(v.na)})`;
  if (v.text) return withTag ? `[${v.tag}]` : "";
  const num = typeof v.value === "number" ? fmt(v.value) : mdEsc(v.value);
  return `${num}${v.unit && v.unit !== "–" ? ` ${v.unit}` : ""}${withTag ? ` [${v.tag}]` : ""}`;
}

export function renderMarkdown(rep) {
  const L = [];
  L.push(`# ModalForge: math & provenance report`, "");
  L.push(`- Surface: ${rep.surface}`, `- Generated: ${rep.generatedAt}`, `- Mode source: ${rep.source === "allsolve" ? "Allsolve FEM" : "analytical preview"}`);
  for (const r of rep.runs) L.push(`- Allsolve run (${r.role}): simulation \`${r.simulationId || "not recorded"}\`, project \`${r.projectId || "?"}\`, job ran ${r.computedAt || "?"}${r.fromCache ? " (loaded from cache)" : ""}`);
  L.push("");
  if (rep.banner) L.push(`> **${rep.banner}**`, "");
  L.push("**Tags:** " + Object.entries(TAGS).map(([k, v]) => `\`[${k}]\` ${v}`).join(" · "), "");
  for (const s of rep.sections) {
    L.push(`## ${s.title}`, "");
    for (const b of s.blocks) {
      if (b.title) L.push(`### ${b.title}`, "");
      if (b.type === "note") L.push(`${b.kind === "warn" ? "> **Note:** " : ""}${b.text}`, "");
      else if (b.type === "formula") L.push("```", b.text, "```", "");
      else if (b.type === "kv") {
        let group = null;
        for (const r of b.rows) {
          if (b.grouped && r.group !== group) { group = r.group; L.push("", `**${group}**`, ""); }
          const v = r.text ? `[${r.tag}]` : valMd(r);
          L.push(`- ${r.label}${r.sym ? ` (\`${r.sym}\`)` : ""}: ${v}${r.source && !r.na ? ` (${r.source})` : ""}`);
        }
        L.push("");
      } else if (b.type === "table") {
        const ctag = Object.fromEntries(b.columns.map(([k]) => [k, columnTag(b.rows, k)]));
        L.push(`| ${b.columns.map(([k, l]) => mdEsc(l) + (ctag[k] ? ` [${ctag[k]}]` : "")).join(" | ")} |`);
        L.push(`|${b.columns.map(() => "---").join("|")}|`);
        for (const r of b.rows) L.push(`| ${b.columns.map(([k]) => valMd(r[k], !ctag[k])).join(" | ")} |`);
        const srcs = b.columns.filter(([k]) => ctag[k]).map(([k, l]) => {
          const first = b.rows.find((r) => isTv(r[k]) && !r[k].na);
          return first ? `${l}: ${first[k].source}` : null;
        }).filter(Boolean);
        L.push("");
        if (srcs.length) L.push(`<sub>Sources: ${srcs.map(mdEsc).join("; ")}</sub>`, "");
      }
    }
  }
  // Glossary: the "?" explanations of every symbol and column used above
  const seen = new Map();
  for (const s of rep.sections) for (const b of s.blocks) {
    if (b.type === "kv") for (const r of b.rows) if (r.help) seen.set(r.sym || r.label, r.help);
    if (b.type === "table") for (const [, label, help] of b.columns) if (help && !seen.has(label)) seen.set(label, help);
  }
  if (seen.size) {
    L.push("## Glossary", "");
    for (const [k, v] of seen) L.push(`- **${k}**: ${v}`);
    L.push("");
  }
  return L.join("\n");
}
