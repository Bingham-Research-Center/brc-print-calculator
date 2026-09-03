// Run with: node --test
// Extracts the BRC_MODEL block from index.html and exercises the parsers and estimate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('/* BRC_MODEL_START */'), end = html.indexOf('/* BRC_MODEL_END */');
assert.ok(start > 0 && end > start, 'BRC_MODEL block not found in index.html');
const M = new Function(html.slice(start, end) + '\nreturn BRCModel;')();

const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const toBuf = (s) => new TextEncoder().encode(s).slice().buffer;

/* ---- fixtures ---- */

// Axis-aligned box as 12 outward-facing triangles.
function boxTris([x0, y0, z0], [x1, y1, z1]){
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const P = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const quads = [[0,1,2,3],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  const out = [];
  for (const q of quads){
    for (const [a, b, d] of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]){
      let [A, B, C] = [P[a], P[b], P[d]];
      const u = B.map((v, i) => v - A[i]), w = C.map((v, i) => v - A[i]);
      const n = [u[1]*w[2] - u[2]*w[1], u[2]*w[0] - u[0]*w[2], u[0]*w[1] - u[1]*w[0]];
      const mid = [0, 1, 2].map(i => (A[i] + B[i] + C[i]) / 3 - c[i]);
      if (n[0]*mid[0] + n[1]*mid[1] + n[2]*mid[2] < 0) [B, C] = [C, B];
      out.push(...A, ...B, ...C);
    }
  }
  return Float32Array.from(out);
}
function concat(...list){
  const out = new Float32Array(list.reduce((n, t) => n + t.length, 0));
  let off = 0;
  for (const t of list){ out.set(t, off); off += t.length; }
  return out;
}
function binarySTL(tris){
  const n = tris.length / 9, buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++){
    const p = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) dv.setFloat32(p + k * 4, tris[i * 9 + k], true);
  }
  return buf;
}
function asciiSTL(tris){
  let s = 'solid part\n';
  for (let i = 0; i < tris.length; i += 9){
    s += ' facet normal 0 0 0\n  outer loop\n';
    for (let k = 0; k < 9; k += 3) s += `   vertex ${tris[i+k]} ${tris[i+k+1]} ${tris[i+k+2]}\n`;
    s += '  endloop\n endfacet\n';
  }
  return s + 'endsolid part\n';
}
// Dedupe vertices; returns { verts: [[x,y,z]...], faces: [[i,j,k]...] } with 0-based indices.
function indexed(tris){
  const verts = [], index = new Map(), flat = [];
  for (let i = 0; i < tris.length; i += 3){
    const key = `${tris[i]} ${tris[i+1]} ${tris[i+2]}`;
    if (!index.has(key)){ index.set(key, verts.length); verts.push([tris[i], tris[i+1], tris[i+2]]); }
    flat.push(index.get(key));
  }
  const faces = [];
  for (let i = 0; i < flat.length; i += 3) faces.push(flat.slice(i, i + 3));
  return { verts, faces };
}
function objText(tris){
  const { verts, faces } = indexed(tris);
  return verts.map(v => `v ${v.join(' ')}`).join('\n') + '\n' + faces.map(f => `f ${f.map(i => `${i + 1}/1/1`).join(' ')}`).join('\n') + '\n';
}
function modelXML(tris, { unit = 'millimeter', id = '1' } = {}){
  const { verts, faces } = indexed(tris);
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="${id}" type="model"><mesh>
   <vertices>${verts.map(v => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('')}</vertices>
   <triangles>${faces.map(f => `<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"/>`).join('')}</triangles>
  </mesh></object>
 </resources>
 <build><item objectid="${id}"/></build>
</model>`;
}
// Minimal zip writer: [{ name, data: string | Uint8Array, stored?: boolean }]
function zip(entries){
  const enc = new TextEncoder(), crc = zlib.crc32 ? (b) => zlib.crc32(b) : () => 0;
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries){
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const name = enc.encode(e.name), method = e.stored ? 0 : 8;
    const data = method ? zlib.deflateRawSync(raw) : raw;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(8, method, true); local.setUint32(14, crc(raw), true);
    local.setUint32(18, data.length, true); local.setUint32(22, raw.length, true); local.setUint16(26, name.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(10, method, true); cd.setUint32(16, crc(raw), true);
    cd.setUint32(20, data.length, true); cd.setUint32(24, raw.length, true); cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, central.reduce((n, p) => n + p.length, 0), true); eocd.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all){ out.set(p, o); o += p.length; }
  return out.buffer;
}

// Same archive in zip64 form: 0xFFFFFFFF in the 32-bit size/offset fields, real values in
// zip64 extra fields, plus the zip64 end-of-central-directory record and locator.
function zip64(entries){
  const enc = new TextEncoder(), crc = zlib.crc32 ? (b) => zlib.crc32(b) : () => 0, FF = 0xFFFFFFFF;
  const parts = [], central = [];
  let offset = 0;
  const x64 = (...vals) => { const d = new DataView(new ArrayBuffer(4 + 8 * vals.length)); d.setUint16(0, 1, true); d.setUint16(2, 8 * vals.length, true); vals.forEach((v, i) => d.setBigUint64(4 + 8 * i, BigInt(v), true)); return new Uint8Array(d.buffer); };
  for (const e of entries){
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data, data = zlib.deflateRawSync(raw), name = enc.encode(e.name);
    const lx = x64(raw.length, data.length), local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 45, true); local.setUint16(8, 8, true); local.setUint32(14, crc(raw), true);
    local.setUint32(18, FF, true); local.setUint32(22, FF, true); local.setUint16(26, name.length, true); local.setUint16(28, lx.length, true);
    const cx = x64(raw.length, data.length, offset), cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(6, 45, true); cd.setUint16(10, 8, true); cd.setUint32(16, crc(raw), true);
    cd.setUint32(20, FF, true); cd.setUint32(24, FF, true); cd.setUint16(28, name.length, true); cd.setUint16(30, cx.length, true); cd.setUint32(42, FF, true);
    parts.push(new Uint8Array(local.buffer), name, lx, data);
    central.push(new Uint8Array(cd.buffer), name, cx);
    offset += 30 + name.length + lx.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const z64 = new DataView(new ArrayBuffer(56));
  z64.setUint32(0, 0x06064b50, true); z64.setBigUint64(4, 44n, true); z64.setUint16(12, 45, true); z64.setUint16(14, 45, true);
  z64.setBigUint64(24, BigInt(entries.length), true); z64.setBigUint64(32, BigInt(entries.length), true);
  z64.setBigUint64(40, BigInt(cdSize), true); z64.setBigUint64(48, BigInt(offset), true);
  const loc = new DataView(new ArrayBuffer(20));
  loc.setUint32(0, 0x07064b50, true); loc.setBigUint64(8, BigInt(offset + cdSize), true); loc.setUint32(16, 1, true);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, FF, true);
  const all = [...parts, ...central, new Uint8Array(z64.buffer), new Uint8Array(loc.buffer), new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all){ out.set(p, o); o += p.length; }
  return out.buffer;
}

const CUBE = boxTris([0, 0, 0], [10, 10, 10]);
const EST = { layerHeight:0.2, wallThickness:0.87, topThickness:1.0, bottomThickness:0.6, infill:0.15, supportDensity:0.08, supportFlow:1.5, layerSeconds:4.5, fixedSeconds:360, fixedGrams:1 };
const PLA = { density:1.26, flow:9 };

/* ---- mesh readers + metrics ---- */

test('binary STL cube: volume, area, height, shell weights, nothing overhanging on the bed', () => {
  const m = M.meshMetrics(M.parseSTL(binarySTL(CUBE)), 30);
  assert.equal(m.triangles, 12);
  near(m.volume, 1000); near(m.area, 600); near(m.height, 10);
  near(m.topW, 100); near(m.botW, 100); near(m.wallW, 400);
  near(m.overhangArea, 0);
  assert.equal(m.suspect, false);
});

test('ASCII STL and OBJ read the same cube', () => {
  near(M.meshMetrics(M.parseSTL(toBuf(asciiSTL(CUBE))), 30).volume, 1000);
  near(M.meshMetrics(M.parseOBJ(objText(CUBE)), 30).volume, 1000);
});

test('OBJ polygons are fan-triangulated and negative indices resolve', () => {
  const t = M.parseOBJ('v 0 0 0\nv 10 0 0\nv 10 10 0\nv 0 10 0\nf 1 2 3 4\nf -4 -3 -2\n');
  assert.equal(t.length, 27);
  assert.throws(() => M.parseOBJ('# nothing here\n'));
});

test('overhangs: underside of a box held up by a post', () => {
  const m = M.meshMetrics(concat(boxTris([4, 4, 0], [6, 6, 5]), boxTris([0, 0, 5], [10, 10, 15])), 30);
  near(m.overhangArea, 100);
  near(m.overhangDrop, 5);
});

test('overhang angle threshold: 45° chamfer is flagged at 30°, not at 60°', () => {
  // a single downward-facing plane z = y (wound so its normal points down and -y): 45° from vertical
  const wedge = Float32Array.from([0,0,0, 10,10,10, 10,0,0,  0,0,0, 0,10,10, 10,10,10]);
  assert.ok(M.meshMetrics(wedge, 30).overhangArea > 0);
  assert.equal(M.meshMetrics(wedge, 60).overhangArea, 0);
});

test('suspect meshes: open surface and inverted-but-closed mesh', () => {
  assert.equal(M.meshMetrics(Float32Array.from([0,0,0, 10,0,0, 0,10,0]), 30).suspect, true);
  const flipped = Float32Array.from(CUBE);
  for (let i = 0; i < flipped.length; i += 9){ // swap b and c on every triangle
    for (let k = 0; k < 3; k++){ const t = flipped[i+3+k]; flipped[i+3+k] = flipped[i+6+k]; flipped[i+6+k] = t; }
  }
  near(M.meshMetrics(flipped, 30).volume, 1000);
});

/* ---- estimate ---- */

test('estimate: shell + infill, layers, grams, hours', () => {
  const e = M.estimate(M.meshMetrics(CUBE, 30), EST, PLA, false);
  near(e.extruded, 581.8);           // shell 100*1.0 + 100*0.6 + 400*0.87 = 508, plus 15% of the remaining 492
  assert.equal(e.layers, 50);
  near(e.grams, 0.5818 * 1.26 + 1, 1e-6);
  near(e.hours, (581.8 / 9 + 50 * 4.5 + 360) / 3600, 1e-6);
  assert.equal(e.support, 0);
});

test('estimate: pre-print overhead is spread across a batch of copies', () => {
  const m = M.meshMetrics(CUBE, 30);
  const one = M.estimate(m, EST, PLA, false), four = M.estimate(m, EST, PLA, false, 4);
  assert.equal(four.extruded, one.extruded);
  near(one.hours - four.hours, 360 * 0.75 / 3600, 1e-9);
  near(one.grams - four.grams, 0.75, 1e-9);
  for (const q of [undefined, 0, NaN, 1.9]) near(M.estimate(m, EST, PLA, false, q).hours, one.hours, 1e-12);
});

test('estimate: thin sheet is all shell, no infill', () => {
  const e = M.estimate(M.meshMetrics(boxTris([0, 0, 0], [100, 100, 0.5]), 30), EST, PLA, false);
  near(e.extruded, 5000);
  assert.equal(e.layers, 3);
});

test('estimate: supports add material only when requested and only where overhangs exist', () => {
  const m = M.meshMetrics(concat(boxTris([4, 4, 0], [6, 6, 5]), boxTris([0, 0, 5], [10, 10, 15])), 30);
  const without = M.estimate(m, EST, PLA, false), withS = M.estimate(m, EST, PLA, true);
  near(withS.support, 100 * 5 * 0.08);
  near(withS.extruded - without.extruded, withS.support);
  assert.equal(M.estimate(M.meshMetrics(CUBE, 30), EST, PLA, true).support, 0);
  // support volume prints at supportFlow, the rest at the material flow
  near(withS.hours - without.hours, withS.support / 1.5 / 3600, 1e-9);
});

/* ---- sliced files ---- */

test('parseDuration', () => {
  assert.equal(M.parseDuration('2h 24m 33s'), 8673);
  assert.equal(M.parseDuration('45m'), 2700);
  assert.equal(M.parseDuration('1d 2h 3m 4s'), 93784);
  assert.equal(M.parseDuration('garbage'), 0);
});

test('G-code: Bambu Studio header, multi-filament weights, filament type from the config block', () => {
  const g = [
    '; HEADER_BLOCK_START', '; BambuStudio 02.01.00.59',
    '; model printing time: 2h 16m 53s; total estimated time: 2h 24m 33s',
    '; total layer number: 305', '; total filament length [mm] : 13253.21,100.00',
    '; total filament weight [g] : 10.5,20.25', '; HEADER_BLOCK_END', 'G28', 'G1 X10 E1',
    '; CONFIG_BLOCK_START', '; filament_type = PLA;PETG', '; CONFIG_BLOCK_END', ''
  ].join('\n');
  const r = M.parseGcode(g);
  assert.equal(r.kind, 'sliced');
  assert.equal(r.seconds, 8673);
  near(r.grams, 30.75);
  assert.equal(r.filamentType, 'PLA');
});

test('G-code: PrusaSlicer and Cura variants, and G-code without a summary', () => {
  const p = M.parseGcode('; filament used [g] = 39.76\n; total filament used [g] = 39.76\n; estimated printing time (normal mode) = 1d 2h 3m 4s\n; filament_type = PETG\n');
  assert.equal(p.seconds, 93784); near(p.grams, 39.76); assert.equal(p.filamentType, 'PETG');
  const c = M.parseGcode(';FLAVOR:Marlin\n;TIME:8673\n;Filament used: 13.25m\n');
  assert.equal(c.seconds, 8673); assert.equal(c.grams, 0); assert.equal(c.filamentType, null);
  assert.throws(() => M.parseGcode('G28\nG1 X10\n'));
});

test('3MF: plain model file (deflated) reads as a mesh', async () => {
  const r = await M.parse3MF(zip([{ name: '3D/3dmodel.model', data: modelXML(CUBE) }]));
  assert.equal(r.kind, 'mesh');
  near(M.meshMetrics(r.tris, 30).volume, 1000);
});

test('3MF: components in a separate (stored) file with scale, translation, and build transform', async () => {
  const main = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
<resources><object id="2" type="model"><components><component objectid="1" transform="2 0 0 0 2 0 0 0 2 0 0 7" p:path="/3D/Objects/object_1.model"/></components></object></resources>
<build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 5 5 0"/></build></model>`;
  const r = await M.parse3MF(zip([
    { name: '3D/3dmodel.model', data: main },
    { name: '3D/Objects/object_1.model', data: modelXML(CUBE), stored: true }
  ]));
  const m = M.meshMetrics(r.tris, 30);
  near(m.volume, 8000);
  near(m.height, 20);
  near(m.size[0], 20);
});

