import * as B from '@babylonjs/core';
import { parseWad, WadTex } from './wad';

// Загрузчик карт GoldSrc/Half-Life (BSP v30) — Counter-Strike 1.6 формат.
// Рендерит геометрию мира (модель 0) как набор мешей по группам текстур:
// реальная текстура из WAD, если имя совпало, иначе процедурная по категории имени.
// Координаты HL (Z-вверх, правосторонние) → Babylon (Y-вверх) с масштабом.

const LUMP = { ENTITIES: 0, PLANES: 1, TEXTURES: 2, VERTICES: 3, NODES: 5, TEXINFO: 6, FACES: 7, EDGES: 12, SURFEDGES: 13, MODELS: 14 };

// текстуры, грани с которыми не рисуем (небо, клипы, триггеры, служебные)
const SKIP_TEX = /^[-+]?\d*[~]?(sky|clip|null|aaatrigger|origin|hint|skip|trigger|nodraw|bevel|black_hidden)/i;

interface FaceGroup { name: string; positions: number[]; uvs: number[]; indices: number[]; texW: number; texH: number; }
interface ParsedBsp { groups: FaceGroup[]; spawn: [number, number, number]; minX: number; maxX: number; minZ: number; maxZ: number; }
const cache = new Map<string, ParsedBsp>();

function parse(buf: ArrayBuffer, scale: number): ParsedBsp {
  const dv = new DataView(buf);
  const lump = (i: number) => ({ off: dv.getInt32(4 + i * 8, true), len: dv.getInt32(4 + i * 8 + 4, true) });

  const vl = lump(LUMP.VERTICES);
  const verts = new Float32Array(buf, vl.off, (vl.len / 4) | 0);
  const el = lump(LUMP.EDGES);
  const edges = new Uint16Array(buf, el.off, (el.len / 2) | 0);
  const sl = lump(LUMP.SURFEDGES);
  const surfedges = new Int32Array(buf, sl.off, (sl.len / 4) | 0);

  // имена + размеры текстур: TEXTURES = int32 numMip + int32 offsets[numMip], miptex_t в каждом offset:
  // char name[16], uint32 width, uint32 height, uint32 mipOffsets[4]
  const tl = lump(LUMP.TEXTURES);
  const numMip = dv.getInt32(tl.off, true);
  const texName: string[] = [], texW: number[] = [], texH: number[] = [];
  for (let i = 0; i < numMip; i++) {
    const mo = dv.getInt32(tl.off + 4 + i * 4, true);
    if (mo < 0) { texName.push(''); texW.push(64); texH.push(64); continue; }
    const base = tl.off + mo;
    let name = '';
    for (let c = 0; c < 16; c++) { const ch = dv.getUint8(base + c); if (!ch) break; name += String.fromCharCode(ch); }
    texName.push(name);
    texW.push(dv.getUint32(base + 16, true) || 64);
    texH.push(dv.getUint32(base + 20, true) || 64);
  }
  // texinfo: 40 байт — vecS[4] float, vecT[4] float, miptex int32 @32, flags int32 @36
  const til = lump(LUMP.TEXINFO);
  const tiCount = til.len / 40;
  const tiS: Float32Array[] = [], tiT: Float32Array[] = [], tiMip: number[] = [];
  for (let i = 0; i < tiCount; i++) {
    const o = til.off + i * 40;
    tiS.push(new Float32Array(buf.slice(o, o + 16)));
    tiT.push(new Float32Array(buf.slice(o + 16, o + 32)));
    tiMip.push(dv.getInt32(o + 32, true));
  }

  // модель 0 (worldspawn): firstface @56, numfaces @60
  const ml = lump(LUMP.MODELS);
  const firstFace = dv.getInt32(ml.off + 56, true);
  const numFaces = dv.getInt32(ml.off + 60, true);

  // грани: 20 байт — firstedge int32 @4, numedges uint16 @8, texinfo uint16 @10
  const fl = lump(LUMP.FACES);
  const groups = new Map<string, FaceGroup>();
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (let f = firstFace; f < firstFace + numFaces; f++) {
    const fo = fl.off + f * 20;
    const firstedge = dv.getInt32(fo + 4, true);
    const numedges = dv.getUint16(fo + 8, true);
    const ti = dv.getUint16(fo + 10, true);
    const mip = tiMip[ti] ?? 0;
    const tn = texName[mip] || 'unknown';
    if (SKIP_TEX.test(tn) || numedges < 3) continue;
    let grp = groups.get(tn);
    if (!grp) { grp = { name: tn, positions: [], uvs: [], indices: [], texW: texW[mip], texH: texH[mip] }; groups.set(tn, grp); }
    const S = tiS[ti], T = tiT[ti];
    const base = grp.positions.length / 3;
    for (let e = 0; e < numedges; e++) {
      const se = surfedges[firstedge + e];
      const ei = Math.abs(se);
      const v = se >= 0 ? edges[ei * 2] : edges[ei * 2 + 1];
      const hx = verts[v * 3], hy = verts[v * 3 + 1], hz = verts[v * 3 + 2];
      const bx = hx * scale, by = hz * scale, bz = hy * scale; // HL z-up → Babylon y-up
      grp.positions.push(bx, by, bz);
      const u = (hx * S[0] + hy * S[1] + hz * S[2] + S[3]) / grp.texW;
      const vv = (hx * T[0] + hy * T[1] + hz * T[2] + T[3]) / grp.texH;
      grp.uvs.push(u, vv);
      if (bx < minX) minX = bx; if (bx > maxX) maxX = bx;
      if (bz < minZ) minZ = bz; if (bz > maxZ) maxZ = bz;
    }
    for (let k = 1; k < numedges - 1; k++) grp.indices.push(base, base + k + 1, base + k);
  }

  const enl = lump(LUMP.ENTITIES);
  const ents = new TextDecoder().decode(new Uint8Array(buf, enl.off, enl.len));
  const spawn = findSpawn(ents, scale);
  return { groups: [...groups.values()], spawn, minX, maxX, minZ, maxZ };
}

