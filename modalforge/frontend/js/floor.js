// The floor plan: procedural surface textures, joist lines, live modal vibration (slow motion),
// loudness map, footprints, listener and path drawing.

import { mulberry32 } from "./synth.js";

const VIS_NX = 48, VIS_NY = 36;

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Procedural texture for a surface, drawn into ctx over w x h pixels. */
export function drawTexture(ctx, kind, w, h, pxPerM, joistXs = [], grainAlongX = true) {
  const rng = mulberry32(kind.length * 977 + 13);
  const P = {
    pine:     { base: [196, 154, 104], var: 26, grain: "rgba(110,70,35,0.22)", gap: "rgba(40,24,10,0.55)" },
    oak:      { base: [150, 104, 62],  var: 22, grain: "rgba(70,40,18,0.25)", gap: "rgba(30,18,8,0.6)" },
    larch:    { base: [168, 118, 78],  var: 24, grain: "rgba(90,55,28,0.25)", gap: "rgba(16,12,8,0.9)" },
  }[kind];
  ctx.save();
  if (P) {
    const board = 0.12 * pxPerM;               // 120 mm boards
    const gap = kind === "larch" ? Math.max(2, 0.008 * pxPerM) : 1;
    for (let y = 0, row = 0; y < h; y += board, row++) {
      let x = -rng() * 1.2 * pxPerM;
      while (x < w) {
        const len = (0.9 + rng() * 1.6) * pxPerM;
        const v = (rng() - 0.5) * P.var;
        ctx.fillStyle = `rgb(${P.base[0] + v},${P.base[1] + v * 0.8},${P.base[2] + v * 0.6})`;
        ctx.fillRect(x, y, len, board - gap);
        ctx.strokeStyle = P.grain; ctx.lineWidth = 1;
        for (let g = 0; g < 5; g++) {
          const gy = y + (board - gap) * (0.15 + 0.7 * rng());
          ctx.beginPath(); ctx.moveTo(x, gy);
          for (let gx = x; gx < x + len; gx += 18) ctx.lineTo(gx, gy + Math.sin(gx * 0.02 + g) * 1.4);
          ctx.stroke();
        }
        ctx.fillStyle = P.gap; ctx.fillRect(x + len - 1, y, 1.5, board - gap);
        x += len;
      }
      if (gap > 1) { ctx.fillStyle = P.gap; ctx.fillRect(0, y + board - gap, w, gap); }
    }
  } else if (kind === "steel") {
    ctx.fillStyle = "#7d8792"; ctx.fillRect(0, 0, w, h);
    const s = Math.max(10, 0.035 * pxPerM);
    for (let y = 0, r = 0; y < h + s; y += s, r++) for (let x = (r % 2) * s / 2; x < w + s; x += s) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(r % 2 ? 0.8 : -0.8);
      ctx.fillStyle = "rgba(255,255,255,0.22)"; ctx.fillRect(-s * 0.32, -1.5, s * 0.64, 3);
      ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(-s * 0.32, 1.5, s * 0.64, 1.5);
      ctx.restore();
    }
  } else if (kind === "glass") {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "rgba(150,205,215,0.30)"); g.addColorStop(1, "rgba(90,150,170,0.22)");
    ctx.fillStyle = "#16242b"; ctx.fillRect(0, 0, w, h); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(220,245,250,0.18)"; ctx.lineWidth = 2;
    for (let k = -h; k < w; k += 140) { ctx.beginPath(); ctx.moveTo(k, h); ctx.lineTo(k + h * 0.6, 0); ctx.stroke(); }
  } else {
    ctx.fillStyle = "#8f9196"; ctx.fillRect(0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rng() - 0.5) * 26 + (rng() < 0.01 ? -40 : 0);
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }
  ctx.restore();
}

