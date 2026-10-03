// Small canvas charts: waveform, mode spectrum, mode thumbnails.
import { cssVar } from "./floor.js";

function fit(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  return { ctx: canvas.getContext("2d"), W: canvas.width, H: canvas.height, d: dpr };
}

export function drawWave(canvas, L, R) {
  const { ctx, W, H } = fit(canvas);
  ctx.clearRect(0, 0, W, H);
  if (!L) return;
  const n = L.length, step = Math.max(1, Math.floor(n / W));
  ctx.fillStyle = cssVar("--copper");
  for (let x = 0; x < W; x++) {
    let mx = 0;
    for (let i = x * step; i < Math.min(n, (x + 1) * step); i++) mx = Math.max(mx, Math.abs(L[i]), R ? Math.abs(R[i]) : 0);
    const h = Math.max(1, Math.min(1, mx / 0.8) * (H / 2 - 2));
    ctx.fillRect(x, H / 2 - h, 1, 2 * h);
  }
}

export function drawSpectrum(canvas, contrib) {
  const { ctx, W, H, d } = fit(canvas);
  ctx.clearRect(0, 0, W, H);
  const fmin = 15, fmax = 4000;
  const X = (f) => (Math.log(f / fmin) / Math.log(fmax / fmin)) * (W - 12 * d) + 6 * d;
  ctx.strokeStyle = cssVar("--line"); ctx.fillStyle = cssVar("--muted"); ctx.lineWidth = 1;
  ctx.font = `${9.5 * d}px "Plex Mono", monospace`; ctx.textAlign = "center";
  for (const f of [31, 63, 125, 250, 500, 1000, 2000]) {
    const x = X(f); ctx.beginPath(); ctx.moveTo(x, 4 * d); ctx.lineTo(x, H - 14 * d); ctx.stroke();
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, H - 3 * d);
  }
  if (!contrib || !contrib.length) return;
  const peak = Math.max(...contrib.map((c) => c.peak));
  const floorDb = -40;
  ctx.fillStyle = cssVar("--copper");
  for (const c of contrib) {
    if (c.f < fmin || c.f > fmax) continue;
    const db = 20 * Math.log10(Math.max(c.peak / peak, 1e-6));
    const h = Math.max(0, (db - floorDb) / -floorDb) * (H - 22 * d);
    ctx.fillRect(X(c.f) - 1.5 * d, H - 14 * d - h, 3 * d, h);
  }
  ctx.fillStyle = cssVar("--text"); ctx.textAlign = "left";
  contrib.slice(0, 2).forEach((c, i) => ctx.fillText(`${c.f.toFixed(0)} Hz`, Math.min(X(c.f) + 5 * d, W - 50 * d), 12 * d + i * 12 * d));
}

/** Allsolve vs. textbook, mode by mode (crossCheck pairs): x = mode number, y = frequency (log).
 *  Hollow dots are the rigid-joist / clamped-plate formula, filled dots the 3D solve. A pair whose
 *  frequencies differ by more than `diverge` gets an amber connector; deck + joist modes a teal ring. */
export function drawCompare(canvas, pairs, diverge = 0.15) {
  const { ctx, W, H, d } = fit(canvas);
  ctx.clearRect(0, 0, W, H);
  if (!pairs || !pairs.length) return;
  const all = pairs.flatMap((p) => [p.fem, p.analytic]);
  const fmin = Math.min(...all) / 1.15, fmax = Math.max(...all) * 1.15;
  const L = 34 * d, R = 8 * d, T = 8 * d, B = 18 * d;
  const X = (k) => L + ((k - 0.5) / pairs.length) * (W - L - R);
  const Y = (f) => H - B - (Math.log(f / fmin) / Math.log(fmax / fmin)) * (H - T - B);
  ctx.strokeStyle = cssVar("--line"); ctx.fillStyle = cssVar("--muted"); ctx.lineWidth = 1;
  ctx.font = `${9.5 * d}px "Plex Mono", monospace`; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const f of [10, 20, 31, 50, 63, 100, 125, 200, 250, 500, 1000, 2000]) {
    if (f < fmin || f > fmax) continue;
    const y = Y(f); ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, L - 4 * d, y);
  }
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  const every = Math.max(1, Math.ceil(pairs.length / 8));
  pairs.forEach((p, i) => { if (i % every === 0) ctx.fillText(`#${p.k}`, X(p.k), H - 4 * d); });
  const r = Math.max(2 * d, Math.min(3.5 * d, (W - L - R) / pairs.length / 3));
  for (const p of pairs) {
    const x = X(p.k), off = Math.abs(p.diff) > diverge;
    ctx.strokeStyle = cssVar(off ? "--amber" : "--line"); ctx.lineWidth = off ? 2 * d : d;
    ctx.beginPath(); ctx.moveTo(x, Y(p.analytic)); ctx.lineTo(x, Y(p.fem)); ctx.stroke();
    ctx.strokeStyle = cssVar("--muted"); ctx.lineWidth = d;
    ctx.beginPath(); ctx.arc(x, Y(p.analytic), r, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillStyle = cssVar("--copper");
    ctx.beginPath(); ctx.arc(x, Y(p.fem), r, 0, 2 * Math.PI); ctx.fill();
    if (p.coupled) {
      ctx.strokeStyle = cssVar("--teal"); ctx.lineWidth = 1.5 * d;
      ctx.beginPath(); ctx.arc(x, Y(p.fem), r + 2.5 * d, 0, 2 * Math.PI); ctx.stroke();
    }
  }
}

export function drawModeThumb(canvas, model, mode) {
  const { ctx, W, H } = fit(canvas);
  const nx = 32, ny = Math.max(8, Math.round(32 * model.spec.Ly / model.spec.Lx));
  const img = ctx.createImageData(nx, ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = model.sample(mode.shape, (i + 0.5) * model.spec.Lx / nx, (ny - 0.5 - j) * model.spec.Ly / ny);
    const c = v >= 0 ? [224, 135, 74] : [79, 143, 192], a = Math.min(1, Math.abs(v));
    const o = (j * nx + i) * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = Math.round(40 + 215 * a);
  }
  const tmp = document.createElement("canvas"); tmp.width = nx; tmp.height = ny;
  tmp.getContext("2d").putImageData(img, 0, 0);
  ctx.fillStyle = cssVar("--floor-paper"); ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true; ctx.drawImage(tmp, 0, 0, W, H);
}
