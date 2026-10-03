// Loose material lying on the floor: broken glass, gravel, sand. No samples: every grain is computed.
//
//  timing   grains break or shift while the load changes: onsets are drawn from a density that follows
//           the foot force F(t), mostly where it rises (heel and toe loading), some where it falls (release)
//  grain    a few decaying sinusoids (its own little modal bank, frequencies log-uniform in [fLo, fHi])
//           plus a contact tick, and for brittle material a broadband "snap" (the crack)
//  hiss     band-passed noise riding the load: friction of many unresolved particles (sand slide, crunch bed)
//  force    every grain also pushes the deck a little, so the floor's own modes ring under the debris
//
// Output is pressure [Pa] at distance r, plus an extra force [N] for the floor, both at FS.

import { FS } from "./synth.js";

/** One-pole smoothing of |F|, normalised to peak 1. */
function loadEnvelope(F) {
  const a = 1 - Math.exp(-2 * Math.PI * 30 / FS); // ~5 ms
  const env = new Float32Array(F.length);
  let s = 0, max = 0;
  for (let i = 0; i < F.length; i++) { s += a * (Math.abs(F[i]) - s); env[i] = s; if (s > max) max = s; }
  if (max > 0) for (let i = 0; i < env.length; i++) env[i] /= max;
  return env;
}

/** RBJ band-pass biquad (constant 0 dB peak gain). */
function bandpass(fc, Q) {
  const w = 2 * Math.PI * fc / FS, al = Math.sin(w) / (2 * Q), a0 = 1 + al;
  return { b0: al / a0, b2: -al / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - al) / a0 };
}