export class FloorView {
  constructor(canvas, handlers) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.h = handlers;
    this.model = null;
    this.texture = null;
    this.tool = "step";
    this.overlay = "vibration";
    this.listener = { x: 0, y: 0, yaw: Math.PI / 2 }; // yaw: facing direction (rad from +x); default faces into the floor
    this.path = [];
    this.footprints = [];
    this.excitations = [];
    this.selectedMode = null;
    this.loudness = null;
    this.visShapes = null;
    this.debris = null;       // { sprite, amount, bits: [{x, y, s, rot, v}] } loose material drawn on the floor
    this.debrisLayer = null;
    this.drag = null;
    this.field = document.createElement("canvas");
    this.field.width = VIS_NX; this.field.height = VIS_NY;
    this.fctx = this.field.getContext("2d");
    this.fimg = this.fctx.createImageData(VIS_NX, VIS_NY);
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    const loop = (t) => { this.draw(t / 1000); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  setModel(model, textureKind) {
    const old = this.model?.spec;
    this.model = model;
    this.textureKind = textureKind;
    const { Lx, Ly } = model.spec;
    if (!old) this.listener = { x: Lx * 0.5, y: Ly * 0.12, yaw: Math.PI / 2 };
    else if (old.Lx !== Lx || old.Ly !== Ly) {
      // resized: listener and path keep their relative place on the floor
      const sx = Lx / old.Lx, sy = Ly / old.Ly;
      this.listener = { ...this.listener, x: this.listener.x * sx, y: this.listener.y * sy };
      this.path = this.path.map((p) => ({ x: p.x * sx, y: p.y * sy }));
      this.footprints = [];
    }
    this.visShapes = model.modes.slice(0, 60).map((m) => {
      const a = new Float32Array(VIS_NX * VIS_NY);
      for (let j = 0; j < VIS_NY; j++) for (let i = 0; i < VIS_NX; i++)
        a[j * VIS_NX + i] = model.sample(m.shape, (i + 0.5) * model.spec.Lx / VIS_NX, (j + 0.5) * model.spec.Ly / VIS_NY);
      return a;
    });
    this.excitations = [];
    this.loudness = null;
    if (this.debris) this.setDebris(this.debris.sprite, this.debris.amount);
    this._layout();
  }

  /** Scatter loose material over the floor (sprite: shards, stones, sand, leaves, snow; null clears it). */
  setDebris(sprite, amount = 0.6) {
    if (!sprite || amount <= 0) { this.debris = null; this.debrisLayer = null; return; }
    if (!this.model) { this.debris = { sprite, amount, bits: [] }; return; } // scattered once the floor exists
    const { Lx, Ly } = this.model.spec;
    const perM2 = { shards: 70, stones: 160, sand: 1400, leaves: 45, snow: 500 }[sprite] ?? 80;
    const rng = mulberry32(sprite.length * 7919 + 3);
    const n = Math.round(perM2 * Lx * Ly * amount);
    const bits = Array.from({ length: n }, () => ({ x: rng() * Lx, y: rng() * Ly, s: rng(), rot: rng() * Math.PI * 2, v: rng() }));
    this.debris = { sprite, amount, bits };
    this._paintDebris();
  }

  _paintDebris() {
    if (!this.debris || !this.texture) { this.debrisLayer = null; return; }
    const { sprite, amount, bits } = this.debris, s = this.scale, Ly = this.model.spec.Ly;
    const c = this.debrisLayer || document.createElement("canvas");
    c.width = this.texture.width; c.height = this.texture.height;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (sprite === "sand") { ctx.fillStyle = `rgba(214,186,130,${0.35 * amount})`; ctx.fillRect(0, 0, c.width, c.height); }
    if (sprite === "snow") { ctx.fillStyle = `rgba(240,245,250,${0.55 * amount})`; ctx.fillRect(0, 0, c.width, c.height); }
    for (const b of bits) {
      const px = b.x * s, py = (Ly - b.y) * s;
      ctx.save(); ctx.translate(px, py); ctx.rotate(b.rot);
      if (sprite === "shards") {
        const r = (0.008 + 0.02 * b.s) * s;
        ctx.fillStyle = `rgba(${200 + 40 * b.v},240,250,0.55)`; ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(-r, -r * 0.3); ctx.lineTo(r * (0.4 + 0.6 * b.v), -r * 0.6); ctx.lineTo(r * 0.2, r * 0.7); ctx.closePath(); ctx.fill(); ctx.stroke();
      } else if (sprite === "stones") {
        const r = (0.006 + 0.014 * b.s * b.s) * s, g = 105 + 70 * b.v;
        ctx.fillStyle = `rgb(${g},${g - 6},${g - 14})`; ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.72, 0, 0, 7); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.beginPath(); ctx.ellipse(-r * 0.3, -r * 0.25, r * 0.4, r * 0.25, 0, 0, 7); ctx.fill();
      } else if (sprite === "sand") {
        const r = Math.max(0.6, (0.0015 + 0.002 * b.s) * s), g = 170 + 50 * b.v;
        ctx.fillStyle = `rgba(${g},${g - 30},${g - 85},0.8)`; ctx.fillRect(-r / 2, -r / 2, r, r);
      } else if (sprite === "leaves") {
        const r = (0.025 + 0.03 * b.s) * s;
        ctx.fillStyle = `rgba(${150 + 60 * b.v},${80 + 40 * b.v},30,0.85)`; ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.45, 0, 0, 7); ctx.fill();
        ctx.strokeStyle = "rgba(70,35,10,0.6)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.stroke();
      } else {
        const r = (0.01 + 0.025 * b.s) * s;
        ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
      }
      ctx.restore();
    }
    this.debrisLayer = c;
  }

  setLoudness(grid) { this.loudness = grid; }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.c.getBoundingClientRect();
    this.c.width = Math.max(1, Math.round(r.width * dpr));
    this.c.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr;
    this._layout();
  }

  _layout() {
    if (!this.model) return;
    const { Lx, Ly } = this.model.spec;
    const W = this.c.width, H = this.c.height, pad = 64 * this.dpr;
    const s = Math.min((W - 2 * pad) / Lx, (H - 2 * pad - 30 * this.dpr) / Ly);
    this.scale = s;
    this.ox = (W - Lx * s) / 2;
    this.oy = (H - Ly * s) / 2 - 6 * this.dpr;
    const tex = document.createElement("canvas");
    tex.width = Math.max(1, Math.round(Lx * s)); tex.height = Math.max(1, Math.round(Ly * s));
    drawTexture(tex.getContext("2d"), this.textureKind, tex.width, tex.height, s);
    this.texture = tex;
    this._paintDebris();
  }

  toPx(x, y) { return [this.ox + x * this.scale, this.oy + (this.model.spec.Ly - y) * this.scale]; }
  toM(px, py) { return [(px - this.ox) / this.scale, this.model.spec.Ly - (py - this.oy) / this.scale]; }

  /** Screen position of the heading handle (tip of the facing arrow). */
  headingPx() {
    const [lx, ly] = this.toPx(this.listener.x, this.listener.y), R = 34 * this.dpr;
    return [lx + Math.cos(this.listener.yaw) * R, ly - Math.sin(this.listener.yaw) * R];
  }

  rotateListener(dYaw) { this.listener = { ...this.listener, yaw: this.listener.yaw + dYaw }; this.h.onListener?.(this.listener); }

  inside(x, y) { return this.model && x >= 0 && y >= 0 && x <= this.model.spec.Lx && y <= this.model.spec.Ly; }

  _bind() {
    const pos = (e) => { const r = this.c.getBoundingClientRect(); return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr]; };
    this.c.addEventListener("pointerdown", (e) => {
      if (!this.model) return;
      const [px, py] = pos(e); const [x, y] = this.toM(px, py);
      const [lx, ly] = this.toPx(this.listener.x, this.listener.y);
      const [hx, hy] = this.headingPx();
      if (Math.hypot(px - hx, py - hy) < 11 * this.dpr) { this.drag = "yaw"; this.c.setPointerCapture(e.pointerId); return; }
      if (Math.hypot(px - lx, py - ly) < 22 * this.dpr) { this.drag = "listener"; this.c.setPointerCapture(e.pointerId); return; }
      if (!this.inside(x, y)) return;
      if (this.tool === "path") { this.drag = "path"; this.path = [{ x, y }]; this.c.setPointerCapture(e.pointerId); this.h.onPathChange?.(this.path); }
      else this.h.onStep?.(x, y);
    });
    this.c.addEventListener("pointermove", (e) => {
      if (!this.model) return;
      const [px, py] = pos(e); let [x, y] = this.toM(px, py);
      const [lx, ly] = this.toPx(this.listener.x, this.listener.y);
      const [hx, hy] = this.headingPx();
      const onYaw = this.drag === "yaw" || Math.hypot(px - hx, py - hy) < 11 * this.dpr;
      this.c.style.cursor = onYaw ? "alias" : this.drag === "listener" || Math.hypot(px - lx, py - ly) < 22 * this.dpr ? "grab" : "crosshair";
      if (!this.drag) return;
      if (this.drag === "yaw") {
        this.listener = { ...this.listener, yaw: Math.atan2(y - this.listener.y, x - this.listener.x) };
        this.h.onListener?.(this.listener); return;
      }
      x = Math.min(Math.max(x, 0.02), this.model.spec.Lx - 0.02); y = Math.min(Math.max(y, 0.02), this.model.spec.Ly - 0.02);
      if (this.drag === "listener") { this.listener = { ...this.listener, x, y }; this.h.onListener?.(this.listener); }
      if (this.drag === "path") {
        const last = this.path[this.path.length - 1];
        if (Math.hypot(x - last.x, y - last.y) > 0.06) { this.path.push({ x, y }); this.h.onPathChange?.(this.path); }
      }
    });
    const up = () => { this.drag = null; };
    this.c.addEventListener("pointerup", up);
    this.c.addEventListener("pointercancel", up);
  }

  /** Visual excitation from a step. Real mode amplitudes, slow-motion time base. */
  excite(x, y, contrib, side = 1, angle = 0) {
    if (!this.model) return;
    const amps = new Map(contrib.map((c) => [c.f, c.peak]));
    const peak = Math.max(1e-12, ...contrib.map((c) => c.peak));
    const list = [];
    this.model.modes.slice(0, this.visShapes.length).forEach((m, k) => {
      const a = (amps.get(m.f) || 0) / peak;
      if (a > 0.02) {
        const fv = 1.2 + 2.4 * (k / Math.max(1, this.visShapes.length - 1)); // slow-motion frequency [Hz]
        const tau = Math.min(4, Math.max(0.35, m.Q / (Math.PI * fv) * 0.18));
        list.push({ k, a: a * Math.sign(this.model.sample(m.shape, x, y) || 1), fv, tau });
      }
    });
    this.excitations.push({ t0: performance.now() / 1000, list });
    if (this.excitations.length > 6) this.excitations.shift();
    this.footprints.push({ x, y, t0: performance.now() / 1000, side, angle });
    if (this.footprints.length > 40) this.footprints.shift();
    // the step pushes loose material aside
    if (this.debris) {
      const R = 0.16, { Lx, Ly } = this.model.spec;
      let moved = false;
      for (const b of this.debris.bits) {
        const dx = b.x - x, dy = b.y - y, dist = Math.hypot(dx, dy);
        if (dist > R) continue;
        const push = (R - dist) * 0.35 * (0.5 + b.v) / Math.max(dist, 0.01);
        b.x = Math.min(Lx, Math.max(0, b.x + dx * push)); b.y = Math.min(Ly, Math.max(0, b.y + dy * push));
        b.rot += (b.v - 0.5) * 0.8; moved = true;
      }
      if (moved) this._paintDebris();
    }
  }

  clearPath() { this.path = []; this.h.onPathChange?.(this.path); }

  draw(now) {
    const ctx = this.ctx, W = this.c.width, H = this.c.height, d = this.dpr;
    ctx.clearRect(0, 0, W, H);
    if (!this.model || !this.texture) return;
    const { Lx, Ly } = this.model.spec;
    const [x0, y0] = this.toPx(0, Ly);
    const fw = Lx * this.scale, fh = Ly * this.scale;

    // shadow + texture
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 24 * d; ctx.shadowOffsetY = 8 * d;
    ctx.fillStyle = "#000"; ctx.fillRect(x0, y0, fw, fh);
    ctx.restore();
    ctx.drawImage(this.texture, x0, y0, fw, fh);
    if (this.debrisLayer) ctx.drawImage(this.debrisLayer, x0, y0, fw, fh);

    // overlay field
    let fieldDrawn = false;
    if (this.selectedMode != null && this.visShapes[this.selectedMode]) {
      const wob = Math.cos(now * 2 * Math.PI * 0.8);
      this._paintField((i) => this.visShapes[this.selectedMode][i] * wob, 0.75); fieldDrawn = true;
    } else if (this.overlay === "loudness" && this.loudness) {
      this._paintLoudness(); fieldDrawn = true;
    } else if (this.overlay === "vibration" && this.excitations.length) {
      const field = new Float32Array(VIS_NX * VIS_NY);
      let any = false;
      for (const ex of this.excitations) {
        const t = now - ex.t0;
        for (const e of ex.list) {
          const env = Math.exp(-t / e.tau);
          if (env < 0.01) continue;
          any = true;
          const c = e.a * env * Math.cos(2 * Math.PI * e.fv * t);
          const sh = this.visShapes[e.k];
          for (let i = 0; i < field.length; i++) field[i] += c * sh[i];
        }
      }
      if (any) { this._paintField((i) => field[i], 0.85); fieldDrawn = true; }
      else this.excitations = [];
    }
    if (fieldDrawn) {
      ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.field, x0, y0, fw, fh); ctx.restore();
    }

    // joists (dashed: hidden below the deck)
    ctx.save();
    ctx.setLineDash([7 * d, 6 * d]); ctx.lineWidth = 1.5 * d; ctx.strokeStyle = "rgba(255,255,255,0.55)";
    for (const xj of this.model.joists) {
      const [px] = this.toPx(xj, 0);
      ctx.beginPath(); ctx.moveTo(px, y0); ctx.lineTo(px, y0 + fh); ctx.stroke();
    }
    ctx.restore();

    // frame + dimension lines (drafting style)
    const ink = cssVar("--muted");
    ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = 1 * d;
    ctx.strokeRect(x0, y0, fw, fh);
    ctx.font = `${11 * d}px "Plex Mono", monospace`; ctx.textAlign = "center";
    const dimY = y0 + fh + 22 * d;
    ctx.beginPath(); ctx.moveTo(x0, dimY); ctx.lineTo(x0 + fw, dimY);
    ctx.moveTo(x0, dimY - 5 * d); ctx.lineTo(x0, dimY + 5 * d); ctx.moveTo(x0 + fw, dimY - 5 * d); ctx.lineTo(x0 + fw, dimY + 5 * d); ctx.stroke();
    ctx.fillText(`${Lx.toFixed(2)} m`, x0 + fw / 2, dimY - 6 * d);
    const dimX = x0 - 22 * d;
    ctx.beginPath(); ctx.moveTo(dimX, y0); ctx.lineTo(dimX, y0 + fh);
    ctx.moveTo(dimX - 5 * d, y0); ctx.lineTo(dimX + 5 * d, y0); ctx.moveTo(dimX - 5 * d, y0 + fh); ctx.lineTo(dimX + 5 * d, y0 + fh); ctx.stroke();
    ctx.save(); ctx.translate(dimX - 7 * d, y0 + fh / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(`${Ly.toFixed(2)} m`, 0, 0); ctx.restore();
    if (this.model.joists.length) {
      ctx.textAlign = "left";
      ctx.fillText(`joists @ ${((this.model.joists[1] - this.model.joists[0]) * 100).toFixed(0)} cm`, x0, y0 - 10 * d);
    }

    // path
    if (this.path.length > 1) {
      ctx.save(); ctx.strokeStyle = cssVar("--copper"); ctx.lineWidth = 2.5 * d; ctx.setLineDash([2 * d, 7 * d]); ctx.lineCap = "round";
      ctx.beginPath(); this.path.forEach((p, i) => { const [px, py] = this.toPx(p.x, p.y); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.stroke();
      const [ex, ey] = this.toPx(this.path[this.path.length - 1].x, this.path[this.path.length - 1].y);
      ctx.setLineDash([]); ctx.fillStyle = cssVar("--copper"); ctx.beginPath(); ctx.arc(ex, ey, 5 * d, 0, 7); ctx.fill();
      ctx.restore();
    }

    // footprints
    for (const f of this.footprints) {
      const age = now - f.t0, alpha = Math.max(0, 1 - age / 6);
      if (alpha <= 0) continue;
      const [px, py] = this.toPx(f.x, f.y);
      this._foot(px, py, f.angle, f.side, alpha);
      if (age < 0.6) {
        ctx.save(); ctx.strokeStyle = `rgba(240,170,110,${0.8 * (1 - age / 0.6)})`; ctx.lineWidth = 2 * d;
        ctx.beginPath(); ctx.arc(px, py, (8 + age * 90) * d, 0, 7); ctx.stroke(); ctx.restore();
      }
    }

    // listener: facing cone + arrow with a draggable tip (screen y is flipped, so the angle is -yaw)
    const [lx, ly] = this.toPx(this.listener.x, this.listener.y);
    const [hx, hy] = this.headingPx(), sy = -this.listener.yaw;
    ctx.save();
    const cone = ctx.createRadialGradient(lx, ly, 10 * d, lx, ly, 90 * d);
    cone.addColorStop(0, "rgba(90,190,180,0.28)"); cone.addColorStop(1, "rgba(90,190,180,0)");
    ctx.fillStyle = cone; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.arc(lx, ly, 90 * d, sy - 0.6, sy + 0.6); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = cssVar("--teal"); ctx.lineWidth = 2 * d;
    ctx.beginPath(); ctx.moveTo(lx + Math.cos(sy) * 15 * d, ly + Math.sin(sy) * 15 * d); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.fillStyle = cssVar("--teal"); ctx.beginPath(); ctx.arc(hx, hy, 6 * d, 0, 7); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = cssVar("--panel"); ctx.strokeStyle = cssVar("--teal"); ctx.lineWidth = 2 * d;
    ctx.beginPath(); ctx.arc(lx, ly, 15 * d, 0, 7); ctx.fill(); ctx.stroke();
    ctx.lineWidth = 1.8 * d;
    ctx.beginPath(); ctx.arc(lx, ly + 1 * d, 7 * d, Math.PI, 0); ctx.stroke();
    ctx.fillStyle = cssVar("--teal");
    ctx.fillRect(lx - 8.5 * d, ly, 3.5 * d, 6 * d); ctx.fillRect(lx + 5 * d, ly, 3.5 * d, 6 * d);
    ctx.font = `500 ${10.5 * d}px "Plex Mono", monospace`; ctx.textAlign = "center";
    const tw = ctx.measureText("listener").width + 12 * d;
    ctx.fillStyle = cssVar("--panel"); ctx.beginPath(); ctx.roundRect(lx - tw / 2, ly + 19 * d, tw, 16 * d, 8 * d); ctx.fill();
    ctx.fillStyle = cssVar("--teal"); ctx.fillText("listener", lx, ly + 31 * d);
    ctx.restore();
  }

  _paintField(valueAt, maxAlpha) {
    const data = this.fimg.data;
    let peak = 1e-9;
    for (let i = 0; i < VIS_NX * VIS_NY; i++) peak = Math.max(peak, Math.abs(valueAt(i)));
    const norm = Math.max(peak, 0.35);
    const pos = [224, 135, 74], neg = [79, 143, 192];
    for (let j = 0; j < VIS_NY; j++) for (let i = 0; i < VIS_NX; i++) {
      // canvas row 0 is the top of the floor (y = Ly)
      const v = valueAt((VIS_NY - 1 - j) * VIS_NX + i) / norm;
      const c = v >= 0 ? pos : neg, a = Math.min(1, Math.abs(v));
      const o = (j * VIS_NX + i) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = Math.round(255 * maxAlpha * Math.pow(a, 0.8));
    }
    this.fctx.putImageData(this.fimg, 0, 0);
  }

  _paintLoudness() {
    const { values, nx, ny, min, max } = this.loudness;
    const data = this.fimg.data;
    for (let j = 0; j < VIS_NY; j++) for (let i = 0; i < VIS_NX; i++) {
      const gi = Math.min(nx - 1, Math.floor(i / VIS_NX * nx)), gj = Math.min(ny - 1, Math.floor((VIS_NY - 1 - j) / VIS_NY * ny));
      const t = (values[gj * nx + gi] - min) / Math.max(1e-9, max - min);
      const [r, g, b] = heat(t);
      const o = (j * VIS_NX + i) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 175;
    }
    this.fctx.putImageData(this.fimg, 0, 0);
  }

  _foot(px, py, angle, side, alpha) {
    const ctx = this.ctx, d = this.dpr, s = this.scale;
    ctx.save(); ctx.translate(px, py); ctx.rotate(-angle + Math.PI / 2);
    ctx.fillStyle = `rgba(20,16,12,${0.55 * alpha})`;
    ctx.strokeStyle = `rgba(255,236,214,${0.7 * alpha})`; ctx.lineWidth = 1.2 * d;
    const L = 0.27 * s, Wd = 0.095 * s;
    ctx.beginPath(); ctx.ellipse(0, -L * 0.18, Wd * 0.5, L * 0.32, 0, 0, 7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(side * Wd * 0.05, L * 0.27, Wd * 0.38, L * 0.17, 0, 0, 7); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}

/** Sequential heat ramp for the loudness map (quiet = deep blue, loud = copper/gold). */
export function heat(t) {
  const stops = [[30, 42, 74], [61, 90, 128], [224, 135, 74], [244, 213, 141]];
  t = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t)), u = t - i;
  return stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * u));
}
