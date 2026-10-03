// Footstep synthesis from floor modes. No samples: every sound is computed.
//
//  force F(t)   heel strike (half-sine, width set by heel hardness) + forefoot contact + weight transfer
//  each mode k  q̈ + (ω/Q) q̇ + ω² q = φk(step) F(t) / mk           (modal equation of motion)
//  pressure     p(t) = ρ0 / (2π r) · Σ Rk q̈k(t)                     (baffled radiator, volume acceleration)
//  plus         a contact "click" (local, non-modal) and a statistical high-frequency fill above
//               the highest computed mode. Output is in pascals at the listener.

import { RHO_AIR } from "./physics.js";
import { renderDebris } from "./debris.js";

export const FS = 48000;
export const EAR_HEIGHT = 1.5;      // listener ear height above the floor [m]
export const PA_TO_DIGITAL = 0.25;  // fixed (≈106 dB peak → full scale): clean exports, honest relative loudness.
                                    // Extra loudness for playback comes from the volume + limiter stage in main.js.
const G = 9.81;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ground reaction force of one footstep [N], sampled at FS.
 *  Two physically distinct parts (as in gait biomechanics and the ISO 10140 tapping machine):
 *   - the heel "click": a small effective mass (heel + shoe) stopping in Th, impulse ≈ 0.03–0.3 N·s
 *     (the ISO tapping hammer, built to imitate hard heels, delivers 0.44 N·s);
 *   - body-weight loading: ~0.75–1.6 BW, rising over 25 ms (heel) and 40 ms (forefoot): mostly sub-audio. */
export function footForce(shoe, pace, massKg, rng, run = false, force = 1) {
  const BW = massKg * G * force;
  const jitter = (s) => 1 + (rng() * 2 - 1) * s;
  const Th = (shoe.heelMs / 1000) * jitter(0.12);
  const paceScale = pace.impact / 0.75;
  const impulse = shoe.impulse * paceScale * (pace.click ?? 1) * Math.sqrt(massKg / 75) * force * jitter(0.15); // N·s
  const Fh = (impulse * Math.PI) / (2 * Th);       // peak of the click half-sine
  const toeDelay = (run ? 0.03 : 0.085) * jitter(0.15);
  const n = Math.ceil((toeDelay + 0.2) * FS);
  const F = new Float32Array(n);
  const halfSine = (t0, T, A) => {
    const i0 = Math.round(t0 * FS), len = Math.max(2, Math.round(T * FS));
    for (let i = 0; i < len && i0 + i < n; i++) F[i0 + i] += A * Math.sin(Math.PI * i / len);
  };
  // Body loading is smooth (continuous slope), so its spectrum falls off fast: Hann pulses.
  const hann = (t0, T, A) => {
    const i0 = Math.round(t0 * FS), len = Math.max(2, Math.round(T * FS));
    for (let i = 0; i < len && i0 + i < n; i++) F[i0 + i] += A * 0.5 * (1 - Math.cos(2 * Math.PI * i / len));
  };
  const toeClick = Fh * shoe.toeRatio * jitter(0.15);
  const heelLoadT = run ? 0.05 : 0.06, heelLoad = pace.impact * BW * jitter(0.08);
  const toeLoad = 0.3 * BW * jitter(0.1);
  halfSine(0, Th, Fh);                       // heel click
  halfSine(toeDelay, Th * 1.6, toeClick);    // forefoot click
  hann(0, heelLoadT, heelLoad);              // heel loading
  hann(toeDelay, 0.09, toeLoad);             // forefoot loading
  // parts: the drawn values of this step (the Math & provenance report shows them)
  return { F, Th, Fh, parts: { BW, impulse, toeDelay, toeClick, heelLoadT, heelLoad, toeLoad } };
}

/** A foot dragged across the floor [N]: body weight shifting over the slide, plus the roughness of
 *  sole against surface as a stream of small band-limited impacts (a fraction of a heel click). */
