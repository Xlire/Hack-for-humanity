// Game engine packs: variation sets of dry mono one-shots rendered from the floor model.
// No DOM here, so the same code runs in the browser and in Node (batch rendering).
//
// Loudness: each pack's files share one gain (loudest file at -1 dBFS), so a run stays louder than a stroll
// and every file uses the full bit depth. How loud the pack is next to OTHER packs comes from physics:
// the SPL at the walker's own ear (1.5 m above the foot) gives a calibrated playback volume. Real floors
// span ~100 dB (barefoot on concrete ~40 dB SPL, heels landing on pine ~136 dB SPL), far more than a game
// mix can use, so the differences are compressed 3:1. Order and proportions stay physical.

import { FS, PA_TO_DIGITAL, renderStep, dbSPL, mulberry32 } from "./synth.js";
import { encodeWav, trimTail, peakOf, rmsDb } from "./export.js";

export const VARIATIONS = 10;
/** Calibration reference [dB SPL peak at 1.5 m]: about the loudest catalogue sound (high heels landing
 *  on the old pine floor). A pack this loud plays at volume 1.0. */
export const CAL_REF_SPL = 136;
export const CAL_RATIO = 3; // range compression of physical level differences
export const UE_CONTENT_ROOT = "/Game/Audio/ModalForge";

export const pascal = (s) => s.replace(/\(.*?\)/g, "").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const pad2 = (n) => String(n).padStart(2, "0");

/** Everything a pack contains: the walking paces, then the extra actions (land, jump, scuff). */
export function packGroups(cat) {
  return [
    ...Object.entries(cat.paces).map(([id, p]) => ({ id, name: pascal(p.name), pace: p, run: id === "run" })),
    ...Object.entries(cat.actions || {}).map(([id, a]) => ({ id, name: pascal(a.name), pace: a, run: !!a.run, action: a })),
  ];
}

/** One one-shot of a group at (x, y), heard from the walker's ear. Returns pressure [Pa]. */
function renderShot(model, group, walker, x, y, seed) {
  const base = { ...walker, listener: { x, y }, x, y, seed };
  const a = group.action;
  if (a?.slideMs) return renderStep(model, { ...base, pace: group.pace, scuffMs: a.slideMs }).signal;
  const one = renderStep(model, { ...base, pace: group.pace, run: group.run }).signal;
  if (!(a?.feet > 1)) return one;
  // Landing: the second foot lands 8-30 ms later, a stride width away, a little softer.
  const rng = mulberry32(seed ^ 0x5bd1e995);
  const lag = Math.round((0.008 + rng() * 0.022) * FS);
  const x2 = Math.min(model.spec.Lx - 0.1, Math.max(0.1, x + (rng() < 0.5 ? -0.2 : 0.2)));
  const two = renderStep(model, { ...base, x: x2, pace: group.pace, run: group.run, seed: seed + 1, force: 0.85 }).signal;
  const out = new Float32Array(Math.max(one.length, two.length + lag));
  out.set(one);
  for (let i = 0; i < two.length; i++) out[i + lag] += two[i];
  return out;
}

/** Renders every group × variation. `onProgress(i, n, group)` may return a promise (lets the UI repaint).
 *  Positions and seeds come from `seed`, so the same seed gives the same pack. */
export async function renderShots(model, cat, walker, { variations = VARIATIONS, seed = 1, onProgress } = {}) {
  const rng = mulberry32(seed);
  const { Lx, Ly } = model.spec;
  const groups = packGroups(cat);
  const shots = [];
  for (const [k, g] of groups.entries()) {
    if (onProgress) await onProgress(k, groups.length, g);
    for (let v = 1; v <= variations; v++) {
      const x = 0.15 + rng() * (Lx - 0.3), y = 0.15 + rng() * (Ly - 0.3), s = (rng() * 1e9) >>> 0;
      const pa = renderShot(model, g, walker, x, y, s);
      shots.push({ group: g.name, groupId: g.id, variation: v, seed: s, x, y,
        sig: trimTail(Float32Array.from(pa, (p) => p * PA_TO_DIGITAL)), peakSPL: dbSPL(peakOf([pa])) });
    }
  }
  return shots;
}

/** One gain for the whole pack: the loudest file peaks at -1 dBFS. */
export function packGain(shots) { return 0.891 / peakOf(shots.map((s) => s.sig)); }

