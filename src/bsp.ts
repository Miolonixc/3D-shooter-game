import * as B from '@babylonjs/core';
import { parseWad, WadTex } from './wad';

// Загрузчик карт GoldSrc/Half-Life (BSP v30) — Counter-Strike 1.6 формат.
// Рендерит геометрию мира (модель 0) как набор мешей по группам текстур:
// реальная текстура из WAD, если имя совпало, иначе процедурная по категории имени.
// Координаты HL (Z-вверх, правосторонние) → Babylon (Y-вверх) с масштабом.

const LUMP = { ENTITIES: 0, PLANES: 1, TEXTURES: 2, VERTICES: 3, NODES: 5, TEXINFO: 6, FACES: 7, EDGES: 12, SURFEDGES: 13, MODELS: 14 };

// текстуры, грани с которыми не рисуем (небо, клипы, триггеры, служебные)
const SKIP_TEX = /^[-+]?\d*[~]?(sky|clip|null|aaatrigger|origin|hint|skip|trigger|nodraw|bevel|black_hidden)/i;
// тонкая декоративная мелочь (не капитальная стена/пол/ящик) — рисуем, но без коллизии,
// иначе эллипсоид игрока залипает в стыках тонких деталей (кузов грузовика, панели и т.п.)
const DECOR_NONSOLID = /^trk_|sign_blarco|viewscreen|tankrear/i;
// капитальные категории — коллизия ВСЕГДА включена, независимо от габаритов группы
// (важно: некоторые настоящие стены/двери имеют небольшой суммарный bbox, если текстура
// использована лишь в одном месте карты — по имени их не спутать с декором)
const PROTECT_SOLID = /wall|w\d|crate|floor|flr|sidewlk|stone|rock|brck|brick|ccrete|concrete|tnnl|cement|c_bldg|bcontainer|silo|dsk|secdr|_dr\d|fifties_dr|babtech_dr|skkylite/i;
// декоративные группы без защищённого имени и с маленьким габаритом (< 8 юнитов) — без коллизии
const DECOR_MAX_EXTENT = 8;
// невысокие бордюры/поребрики (ниже, чем наш шаг вверх ~1 юнит) — без коллизии Babylon,
// перешагиваем через собственную вертикальную физику (см. LOW_KERB_HEIGHT ниже)
const LOW_KERB_HEIGHT = 0.6;