function findSpawn(ents: string, scale: number): [number, number, number] {
  let ct: number[] | null = null, any: number[] | null = null;
  for (const blk of ents.split('}')) {
    const cls = /"classname"\s*"([^"]+)"/.exec(blk);
    const org = /"origin"\s*"([^"]+)"/.exec(blk);
    if (!cls || !org) continue;
    const o = org[1].trim().split(/\s+/).map(Number);
    if (o.length < 3 || o.some(isNaN)) continue;
    if (cls[1] === 'info_player_start') ct = o;
    if (/^info_player_(start|deathmatch|vip)/.test(cls[1])) any = any || o;
  }
  const o = ct || any || [0, 0, 64];
  return [o[0] * scale, o[2] * scale + 0.5, o[1] * scale];
}

// --- процедурные текстуры-заменители (нет реального WAD-совпадения) ---
function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) * f) | 0;
  const g = Math.min(255, ((n >> 8) & 255) * f) | 0;
  const b = Math.min(255, (n & 255) * f) | 0;
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}
function speckleTex(scene: B.Scene, name: string, base: string, fleck: string) {
  const dt = new B.DynamicTexture(name, { width: 128, height: 128 }, scene, false);
  const ctx = dt.getContext() as any;
  ctx.fillStyle = base; ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 700; i++) { ctx.fillStyle = Math.random() < 0.5 ? fleck : base; ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2); }
  dt.update();
  return dt;
}
function brickTex(scene: B.Scene, name: string, base: string, mortar: string) {
  const dt = new B.DynamicTexture(name, { width: 128, height: 128 }, scene, false);
  const ctx = dt.getContext() as any;
  ctx.fillStyle = mortar; ctx.fillRect(0, 0, 128, 128);
  const bw = 30, bh = 11, gap = 2;
  let row = 0;
  for (let y = 0; y < 128; y += bh + gap, row++) {
    const off = row % 2 ? -bw / 2 : 0;
    for (let x = off - bw; x < 128 + bw; x += bw + gap) {
      ctx.fillStyle = shade(base, 0.82 + Math.random() * 0.32);
      ctx.fillRect(x, y, bw, bh);
    }
  }
  dt.update();
  return dt;
}
function tileTex(scene: B.Scene, name: string, base: string, grout: string) {
  const dt = new B.DynamicTexture(name, { width: 128, height: 128 }, scene, false);
  const ctx = dt.getContext() as any;
  ctx.fillStyle = grout; ctx.fillRect(0, 0, 128, 128);
  const n = 3, gap = 4, cell = (128 - gap * (n + 1)) / n;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    ctx.fillStyle = shade(base, 0.88 + Math.random() * 0.22);
    ctx.fillRect(gap + c * (cell + gap), gap + r * (cell + gap), cell, cell);
  }
  dt.update();
  return dt;
}