/** Calibrated playback volume of a pack [dB, ≤ 0], from its loudest file's physical level. */
export function packVolumeDb(shots) {
  const L = Math.max(...shots.map((s) => s.peakSPL));
  return Math.min(0, (L - CAL_REF_SPL) / CAL_RATIO);
}
const levelInfo = (shots) => {
  const volumeDb = packVolumeDb(shots);
  return { volumeDb: +volumeDb.toFixed(1), volume: +(10 ** (volumeDb / 20)).toFixed(4),
    levels: `files: one gain per pack, loudest at -1 dBFS. Calibrated volume ${volumeDb.toFixed(1)} dB `
      + `(= ${(10 ** (volumeDb / 20)).toFixed(3)}), from the pack's peak SPL at 1.5 m vs ${CAL_REF_SPL} dB, differences compressed ${CAL_RATIO}:1` };
};

function manifestRows(shots, gain, fileOf) {
  const gDb = 20 * Math.log10(gain);
  return shots.map((s) => ({
    file: fileOf(s), group: s.group, variation: s.variation, seed: s.seed, x_m: +s.x.toFixed(3), y_m: +s.y.toFixed(3),
    duration_s: +(s.sig.length / FS).toFixed(3), peak_dBFS: +(20 * Math.log10(peakOf([s.sig])) + gDb).toFixed(1),
    rms_dBFS: +(rmsDb([s.sig]) + gDb).toFixed(1), peak_dB_SPL_at_1m5: +s.peakSPL.toFixed(1),
  }));
}

const toCsv = (rows) => {
  const cols = Object.keys(rows[0]);
  return [cols.join(",")].concat(rows.map((r) => cols.map((c) => r[c]).join(","))).join("\n") + "\n";
};

/** Files of the generic engine pack (Unity / FMOD / Wwise / Unreal by hand): Mono_Dry/<Group>/SFX_Footstep_*.wav. */
export function genericPackFiles(shots, info) {
  const sName = pascal(info.surface), shName = pascal(info.shoe);
  const root = `ModalForge_${sName}_${shName}`;
  const gain = packGain(shots);
  const fileOf = (s) => `Mono_Dry/${s.group}/SFX_Footstep_${sName}_${shName}_${s.group}_${pad2(s.variation)}.wav`;
  const files = shots.map((s) => ({ name: `${root}/${fileOf(s)}`, data: encodeWav([s.sig], FS, false, { bits: 24, gain }) }));
  const rows = manifestRows(shots, gain, fileOf);
  return { root, files, rows, csv: toCsv(rows), sName, shName, ...levelInfo(shots) };
}

/** Unreal Engine pack: waves named for the Content Browser, a DataTable CSV and an editor import script. */
export function unrealPackFiles(shots, info, { contentRoot = UE_CONTENT_ROOT, importScript = "" } = {}) {
  const sName = pascal(info.surface), shName = pascal(info.shoe);
  const root = `ModalForge_UE_${sName}_${shName}`;
  const gain = packGain(shots);
  const asset = (s) => `SW_Footstep_${sName}_${shName}_${s.group}_${pad2(s.variation)}`;
  const folder = (s) => `${sName}/${shName}/${s.group}`;
  const fileOf = (s) => `Waves/${folder(s)}/${asset(s)}.wav`;
  const files = shots.map((s) => ({ name: `${root}/${fileOf(s)}`, data: encodeWav([s.sig], FS, false, { bits: 24, gain }) }));
  const rows = manifestRows(shots, gain, fileOf).map((r, i) => ({ ...r, ue_asset: `${contentRoot}/${folder(shots[i])}/${asset(shots[i])}` }));
  const enc = new TextEncoder();
  const manifest = { ...info, generator: "ModalForge", target: "Unreal Engine 5", sampleRate: FS, bitDepth: 24, channels: 1,
    surfaceName: sName, shoeName: shName, contentRoot, ...levelInfo(shots), calibrationRefSPL: CAL_REF_SPL, calibrationRatio: CAL_RATIO,
    processing: "dry (no room), transient at sample 0, trimmed to -70 dB, 5 ms fade", files: rows };
  files.push(
    { name: `${root}/manifest.json`, data: enc.encode(JSON.stringify(manifest, null, 2)) },
    { name: `${root}/DT_ModalForge_Footsteps.csv`, data: enc.encode(dataTableCsv(rows, sName, shName)) },
    { name: `${root}/import_modalforge.py`, data: enc.encode(importScript) },
    { name: `${root}/README_Unreal.txt`, data: enc.encode(unrealReadme(manifest, root)) },
  );
  return { root, files };
}

