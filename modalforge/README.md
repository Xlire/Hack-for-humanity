# ModalForge · Footstep lab

Physically simulated footstep sounds. Pick a floor, walk on it, download the sound.
The floor's vibration (its natural modes) is solved in 3D by **Quanscient Allsolve**; the browser
turns those modes into sound in real time. No recorded samples are used.

## Run it

1. Put your Allsolve API key in `.env` (already created, git-ignored):
   ```
   ALLSOLVE_ACCESS_KEY=...
   ALLSOLVE_SECRET_KEY=...
   ALLSOLVE_HOST=https://allsolve.quanscient.com/
   ```
   Organization keys and project keys both work. A project key cannot create projects, so
   ModalForge reuses the key's own project and clears it before each run.
2. Double-click `start.bat` (first run creates `.venv` and installs `requirements.txt`).
   Or manually: `python -m venv .venv`, `.venv\Scripts\pip install -r requirements.txt`,
   `.venv\Scripts\python -m uvicorn backend.server:app --port 8000`.
3. Open http://localhost:8000. The status pill (top right) shows whether the key is loaded;
   click it to reload keys or test the connection without restarting.

## How it works

```
browser (frontend/)                         server (backend/)                   Allsolve cloud
-------------------                         -----------------                   --------------
choose surface, thickness, joists  ──POST /api/simulations──▶  build_spec()  ──▶ geometry: deck + joists
                                                                                  orthotropic wood / steel / glass / concrete
analytical preview (instant)                                                      clamp joist ends (or slab edges)
                                                                                  mesh ≈ 6 elements per bending wavelength @ 2.5 kHz
                                   ◀── modes + shapes (JSON) ─  cache/results/  ◀ eigenmode solve, 100 modes
                                                                                  w(x,y) probed on a 12 × 8 grid
modal synthesis → binaural / stereo / 5.1 / 7.1 + room echo → WAV / ZIP / JSON
```

**Sound model (frontend/js/synth.js).** Each footstep is a ground reaction force: a short heel
"click" (small effective mass; impulse 0.03–0.3 N·s depending on footwear; the ISO 10140 tapping
machine, built to imitate heels, gives 0.44 N·s) plus smooth body-weight loading. Every mode is
driven as `q̈ + (ω/Q) q̇ + ω² q = φ(step) F(t) / m`, and the radiated pressure at the listener is
`p = ρ0 / (2π r) · Σ R q̈` (baffled radiator; R ramps from net volume displacement to full area
toward the coincidence frequency). A contact-noise burst and a statistical high-frequency fill
above the highest solved mode complete the sound. Damping uses loss factors for built-up
structures (joints, fixings), listed in `frontend/data/surfaces.json`.

**Above the solved band.** A solve returns a fixed number of modes (100). On a thin, stiff, lightly
damped deck these can all sit low: the steel catwalk's 100 FEM modes stop at 594 Hz, which leaves
out the metallic ring. `buildModel()` adds analytic modes from the highest solved mode up to 3 kHz.
The Physics check panel lists how many modes it added.

**Floor size.** Width (1–6 m) and Depth (1–5 m) sliders, in 10 cm steps; Landing and Small room stay as presets.
The analytic modes and their shape grid (about 10 cm cells) grow with the floor. An Allsolve solve takes longer
for big floors, and each size is cached separately.

**Listening.** The listener has a position and a facing direction. Drag the teal dot or press Q/E to turn.
Output can be *Headphones* (Web Audio HRTF, with front/back and below-ear cues), *Speakers*
(equal-power pan; sources behind are darkened), or *5.1 / 7.1* (pairwise panning over ITU speaker angles, plus LFE).
Surround plays as a stereo fold-down on devices that have fewer channels. Exports always keep every channel
(WAVE_FORMAT_EXTENSIBLE). Room echo presets are Normal room, Vocal booth, Office, Outside (slap-back),
Cave (discrete echoes), Gymnasium (flutter echo) and Church. Each output channel gets its own
decorrelated impulse response. **Loop** (or `L`) keeps walking the path with fresh step variations until Stop.

**Exports for game engines.**
- **Walk, step by step:** every step of the last walk as its own mono, dry WAV, plus the full mix and `steps.csv`.
  Single steps can also be downloaded from the step list.