type GroupKind = 'flat' | 'lowkerb' | 'wall';
interface FaceGroup { name: string; positions: number[]; uvs: number[]; indices: number[]; texW: number; texH: number; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number; kind: GroupKind; }
interface ParsedBsp { groups: FaceGroup[]; spawn: [number, number, number]; spawnYaw: number; minX: number; maxX: number; minZ: number; maxZ: number; }
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
    const S = tiS[ti], T = tiT[ti];
    // сначала собираем вершины грани во временный буфер — нужно посчитать нормаль,
    // чтобы решить: пол/потолок (плоская, без коллизии Babylon — только опора для
    // собственной вертикальной физики через metadata.floor) или стена (обычная коллизия)
    const fx: number[] = [], fy: number[] = [], fz: number[] = [], fu: number[] = [], fv: number[] = [];
    for (let e = 0; e < numedges; e++) {
      const se = surfedges[firstedge + e];
      const ei = Math.abs(se);
      const v = se >= 0 ? edges[ei * 2] : edges[ei * 2 + 1];
      const hx = verts[v * 3], hy = verts[v * 3 + 1], hz = verts[v * 3 + 2];
      const bx = hx * scale, by = hz * scale, bz = hy * scale; // HL z-up → Babylon y-up
      fx.push(bx); fy.push(by); fz.push(bz);
      fu.push((hx * S[0] + hy * S[1] + hz * S[2] + S[3]) / texW[mip]);
      fv.push((hx * T[0] + hy * T[1] + hz * T[2] + T[3]) / texH[mip]);
      if (bx < minX) minX = bx; if (bx > maxX) maxX = bx;
      if (bz < minZ) minZ = bz; if (bz > maxZ) maxZ = bz;
    }
    // нормаль грани — крест-произведение первых двух рёбер
    const e1x = fx[1] - fx[0], e1y = fy[1] - fy[0], e1z = fz[1] - fz[0];
    const e2x = fx[2] - fx[0], e2y = fy[2] - fy[0], e2z = fz[2] - fz[0];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    ny /= nlen;
    const flat = Math.abs(ny) > 0.7; // почти горизонтальная грань (пол или потолок)
    // высота именно ЭТОЙ грани (не всей группы — текстура переиспользуется по всей карте,
    // поэтому агрегированный bbox группы не отличит короткий бордюр от высокой стены той
    // же текстуры в другом месте карты)
    const faceMinY = Math.min(...fy), faceMaxY = Math.max(...fy);
    const lowKerb = !flat && (faceMaxY - faceMinY) < LOW_KERB_HEIGHT;
    const kind: GroupKind = flat ? 'flat' : lowKerb ? 'lowkerb' : 'wall';
    const key = tn + (kind === 'wall' ? '' : '#' + kind);
    let grp = groups.get(key);
    if (!grp) { grp = { name: tn, positions: [], uvs: [], indices: [], texW: texW[mip], texH: texH[mip], minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9, kind }; groups.set(key, grp); }
    const base = grp.positions.length / 3;
    for (let e = 0; e < numedges; e++) {
      grp.positions.push(fx[e], fy[e], fz[e]);
      grp.uvs.push(fu[e], fv[e]);
      if (fx[e] < grp.minX) grp.minX = fx[e]; if (fx[e] > grp.maxX) grp.maxX = fx[e];
      if (fy[e] < grp.minY) grp.minY = fy[e]; if (fy[e] > grp.maxY) grp.maxY = fy[e];
      if (fz[e] < grp.minZ) grp.minZ = fz[e]; if (fz[e] > grp.maxZ) grp.maxZ = fz[e];
    }
    for (let k = 1; k < numedges - 1; k++) grp.indices.push(base, base + k + 1, base + k);
  }

  const enl = lump(LUMP.ENTITIES);
  const ents = new TextDecoder().decode(new Uint8Array(buf, enl.off, enl.len));
  const { pos, angle } = findSpawn(ents);
  const spawn: [number, number, number] = [pos[0] * scale, pos[2] * scale + 0.5, pos[1] * scale];
  return { groups: [...groups.values()], spawn, spawnYaw: angle, minX, maxX, minZ, maxZ };
}