/** DataTable rows for the FModalForgeFootstepSet struct: one row per surface × shoe × group.
 *  Arrays of soft references use Unreal's CSV text format: "(""/Game/A.A"",""/Game/B.B"")". */
export function dataTableCsv(rows, sName, shName) {
  const byGroup = new Map();
  for (const r of rows) (byGroup.get(r.group) || byGroup.set(r.group, []).get(r.group)).push(r.ue_asset);
  const lines = ["---,Surface,Shoe,Action,Sounds,VolumeMultiplier,PitchMin,PitchMax"];
  for (const [group, assets] of byGroup) {
    const refs = assets.map((a) => `""${a}.${a.split("/").pop()}""`).join(",");
    lines.push([`${sName}_${shName}_${group}`, sName, shName, group, `"(${refs})"`, "1.0", "0.96", "1.04"].join(","));
  }
  return lines.join("\n") + "\n";
}

function unrealReadme(m, root) {
  const groups = [...new Set(m.files.map((f) => f.group))].join(", ");
  return `ModalForge footstep pack for Unreal Engine 5
============================================
Surface: ${m.surface}    Footwear: ${m.shoe}    Walker: ${m.massKg} kg    Modes: ${m.source === "allsolve" ? "Allsolve 3D FEM" : "analytical preview"}
Every sound is synthesised from the floor's vibration modes. No recorded samples.

Contents
--------
Waves/${m.surfaceName}/${m.shoeName}/<Action>/SW_*.wav
                     ${groups}: mono, dry, 48 kHz / 24-bit, heel strike at sample 0.
Levels               ${m.levels}.
                     The import script sets this volume (${m.volume}) on every Sound Wave, so this pack plays at
                     the right loudness next to every other ModalForge surface and shoe. If you play the waves
                     through a MetaSound Wave Player (which ignores the Sound Wave volume), multiply by it there.
DT_ModalForge_Footsteps.csv
                     DataTable rows "<Surface>_<Shoe>_<Action>" -> list of Sound Waves, volume, pitch range.
import_modalforge.py Editor script that does the whole import (below).
manifest.json        Per file: seed, floor position, duration, peak/RMS level, SPL, Unreal asset path.

One-step import (Unreal 5.x)
---------------------------
1. Enable the "Python Editor Script Plugin" (Edit -> Plugins), restart the editor.
2. Unzip this pack anywhere.
3. Tools -> Execute Python Script... -> pick ${root}/import_modalforge.py
   (or in the Output Log, Python mode:  py "C:/path/to/${root}/import_modalforge.py")

The script:
  * imports every WAV into ${m.contentRoot}/${m.surfaceName}/${m.shoeName}/<Action>/ (re-running replaces them),
  * sets the calibrated Volume and ATT_ModalForge_Footstep (attenuation, 3D, 50-2500 cm, created once) on every wave,
  * creates the Physical Material PM_ModalForge_${m.surfaceName} for your floor materials,
  * if the row struct ${m.contentRoot}/Core/S_ModalForgeFootstepSet exists: creates or updates the DataTable
    ${m.contentRoot}/DT_ModalForge_Footsteps, merging the rows of every pack you import.

Row struct (create once, if you want the DataTable)
---------------------------------------------------
Content Browser -> right click -> Blueprint -> Structure, save as ${m.contentRoot}/Core/S_ModalForgeFootstepSet with:
  Surface (Name), Shoe (Name), Action (Name), Sounds (Sound Wave, Soft Object Reference, Array),
  VolumeMultiplier (Float), PitchMin (Float), PitchMax (Float)
Then run the script again.

Playing the sounds
------------------
* Footstep AnimNotify on each foot plant -> line trace down -> Physical Material -> row "<Surface>_<Shoe>_<Action>"
  -> pick a random entry of Sounds (not the same as last time) -> Play Sound at Location with
  Volume = VolumeMultiplier, Pitch = random(PitchMin, PitchMax).
* Use the Land row on landing, Jump on take-off, Scuff when the character stops or turns sharply.
* Keep the waves dry: reverb comes from your Audio Volumes / submix, so steps sound right in every room.
`;
}
