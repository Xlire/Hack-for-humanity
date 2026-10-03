import { analyticModes, buildModel, crossCheck, joistPositions } from "./physics.js";
import { FS, mulberry32, renderStep, renderWalk, finishMix, planSteps, renderModeTone, dbSPL, EAR_HEIGHT, PA_TO_DIGITAL } from "./synth.js";
import { OUTPUTS, spatialize, downmixStereo, LFE_INDEX } from "./spatial.js";
import { FloorView, drawTexture, heat } from "./floor.js";
import { drawWave, drawSpectrum, drawModeThumb } from "./charts.js";
import { encodeWav, makeZip, download, trimTail, wrapLoop, peakOf, rmsDb } from "./export.js";

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const S = {
  cat: null, surface: null, floorSize: "landing", Lx: 2.4, Ly: 1.8, deckMaterial: null, thickness: 0.022, spacing: 0.6,
  shoe: "leather", pace: "walk", mass: 75, room: "normal", output: "binaural", loop: false, vary: true,
  result: null, model: null, view: null, audio: null, oneShot: null, sources: new Set(), outCh: 0,
  lastStep: null, lastWalk: null, walking: false, walkRun: 0, walkTimers: [], job: null, lookupSeq: 0, packBusy: false,
};

// ------------------------------------------------------------------------------- boot
init().catch((e) => { console.error(e); toast(`Could not start: ${e.message}`); });

async function init() {
  document.documentElement.dataset.theme = store.get("mf-theme", "dark");
  S.room = store.get("mf-room", "normal"); S.output = store.get("mf-output", "binaural"); S.loop = store.get("mf-loop", false); S.vary = store.get("mf-vary", true);
  S.cat = await (await fetch("data/surfaces.json")).json();
  S.view = new FloorView($("#floor"), {
    onStep: (x, y) => stepAt(x, y),
    onListener: () => { if (S.view.overlay === "loudness") updateLoudness(); },
    onPathChange: (p) => { $("#floorHint").style.opacity = p.length > 1 ? 0 : 1; },
  });
  buildControls();
  selectSurface(S.cat.surfaces[0].id);
  refreshStatus();
  wire();
  // Automated checks. #selftest renders a walk, reverb, WAV and ZIP and reports into the DOM.
  if (location.hash === "#selftest") {
    store.set("mf-toured", true);
    setTimeout(async () => {
      const out = {};
      try {
        const steps = planSteps(defaultPath(), S.cat.paces.walk, S.model.spec.Lx, S.model.spec.Ly);
        const w = renderWalk(S.model, steps, walker());
        const outputs = {};
        for (const mode of Object.keys(OUTPUTS)) outputs[mode] = (await spatialize(w.items, S.view.listener, mode)).length;
        const rooms = {};
        for (const id of Object.keys(S.cat.rooms)) {
          S.room = id;
          const m = await mixItems(w.items.slice(0, 2), S.view.listener, "stereo");
          rooms[id] = { seconds: +(m[0].length / FS).toFixed(2), peak: +peakOf(m).toFixed(3) };
        }
        S.room = "normal";
        const mixed = await mixItems(w.items, S.view.listener, "5.1");
        const wav = encodeWav(mixed, FS, true, { bits: 24 });
        const hv = new DataView(wav.buffer);
        const pack = await buildPack();
        Object.assign(out, { ok: true, source: S.model.source, modes: S.model.modes.length, steps: steps.length,
          seconds: +(mixed[0].length / FS).toFixed(2), peak: +peakOf(mixed).toFixed(3), outputs, rooms,
          wav51: { format: hv.getUint16(20, true).toString(16), channels: hv.getUint16(22, true), bits: hv.getUint16(34, true), mask: hv.getUint32(40, true).toString(16), bytes: wav.length },
          pack: { files: pack.files.length, names: pack.files.map((f) => f.name).filter((n) => !n.includes("/Mono_Dry/")), zipBytes: pack.zip.size },
          check: crossCheck(S.cat, S.model) });
      } catch (e) { Object.assign(out, { ok: false, error: String(e && e.stack || e) }); }
      document.body.setAttribute("data-selftest", JSON.stringify(out));
    }, 1500);
    return;
  }
  // Screenshot hook for automated checks: #shot, #shot-loudness, #shot-steel
  if (location.hash.startsWith("#shot")) {
    store.set("mf-toured", true);
    if (location.hash.includes("steel")) selectSurface("steel-catwalk");
    setTimeout(() => {
      const { Lx, Ly } = S.model.spec;
      stepAt(Lx * 0.42, Ly * 0.55);
      if (location.hash.includes("loudness")) $("#overlaySeg [data-overlay=loudness]").click();
    }, 400);
  } else if (!store.get("mf-toured", false)) setTimeout(startTour, 700);
}