// "angle" в HL: 0° = смотрит на +X (восток), 90° = на +Y исходных координат (после
// нашего свопа осей это +Z Babylon, т.е. «север»), растёт против часовой стрелки.
function findSpawn(ents: string): { pos: number[]; angle: number } {
  let ct: number[] | null = null, ctAngle = 0, any: number[] | null = null, anyAngle = 0;
  for (const blk of ents.split('}')) {
    const cls = /"classname"\s*"([^"]+)"/.exec(blk);
    const org = /"origin"\s*"([^"]+)"/.exec(blk);
    if (!cls || !org) continue;
    const o = org[1].trim().split(/\s+/).map(Number);
    if (o.length < 3 || o.some(isNaN)) continue;
    const angMatch = /"angle"\s*"([^"]+)"/.exec(blk);
    const ang = angMatch ? Number(angMatch[1]) || 0 : 0;
    if (cls[1] === 'info_player_start') { ct = o; ctAngle = ang; }
    if (!any && /^info_player_(start|deathmatch|vip)/.test(cls[1])) { any = o; anyAngle = ang; }
  }
  return { pos: ct || any || [0, 0, 64], angle: ct ? ctAngle : anyAngle };
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
  const dt = new B.DynamicTexture(name, { width: 128, height: 128 }, scene, true); // мипмапы — без них тайлинг на полу даёт муар/полосы
  const ctx = dt.getContext() as any;
  ctx.fillStyle = base; ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 700; i++) { ctx.fillStyle = Math.random() < 0.5 ? fleck : base; ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2); }
  dt.update();
  return dt;
}
function brickTex(scene: B.Scene, name: string, base: string, mortar: string) {
  const dt = new B.DynamicTexture(name, { width: 128, height: 128 }, scene, true);
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
  const dt = new B.DynamicTexture(name, { width: 128, height: 128 }, scene, true);
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
// деревянный ящик: горизонтальные доски + диагональные металлические рейки-крепления
function crateTex(scene: B.Scene, name: string, base: string, dark: string) {
  const dt = new B.DynamicTexture(name, { width: 128, height: 128 }, scene, true);
  const ctx = dt.getContext() as any;
  ctx.fillStyle = base; ctx.fillRect(0, 0, 128, 128);
  const plankH = 128 / 4;
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = shade(base, 0.85 + Math.random() * 0.3);
    ctx.fillRect(0, i * plankH + 1, 128, plankH - 2);
  }
  ctx.strokeStyle = dark; ctx.lineWidth = 2;
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, i * plankH); ctx.lineTo(128, i * plankH); ctx.stroke(); }
  ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(128, 128); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(128, 0); ctx.lineTo(0, 128); ctx.stroke();
  dt.update();
  return dt;
}
// вентиляция: металл с горизонтальными жалюзи + рамка
function ventTex(scene: B.Scene, name: string, base: string, dark: string) {
  const dt = new B.DynamicTexture(name, { width: 128, height: 128 }, scene, true);
  const ctx = dt.getContext() as any;
  ctx.fillStyle = base; ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = dark;
  for (let y = 5; y < 124; y += 11) ctx.fillRect(6, y, 116, 6);        // жалюзи
  ctx.fillStyle = shade(base, 1.15);
  for (let y = 3; y < 124; y += 11) ctx.fillRect(6, y, 116, 2);        // блик над каждой планкой
  ctx.strokeStyle = shade(base, 0.55); ctx.lineWidth = 5; ctx.strokeRect(3, 3, 122, 122); // рамка
  dt.update();
  return dt;
}
// кабинет/консоль: панельная сетка + тёмные «экраны» + индикаторы
function officeTex(scene: B.Scene, name: string, base: string, dark: string) {
  const dt = new B.DynamicTexture(name, { width: 128, height: 128 }, scene, true);
  const ctx = dt.getContext() as any;
  ctx.fillStyle = base; ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = shade(base, 0.7); ctx.lineWidth = 2;
  for (let x = 0; x <= 128; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 128); ctx.stroke(); }
  for (let y = 0; y <= 128; y += 43) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y); ctx.stroke(); }
  ctx.fillStyle = dark;
  for (let i = 0; i < 4; i++) ctx.fillRect(6 + (i % 2) * 64, 6 + ((i / 2) | 0) * 64, 52, 30); // корпуса экранов
  const screens = ['#1c3f63', '#123f2c', '#432033', '#2a3f14']; // синий/зелёный/пурпур/жёлтый мониторы
  for (let i = 0; i < 4; i++) { ctx.fillStyle = screens[i]; ctx.fillRect(9 + (i % 2) * 64, 9 + ((i / 2) | 0) * 64, 46, 22); }
  const ind = ['#5fd06a', '#e8b53c', '#e0503c', '#4fa6e6']; // разноцветные индикаторы
  for (let i = 0; i < 8; i++) { ctx.fillStyle = ind[i % 4]; ctx.fillRect(10 + (i % 4) * 28, 40 + ((i / 4) | 0) * 64, 5, 5); }
  dt.update();
  return dt;
}