type Category = 'concrete' | 'brick' | 'metal' | 'wood' | 'floor' | 'glass' | 'light' | 'grass' | 'generic';
function categorize(name: string): Category {
  const n = name.toLowerCase().replace(/^[-+]\d*~?/, '');
  if (/glass|glu|window|wndow/.test(n)) return 'glass';
  if (/light|neon|lgt|viewscreen|sign|pow\b/.test(n)) return 'light';
  if (/grss|grass/.test(n)) return 'grass';
  if (/flr|floor|sidewlk|labflr/.test(n)) return 'floor';
  if (/brck|brick|stone|rockwall/.test(n)) return 'brick';
  if (/crate|wood|wd\b/.test(n)) return 'wood';
  if (/metal|mtl|drkmtl|door|dr\d|vent|container|silo|trim/.test(n)) return 'metal';
  if (/ccrete|concrete|conc|tnnl|cement|wall/.test(n)) return 'concrete';
  return 'generic';
}
const catColor: Record<Category, [string, string, 'speckle' | 'brick' | 'tile']> = {
  concrete: ['#9a9a94', '#6f6f68', 'speckle'],
  brick: ['#a3663f', '#3d2a20', 'brick'],
  metal: ['#4d5158', '#2a2d32', 'speckle'],
  wood: ['#8a6541', '#4a3520', 'brick'],
  floor: ['#8c8c86', '#4a4a44', 'tile'],
  glass: ['#7fa7c2', '#5c7f96', 'speckle'],
  light: ['#e8e2b8', '#c9c090', 'speckle'],
  grass: ['#5c7a45', '#3c5530', 'speckle'],
  generic: ['#8a8a84', '#5a5a54', 'speckle'],
};
const procMatCache = new Map<Category, B.Material>();
function procMaterial(scene: B.Scene, cat: Category): B.Material {
  let m = procMatCache.get(cat);
  if (m) return m;
  const [base, fleck, style] = catColor[cat];
  const mat = new B.StandardMaterial('proc_' + cat, scene);
  const dt = style === 'brick' ? brickTex(scene, 'pt_' + cat, base, fleck) : style === 'tile' ? tileTex(scene, 'pt_' + cat, base, fleck) : speckleTex(scene, 'pt_' + cat, base, fleck);
  mat.diffuseTexture = dt;
  mat.diffuseColor = new B.Color3(1, 1, 1);
  mat.specularColor = new B.Color3(0.04, 0.04, 0.04);
  if (cat === 'light') mat.emissiveColor = new B.Color3(0.35, 0.32, 0.2);
  mat.backFaceCulling = false;
  procMatCache.set(cat, mat);
  return mat;
}

function wadTexToMaterial(scene: B.Scene, name: string, tex: WadTex): B.Material {
  const mat = new B.StandardMaterial('wad_' + name, scene);
  const dt = new B.RawTexture(tex.rgba, tex.width, tex.height, B.Engine.TEXTUREFORMAT_RGBA, scene, true, false, B.Texture.TRILINEAR_SAMPLINGMODE);
  dt.wrapU = B.Texture.WRAP_ADDRESSMODE; dt.wrapV = B.Texture.WRAP_ADDRESSMODE;
  mat.diffuseTexture = dt;
  mat.diffuseColor = new B.Color3(1, 1, 1);
  mat.specularColor = new B.Color3(0.04, 0.04, 0.04);
  mat.backFaceCulling = false;
  return mat;
}