// ------------------------------------------------------------------------------- controls
function buildControls() {
  const grid = $("#surfaceGrid");
  for (const s of S.cat.surfaces) {
    const b = el("button", { className: "surface-card", type: "button", role: "radio", "aria-checked": "false", "data-id": s.id });
    const cv = el("canvas"); b.append(cv, el("span", { className: "sc-name", textContent: s.name }));
    b.title = s.blurb;
    b.addEventListener("click", () => selectSurface(s.id));
    grid.append(b);
    requestAnimationFrame(() => {
      const r = cv.getBoundingClientRect(); cv.width = r.width * 2 || 280; cv.height = r.height * 2 || 108;
      drawTexture(cv.getContext("2d"), s.texture, cv.width, cv.height, 520);
    });
  }
  grid.after(el("p", { className: "surface-blurb", id: "surfaceBlurb" }));

  seg($("#sizeSeg"), Object.entries(S.cat.floorSizes).map(([id, f]) => [id, `${f.name} · ${f.Lx}×${f.Ly} m`]), () => S.floorSize,
    (v) => { S.Lx = S.cat.floorSizes[v].Lx; S.Ly = S.cat.floorSizes[v].Ly; syncSize(); onFloorChange(); });
  $("#floorWidth").addEventListener("input", (e) => { S.Lx = +e.target.value; syncSize(); onFloorChange(220); });
  $("#floorDepth").addEventListener("input", (e) => { S.Ly = +e.target.value; syncSize(); onFloorChange(220); });
  syncSize();
  const dm = $("#deckMaterial");
  for (const [id, m] of Object.entries(S.cat.materials)) dm.append(el("option", { value: id, textContent: m.name }));
  dm.addEventListener("change", () => { S.deckMaterial = dm.value; onFloorChange(); });
  $("#thickness").addEventListener("input", (e) => { S.thickness = +e.target.value / 1000; syncOutputs(); onFloorChange(); });
  $("#spacing").addEventListener("input", (e) => { S.spacing = +e.target.value / 100; syncOutputs(); onFloorChange(); });

  const chips = $("#shoeChips");
  for (const [id, s] of Object.entries(S.cat.shoes)) {
    const b = el("button", { type: "button", role: "radio", "aria-checked": String(id === S.shoe), textContent: s.name });
    b.addEventListener("click", () => { S.shoe = id; chips.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b))); onWalkerChange(); });
    chips.append(b);
  }
  seg($("#paceSeg"), Object.entries(S.cat.paces).map(([id, p]) => [id, p.name]), () => S.pace, (v) => { S.pace = v; onWalkerChange(); });
  $("#mass").addEventListener("input", (e) => { S.mass = +e.target.value; syncOutputs(); onWalkerChange(); });
  if (!S.cat.rooms[S.room]) S.room = "normal";
  if (!OUTPUTS[S.output]) S.output = "binaural";
  seg($("#roomChips"), Object.entries(S.cat.rooms).map(([id, r]) => [id, r.name]), () => S.room,
    (v) => { S.room = v; store.set("mf-room", v); replayLastStep(); });
  seg($("#outputSeg"), Object.entries(OUTPUTS).map(([id, o]) => [id, o.name]), () => S.output,
    (v) => { S.output = v; store.set("mf-output", v); syncOutputHint(); replayLastStep(); });
  syncOutputHint();
  $("#loopBtn").setAttribute("aria-pressed", String(S.loop));
  $("#loopBtn").addEventListener("click", () => {
    S.loop = !S.loop; store.set("mf-loop", S.loop);
    $("#loopBtn").setAttribute("aria-pressed", String(S.loop));
  });
  $("#varyBtn").setAttribute("aria-pressed", String(S.vary));
  $("#varyBtn").addEventListener("click", () => {
    S.vary = !S.vary; store.set("mf-vary", S.vary);
    $("#varyBtn").setAttribute("aria-pressed", String(S.vary));
  });
  $("#volume").value = store.get("mf-volume", 12);
  $("#volume").addEventListener("input", () => { setVolume(); store.set("mf-volume", +$("#volume").value); });
  setVolume();
}

function seg(container, items, get, set) {
  container.innerHTML = "";
  for (const [id, label] of items) {
    const b = el("button", { type: "button", role: "radio", "aria-checked": String(get() === id), textContent: label, "data-v": id });
    b.addEventListener("click", () => { set(id); container.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.v === id))); });
    container.append(b);
  }
}

/** Size sliders, their readouts, and which preset (if any) the current size matches. */
function syncSize() {
  $("#floorWidth").value = S.Lx; $("#floorDepth").value = S.Ly;
  $("#widthOut").textContent = `${S.Lx.toFixed(1)} m`;
  $("#depthOut").textContent = `${S.Ly.toFixed(1)} m · ${(S.Lx * S.Ly).toFixed(1)} m²`;
  S.floorSize = Object.keys(S.cat.floorSizes).find((id) => S.cat.floorSizes[id].Lx === S.Lx && S.cat.floorSizes[id].Ly === S.Ly) || "custom";
  $("#sizeSeg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === S.floorSize)));
}

function syncOutputs() {
  $("#thicknessOut").textContent = `${Math.round(S.thickness * 1000)} mm`;
  $("#spacingOut").textContent = `${Math.round(S.spacing * 100)} cm`;
  $("#massOut").textContent = `${S.mass} kg`;
}

function selectSurface(id) {
  const s = S.cat.surfaces.find((x) => x.id === id);
  S.surface = s;
  S.deckMaterial = s.deck.material;
  S.thickness = s.deck.thickness;
  if (s.joists) S.spacing = s.joists.spacing;
  document.querySelectorAll(".surface-card").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === id)));
  $("#surfaceBlurb").textContent = s.blurb;
  $("#deckMaterial").value = S.deckMaterial;
  const th = $("#thickness");
  th.min = s.texture === "concrete" ? 80 : 4; th.max = s.texture === "concrete" ? 250 : 60;
  th.value = Math.round(S.thickness * 1000);
  $("#spacing").value = Math.round(S.spacing * 100);
  $("#spacingField").hidden = !s.joists;
  syncOutputs();
  onFloorChange();
}

function currentSpec() {
  const j = S.surface.joists;
  return {
    surfaceId: S.surface.id, Lx: S.Lx, Ly: S.Ly, deckMaterial: S.deckMaterial, thickness: S.thickness,
    joists: j ? { material: j.material, width: j.width, height: j.height, spacing: S.spacing } : null,
  };
}

function requestBody(fresh = false) {
  return { surfaceId: S.surface.id, floorSize: S.floorSize, Lx: S.Lx, Ly: S.Ly, deckMaterial: S.deckMaterial,
    thickness: S.thickness, joistSpacing: S.surface.joists ? S.spacing : null, fresh };
}