type Category = 'concrete' | 'asphalt' | 'brick' | 'metal' | 'vent' | 'office' | 'wood' | 'crate' | 'floor' | 'glass' | 'light' | 'grass' | 'generic' | 'tire' | 'rim' | 'vehicle';
function categorize(name: string): Category {
  const n = name.toLowerCase().replace(/^[-+]\d*~?/, '');
  if (/glass|glu|window|wndow/.test(n)) return 'glass';
  if (/light|neon|lgt|pow\b/.test(n)) return 'light';
  if (/grss|grass/.test(n)) return 'grass';
  if (/duct|vnt|vent|pfab|galv|grille/.test(n)) return 'vent';        // система вентиляции
  if (/comp\d|generic\d|recharged|viewscreen|dsk|desk|babtech|fifties|introdr|secdr|tankrear|silo/.test(n)) return 'office'; // кабинет/консоли/шкафы
  if (/crate|xcrate/.test(n)) return 'crate';
  if (/^trk_(tire|tread)/.test(n)) return 'tire';
  if (/^trk_rim/.test(n)) return 'rim';
  if (/^trk_/.test(n)) return 'vehicle';
  if (/tnnl_flr|labflr|duct_flr|crete4_flr|_flr\d|out_pave/.test(n)) return 'asphalt'; // асфальт: двор-дорога снаружи + вход/туннель внутри
  if (/flr|floor/.test(n)) return 'floor';
  if (/brck|brick|stone|rockwall/.test(n)) return 'brick';
  if (/wood|wd\b/.test(n)) return 'wood';
  if (/metal|mtl|drkmtl|door|dr\d|trim/.test(n)) return 'metal';
  if (/ccrete|concrete|conc|tnnl|cement|wall|crete|comp|lab|c1a|c2a|c3a/.test(n)) return 'concrete';
  return 'generic';
}
const catColor: Record<Category, [string, string, 'speckle' | 'brick' | 'tile' | 'crate' | 'vent' | 'office']> = {
  concrete: ['#9d968a', '#6d675b', 'speckle'], // тёпло-серый бетон (стены зданий/ангара, как в cs_assault)
  asphalt: ['#474a4e', '#30323a', 'speckle'],   // асфальт: двор-дорога снаружи + вход/туннель
  brick: ['#a3663f', '#3d2a20', 'brick'],
  metal: ['#4d5158', '#2a2d32', 'speckle'],
  vent: ['#5c6068', '#33363c', 'vent'],          // вентиляция — жалюзи
  office: ['#6b6f77', '#22252b', 'office'],       // кабинет — консольные панели
  wood: ['#8a6541', '#4a3520', 'brick'],
  crate: ['#9c703f', '#5a3d20', 'crate'],
  floor: ['#8c8c86', '#4a4a44', 'tile'],
  glass: ['#7fa7c2', '#5c7f96', 'speckle'],
  light: ['#e8e2b8', '#c9c090', 'speckle'],
  grass: ['#5c7a45', '#3c5530', 'speckle'],
  generic: ['#8a8a84', '#5a5a54', 'speckle'],
  tire: ['#232323', '#141414', 'speckle'],
  rim: ['#9a9a9e', '#6a6a6e', 'speckle'],
  vehicle: ['#6e6a52', '#4a4738', 'speckle'],
};
const procMatCache = new Map<Category, B.Material>();
function procMaterial(scene: B.Scene, cat: Category): B.Material {
  let m = procMatCache.get(cat);
  if (m) return m;
  const [base, fleck, style] = catColor[cat];
  const mat = new B.StandardMaterial('proc_' + cat, scene);
  const dt = style === 'crate' ? crateTex(scene, 'pt_' + cat, base, fleck)
    : style === 'vent' ? ventTex(scene, 'pt_' + cat, base, fleck)
    : style === 'office' ? officeTex(scene, 'pt_' + cat, base, fleck)
    : style === 'brick' ? brickTex(scene, 'pt_' + cat, base, fleck)
    : style === 'tile' ? tileTex(scene, 'pt_' + cat, base, fleck)
    : speckleTex(scene, 'pt_' + cat, base, fleck);
  dt.anisotropicFilteringLevel = 8; // без этого пол под углом даёт муар/полосы
  mat.diffuseTexture = dt;
  mat.diffuseColor = new B.Color3(1, 1, 1);
  mat.specularColor = new B.Color3(0.04, 0.04, 0.04);
  if (cat === 'light') mat.emissiveColor = new B.Color3(0.35, 0.32, 0.2);
  if (cat === 'office') { mat.emissiveTexture = dt; mat.emissiveColor = new B.Color3(0.5, 0.5, 0.5); } // экраны/индикаторы светятся в тёмном ангаре
  if (cat === 'vent') mat.emissiveColor = new B.Color3(0.09, 0.10, 0.12); // лёгкая подсветка металла вентиляции
  mat.backFaceCulling = false;
  procMatCache.set(cat, mat);
  return mat;
}

