// Listener-relative spatialisation of dry (mono, pascal) step signals.
//
//  binaural   Web Audio HRTF panner per step: front/back and "below the ears" cues for headphones
//  stereo     equal-power pan by azimuth; sources behind the head are slightly darkened
//  5.1 / 7.1  pairwise amplitude panning (2D VBAP-style) over ITU speaker angles + LFE (< 80 Hz)
//
// Distance attenuation is NOT applied here: the synthesiser already models it physically (1/r).
// Channel order follows WAVE/SMPTE so exported files open correctly in DAWs and game engines.

import { FS, EAR_HEIGHT } from "./synth.js";

export const OUTPUTS = {
  binaural: { name: "Headphones", channels: 2, hint: "Binaural (HRTF): hear front, back and the floor below you." },
  stereo:   { name: "Speakers",   channels: 2, hint: "Stereo speakers. Steps behind you sound slightly darker." },
  "5.1":    { name: "5.1",        channels: 6, hint: "5.1 surround: L R C LFE Ls Rs." },
  "7.1":    { name: "7.1",        channels: 8, hint: "7.1 surround: L R C LFE Lb Rb Ls Rs." },
};

// Speaker azimuths in degrees (0 = front, + = right). null = LFE (no direction).
const LAYOUTS = {
  "5.1": [-30, 30, 0, null, -110, 110],
  "7.1": [-30, 30, 0, null, -150, 150, -90, 90],
};
export const LFE_INDEX = 3;
export const CHANNEL_MASK = { 1: 0x4, 2: 0x3, 6: 0x3f, 8: 0x63f };

/** Where a floor point is, seen from the listener's head. yaw: facing direction in floor coords (rad, from +x). */
export function relative(listener, x, y) {
  const yaw = listener.yaw ?? Math.PI / 2;
  const dx = x - listener.x, dy = y - listener.y;
  const forward = dx * Math.cos(yaw) + dy * Math.sin(yaw);
  const right = dx * Math.sin(yaw) - dy * Math.cos(yaw);
  return { forward, right, az: Math.atan2(right, forward), dist: Math.hypot(forward, right) };
}

/** items: [{ t, x, y, signal }] (signal = mono Float32Array). Returns Float32Array[] (one per output channel). */
export async function spatialize(items, listener, mode = "binaural") {
  const nCh = (OUTPUTS[mode] || OUTPUTS.stereo).channels;
  const len = Math.ceil(Math.max(...items.map((it) => it.t * FS + it.signal.length))) + 1;
  if (mode === "binaural" && typeof OfflineAudioContext !== "undefined") return binaural(items, listener, len);
  const out = Array.from({ length: nCh }, () => new Float32Array(len));
  for (const it of items) {
    const { az } = relative(listener, it.x, it.y);
    const off = Math.round(it.t * FS);
    if (nCh === 2) stereoPan(it.signal, az, out, off);
    else surroundPan(it.signal, az, LAYOUTS[mode], out, off);
  }
  return out;
}

async function binaural(items, listener, len) {
  const ctx = new OfflineAudioContext(2, len, FS);
  for (const it of items) {
    const { forward, right } = relative(listener, it.x, it.y);
    const buf = ctx.createBuffer(1, it.signal.length, FS);
    buf.copyToChannel(it.signal, 0);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const p = new PannerNode(ctx, {
      panningModel: "HRTF", distanceModel: "linear", rolloffFactor: 0, refDistance: 1, maxDistance: 1e4,
      // Web Audio listener: at origin, facing -z, up +y. The floor is EAR_HEIGHT below the ears.
      positionX: right, positionY: -EAR_HEIGHT, positionZ: -forward,
    });
    src.connect(p).connect(ctx.destination);
    src.start(it.t);
  }
  const r = await ctx.startRendering();
  return [r.getChannelData(0).slice(), r.getChannelData(1).slice()];
}

function stereoPan(sig, az, out, off) {
  const pan = Math.sin(az);                        // -1 left … +1 right, front/back folded only in the gains
  const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
  const rear = Math.max(0, -Math.cos(az)) * 0.55;  // behind the head: the pinna shadows high frequencies
  const a = 1 - Math.exp(-2 * Math.PI * 3500 / FS);
  let lp = 0;
  const [L, R] = out;
  for (let i = 0; i < sig.length; i++) {
    lp += a * (sig[i] - lp);
    const v = sig[i] * (1 - rear) + lp * rear;
    L[off + i] += gl * v; R[off + i] += gr * v;
  }
}

function surroundPan(sig, az, layout, out, off) {
  const deg = (az * 180) / Math.PI;
  const spk = layout.map((a, i) => ({ a, i })).filter((s) => s.a !== null).sort((p, q) => p.a - q.a);
  // find the adjacent pair (wrapping through the back) that contains the source direction
  let s1 = spk[spk.length - 1], s2 = spk[0], span = 360 - s1.a + s2.a, t = (deg - s1.a + 360) % 360 / span;
  for (let k = 0; k < spk.length - 1; k++) {
    if (deg >= spk[k].a && deg <= spk[k + 1].a) { s1 = spk[k]; s2 = spk[k + 1]; span = s2.a - s1.a; t = (deg - s1.a) / span; break; }
  }
  t = Math.min(1, Math.max(0, t));
  const g1 = Math.cos(t * Math.PI / 2), g2 = Math.sin(t * Math.PI / 2);
  const A = out[s1.i], B = out[s2.i], LFE = out[LFE_INDEX];
  const a = 1 - Math.exp(-2 * Math.PI * 80 / FS);
  let lp1 = 0, lp2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const v = sig[i];
    A[off + i] += g1 * v; B[off + i] += g2 * v;
    lp1 += a * (v - lp1); lp2 += a * (lp1 - lp2);   // 2-pole low-pass for the sub channel
    LFE[off + i] += 0.316 * lp2;                     // −10 dB, the usual LFE send level
  }
}

/** Fold 5.1/7.1 down to stereo (ITU-style coefficients) for devices without surround output. */
export function downmixStereo(ch) {
  if (ch.length <= 2) return ch;
  const n = ch[0].length, L = new Float32Array(n), R = new Float32Array(n), k = Math.SQRT1_2;
  const sides = ch.length === 8 ? [[4, 5], [6, 7]] : [[4, 5]];
  for (let i = 0; i < n; i++) {
    let l = ch[0][i] + k * ch[2][i], r = ch[1][i] + k * ch[2][i];
    for (const [a, b] of sides) { l += k * ch[a][i]; r += k * ch[b][i]; }
    L[i] = l; R[i] = r;
  }
  return [L, R];
}