export function scuffForce(shoe, massKg, rng, slideMs) {
  const T = (slideMs / 1000) * (1 + (rng() * 2 - 1) * 0.2);
  const Th = shoe.heelMs / 1000;
  const Fh = (0.03 * shoe.impulse * Math.PI) / (2 * Th) * Math.sqrt(massKg / 75); // sole roughness: far below a heel click
  const len = Math.round(T * FS), F = new Float32Array(len + Math.round(0.02 * FS));
  const alpha = 1 - Math.exp(-2 * Math.PI * Math.min(8000, 0.9 / Th) / FS);
  const norm = 1 / Math.sqrt(alpha / (2 - alpha)); // unit-RMS one-pole lowpassed noise
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const env = Math.sin(Math.PI * i / len);
    lp += alpha * ((rng() * 2 - 1) - lp);
    F[i] = env * env * 0.2 * massKg * G + env * Fh * lp * norm;
  }
  return { F, Th, Fh };
}

/** One step at floor position (x, y). Returns mono pressure signal [Pa] and diagnostics.
 *  scuffMs > 0 renders a scuff (sliding foot) of about that length instead of a step.
 *  debris (a catalogue debris entry) adds loose material on the floor, debrisAmount 0..1 of it. */
export function renderStep(model, { x, y, listener, shoe, pace, massKg, seed = 1, run = false, maxModes = 1500, force = 1, scuffMs = 0, debris = null, debrisAmount = 0.6 }) {
  const rng = mulberry32(seed);
  const foot = scuffMs ? scuffForce(shoe, massKg, rng, scuffMs) : footForce(shoe, pace, massKg, rng, run, force);
  const { Th, Fh } = foot;
  let F = foot.F;
  const nF = F.length;
  const r = Math.hypot(x - listener.x, y - listener.y, EAR_HEIGHT);
  const radiation = RHO_AIR / (2 * Math.PI * r);

  // Loose material on the floor: its own sound, plus the grains' pushes added to the force on the deck.
  // Own RNG stream, so a floor without debris sounds exactly as before.
  let deb = null, dampClick = 1, dampHf = 1;
  if (debris && debrisAmount > 0) {
    deb = renderDebris(debris, debrisAmount, { F, Th, massKg, impact: force * (pace?.impact ?? 0.75), scuff: !!scuffMs,
      hardness: shoe.hardness, r, rng: mulberry32((seed ^ 0x9e3779b9) >>> 0) });
    const F2 = new Float32Array(Math.max(nF, deb.force.length));
    F2.set(F);
    for (let i = 0; i < deb.force.length; i++) F2[i] += deb.force[i];
    F = F2;
    dampClick = 1 - debrisAmount * (1 - (debris.damp?.click ?? 1));
    dampHf = 1 - debrisAmount * (1 - (debris.damp?.hf ?? 1));
  }

  // Duration: until the slowest relevant mode has decayed 60 dB (capped).
  const modes = model.modes.slice(0, maxModes);
  let T60max = 0.25;
  for (const m of modes) T60max = Math.max(T60max, Math.min(3.2, 6.91 * m.Q / (Math.PI * m.f)));
  const N = Math.max(Math.ceil((T60max + 0.08) * FS) + (scuffMs ? nF : 0), deb ? deb.air.length : 0);
  const out = new Float32Array(N);
  const contrib = [];
  const dt = 1 / FS;

  for (const m of modes) {
    const phi = model.sample(m.shape, x, y);
    if (Math.abs(phi) < 1e-4) continue;
    const w = 2 * Math.PI * m.f, zeta = 1 / (2 * m.Q);
    if (w * dt > 2.6) continue; // above ~Nyquist safety
    const wd = w * Math.sqrt(1 - zeta * zeta);
    const rr = Math.exp(-zeta * w * dt);
    const a1 = 2 * rr * Math.cos(wd * dt), a2 = -rr * rr;
    const b1 = dt * rr * Math.sin(wd * dt) / wd;  // impulse-invariant displacement response
    const gain = (phi / m.mass) * m.R * radiation;
    const Nm = Math.min(N, Math.ceil((Math.min(3.2, 6.91 * m.Q / (Math.PI * m.f)) + 0.05) * FS) + F.length);
    let q1 = 0, q2 = 0, qp1 = 0, qp2 = 0, peak = 0;
    for (let i = 0; i < Nm; i++) {
      const xin = i > 0 && i - 1 < F.length ? F[i - 1] : 0;
      const q = a1 * q1 + a2 * q2 + b1 * xin;
      // acceleration by central second difference (one-sample delay, inaudible)
      const acc = (q - 2 * q1 + q2) * FS * FS;
      const p = gain * acc;
      out[i] += p;
      if (Math.abs(p) > peak) peak = Math.abs(p);
      q2 = q1; q1 = q; qp2 = qp1; qp1 = q;
    }
    contrib.push({ f: m.f, peak });
  }

  // Contact click: local shoe/surface contact noise, bandwidth set by heel duration.
  const clickLen = scuffMs ? nF : Math.max(Math.round(Th * 2.2 * FS), 48);
  const cutoff = Math.min(14000, 0.9 / Th);
  const alpha = 1 - Math.exp(-2 * Math.PI * cutoff / FS);
  const clickAmp = 2.2e-4 * Fh * shoe.hardness * model.contact / r * dampClick;
  let lp = 0;
  for (let i = 0; i < clickLen; i++) {
    lp += alpha * ((rng() * 2 - 1) - lp);
    out[i] += clickAmp * lp * Math.sin(Math.PI * i / clickLen) * (scuffMs ? 0.35 : 1.8);
  }

  // High-frequency fill above the last computed mode (modal density there is high).
  const fTop = modes.length ? modes[modes.length - 1].f : 1500;
  let early = 0;
  const nE = Math.min(N, Math.round(0.05 * FS));
  for (let i = 0; i < nE; i++) early += out[i] * out[i];
  const rmsEarly = Math.sqrt(early / nE);
  const Qavg = modes.length ? modes.reduce((s, m) => s + m.Q, 0) / modes.length : 60;
  const tau = Math.min(0.6, Math.max(0.015, Qavg / (Math.PI * fTop)));
  const bright = 1 / (1 + (fTop * Th * 1.5) ** 2);
  const hfAmp = 0.35 * rmsEarly * bright * dampHf;
  const hpA = Math.exp(-2 * Math.PI * fTop / FS);
  let hpPrevIn = 0, hpOut = 0;
  const nH = Math.min(N, Math.round(tau * 7 * FS));
  for (let i = 0; i < nH; i++) {
    const nIn = rng() * 2 - 1;
    hpOut = hpA * (hpOut + nIn - hpPrevIn); hpPrevIn = nIn;
    out[i] += hfAmp * hpOut * Math.exp(-i / (tau * FS));
  }

  if (deb) for (let i = 0; i < deb.air.length; i++) out[i] += deb.air[i];

  let peakPa = 0;
  for (let i = 0; i < N; i++) peakPa = Math.max(peakPa, Math.abs(out[i]));
  contrib.sort((a, b) => b.peak - a.peak);
  return { signal: out, peakPa, r, contrib, ringTime: estimateRing(out) };
}

