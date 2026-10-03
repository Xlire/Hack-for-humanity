# ModalForge · Footstep lab

**Footstep sounds made with physics, not recordings.** Pick a floor, walk on it, and download the sound.

The floor's vibration (its natural *modes*) is solved in 3D by **Quanscient Allsolve**. The browser turns
those modes into sound in real time. No recorded samples are used.

> **No Allsolve key?** The app still works. It uses an instant textbook estimate (the *preview*) instead of the 3D solve.

---

## Contents

1. [Quick start](#quick-start)
2. [Using the app](#using-the-app)
3. [Exporting sounds](#exporting-sounds)
4. [Keyboard shortcuts](#keyboard-shortcuts)
5. [Troubleshooting](#troubleshooting)
6. [Preparing a demo (pre-computing results)](#preparing-a-demo-pre-computing-results)
7. [How it works](#how-it-works)
8. [Project files](#project-files)
9. [Allsolve SDK feedback log](#allsolve-sdk-feedback-log-judging-criterion-3)

---

## Quick start

**You need:** Windows, Python 3.10 or newer on your `PATH`, and a modern browser (Chrome, Edge or Firefox).
An Allsolve API key is optional.

1. **Add your Allsolve key (optional).** Copy `.env.example` to `.env` and fill in:
   ```
   ALLSOLVE_ACCESS_KEY=your-access-key-here
   ALLSOLVE_SECRET_KEY=your-secret-key-here
   ALLSOLVE_HOST=https://allsolve.quanscient.com/
   ```
   Create a key in the Allsolve web UI under *Settings → Organization → API keys → Create key*.
   Organization keys and project keys both work (see [Troubleshooting](#troubleshooting) for the difference).

2. **Start the app.** Double-click `start.bat`.
   The first run creates a `.venv` folder and installs the dependencies, which takes a minute or two.
   Your browser then opens at **http://localhost:8000**.

   <details><summary>Starting it manually instead</summary>

   ```
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt
   .venv\Scripts\python -m uvicorn backend.server:app --port 8000
   ```
   </details>

3. **Check the connection.** The status pill in the top-right corner shows whether your key is loaded.
   Click it to reload the key or test the connection. You don't need to restart the server after editing `.env`.

To stop the app, press `Ctrl+C` in the console window.

New to the app? Click **How it works** in the top bar for a short guided tour.

---

## Using the app

The left column has three numbered steps. The centre shows the floor, and the right column has the sound, comparisons and exports.

### 1 · Choose a surface
Pick one of six ready-made floors: old pine floor, oak hardwood, garden deck, steel catwalk, glass walkway or concrete slab.

### 2 · Shape the floor
| Control | What it does |
|---|---|
| **Floor size** | Presets (*Landing*, *Small room*) or the **Width** (1–6 m) and **Depth** (1–5 m) sliders. Bigger floors sound deeper and boomier. |
| **Deck material** | Wood species, steel, glass or concrete. |
| **Deck thickness** | Thicker boards are stiffer and give higher, shorter tones. |
| **Joist spacing** | Distance between the beams under the floor. Wider spacing sounds boomier. |

### 3 · Run the physics
You can listen straight away using the preview. For the real 3D result:

1. Choose a **Detail** level:

   | Detail | Best for | Typical solve time* |
   |---|---|---|
   | **Draft** (default) | Exploring. The lowest tones are within about 1 % of Fine. | about 2 min |
   | **Standard** | A good balance | between Draft and Fine |
   | **Fine** | The final sound | about 5 min |

   \*Measured on the 2.4 × 1.8 m pine floor. Larger floors and stiff metal decks take longer.

2. Click **Simulate with Allsolve**. A progress panel shows each stage: geometry, mesh, eigenmode solve, results.

Every result is **saved automatically**. Next time you pick the same floor and detail level, it loads instantly.
To force a new solve, tick **Ignore saved result and solve again**.

### Walk on the floor
- **Step** tool: click anywhere on the floor to play a single footstep there.
- **Draw a path** tool: draw a route, then press **Walk**. **Loop** keeps walking until you press Stop.
  **Vary** (on by default) makes every walk slightly different. Turn it off to get the same walk every time.
- **Live vibration / Loudness map** switch what the floor view shows.
- **The listener** is the teal dot. Drag it to move it, and press `Q` / `E` to turn it.
- Click a card under **Vibration modes** to animate that mode on the floor.

### Walker panel
| Setting | Options |
|---|---|
| **Footwear** | Heels, leather shoes, boots, sneakers or barefoot. Hard heels click, soft soles thud. |
| **Pace** | Stroll, walk, brisk or run. |
| **Body mass** | 20–140 kg. |
| **Ground debris** | None, broken glass, gravel, sand, dry leaves or packed snow, with an **amount** slider. Debris also makes the floor ring: gravel on a steel catwalk rings, while the same gravel on concrete doesn't. |
| **Room echo** | Normal room, Vocal booth, Office, Outside, Cave, Gymnasium, Church. |
| **Output** | **Headphones** (3D binaural sound), **Speakers** (stereo), **5.1** or **7.1** surround. Surround plays as stereo if your device has fewer channels, but exports always keep every channel. |
| **Playback volume** | Changes only what you hear. Exports are not affected. |

### Right column
- **Last sound:** the waveform of the last step or walk, and a list of its steps (each one can be downloaded).
- **Allsolve vs preview:** appears after an Allsolve result loads.
  - Switch between **Preview** and **Allsolve** to hear the difference. The same step is replayed with only the physics changed.
  - The chart compares each solved mode with the textbook estimate.
  - Modes marked with a teal badge are ones where the joists move as well as the boards. The preview cannot produce these.
- **Physics check:** compares Allsolve's lowest tone with a textbook estimate, as a sanity check.
- **Math** (top bar): shows the full calculation from floor to sound for the current floor and last step.
  Every number is labelled **ALLSOLVE**, **LOCAL** (computed in the browser) or **ASSUMED** (catalogue value).
  This screen also lets you run extra validation solves and export a report (`.md` + `.json`).

---

## Exporting sounds

All exports are in the **Export** panel.

| Button | You get | Use it for |
|---|---|---|
| **Walk** | The last walk as one WAV, in the current output format (stereo, binaural, 5.1 or 7.1) | Listening, video, film sound |
| **Single step** | One WAV at the last step position | Quick one-off sounds |
| **Walk, step by step** | ZIP: every step as its own mono, dry WAV, the full mix, and `steps.csv` | Cutting your own sound sets |
| **Unreal Engine pack** | ZIP: walk, run, land, jump and scuff × 10 variations, with Unreal asset names, a DataTable and an import script | Unreal Engine |
| **Game engine pack** | ZIP: 7 actions × 10 mono one-shots, a seamless walk loop, a wet preview, a manifest and a setup README | Unity, FMOD, Wwise, Unreal MetaSounds |
| **Mode data** | JSON with the floor's modes | Custom engines and analysis |

**About the game packs**
- The files are 48 kHz / 24-bit / mono / dry. Game engines add their own spatial audio and reverb.
- The sound starts at sample 0, so it lines up with animation events.
- Loudness is calibrated, so a steel catwalk pack stays louder than a carpet pack. Packs mix well together.
- `manifest.json` / `.csv` stores the seed and position of each file, so any file can be re-rendered.

**Importing the Unreal pack:** unzip it, then in the Unreal Editor run **Tools → Execute Python Script** and choose
`import_modalforge.py`. The script imports the sounds, sets their volume and attenuation, creates a Physical Material,
and fills (or merges into) the `DT_ModalForge_Footsteps` DataTable.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Walk / stop |
| `S` | Play a random step |
| `L` | Loop on / off |
| `D` | Cycle ground debris |
| `Q` / `E` | Turn the listener left / right |

---

## Troubleshooting

| Problem | What to do |
|---|---|
| `start.bat` says *Setup failed* | Install Python 3.10+ and tick "Add Python to PATH" during setup. Delete the `.venv` folder and try again. |
| Status pill says **Add Allsolve key** | Check that `.env` sits next to `start.bat` and has both keys, then click the pill → **Reload keys**. |
| *Operation not authorized with a project API key* | That's expected with a project key: ModalForge reuses the key's own project and clears it before each run. Everything still works, but only one solve runs at a time. |
| A solve takes a long time | Use **Draft** detail, or pick a floor that is already saved. Big floors and metal decks take longest. |
| No sound | Click once on the page first (browsers block audio until you interact), then check **Playback volume** and **Output**. |
| Surround sounds like stereo | Your device has fewer than 6/8 output channels, so the app plays a stereo fold-down. Exported files still have every channel. |
| Port 8000 is already in use | Close the other program, or run uvicorn manually with `--port 8001` and open that port instead. |

**Optional setting:** `MODALFORGE_NODE_TYPE` in `.env` (default `CORES_4_64GB`) picks the Allsolve compute node.

---

## Preparing a demo (pre-computing results)

Solve floors ahead of time so a live demo never waits on the cloud. Results go to `cache/results/`:

```
.venv\Scripts\python scripts/precompute.py --list                                   # show what is saved
.venv\Scripts\python scripts/precompute.py --surfaces all --sizes landing,room --quality draft
.venv\Scripts\python scripts/precompute.py --surfaces pine-floor --sizes 3.0x2.4 --quality standard,fine
```

- **Project key:** runs one at a time (the project is shared). Don't run it while the app is solving.
- **Organization key:** add `--jobs N` to solve N floors in parallel.

When a floor is selected, the app loads the chosen detail level if it is saved, otherwise the most detailed one saved.
Older saved results (cache key v1) load as *Fine*.

---

## How it works

```
browser (frontend/)                         server (backend/)                   Allsolve cloud
-------------------                         -----------------                   --------------
choose surface, thickness, joists  ──POST /api/simulations──▶  build_spec()  ──▶ geometry: deck + joists
                                                                                  orthotropic wood / steel / glass / concrete
analytical preview (instant)                                                      clamp joist ends (or slab edges)
                                                                                  mesh ≈ 6 elements per bending wavelength @ f_max
                                   ◀── modes + shapes (JSON) ─  cache/results/  ◀ eigenmode solve, N modes
                                                                                  w(x,y) probed on a 12 × 8 or 24 × 16 grid
                                                                                  (f_max, N, grid: the Detail preset)
modal synthesis → binaural / stereo / 5.1 / 7.1 + room echo → WAV / ZIP / JSON
```

**Sound model (`frontend/js/synth.js`).** Each footstep is a ground reaction force: a short heel
"click" (small effective mass; impulse 0.03–0.3 N·s depending on footwear; the ISO 10140 tapping
machine, built to imitate heels, gives 0.44 N·s) plus smooth body-weight loading. Every mode is
driven as `q̈ + (ω/Q) q̇ + ω² q = φ(step) F(t) / m`, and the radiated pressure at the listener is
`p = ρ0 / (2π r) · Σ R q̈` (baffled radiator; R ramps from net volume displacement to full area
toward the coincidence frequency). A contact-noise burst and a statistical high-frequency fill
above the highest solved mode complete the sound. Damping uses loss factors for built-up
structures (joints, fixings), listed in `frontend/data/surfaces.json`.

**Detail presets.** The preset is sent with every request and is part of the cache key.

| Preset | Mesh sized for | Modes | Shape grid |
|---|---|---|---|
| Draft | 1 kHz | 30 | 12 × 8 |
| Standard | 1.8 kHz | 60 | 24 × 16 |
| Fine | 2.5 kHz | 100 | 24 × 16 |

Element size follows the bending wavelength, λ ∝ 1/√f, so a 3D mesh shrinks roughly as f_max^1.5. On the pine landing,
Draft's lowest modes are within 1 % of Fine (157.5 vs 157.0 Hz, 212.7 vs 211.8 Hz). Each run records wall time per stage
in `meta.timings`, which is shown live in the job panel and kept on the solve card. Only the probe values are requested
(not the full `u` field), because writing the field files took minutes.

**Above the solved band.** A thin, stiff, lightly damped deck can have all its solved modes at low frequencies: the steel
catwalk's 100 FEM modes stop at 594 Hz, which leaves out the metallic ring. `buildModel()` adds analytic modes from the
highest solved mode up to 3 kHz. The Physics check panel lists how many were added.

**Deck vs joists.** `buildModel()` splits each mode's kinetic energy into deck and joists. Allsolve modes where the joists
carry more than 20 % get the teal badge. The preview holds the joists rigid, so these modes are what the 3D solve adds.

**Physics check.** Pine floor, 2.4 × 1.8 m: FEM 157 Hz vs textbook 138 Hz (+14 %). Continuous boards are partly held at
each joist, so they behave stiffer than the simply supported bays in the estimate.

**Validation (Math screen).** The thin-plate formula f_mn = (π/2)·√(D/ρh)·((m/a)² + (n/b)²) is compared against an
on-demand Allsolve **SS-plate** job (bare deck, bottom edges pinned). Sensitivity runs (half thickness, another material)
and a **refined-mesh** run (×0.7 element size) check mesh convergence. Each is cached under its own key.

**Ground debris (`frontend/js/debris.js`).** Each grain is a small modal bank (a few decaying sinusoids, plus a crack
for brittle material), triggered where the foot load changes, over band-passed friction noise. Every grain also pushes
the deck. Parameters are in `surfaces.json` (`debris`). The backend ignores them.

**Spatial audio.** Headphones use Web Audio HRTF with front/back and below-ear cues. Speakers use equal-power panning,
with sources behind darkened. 5.1 / 7.1 use pairwise panning over ITU speaker angles plus LFE. Each output channel gets
its own decorrelated room impulse response. Exports use WAVE_FORMAT_EXTENSIBLE.

**Game pack loudness (`frontend/js/pack.js`).** One shared gain to −1 dBFS keeps the relative loudness inside a pack.
A calibrated volume, from the peak SPL at the walker's ear compressed 3:1, keeps packs in proportion to each other.

---

## Project files

| Path | What |
|---|---|
| `start.bat` | Windows launcher: sets up `.venv` on first run, starts the server, opens the browser |
| `.env.example` | Template for your Allsolve key |
| `backend/server.py` | FastAPI: static app, simulation jobs, cache, API key status/reload/test |
| `backend/allsolve_runner.py` | The Allsolve model: geometry, regions, materials, physics, mesh, eigenmode solve, result extraction |
| `backend/model.py` | Floor spec validation, detail presets, cache keys, joist layout, wood stiffness matrix, mesh sizing |
| `backend/settings.py` | Reads `.env` (re-readable at runtime) |
| `scripts/precompute.py` | Solves a list of surfaces × sizes × presets into `cache/results/` before a demo |
| `cache/results/` | Saved Allsolve results (one JSON per floor configuration and preset) |
| `frontend/js/physics.js` | Analytical modes, modal mass / damping / radiation per mode |
| `frontend/js/synth.js` | Footstep force, modal synthesis, walking, room reverb |
| `frontend/js/debris.js` | Loose material on the floor: grain events, friction hiss, force coupling into the deck |
| `frontend/js/spatial.js` | Listener-relative panning: HRTF, stereo, 5.1 / 7.1, surround fold-down |
| `frontend/js/report.js` | Math & provenance report: tagged values, validation, Markdown / HTML rendering |
| `frontend/js/export.js` | WAV (16/24-bit, multichannel), trim / loop helpers, ZIP |
| `frontend/js/pack.js` | Game engine packs: variation sets, calibrated volume, Unreal names + DataTable (no DOM, runs in Node) |
| `frontend/js/floor.js` | Floor plan, live vibration view, loudness map |
| `frontend/unreal/import_modalforge.py` | Unreal Editor import script shipped in the Unreal pack |
| `frontend/data/surfaces.json` | Materials, surface presets, shoes, paces, rooms, debris (shared by both sides) |

Developer test hooks: open `/#selftest` or `/#shot`.

---

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
| 7 | `Simulation.add_outputs()` sends one HTTP request per output, in sequence, and a `Client` serialises its requests behind one lock. 96 probe outputs took 16 s, 384 would take ~65 s, longer than the draft solve itself. | We open one client per worker thread (`client.in_thread()`) and send chunks in parallel | A batch endpoint for outputs (like `create_geometry_element_batch`), or a single "probe grid" output |
| 8 | A skin-only full-field output (`u`, every mode) on a 1.9 M DOF solve spent minutes in *processing_output* after the eigensolve had finished; nothing in the API says which output is expensive. | A 10+ minute run, aborted | Report per-output processing time in the job log |

What worked well: the build order (variables → geometry → regions → materials → physics → mesh →
simulation) is clear; `create_simulation_eigenmode` + `interpolate()` probes gave mode shapes at
arbitrary points without downloading field files; the cloud solve of 165 k DOF / 117 modes took
≈ 5 minutes including queueing.