- **Game engine pack:** current surface + footwear, all four paces.
  - 10 one-shot variations per pace, 48 kHz / 24-bit / mono / dry. The transient is at sample 0, so it lines up with animation events.
  - One shared gain to −1 dBFS keeps the relative loudness between paces.
  - Also included: a seamless walk loop, a wet preview, `manifest.json/csv` (seed + position per file, so any file can be re-rendered), and a README with Unity, Unreal (MetaSound / Sound Cue) and FMOD/Wwise setup.
  - The files are mono and dry because engines spatialise and add reverb themselves.

**Physics check.** The app compares Allsolve's lowest mode against a textbook estimate
(orthotropic plate bays between clamped joists, or a clamped slab). Pine floor, 2.4 × 1.8 m:
FEM 157 Hz vs textbook 138 Hz (+14 %): continuous boards are partly held at each joist, so they
behave stiffer than the simply supported bays in the estimate.

**Demo reliability.** Every Allsolve result is cached in `cache/results/` by floor configuration.
The app loads a saved result instantly when the same floor is selected; tick
"Ignore saved result" to solve again. Without a key or a server, the analytical preview still works.

## Files

| Path | What |
|---|---|
| `backend/server.py` | FastAPI: static app, simulation jobs, cache, API key status/reload/test |
| `backend/allsolve_runner.py` | The Allsolve model: geometry, regions, materials, physics, mesh, eigenmode solve, result extraction |
| `backend/model.py` | Floor spec validation, joist layout, wood stiffness matrix, mesh sizing |
| `backend/settings.py` | Reads `.env` (re-readable at runtime) |
| `frontend/js/physics.js` | Analytical modes, modal mass / damping / radiation per mode |
| `frontend/js/synth.js` | Footstep force, modal synthesis, walking, room reverb |
| `frontend/js/spatial.js` | Listener-relative panning: HRTF, stereo, 5.1 / 7.1, surround fold-down |
| `frontend/js/export.js` | WAV (16/24-bit, multichannel), trim / loop helpers, ZIP |
| `frontend/js/floor.js` | Floor plan, live vibration view, loudness map |
| `frontend/data/surfaces.json` | Materials, surface presets, shoes, paces, rooms (shared by both sides) |

Keyboard: `Space` walk / stop, `S` random step, `L` loop on/off, `Q`/`E` turn the listener. Test hooks: `/#selftest`, `/#shot`.

## Allsolve SDK feedback log (judging criterion 3)

Measured while building this app with `allsolve` 0.5.2:

| # | What happened | Cost to us | Suggested fix |
|---|---|---|---|
| 1 | A **project API key** fails at `create_project()` with `Operation not authorized with a project API key` only at runtime; nothing at `Client()` time says which key type you hold. | One failed cloud round trip and a code path rewrite | Expose key type in `Client` repr / `get_quota()`, and have examples branch on `client.is_project_api_key()` |
| 2 | Value outputs from an eigenmode solve are stored as `"name (real)"` and `"name (imag)"`; the name you created (`w_00_00`) returns `None` silently. | A full 5-minute solve wasted before we noticed | Accept the plain name (default to real part) or raise `KeyError` listing available headers |
| 3 | Selecting faces needs hand-built bounding boxes with tolerances (joist end faces, slab edges). Names given to primitives (`add_box(name="joist_0")`) can't select faces. | ~40 lines of region code | Named faces from primitives (`box.face("y-")`) |
| 4 | Expressions are untyped strings (`"interpolate(reg.deck, compz(u), [x, y, z])"`); typos fail only on the server. | Slow feedback loop | Client-side expression parse / validation |
| 5 | Job status is polling only (`is_running(refresh_delay_s=…)`), and log lines arrive in batches, so a web progress bar has to guess. | Custom progress heuristics | Async API or webhooks; structured progress events (mesh %, eigen solver iteration) |
| 6 | The SDK has `SolidMechanicsProportionalDamping` and a `QFactors` output, but we found no example combining them with an eigenmode solve, so damping stays on our side (loss factors per material). | Extra modelling decisions | Add an example: damped eigenmodes + Q factors in one run |

What worked well: the build order (variables → geometry → regions → materials → physics → mesh →
simulation) is clear; `create_simulation_eigenmode` + `interpolate()` probes gave mode shapes at
arbitrary points without downloading field files; the cloud solve of 165 k DOF / 117 modes took
≈ 5 minutes including queueing.