let floorTimer = 0;
/** Rebuilds the floor after a pause in slider movement. Large floors take ~0.5 s, hence a longer pause for the size sliders. */
function onFloorChange(delay = 90) {
  clearTimeout(floorTimer);
  floorTimer = setTimeout(async () => {
    applyResult(analyticModes(S.cat, currentSpec()));
    // Is there a saved Allsolve result for exactly this floor? Use it.
    const seq = ++S.lookupSeq;
    try {
      const r = await fetch("api/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody()) });
      if (r.ok && seq === S.lookupSeq) applyResult(fromBackend((await r.json()).result));
    } catch { /* backend offline: preview only */ }
  }, delay);
}

function onWalkerChange() { if (S.view.overlay === "loudness") updateLoudness(); }

// ------------------------------------------------------------------------------- results
function fromBackend(r) {
  const s = r.spec;
  r.spec = {
    surfaceId: s.surface_id, Lx: s.Lx, Ly: s.Ly, deckMaterial: s.deck_material, thickness: s.thickness,
    joists: s.joist_material ? { material: s.joist_material, width: s.joist_width, height: s.joist_height, spacing: s.joist_spacing } : null,
  };
  if (!r.joists) r.joists = joistPositions(s.Lx, r.spec.joists);
  return r;
}

function applyResult(result) {
  S.result = result;
  S.model = buildModel(S.cat, result);
  S.view.setModel(S.model, S.surface.texture);
  S.view.selectedMode = null;
  renderModeStrip();
  renderCheck();
  const badge = $("#sourceBadge");
  badge.dataset.source = result.source;
  $("#sourceText").textContent = result.source === "allsolve"
    ? `Allsolve FEM · ${result.modes.length} modes${result.meta?.fromCache ? " · saved result" : ""}`
    : "Analytical preview · run Allsolve for the full 3D solve";
  $("#simBtnText").textContent = result.source === "allsolve" ? "Solve again with Allsolve" : "Simulate with Allsolve";
  $("#freshRun").parentElement.hidden = result.source !== "allsolve";
  if (S.view.overlay === "loudness") updateLoudness();
}

function renderModeStrip() {
  const strip = $("#modeStrip");
  strip.innerHTML = "";
  S.model.modes.slice(0, 14).forEach((m, k) => {
    const b = el("button", { className: "mode-card", type: "button", role: "listitem", "aria-pressed": "false", title: `Mode ${k + 1}: ${m.f.toFixed(1)} Hz, Q ${m.Q.toFixed(0)}` });
    const cv = el("canvas");
    b.append(cv, el("span", { innerHTML: `${m.f < 100 ? m.f.toFixed(1) : m.f.toFixed(0)} Hz <i>#${k + 1}</i>` }));
    b.addEventListener("click", () => {
      const on = S.view.selectedMode !== k;
      S.view.selectedMode = on ? k : null;
      strip.querySelectorAll(".mode-card").forEach((x, i) => x.setAttribute("aria-pressed", String(on && i === k)));
      if (on) { const t = renderModeTone(m); play([t, t]); }
    });
    strip.append(b);
    requestAnimationFrame(() => drawModeThumb(cv, S.model, m));
  });
}

function renderCheck() {
  const m = S.model, list = $("#checkList");
  const rows = [];
  rows.push(["Source", m.source === "allsolve" ? "<span class='good'>Allsolve 3D FEM</span>" : "<span class='warn'>Analytical estimate</span>"]);
  rows.push(["Modes", `${m.modes.length} (to ${m.modes.length ? m.modes[m.modes.length - 1].f.toFixed(0) : "–"} Hz)`]);
  if (m.source === "allsolve") {
    const c = crossCheck(S.cat, m);
    rows.push(["Lowest mode, FEM", `${c.fem.toFixed(1)} Hz`]);
    rows.push(["Textbook estimate", `${c.analytic.toFixed(1)} Hz (${c.diff >= 0 ? "+" : ""}${(c.diff * 100).toFixed(0)}%)`]);
    if (m.meta.elapsedS) rows.push(["Cloud solve time", `${Math.floor(m.meta.elapsedS / 60)}:${String(Math.round(m.meta.elapsedS % 60)).padStart(2, "0")}`]);
    if (m.meta.meshMaxSize) rows.push(["Mesh size", `≤ ${(m.meta.meshMaxSize * 1000).toFixed(0)} mm`]);
    if (m.meta.mesh?.nodes) rows.push(["Mesh nodes", m.meta.mesh.nodes.toLocaleString("en")]);
    if (m.meta.extendedModes) rows.push(["Above the solved band", `+${m.meta.extendedModes} analytic modes > ${m.meta.extendedFrom.toFixed(0)} Hz`]);
    if (m.meta.projectUrl) rows.push(["Allsolve project", `<a href="${m.meta.projectUrl}" target="_blank" rel="noopener">Open ↗</a>`]);
  } else {
    rows.push(["Lowest mode", `${m.modes[0].f.toFixed(1)} Hz`]);
    rows.push(["Model", m.meta.note || "–"]);
  }
  rows.push(["Coincidence freq.", `${m.plate.fc.toFixed(0)} Hz`]);
  rows.push(["Deck damping", `η ${m.plate.eta} (Q ${(1 / m.plate.eta).toFixed(0)})`]);
  list.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
}

// ------------------------------------------------------------------------------- sound
function walker() {
  return { shoe: S.cat.shoes[S.shoe], pace: S.cat.paces[S.pace], massKg: S.mass, listener: S.view.listener, run: S.pace === "run" };
}

function ensureAudio() {
  if (!S.audio) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: FS });
    // Playback chain: volume -> brick-wall-ish limiter -> speakers (loud demo rooms, no clipping).
    // A compressor node is at most stereo, so discrete surround output bypasses it (mixes are soft-clipped already).
    S.master = ctx.createGain();
    S.limiter = ctx.createDynamicsCompressor();
    const lim = S.limiter;
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
    lim.connect(ctx.destination);
    S.audio = ctx;
    configureOutput(2);
    setVolume();
    syncOutputHint();
  }
  if (S.audio.state === "suspended") S.audio.resume();
  return S.audio;
}

/** Route playback for n channels. Returns the channel count the device actually plays (2 or n). */
function configureOutput(n) {
  const ctx = S.audio, dest = ctx.destination;
  const want = n > 2 && dest.maxChannelCount >= n ? n : 2;
  if (S.outCh === want) return want;
  S.master.disconnect();
  dest.channelCount = want;
  dest.channelInterpretation = want > 2 ? "discrete" : "speakers";
  Object.assign(S.master, { channelCount: want, channelCountMode: "explicit", channelInterpretation: want > 2 ? "discrete" : "speakers" });
  S.master.connect(want > 2 ? dest : S.limiter);
  S.outCh = want;
  return want;
}

function syncOutputHint() {
  const o = OUTPUTS[S.output];
  const max = S.audio ? S.audio.destination.maxChannelCount : null;
  let hint = o.hint;
  if (o.channels > 2 && max !== null && max < o.channels) hint += ` This device plays ${max} channels, so you hear a stereo fold-down. Exports keep all ${o.channels}.`;
  $("#outputHint").textContent = hint;
  $("#dlWalkSub").textContent = `${o.channels === 2 ? (S.output === "binaural" ? "Binaural stereo" : "Stereo") : o.name} WAV, all steps`;
}