function estimateRing(sig) {
  // time until the envelope falls 40 dB below its peak
  const win = Math.round(0.01 * FS);
  let peak = 0, peakAt = 0;
  const env = [];
  for (let i = 0; i < sig.length; i += win) {
    let e = 0; for (let k = i; k < Math.min(sig.length, i + win); k++) e = Math.max(e, Math.abs(sig[k]));
    env.push(e); if (e > peak) { peak = e; peakAt = env.length - 1; }
  }
  for (let k = peakAt; k < env.length; k++) if (env[k] < peak * 0.01) return (k * win) / FS;
  return sig.length / FS;
}

/** Steps along a path (array of {x,y} in metres). Returns step events with times.
 *  Human gait is not a metronome: stride time varies ~2–4 %, stride length and foot placement a little,
 *  and the two feet rarely strike equally hard. */
export function planSteps(path, pace, Lx, Ly, rng = mulberry32(1)) {
  if (path.length < 2) return [];
  const cadence = pace.cadence;           // steps per minute
  const stepLen = pace.cadence > 150 ? 1.0 : 0.62 + (cadence - 90) * 0.004;
  const dtStep = 60 / cadence;
  const seg = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const L = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    seg.push({ a: path[i - 1], b: path[i], L, s0: total }); total += L;
  }
  const steps = [];
  const jit = () => rng() * 2 - 1;
  const footBias = { 1: 1 + 0.1 * jit(), [-1]: 1 + 0.1 * jit() }; // per-foot strike strength
  let side = 1, t = 0;
  for (let s = stepLen * 0.3; s <= total; s += stepLen * (1 + 0.04 * jit())) {
    const g = seg.find((q) => s <= q.s0 + q.L) || seg[seg.length - 1];
    const u = g.L > 0 ? (s - g.s0) / g.L : 0;
    const dx = (g.b.x - g.a.x) / (g.L || 1), dy = (g.b.y - g.a.y) / (g.L || 1);
    const off = 0.09 * side + 0.015 * jit(); // feet are ~18 cm apart
    const fwd = 0.02 * jit();
    const x = Math.min(Math.max(g.a.x + dx * (g.L * u + fwd) - dy * off, 0.02), Lx - 0.02);
    const y = Math.min(Math.max(g.a.y + dy * (g.L * u + fwd) + dx * off, 0.02), Ly - 0.02);
    steps.push({ t, x, y, side, angle: Math.atan2(dy, dx), force: footBias[side] * (1 + 0.05 * jit()) });
    t += dtStep * (1 + 0.03 * jit());
    side = -side;
  }
  return steps;
}

