// WAV encoding and a tiny dependency-free ZIP writer (stored, no compression).

import { CHANNEL_MASK } from "./spatial.js";

export function peakOf(channels) {
  let peak = 1e-9; for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  return peak;
}

/** PCM WAV. More than 2 channels → WAVE_FORMAT_EXTENSIBLE with a speaker mask (5.1/7.1), as engines and DAWs expect.
 *  opts.bits: 16 or 24. opts.gain: fixed gain (e.g. one gain for a whole variation set) instead of normalize. */
export function encodeWav(channels, sampleRate, normalize = false, { bits = 16, gain } = {}) {
  const nCh = channels.length, n = channels[0].length, B = bits / 8;
  const g = gain ?? (normalize ? 0.891 / peakOf(channels) : 1); // -1 dBFS
  const ext = nCh > 2;
  const fmtLen = ext ? 40 : 16, head = 12 + 8 + fmtLen + 8;
  const buf = new ArrayBuffer(head + n * nCh * B);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, head - 8 + n * nCh * B, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, fmtLen, true); v.setUint16(20, ext ? 0xfffe : 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * B, true); v.setUint16(32, nCh * B, true); v.setUint16(34, bits, true);
  if (ext) {
    v.setUint16(36, 22, true); v.setUint16(38, bits, true); v.setUint32(40, CHANNEL_MASK[nCh] || 0, true);
    // KSDATAFORMAT_SUBTYPE_PCM GUID 00000001-0000-0010-8000-00aa00389b71
    [1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71].forEach((b, i) => v.setUint8(44 + i, b));
  }
  str(head - 8, "data"); v.setUint32(head - 4, n * nCh * B, true);
  let o = head;
  for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) {
    const s = Math.max(-1, Math.min(1, channels[c][i] * g));
    if (B === 2) { v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    else {
      const q = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
      v.setUint8(o, q & 0xff); v.setUint8(o + 1, (q >> 8) & 0xff); v.setUint8(o + 2, (q >> 16) & 0xff); o += 3;
    }
  }
  return new Uint8Array(buf);
}

/** Game-ready one-shot: transient stays at sample 0, tail cut where it falls below `db` re. peak, short fade to true silence. */
export function trimTail(sig, db = -70, fadeMs = 5, sampleRate = 48000) {
  let peak = 1e-12; for (const v of sig) peak = Math.max(peak, Math.abs(v));
  const thr = peak * 10 ** (db / 20);
  let end = sig.length - 1; while (end > 0 && Math.abs(sig[end]) < thr) end--;
  const fade = Math.round(fadeMs * sampleRate / 1000), n = Math.min(sig.length, end + 1 + fade);
  const out = sig.slice(0, n);
  for (let i = 0; i < fade && n - 1 - i >= 0; i++) out[n - 1 - i] *= i / fade;
  return out;
}

/** Make a loop seamless: everything after `period` samples (ring-out, reverb) is wrapped back onto the start. */
export function wrapLoop(channels, period) {
  return channels.map((c) => {
    const out = new Float32Array(period);
    for (let i = 0; i < c.length; i++) out[i % period] += c[i];
    return out;
  });
}

export function rmsDb(channels) {
  let e = 0, n = 0; for (const c of channels) for (const v of c) { e += v * v; n++; }
  return 10 * Math.log10(e / Math.max(1, n) + 1e-20);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(data) { let c = 0xffffffff; for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

export function download(blobOrBytes, filename, type = "audio/wav") {
  const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