const wadMatCache = new Map<string, B.Material>();
function wadTexToMaterial(scene: B.Scene, name: string, tex: WadTex): B.Material {
  const cached = wadMatCache.get(name);
  if (cached) return cached;
  const mat = new B.StandardMaterial('wad_' + name, scene);
  const dt = new B.RawTexture(tex.rgba, tex.width, tex.height, B.Engine.TEXTUREFORMAT_RGBA, scene, true, false, B.Texture.TRILINEAR_SAMPLINGMODE);
  dt.wrapU = B.Texture.WRAP_ADDRESSMODE; dt.wrapV = B.Texture.WRAP_ADDRESSMODE;
  dt.anisotropicFilteringLevel = 8; // без этого пол/тротуар под углом даёт муар/полосы
  mat.diffuseTexture = dt;
  mat.diffuseColor = new B.Color3(1, 1, 1);
  mat.specularColor = new B.Color3(0.04, 0.04, 0.04);
  mat.backFaceCulling = false;
  wadMatCache.set(name, mat);
  return mat;
}

export interface BspResult { meshes: B.Mesh[]; spawn: B.Vector3; spawnYaw: number; minimap: HTMLCanvasElement; bounds: { minX: number; maxX: number; minZ: number; maxZ: number }; }

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
    // коллизия решается ПО КАЖДОЙ ГРАНИ ещё при разборе (g.kind), а не по агрегату группы —
    // одна и та же текстура (напр. поребрик) может быть и низким бордюром, и высокой стеной
    // в разных местах карты, а агрегированный bbox группы это различие теряет.
    if (g.kind === 'flat' || g.kind === 'lowkerb') {
      // пол/потолок и низкие бордюры — НЕ участвуют в горизонтальной коллизии Babylon
      // (перешагиваем/стоим через собственную вертикальную физику, metadata.floor)
      mesh.checkCollisions = false;
      mesh.metadata = { floor: true };
    } else {
      // «стена»: капитальные категории всегда твёрдые; явный декор — никогда; остальное —
      // по габариту (мелкая непомеченная деталь вроде настенных панелей — без коллизии)
      const maxExtent = Math.max(g.maxX - g.minX, g.maxY - g.minY, g.maxZ - g.minZ);
      mesh.checkCollisions = PROTECT_SOLID.test(g.name) || (!DECOR_NONSOLID.test(g.name) && maxExtent >= DECOR_MAX_EXTENT);
    }
    mesh.receiveShadows = true;
    mesh.isPickable = false; // геометрия мира не участвует в хитскане (нет целей на стенах)
    const triCount = g.indices.length / 3;
    if (mesh.checkCollisions && triCount > 250) { mesh.useOctreeForCollisions = true; mesh.subdivide(Math.min(32, Math.ceil(triCount / 100))); mesh.createOrUpdateSubmeshesOctree(64, 2); }
    meshes.push(mesh);
  }

  const minimap = bakeMinimap(data);
  // HL angle (0°=восток/+X, растёт против часовой) → Babylon rotation.y
  // (rotation.y=0 смотрит на +Z, rotation.y=PI/2 смотрит на +X — см. комментарий у findSpawn)
  const spawnYaw = (90 - data.spawnYaw) * Math.PI / 180;
  return {
    meshes,
    spawn: new B.Vector3(data.spawn[0], data.spawn[1], data.spawn[2]),
    spawnYaw,
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