/** Renders every step of a walk as a dry mono signal [Pa]. Spatialisation happens in spatial.js.
 *  seedBase changes the variation (each loop pass of a walk uses a new one). */
export function renderWalk(model, steps, opts, seedBase = 1000) {
  if (!steps.length) return null;
  const rendered = steps.map((s, i) => ({ s, r: renderStep(model, { ...opts, x: s.x, y: s.y, force: s.force ?? 1, seed: (seedBase + i * 7919) >>> 0 }) }));
  return { rendered, items: rendered.map(({ s, r }) => ({ t: s.t, x: s.x, y: s.y, signal: r.signal })) };
}

/** Length of a room's impulse response [s]: tail plus the latest discrete echo. */
function irSeconds(room) {
  const echoes = (room.echoes || []).map(([ms]) => ms / 1000);
  const flutter = room.flutter ? (room.flutter.ms * room.flutter.n) / 1000 : 0;
  return (room.predelayMs || 0) / 1000 + Math.max(room.rt60, 0.05) * 1.1 + Math.max(0, ...echoes, flutter) + 0.02;
}

/** Mono room impulse response for one output channel (decorrelated per channel by the seed):
 *  pre-delay, early reflections, a diffuse exponentially decaying tail whose high frequencies die
 *  faster (hfDamp), plus discrete echoes (cave, outdoor slap-back) and flutter (parallel gym walls). */