function setVolume() {
  const db = +$("#volume").value;
  $("#volumeOut").textContent = `+${db} dB`;
  if (S.master) S.master.gain.value = Math.pow(10, db / 20);
}

/** Schedules a multichannel buffer (digital level). Several can overlap: a looping walk queues passes. */
function playBuffer(channels, when = 0) {
  const ctx = ensureAudio();
  const n = configureOutput(channels.length);
  const ch = channels.length > n ? downmixStereo(channels) : channels;
  const buf = ctx.createBuffer(ch.length, ch[0].length, FS);
  ch.forEach((c, i) => buf.copyToChannel(c, i));
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(S.master); src.start(when);
  S.sources.add(src);
  src.addEventListener("ended", () => S.sources.delete(src));
  return src;
}

/** One-shot playback (steps, mode tones): replaces the previous one-shot, leaves a walk running. */
function play(channels) {
  if (S.oneShot) { try { S.oneShot.stop(); } catch { /* already stopped */ } }
  S.oneShot = playBuffer(channels);
  return S.oneShot;
}

const lfeOf = (mode) => (OUTPUTS[mode].channels > 2 ? LFE_INDEX : -1);

/** Dry mono steps [{t, x, y, signal}] -> spatialised for the output format, room applied, digital level. */
async function mixItems(items, listener = S.view.listener, mode = S.output) {
  const ch = await spatialize(items, listener, mode);
  return finishMix(ch, S.cat.rooms[S.room], lfeOf(mode));
}

const toDigital = (sig) => Float32Array.from(sig, (v) => v * PA_TO_DIGITAL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stepAt(x, y, seed = (Math.random() * 1e9) | 0) {
  ensureAudio();
  const r = renderStep(S.model, { ...walker(), x, y, seed });
  const mixed = await mixItems([{ t: 0, x, y, signal: r.signal }]);
  play(mixed);
  S.view.excite(x, y, r.contrib, 1, Math.PI / 2);
  S.lastStep = { x, y, seed, mixed, r, output: S.output, room: S.room };
  showSound(mixed, r);
  $("#floorHint").style.opacity = 0;
}

/** Room or output changed: hear the last step again with the new setting. */
function replayLastStep() {
  if (S.lastStep && !S.walking) stepAt(S.lastStep.x, S.lastStep.y, S.lastStep.seed);
}

function showSound(mixed, r) {
  drawWave($("#wave"), mixed[0], mixed[1] || mixed[0]);
  drawSpectrum($("#spectrum"), r.contrib);
  $("#roLevel").textContent = `${dbSPL(r.peakPa).toFixed(0)} dB`;
  $("#roRing").textContent = `${(r.ringTime * 1000).toFixed(0)} ms`;
  $("#roLow").textContent = S.model.modes.length ? `${S.model.modes[0].f.toFixed(0)} Hz` : "–";
}

function defaultPath() {
  const { Lx, Ly } = S.model.spec;
  return [{ x: 0.15, y: Ly * 0.62 }, { x: Lx - 0.15, y: Ly * 0.38 }];
}

// With Vary off every walk uses the same seed, so the same path always gives the same walk.
const randomSeed = () => (S.vary ? (Math.random() * 1e9) | 0 : 1000);

/** Step plan for the current path. The seed sets the gait irregularity (timing, placement, per-foot force). */
function walkSteps(seed = randomSeed()) {
  const path = S.view.path.length > 1 ? S.view.path : defaultPath();
  return planSteps(path, S.cat.paces[S.pace], S.model.spec.Lx, S.model.spec.Ly, mulberry32(seed));
}

/** One pass along the path. Every pass (and every press of Walk) gets fresh seeds, so a walk never repeats exactly. */
async function renderPass(steps, pass, seed = randomSeed()) {
  const w = renderWalk(S.model, steps, walker(), seed);
  const mixed = await mixItems(w.items);
  return { ...w, mixed, steps, pass, seed, output: S.output, room: S.room };
}

async function walk() {
  if (S.walking) return stopWalk();
  ensureAudio();
  let steps = walkSteps();
  if (!steps.length) return toast("Draw a longer path: at least one stride.");
  setWalking(true);
  const run = ++S.walkRun;
  const dtStep = 60 / S.cat.paces[S.pace].cadence;
  let when = S.audio.currentTime + 0.05, src = null;
  for (let pass = 0; ; pass++) {
    const t0 = performance.now();
    if (pass > 0) steps = walkSteps();
    const period = steps[steps.length - 1].t + dtStep; // one pass, step to step
    const p = await renderPass(steps, pass);
    const renderS = (performance.now() - t0) / 1000;
    if (run !== S.walkRun) return;
    when = Math.max(when, S.audio.currentTime + 0.03);
    src = playBuffer(p.mixed, when);
    const lead = (when - S.audio.currentTime) * 1000;
    p.rendered.forEach(({ s, r }) => S.walkTimers.push(setTimeout(() => S.view.excite(s.x, s.y, r.contrib, s.side, s.angle), lead + s.t * 1000)));
    S.lastWalk = p;
    showSound(p.mixed, p.rendered.reduce((a, b) => (b.r.peakPa > a.r.peakPa ? b : a)).r);
    renderStepList();
    when += period;
    // Render the next pass just in time: wake up a little before it is due, then check the Loop toggle.
    await sleep(Math.max(0, (when - S.audio.currentTime - renderS * 1.5 - 0.25) * 1000));
    if (run !== S.walkRun) return;
    if (!S.loop) break;
  }
  src.addEventListener("ended", () => { if (run === S.walkRun) setWalking(false); });
}

function stopWalk() {
  S.walkRun++;
  for (const src of S.sources) { if (src !== S.oneShot) { try { src.stop(); } catch { /* stopped */ } } }
  setWalking(false);
}

function setWalking(on) {
  S.walking = on;
  $("#walkBtnText").textContent = on ? "Stop" : "Walk";
  $("#walkBtn").querySelector("svg").innerHTML = on ? '<rect x="6" y="6" width="12" height="12" rx="1"/>' : '<path d="M7 4l12 8-12 8z"/>';
  if (!on) { S.walkTimers.forEach(clearTimeout); S.walkTimers = []; }
}

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l12 8-12 8z"/></svg>';
const ICON_DL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>';

/** Steps of the last walk, each playable alone and downloadable as its own (dry, mono) WAV. */
function renderStepList() {
  const list = $("#stepList"), w = S.lastWalk;
  list.hidden = !w;
  if (!w) return;
  list.innerHTML = "";
  w.rendered.forEach(({ s, r }, i) => {
    const n = String(i + 1).padStart(2, "0");
    const li = el("li");
    li.append(el("span", { textContent: `#${n}` }),
      el("span", { className: "meta", textContent: `${s.t.toFixed(2)} s · ${s.side > 0 ? "left" : "right"} · ${dbSPL(r.peakPa).toFixed(0)} dB` }));
    const pb = el("button", { type: "button", title: `Play step ${i + 1}`, "aria-label": `Play step ${i + 1}`, innerHTML: ICON_PLAY });
    pb.addEventListener("click", async () => {
      play(await mixItems([{ t: 0, x: s.x, y: s.y, signal: r.signal }]));
      S.view.excite(s.x, s.y, r.contrib, s.side, s.angle);
    });
    const db = el("button", { type: "button", title: `Download step ${i + 1} (mono, dry WAV)`, "aria-label": `Download step ${i + 1}`, innerHTML: ICON_DL });
    db.addEventListener("click", () => download(encodeWav([trimTail(toDigital(r.signal))], FS, norm(), { bits: 24 }), `${fileBase()}_walk_step_${n}.wav`));
    li.append(pb, db);
    list.append(li);
  });
}

function updateLoudness() {
  // Fast estimate of peak level per floor position: Σ over modes of radiated acceleration at the
  // mode frequency for a heel-strike force spectrum. Same physics as the synthesiser, no time loop.
  const m = S.model, w = walker();
  const nx = 24, ny = Math.max(10, Math.round(24 * m.spec.Ly / m.spec.Lx));
  const Th = w.shoe.heelMs / 1000;
  const I = w.shoe.impulse * (w.pace.impact / 0.75) * Math.sqrt(w.massKg / 75); // heel click impulse [N·s]
  const values = new Float32Array(nx * ny);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = (i + 0.5) * m.spec.Lx / nx, y = (j + 0.5) * m.spec.Ly / ny;
    const r = Math.hypot(x - w.listener.x, y - w.listener.y, EAR_HEIGHT);
    let e = 0;
    for (const md of m.modes) {
      const f = md.f, u = 2 * f * Th;
      const Fs = I * Math.abs(Math.cos(Math.PI * f * Th) / (1 - u * u || 1e-3)); // half-sine spectrum
      const a = m.sample(md.shape, x, y) / md.mass * md.R * (2 * Math.PI * f) * Fs / r;
      e += a * a * md.Q / f;
    }
    const db = 10 * Math.log10(e + 1e-30);
    values[j * nx + i] = db; min = Math.min(min, db); max = Math.max(max, db);
  }
  min = Math.max(min, max - 24);
  S.view.setLoudness({ values, nx, ny, min, max });
  const lg = $("#legend"); lg.hidden = false;
  $("#legendLo").textContent = "quieter"; $("#legendHi").textContent = `louder (${(max - min).toFixed(0)} dB span)`;
  $("#legendRamp").style.background = `linear-gradient(90deg, ${[0, 0.33, 0.66, 1].map((t) => `rgb(${heat(t).join(",")})`).join(",")})`;
}