export interface BspResult { meshes: B.Mesh[]; spawn: B.Vector3; minimap: HTMLCanvasElement; bounds: { minX: number; maxX: number; minZ: number; maxZ: number }; }

export async function loadBsp(scene: B.Scene, bspUrl: string, wadUrl: string | null, scale: number): Promise<BspResult> {
  const key = bspUrl + '@' + scale;
  let data = cache.get(key);
  if (!data) {
    const buf = await (await fetch(bspUrl)).arrayBuffer();
    data = parse(buf, scale);
    cache.set(key, data);
  }
  let wadTexes = new Map<string, WadTex>();
  if (wadUrl) {
    try { wadTexes = parseWad(await (await fetch(wadUrl)).arrayBuffer()); } catch { /* нет WAD — все текстуры процедурные */ }
  }

  const meshes: B.Mesh[] = [];
  for (const g of data.groups) {
    const mesh = new B.Mesh('bsp_' + g.name, scene);
    const vd = new B.VertexData();
    vd.positions = g.positions;
    vd.indices = g.indices;
    vd.uvs = g.uvs;
    const normals: number[] = [];
    B.VertexData.ComputeNormals(g.positions, g.indices, normals);
    vd.normals = normals;
    vd.applyToMesh(mesh);

    const wadKey = g.name.toLowerCase().replace(/^[-+]\d*~?/, '');
    const wadTex = wadTexes.get(wadKey) || wadTexes.get(g.name.toLowerCase());
    mesh.material = wadTex ? wadTexToMaterial(scene, g.name, wadTex) : procMaterial(scene, categorize(g.name));
    mesh.checkCollisions = true;
    mesh.receiveShadows = true;
    mesh.isPickable = false; // геометрия мира не участвует в хитскане (нет целей на стенах)
    const triCount = g.indices.length / 3;
    if (triCount > 250) { mesh.useOctreeForCollisions = true; mesh.subdivide(Math.min(32, Math.ceil(triCount / 100))); mesh.createOrUpdateSubmeshesOctree(64, 2); }
    meshes.push(mesh);
  }

  const minimap = bakeMinimap(data);
  return {
    meshes,
    spawn: new B.Vector3(data.spawn[0], data.spawn[1], data.spawn[2]),
    minimap,
    bounds: { minX: data.minX, maxX: data.maxX, minZ: data.minZ, maxZ: data.maxZ },
  };
}

// запекаем плоскую проекцию сверху (силуэт геометрии) один раз — миникарта потом просто рисует поверх
function bakeMinimap(data: ParsedBsp): HTMLCanvasElement {
  const SZ = 256;
  const cv = document.createElement('canvas');
  cv.width = SZ; cv.height = SZ;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#0d1114'; ctx.fillRect(0, 0, SZ, SZ);
  const spanX = Math.max(1, data.maxX - data.minX), spanZ = Math.max(1, data.maxZ - data.minZ);
  const span = Math.max(spanX, spanZ) * 1.04;
  const cx = (data.minX + data.maxX) / 2, cz = (data.minZ + data.maxZ) / 2;
  const proj = (x: number, z: number): [number, number] => [SZ / 2 + ((x - cx) / span) * SZ, SZ / 2 - ((z - cz) / span) * SZ];
  ctx.fillStyle = 'rgba(150,160,170,.5)';
  for (const g of data.groups) {
    const pos = g.positions, idx = g.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const pa = proj(pos[a], pos[a + 2]), pb = proj(pos[b], pos[b + 2]), pc = proj(pos[c], pos[c + 2]);
      ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.lineTo(pc[0], pc[1]); ctx.closePath(); ctx.fill();
    }
  }
  return cv;
}
