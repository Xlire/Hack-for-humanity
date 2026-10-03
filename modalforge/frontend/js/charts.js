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