/** d: a catalogue debris entry. amount 0..1. Returns { air: Float32Array [Pa], force: Float32Array [N] }. */
export function renderDebris(d, amount, { F, Th, massKg, impact = 0.75, scuff = false, hardness = 0.8, r, rng }) {
  const g = d.grains, h = d.hiss;
  const tailS = (d.settle ? d.settle.ms / 1000 : 0) + 0.08;
  const len = F.length + Math.round(tailS * FS);
  const air = new Float32Array(len), force = new Float32Array(len);
  if (amount <= 0) return { air, force };
  const massScale = Math.sqrt(massKg / 75);
  const env = loadEnvelope(F);

  // Onset density: rising load crushes, falling load lets particles shift back, steady load adds a few.
  const w = new Float64Array(F.length);
  let wSum = 0, riseMax = 1e-12, fallMax = 1e-12;
  for (let i = 1; i < F.length; i++) { const dv = env[i] - env[i - 1]; riseMax = Math.max(riseMax, dv); fallMax = Math.max(fallMax, -dv); }
  for (let i = 1; i < F.length; i++) {
    const dv = env[i] - env[i - 1];
    w[i] = 0.3 * env[i] + Math.max(0, dv) / riseMax + (g.release ?? 0) * Math.max(0, -dv) / fallMax;
    wSum += w[i];
  }
  const cdf = new Float64Array(F.length);
  for (let i = 1, c = 0; i < F.length; i++) { c += w[i] / wSum; cdf[i] = c; }
  const drawOnset = () => {
    const u = rng();
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; }
    return lo;
  };

  // How many grains: more material, harder pace and a dragged foot all disturb more of it.
  const nGrains = Math.round(g.count * amount * (impact / 0.75) ** 0.5 * (scuff ? 1.6 : 1) * (0.8 + 0.4 * rng()));
  const ampRef = 1.2 * g.level * massScale * (0.6 + 0.4 * hardness) / r; // [Pa] of the loudest possible grain
  const forceRef = 25 * (d.force ?? 0) * massScale;                       // [N] peak push of the loudest grain
  const lnLo = Math.log(g.fLo), lnHi = Math.log(g.fHi);

  const grain = (i0, rel) => {
    const A = ampRef * rel;
    for (let k = 0; k < g.modes; k++) {
      const f = Math.exp(lnLo + rng() * (lnHi - lnLo));
      if (f > FS * 0.45) continue;
      const Q = g.q * (0.7 + 0.6 * rng());
      const tau = Q / (Math.PI * f);
      const n = Math.min(len - i0, Math.ceil(tau * 6.91 * FS));
      const a = A * (0.4 + 0.6 * rng()) / Math.sqrt(g.modes);
      // recursive sine oscillator: y[n] = 2cos(w) y[n-1] - y[n-2], times the decay
      const wf = 2 * Math.PI * f / FS, c = 2 * Math.cos(wf), dec = Math.exp(-1 / (tau * FS));
      const ph = rng() * 2 * Math.PI;
      let y1 = Math.sin(ph - wf), y2 = Math.sin(ph - 2 * wf), e = a;
      for (let j = 0; j < n; j++) {
        const y = c * y1 - y2; y2 = y1; y1 = y;
        air[i0 + j] += e * y * Math.min(1, j / 8); // 8-sample attack: no click from the phase jump
        e *= dec;
      }
    }
    // contact tick: a short band-limited noise burst, length set by the shoe's softness
    const nT = Math.max(12, Math.min(96, Math.round(Th * 0.25 * FS)));
    for (let j = 0, lp = 0; j < nT && i0 + j < len; j++) {
      lp += 0.5 * ((rng() * 2 - 1) - lp);
      air[i0 + j] += A * (g.tick ?? 0.5) * lp * Math.sin(Math.PI * j / nT);
    }
    // brittle snap: a very short, bright crack (differentiated noise)
    if (rng() < (g.snap ?? 0)) {
      const nS = Math.round((0.3 + 0.7 * rng()) * 1e-3 * FS);
      let prev = 0;
      for (let j = 0; j < nS && i0 + j < len; j++) {
        const v = rng() * 2 - 1;
        air[i0 + j] += A * 1.2 * (v - prev) * Math.exp(-4 * j / nS); prev = v;
      }
    }
    // the push into the deck: a 0.3 ms half-sine
    if (forceRef > 0) {
      const nF = Math.round(0.0003 * FS);
      for (let j = 0; j < nF && i0 + j < len; j++) force[i0 + j] += forceRef * rel * Math.sin(Math.PI * j / nF);
    }
  };

  // Power-law sizes: many tiny events, a few loud ones.
  for (let k = 0; k < nGrains; k++) grain(drawOnset(), amount * rng() ** 3);
  // Settling: a few stones still tumbling after the foot is planted.
  if (d.settle) {
    const n = Math.round(d.settle.count * amount * (0.6 + 0.8 * rng()));
    const t0 = Math.round(F.length * 0.5), span = Math.round(d.settle.ms / 1000 * FS);
    for (let k = 0; k < n; k++) grain(Math.min(len - 1, t0 + Math.round(span * rng() ** 1.5)), amount * d.settle.level * rng() ** 2);
  }

  // Hiss: unit-RMS band-passed noise (two cascaded biquads), enveloped by the load and its changes.
  if (h && h.level > 0) {
    const fc = Math.sqrt(h.fLo * h.fHi), bp = bandpass(fc, fc / (h.fHi - h.fLo));
    const hamp = 0.1 * h.level * amount * massScale / r;
    const run = (x, s) => {
      const y = bp.b0 * x + bp.b2 * s[1] - bp.a1 * s[2] - bp.a2 * s[3];
      s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y; return y;
    };
    const s1 = [0, 0, 0, 0], s2 = [0, 0, 0, 0];
    const nH = Math.min(len, F.length + Math.round(0.04 * FS));
    const noise = new Float32Array(nH);
    let e2 = 0;
    for (let i = 0; i < nH; i++) { noise[i] = run(run(rng() * 2 - 1, s1), s2); e2 += noise[i] * noise[i]; }
    const norm = 1 / Math.sqrt(e2 / nH + 1e-20);
    const dvMax = Math.max(riseMax, fallMax);
    let m = 0;
    for (let i = 0; i < nH; i++) {
      const k = Math.min(i, F.length - 1);
      const dv = k > 0 ? env[k] - env[k - 1] : 0;
      const target = i < F.length ? 0.5 * env[k] + 0.5 * Math.abs(dv) / dvMax : 0;
      m += (target > m ? 0.02 : 0.002) * (target - m); // fast attack, slow release
      air[i] += hamp * norm * m * noise[i];
    }
  }
  return { air, force };
}