test('3MF: unit attribute scales to mm', async () => {
  const r = await M.parse3MF(zip([{ name: '3D/3dmodel.model', data: modelXML(boxTris([0, 0, 0], [1, 1, 1]), { unit: 'inch' }) }]));
  near(M.meshMetrics(r.tris, 30).volume, 25.4 ** 3, 1e-2);
});

test('3MF: sliced Bambu project sums plates and keeps the mesh for calibration', async () => {
  const info = `<?xml version="1.0" encoding="UTF-8"?><config><header><header_item key="X-BBL-Client-Type" value="slicer"/></header>
<plate><metadata key="index" value="1"/><metadata key="prediction" value="8673"/><metadata key="weight" value="39.76"/><filament id="1" tray_info_idx="GFL99" type="PLA" color="#FFFFFF" used_m="13.25" used_g="39.76"/></plate>
<plate><metadata key="index" value="2"/><metadata key="prediction" value="1000"/><metadata key="weight" value="0.24"/></plate></config>`;
  const r = await M.parse3MF(zip([{ name: '3D/3dmodel.model', data: modelXML(CUBE) }, { name: 'Metadata/slice_info.config', data: info }]));
  assert.equal(r.kind, 'sliced');
  assert.equal(r.plates, 2);
  assert.equal(r.seconds, 9673);
  near(r.grams, 40);
  assert.equal(r.filamentType, 'PLA');
  near(M.meshMetrics(r.tris, 30).volume, 1000);
});

test('3MF: zip64 archive (MakerWorld export) reads like a plain one', async () => {
  const r = await M.parse3MF(zip64([{ name: '3D/3dmodel.model', data: modelXML(CUBE) }, { name: '[Content_Types].xml', data: '<Types/>' }]));
  assert.equal(r.kind, 'mesh');
  near(M.meshMetrics(r.tris, 30).volume, 1000);
});

test('3MF: garbage is rejected', async () => {
  await assert.rejects(() => M.parse3MF(toBuf('not a zip')));
  await assert.rejects(() => M.parse3MF(zip([{ name: 'readme.txt', data: 'hi' }])));
});