export function roomIR(room, channel = 0) {
  const len = Math.round(irSeconds(room) * FS);
  const d = new Float32Array(len);
  const rng = mulberry32(77 + channel * 1013);
  const pre = Math.round((room.predelayMs || 0) * FS / 1000);
  const rt = Math.max(room.rt60, 0.02), damp = room.hfDamp ?? 0.5;
  let lp = 0, a = 1;
  for (let i = pre; i < len; i++) {
    const t = (i - pre) / FS;
    if ((i - pre) % 64 === 0) a = 1 - Math.exp(-2 * Math.PI * Math.max(250, 14000 * Math.exp(-t * damp * 4)) / FS);
    lp += a * ((rng() * 2 - 1) - lp);
    d[i] = lp * Math.exp((-6.91 * t) / rt) * Math.min(1, t / 0.008);
  }
  const tap = (ms, g) => {
    const k = Math.round(ms * FS / 1000);
    for (let j = 0; j < 24 && k + j < len; j++) d[k + j] += g * Math.exp(-j / 4) * (j === 0 ? 1 : (rng() * 2 - 1) * 0.5);
  };
  for (const [ms, g] of room.early || []) tap((room.predelayMs || 0) + ms + channel * 1.7, g);
  for (const [ms, g] of room.echoes || []) tap(ms + channel * 2.3, g);
  if (room.flutter) for (let k = 1; k <= room.flutter.n; k++) tap(k * room.flutter.ms + channel * 0.4, room.flutter.g * room.flutter.decay ** k);
  return d;
}

/** Applies the room (dry + diffuse wet, decorrelated per channel) and converts pascals to digital level.
 *  channels: Float32Array[] in output order. lfe: index of an LFE channel that gets no reverb. */
export async function finishMix(channels, room, lfe = -1) {
  const toDigital = (a) => { for (let i = 0; i < a.length; i++) a[i] *= PA_TO_DIGITAL; return a; };
  if (!room || room.wet <= 0) return channels.map((c) => softClip(toDigital(c)));
  const n = channels.length, len = channels[0].length;
  const tail = Math.round(irSeconds(room) * FS);
  const ctx = new OfflineAudioContext(n, len + tail, FS);
  // the reverb is fed by the whole (non-LFE) signal: a room is diffuse, every speaker hears all of it
  const dryCh = channels.filter((_, c) => c !== lfe);
  const sum = new Float32Array(len), k = Math.sqrt(2 / dryCh.length) * 0.5;
  for (const c of dryCh) for (let i = 0; i < len; i++) sum[i] += c[i] * k;
  const buf = ctx.createBuffer(1, len, FS); buf.copyToChannel(sum, 0);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const merger = ctx.createChannelMerger(n);
  for (let c = 0; c < n; c++) {
    if (c === lfe) continue;
    const ir = ctx.createBuffer(1, Math.round(irSeconds(room) * FS), FS);
    ir.copyToChannel(roomIR(room, c), 0);
    const conv = new ConvolverNode(ctx, { disableNormalization: false, channelCount: 1, channelCountMode: "explicit" });
    conv.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = room.wet * 2.2;
    src.connect(conv).connect(wet).connect(merger, 0, c);
  }
  merger.connect(ctx.destination);
  src.start();
  const done = await ctx.startRendering();
  return channels.map((dry, c) => {
    const out = done.getChannelData(c).slice();
    for (let i = 0; i < len; i++) out[i] += dry[i];
    return softClip(toDigital(out));
  });
}

export function softClip(a) {
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (Math.abs(v) > 0.8) a[i] = Math.sign(v) * (0.8 + 0.2 * Math.tanh((Math.abs(v) - 0.8) / 0.2)); }
  return a;
}

/** A single mode ringing on its own (for the mode cards). */
export function renderModeTone(mode, seconds = 1.6) {
  const N = Math.round(seconds * FS), out = new Float32Array(N);
  const w = 2 * Math.PI * mode.f, zeta = 1 / (2 * mode.Q);
  const T60 = Math.min(seconds, 6.91 * mode.Q / (Math.PI * mode.f));
  for (let i = 0; i < N; i++) {
    const t = i / FS;
    out[i] = 0.35 * Math.exp(-zeta * w * t) * Math.sin(w * t) * Math.min(1, i / 96) * (t < T60 ? 1 : Math.exp(-(t - T60) * 20));
  }
  return out;
}

export function dbSPL(pa) { return 20 * Math.log10(Math.max(pa, 1e-9) / 20e-6); }