// ------------------------------------------------------------------------------- simulation job
async function simulate() {
  if (S.job) return;
  let res;
  try {
    res = await fetch("api/simulations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody($("#freshRun").checked)) });
  } catch {
    return toast("The ModalForge server is not running. Start it with start.bat.");
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 503) { openKeyDialog(body.detail); return; }
  if (!res.ok) return toast(body.detail || "Simulation could not start.");
  if (body.status === "done") { applyResult(fromBackend(body.result)); toast("Loaded the saved Allsolve result for this floor."); return; }
  S.job = body.jobId;
  const btn = $("#simBtn"); btn.classList.add("running"); btn.disabled = true;
  $("#simBtnText").textContent = "Solving on Allsolve…";
  const panel = $("#jobPanel"); panel.hidden = false; panel.classList.remove("error");
  pollJob();
}

async function pollJob() {
  let j;
  try { j = await (await fetch(`api/simulations/${S.job}`)).json(); } catch { setTimeout(pollJob, 2500); return; }
  $("#jobBar").style.width = `${Math.round(j.progress * 100)}%`;
  $("#jobStage").textContent = j.stage;
  $("#jobTime").textContent = `${Math.floor(j.elapsedS / 60)}:${String(Math.floor(j.elapsedS % 60)).padStart(2, "0")}`;
  $("#jobLog").textContent = j.logs.join("\n");
  $("#jobLog").scrollTop = 1e9;
  const order = ["geometry", "mesh", "solve", "results"];
  const st = /mesh/i.test(j.stage) ? "mesh" : /solv|eigen/i.test(j.stage) ? "solve" : /result|done/i.test(j.stage) ? "results" : "geometry";
  document.querySelectorAll("#jobStages li").forEach((li) => {
    const i = order.indexOf(li.dataset.stage), k = order.indexOf(st);
    li.className = j.status === "done" || i < k ? "done" : i === k ? "active" : "";
  });
  if (j.status === "running") { setTimeout(pollJob, 1500); return; }
  const btn = $("#simBtn"); btn.classList.remove("running"); btn.disabled = false;
  S.job = null;
  if (j.status === "done") {
    applyResult(fromBackend(j.result));
    toast(`Allsolve solved the floor: ${j.result.modes.length} modes.`);
  } else {
    $("#jobPanel").classList.add("error");
    $("#jobStage").textContent = "Simulation failed";
    $("#jobLog").textContent += `\n${j.error}`;
    $("#simBtnText").textContent = "Try again";
    toast("Allsolve run failed. The preview stays active. Details are in the log.");
  }
}

// ------------------------------------------------------------------------------- export
function fileBase() { return `modalforge_${S.surface.id}_${S.shoe}${S.model.source === "allsolve" ? "" : "_preview"}`; }
const norm = () => $("#normalize").checked;
const outTag = () => (S.output === "binaural" ? "binaural" : S.output === "stereo" ? "stereo" : S.output.replace(".", ""));
const pascal = (s) => s.replace(/\(.*?\)/g, "").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const pad2 = (n) => String(n).padStart(2, "0");
const VARIATIONS = 10;

/** The last walk pass (rendering one silently if there is none), mixed for the current room + output. */
async function currentWalk() {
  if (!S.lastWalk) {
    const steps = walkSteps();
    if (!steps.length) { toast("Draw a longer path: at least one stride."); return null; }
    S.lastWalk = await renderPass(steps, 0);
    renderStepList();
  }
  const w = S.lastWalk;
  if (w.output !== S.output || w.room !== S.room) Object.assign(w, { mixed: await mixItems(w.items), output: S.output, room: S.room });
  return w;
}

async function exportWalk() {
  const w = await currentWalk();
  if (w) download(encodeWav(w.mixed, FS, norm(), { bits: 24 }), `${fileBase()}_walk_${outTag()}.wav`);
}

async function exportStep() {
  if (!S.lastStep) { const { Lx, Ly } = S.model.spec; await stepAt(Lx / 2, Ly / 2); }
  const st = S.lastStep;
  const mixed = st.output === S.output && st.room === S.room ? st.mixed : await mixItems([{ t: 0, x: st.x, y: st.y, signal: st.r.signal }]);
  download(encodeWav(mixed, FS, norm(), { bits: 24 }), `${fileBase()}_step_${outTag()}.wav`);
}

/** Every step of the last walk as its own dry mono WAV, plus the full mix and a timing sheet. */
async function exportSteps() {
  const w = await currentWalk();
  if (!w) return;
  const dry = w.rendered.map(({ r }) => trimTail(toDigital(r.signal)));
  const gain = norm() ? 0.891 / peakOf(dry) : 1; // one gain for all steps keeps their relative loudness
  const files = dry.map((sig, i) => ({ name: `steps/${fileBase()}_walk_step_${pad2(i + 1)}.wav`, data: encodeWav([sig], FS, false, { bits: 24, gain }) }));
  files.push({ name: `${fileBase()}_walk_${outTag()}.wav`, data: encodeWav(w.mixed, FS, norm(), { bits: 24 }) });
  const csv = ["step,file,time_s,x_m,y_m,foot,peak_dB_SPL"].concat(w.rendered.map(({ s, r }, i) =>
    [i + 1, files[i].name, s.t.toFixed(3), s.x.toFixed(3), s.y.toFixed(3), s.side > 0 ? "left" : "right", dbSPL(r.peakPa).toFixed(1)].join(",")));
  files.push({ name: "steps.csv", data: new TextEncoder().encode(csv.join("\n") + "\n") });
  download(makeZip(files), `${fileBase()}_walk_steps.zip`, "application/zip");
}

/** Walking on the spot in front of the listener, rendered as a seamless stereo loop (tails wrapped to the start). */
async function renderLoop(n = 8) {
  const pace = S.cat.paces[S.pace], dt = 60 / pace.cadence;
  const { Lx, Ly } = S.model.spec;
  const listener = { x: Lx / 2, y: Ly * 0.12, yaw: Math.PI / 2 };
  const items = Array.from({ length: n }, (_, i) => {
    const x = Lx / 2 + (i % 2 ? -0.09 : 0.09), y = Ly / 2 + (Math.random() - 0.5) * 0.1;
    return { t: i * dt, x, y, signal: renderStep(S.model, { ...walker(), listener, x, y, seed: 5000 + i * 7919 }).signal };
  });
  return wrapLoop(await mixItems(items, listener, "stereo"), Math.round(n * dt * FS));
}

/** Unity / Unreal footstep pack for the current surface + shoe, all paces. */
async function buildPack() {
  const sName = pascal(S.surface.name), shName = pascal(S.cat.shoes[S.shoe].name);
  const root = `ModalForge_${sName}_${shName}`;
  const { Lx, Ly } = S.model.spec;
  const shots = [];
  const paces = Object.entries(S.cat.paces);
  for (const [k, [pid, pace]] of paces.entries()) {
    toast(`Rendering ${pace.name} steps (${k + 1}/${paces.length})…`);
    await sleep(30); // let the toast paint between renders
    for (let v = 1; v <= VARIATIONS; v++) {
      const x = 0.15 + Math.random() * (Lx - 0.3), y = 0.15 + Math.random() * (Ly - 0.3), seed = (Math.random() * 1e9) | 0;
      const r = renderStep(S.model, { ...walker(), pace, run: pid === "run", x, y, seed });
      const file = `SFX_Footstep_${sName}_${shName}_${pascal(pace.name)}_${pad2(v)}.wav`;
      shots.push({ path: `${root}/Mono_Dry/${pascal(pace.name)}/${file}`, file, sig: trimTail(toDigital(r.signal)),
        pace: pace.name, variation: v, seed, x, y, peakSPL: dbSPL(r.peakPa) });
    }
  }
  // One gain for the whole set: a run stays louder than a stroll, variations keep their natural spread.
  const gain = 0.891 / peakOf(shots.map((s) => s.sig));
  const gDb = 20 * Math.log10(gain);
  const files = shots.map((s) => ({ name: s.path, data: encodeWav([s.sig], FS, false, { bits: 24, gain }) }));
  const manifest = shots.map((s) => ({
    file: s.path.slice(root.length + 1), pace: s.pace, variation: s.variation, seed: s.seed, x_m: +s.x.toFixed(3), y_m: +s.y.toFixed(3),
    duration_s: +(s.sig.length / FS).toFixed(3), peak_dBFS: +(20 * Math.log10(peakOf([s.sig])) + gDb).toFixed(1),
    rms_dBFS: +(rmsDb([s.sig]) + gDb).toFixed(1), peak_dB_SPL_at_listener: +s.peakSPL.toFixed(1),
  }));

  toast("Rendering loop and preview…");
  await sleep(30);
  const loopName = `SFX_Footstep_${sName}_${shName}_${pascal(S.cat.paces[S.pace].name)}_Loop.wav`;
  files.push({ name: `${root}/Loops/${loopName}`, data: encodeWav(await renderLoop(), FS, true, { bits: 24 }) });
  const w = await currentWalk();
  const previewName = `SFX_Footstep_${sName}_${shName}_Walk_${pascal(S.cat.rooms[S.room].name)}_${outTag()}.wav`;
  if (w) files.push({ name: `${root}/Preview_Wet/${previewName}`, data: encodeWav(w.mixed, FS, true, { bits: 24 }) });

  const info = {
    generator: "ModalForge", surface: S.surface.name, shoe: S.cat.shoes[S.shoe].name, massKg: S.mass, source: S.model.source,
    sampleRate: FS, bitDepth: 24, channels: 1, processing: "dry (no room), trimmed to -70 dB, 5 ms fade, one shared gain to -1 dBFS",
    loop: `Loops/${loopName}`, preview: w ? `Preview_Wet/${previewName}` : null, files: manifest,
  };
  const enc = new TextEncoder();
  files.push({ name: `${root}/manifest.json`, data: enc.encode(JSON.stringify(info, null, 2)) });
  const cols = Object.keys(manifest[0]);
  files.push({ name: `${root}/manifest.csv`, data: enc.encode([cols.join(",")].concat(manifest.map((m) => cols.map((c) => m[c]).join(","))).join("\n") + "\n") });
  files.push({ name: `${root}/README.txt`, data: enc.encode(packReadme(info, sName, shName)) });
  return { root, files, zip: makeZip(files) };
}

async function exportPack() {
  if (S.packBusy) return;
  S.packBusy = true;
  try {
    const { root, zip } = await buildPack();
    download(zip, `${root}.zip`, "application/zip");
    toast("Game engine pack ready.");
  } finally { S.packBusy = false; }
}

function packReadme(info, sName, shName) {
  const paces = Object.values(S.cat.paces).map((p) => pascal(p.name)).join(", ");
  return `ModalForge footstep pack
========================
Surface: ${info.surface}    Footwear: ${info.shoe}    Walker: ${info.massKg} kg    Modes: ${info.source === "allsolve" ? "Allsolve 3D FEM" : "analytical preview"}
Every sound is synthesised from the floor's vibration modes. No recorded samples.

Contents
--------
Mono_Dry/<Pace>/   ${VARIATIONS} one-shot variations per pace (${paces}).
                   48 kHz, 24-bit, MONO, DRY (no reverb). The heel strike is at sample 0, so the
                   sound lines up with the animation event. Tails are trimmed to -70 dB with a 5 ms fade.
                   One gain is shared by the whole set (peak -1 dBFS), so a run is louder than a stroll.
Loops/             Seamless stereo loop of walking on the spot, room included. Good for crowds and ambience.
Preview_Wet/       The walk as heard in the app (room + output format). For trailers and reference only.
manifest.json/csv  Per file: pace, variation, seed, position, duration, peak and RMS level.

Why mono and dry? Game engines position the sound in 3D and add the room themselves
(Unity Reverb Zones / Audio Mixer, Unreal Reverb volumes and submixes). Stereo files or baked
reverb would be applied twice and would not move with the character.

Unity
-----
1. Drag the Mono_Dry folder into Assets/Audio/Footsteps/${sName}/.
2. Import settings (select all clips): Force To Mono on, Load Type "Decompress On Load",
   Compression "ADPCM" (or Vorbis, quality 70), Preload Audio Data on.
3. On the character: an AudioSource with Spatial Blend = 1 (3D), Doppler 0, Min Distance 1, Max Distance 25.
4. From an Animation Event on each foot plant:
     clip = clips[Random.Range(0, clips.Length)];  // avoid playing the same clip twice in a row
     source.pitch = Random.Range(0.96f, 1.04f);
     source.PlayOneShot(clip, Random.Range(0.9f, 1f));
5. Pick the clip array from the surface under the foot (raycast down, read the collider's
   PhysicMaterial name or a tag such as "${sName}").

Unreal Engine (5.x)
-------------------
1. Drag the Mono_Dry folder into the Content Browser. Each WAV becomes a Sound Wave.
2. Make a MetaSound Source: Wave Player fed by "Random Get (WaveAsset:Array)" with No Repeats = 1,
   plus a random pitch of +/-0.7 semitones. Or make a Sound Cue: Random -> Modulator (pitch 0.96-1.04, volume 0.9-1.0) -> Output.
3. Give it a Sound Attenuation asset (spatialisation on, falloff about 100-2500 cm).
4. In the walk/run animations, add "Play Sound" AnimNotifies on each foot plant. Or use a custom
   notify that traces down and selects the sound by Physical Surface (Project Settings -> Physics -> Physical Surface "${sName}").
5. Use the per-pace folders to swap sounds when the character changes speed.

FMOD / Wwise
------------
Put the variations of one pace in a Multi/Random Container (Wwise: Random Container, "avoid repeating last 2").
Add pitch +/-50 cents and volume -1..0 dB randomisation, and switch on surface and pace.

Re-rendering
------------
manifest.json stores the seed and floor position of every file. The same settings in ModalForge give the same sound.
`;
}

function exportModes() {
  const m = S.model;
  const data = {
    generator: "ModalForge", source: m.source, surface: S.surface.name, spec: m.spec, grid: m.grid, joists: m.joists,
    units: { f: "Hz", mass: "kg (modal, peak-normalised shape)", R: "m² (effective radiating area)" },
    modes: m.modes.map((x) => ({ f: +x.f.toFixed(3), Q: +x.Q.toFixed(1), mass: +x.mass.toFixed(4), R: +x.R.toFixed(4), shape: x.shape, grid: x.grid })),
  };
  download(new Blob([JSON.stringify(data)], { type: "application/json" }), `${fileBase()}_modes.json`);
}

// ------------------------------------------------------------------------------- API key status
async function refreshStatus(test = false) {
  const pill = $("#statusPill"), txt = $("#statusText");
  try {
    const s = await (await fetch("api/status")).json();
    S.status = s;
    if (!s.sdkInstalled) { pill.dataset.state = "missing"; txt.textContent = "Allsolve SDK not installed"; }
    else if (!s.configured) { pill.dataset.state = "missing"; txt.textContent = "Add Allsolve key"; }
    else { pill.dataset.state = "ok"; txt.textContent = test ? "Allsolve connected" : "Allsolve key ready"; }
  } catch {
    pill.dataset.state = "offline"; txt.textContent = "Server offline · preview only";
  }
}

function openKeyDialog(message) {
  const s = S.status || {};
  $("#keyStatus").innerHTML = [
    ["Server", S.status ? "running" : "offline"],
    ["Allsolve SDK", s.sdkInstalled ? `installed (${s.sdkVersion})` : "not installed: pip install -r requirements.txt"],
    ["API key", s.configured ? `found (${s.accessKeyHint})` : "not set"],
    ["Host", s.host || "–"],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("#envPath").textContent = s.envFile ? `File: ${s.envFile}` : "";
  const r = $("#keyResult"); r.textContent = message || ""; r.className = "key-result" + (message ? " bad" : "");
  $("#keyDialog").showModal();
}

// ------------------------------------------------------------------------------- tour
const TOUR = [
  ["#stepSurface", "Pick what you walk on", "Each surface is a real structure: boards, joists and supports, with real material data."],
  ["#stepSim", "Solve it with Allsolve", "One click sends the 3D floor to Quanscient's cloud solver. It returns how the floor vibrates: its natural modes."],
  [".floor-wrap", "Walk on it", "Click to take a step, or draw a path and press Walk. The colours show the floor ringing, slowed down so you can see it."],
  ["#exportPanel", "Take the sound with you", "Download the walk, every step as its own WAV, a Unity / Unreal footstep pack, and the raw mode data. Pick Headphones, Speakers, 5.1 or 7.1 under Output."],
];
let tourIdx = 0, spot = null;
function startTour() { tourIdx = 0; $("#tour").hidden = false; spot = spot || $("#tour").insertBefore(el("div", { className: "tour-spot" }), $("#tour").firstChild); showTour(); }
function showTour() {
  const [sel, title, body] = TOUR[tourIdx];
  const target = document.querySelector(sel);
  target.scrollIntoView({ block: "nearest" });
  const r = target.getBoundingClientRect();
  Object.assign(spot.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px`, display: "block" });
  $("#tourCount").textContent = `${tourIdx + 1} OF ${TOUR.length}`;
  $("#tourTitle").textContent = title; $("#tourBody").textContent = body;
  $("#tourNext").textContent = tourIdx === TOUR.length - 1 ? "Start" : "Next";
  const card = document.querySelector(".tour-card"), cw = 340, ch = card.offsetHeight || 180;
  let left = r.right + 18, top = r.top;
  if (left + cw > innerWidth - 12) left = r.left - cw - 18;
  if (left < 12) { left = Math.min(Math.max(12, r.left), innerWidth - cw - 12); top = r.bottom + 14; }
  card.style.left = `${left}px`; card.style.top = `${Math.min(Math.max(12, top), innerHeight - ch - 12)}px`;
}
function endTour() { $("#tour").hidden = true; if (spot) spot.style.display = "none"; store.set("mf-toured", true); }

// ------------------------------------------------------------------------------- wiring
function wire() {
  $("#simBtn").addEventListener("click", simulate);
  $("#walkBtn").addEventListener("click", walk);
  $("#clearPathBtn").addEventListener("click", () => S.view.clearPath());
  $("#toolSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.view.tool = b.dataset.tool;
    $("#toolSeg").querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    $("#floorHint").textContent = S.view.tool === "path" ? "Drag across the floor to draw a walking path, then press Walk." : "Click to step · drag the headphones to move · drag the teal dot or press Q/E to turn";
    $("#floorHint").style.opacity = 1;
  });
  $("#overlaySeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.view.overlay = b.dataset.overlay;
    $("#overlaySeg").querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    if (S.view.overlay === "loudness") updateLoudness(); else $("#legend").hidden = true;
  });
  $("#dlWalk").addEventListener("click", exportWalk);
  $("#dlStep").addEventListener("click", exportStep);
  $("#dlSteps").addEventListener("click", exportSteps);
  $("#dlPack").addEventListener("click", exportPack);
  $("#dlModes").addEventListener("click", exportModes);
  $("#statusPill").addEventListener("click", () => openKeyDialog());
  $("#reloadKeysBtn").addEventListener("click", async () => {
    try { await fetch("api/status/reload", { method: "POST" }); } catch { /* offline */ }
    await refreshStatus(); openKeyDialog(S.status?.configured ? "" : "Still no key in .env. Save the file first.");
    if (S.status?.configured) { $("#keyResult").textContent = "Key loaded."; $("#keyResult").className = "key-result ok"; }
  });
  $("#testKeysBtn").addEventListener("click", async () => {
    const r = $("#keyResult"); r.textContent = "Testing…"; r.className = "key-result";
    try {
      const t = await (await fetch("api/status/test", { method: "POST" })).json();
      r.textContent = t.message; r.className = "key-result " + (t.ok ? "ok" : "bad");
      await refreshStatus(t.ok);
    } catch { r.textContent = "The ModalForge server is not running."; r.className = "key-result bad"; }
  });
  $("#themeBtn").addEventListener("click", () => {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t; store.set("mf-theme", t);
    renderModeStrip(); if (S.lastStep) showSound(S.lastStep.mixed, S.lastStep.r);
  });
  $("#tourBtn").addEventListener("click", startTour);
  $("#tourNext").addEventListener("click", () => { if (++tourIdx >= TOUR.length) endTour(); else showTour(); });
  $("#tourSkip").addEventListener("click", endTour);
  addEventListener("resize", () => { if (!$("#tour").hidden) showTour(); });
  addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea, dialog") || e.metaKey || e.ctrlKey) return;
    if (e.code === "Space") { e.preventDefault(); walk(); }
    if (e.key === "s" || e.key === "S") {
      const { Lx, Ly } = S.model.spec; stepAt(0.1 + Math.random() * (Lx - 0.2), 0.1 + Math.random() * (Ly - 0.2));
    }
    if (e.key === "q" || e.key === "Q") S.view.rotateListener(Math.PI / 12);
    if (e.key === "e" || e.key === "E") S.view.rotateListener(-Math.PI / 12);
    if (e.key === "l" || e.key === "L") $("#loopBtn").click();
  });
  drawSpectrum($("#spectrum"), null);
}

// ------------------------------------------------------------------------------- utils
function el(tag, props = {}) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k in e && !k.includes("-")) e[k] = v; else e.setAttribute(k, v);
  }
  return e;
}

let toastTimer = 0;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3600);
}
