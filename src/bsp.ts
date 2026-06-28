import * as B from '@babylonjs/core';

// Загрузчик карт GoldSrc/Half-Life (BSP v30) — Counter-Strike 1.6 формат.
// Рендерит геометрию мира (модель 0) как один меш Babylon с коллизией.
// Координаты HL (Z-вверх, правосторонние) → Babylon (Y-вверх) с масштабом.

const LUMP = { ENTITIES: 0, PLANES: 1, TEXTURES: 2, VERTICES: 3, NODES: 5, TEXINFO: 6, FACES: 7, EDGES: 12, SURFEDGES: 13, MODELS: 14 };

// текстуры, грани с которыми не рисуем (небо, клипы, триггеры, служебные)
const SKIP_TEX = /^(sky|clip|null|aaatrigger|origin|hint|skip|trigger|nodraw|bevel|black_hidden)/i;

interface ParsedBsp { positions: number[]; indices: number[]; spawn: [number, number, number]; }
const cache = new Map<string, ParsedBsp>();

function parse(buf: ArrayBuffer, scale: number): ParsedBsp {
  const dv = new DataView(buf);
  const lump = (i: number) => ({ off: dv.getInt32(4 + i * 8, true), len: dv.getInt32(4 + i * 8 + 4, true) });

  // вершины
  const vl = lump(LUMP.VERTICES);
  const verts = new Float32Array(buf, vl.off, (vl.len / 4) | 0);
  // рёбра (пары uint16)
  const el = lump(LUMP.EDGES);
  const edges = new Uint16Array(buf, el.off, (el.len / 2) | 0);
  // surfedges (int32 со знаком)
  const sl = lump(LUMP.SURFEDGES);
  const surfedges = new Int32Array(buf, sl.off, (sl.len / 4) | 0);

  // имена текстур: TEXTURES = [numMip][offsets...][miptex...], miptex.name = char[16]
  const tl = lump(LUMP.TEXTURES);
  const numMip = dv.getInt32(tl.off, true);
  const texName: string[] = [];
  for (let i = 0; i < numMip; i++) {
    const mo = dv.getInt32(tl.off + 4 + i * 4, true);
    if (mo < 0) { texName.push(''); continue; }
    let name = '';
    for (let c = 0; c < 16; c++) { const ch = dv.getUint8(tl.off + mo + c); if (!ch) break; name += String.fromCharCode(ch); }
    texName.push(name);
  }
  // texinfo: 40 байт, miptex index — uint32 @32
  const til = lump(LUMP.TEXINFO);
  const texinfoMip = (ti: number) => dv.getInt32(til.off + ti * 40 + 32, true);

  // модель 0 (worldspawn): firstface @56, numfaces @60
  const ml = lump(LUMP.MODELS);
  const firstFace = dv.getInt32(ml.off + 56, true);
  const numFaces = dv.getInt32(ml.off + 60, true);

  // грани: 20 байт — numedges uint16 @8, firstedge int32 @4, texinfo uint16 @10
  const fl = lump(LUMP.FACES);
  const positions: number[] = [];
  const indices: number[] = [];
  let vi = 0;
  for (let f = firstFace; f < firstFace + numFaces; f++) {
    const fo = fl.off + f * 20;
    const firstedge = dv.getInt32(fo + 4, true);
    const numedges = dv.getUint16(fo + 8, true);
    const texinfo = dv.getUint16(fo + 10, true);
    const tn = texName[texinfoMip(texinfo)] || '';
    if (SKIP_TEX.test(tn)) continue;
    if (numedges < 3) continue;
    const base = vi;
    for (let e = 0; e < numedges; e++) {
      const se = surfedges[firstedge + e];
      const ei = Math.abs(se);
      const v = se >= 0 ? edges[ei * 2] : edges[ei * 2 + 1];
      const hx = verts[v * 3], hy = verts[v * 3 + 1], hz = verts[v * 3 + 2];
      positions.push(hx * scale, hz * scale, hy * scale); // HL z-up → Babylon y-up
      vi++;
    }
    for (let k = 1; k < numedges - 1; k++) indices.push(base, base + k + 1, base + k);
  }

  // спавн: info_player_start (CT) → origin; fallback на любой player start
  const enl = lump(LUMP.ENTITIES);
  const ents = new TextDecoder().decode(new Uint8Array(buf, enl.off, enl.len));
  const spawn = findSpawn(ents, scale);
  return { positions, indices, spawn };
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
  // origin у HL — центр игрока; ставим чуть выше, физика осадит на пол
  return [o[0] * scale, o[2] * scale + 0.5, o[1] * scale];
}

export interface BspResult { mesh: B.Mesh; spawn: B.Vector3; }

export async function loadBsp(scene: B.Scene, url: string, scale: number): Promise<BspResult> {
  const key = url + '@' + scale;
  let data = cache.get(key);
  if (!data) {
    const buf = await (await fetch(url)).arrayBuffer();
    data = parse(buf, scale);
    cache.set(key, data);
  }
  const mesh = new B.Mesh('bspWorld', scene);
  const vd = new B.VertexData();
  vd.positions = data.positions;
  vd.indices = data.indices;
  const normals: number[] = [];
  B.VertexData.ComputeNormals(data.positions, data.indices, normals);
  vd.normals = normals;
  vd.applyToMesh(mesh);

  const mat = new B.StandardMaterial('bspMat', scene);
  mat.diffuseColor = new B.Color3(0.66, 0.65, 0.62);
  mat.specularColor = new B.Color3(0.03, 0.03, 0.03);
  mat.backFaceCulling = false;       // нормали из BSP могут смотреть внутрь
  mat.twoSidedLighting = true;       // свет с обеих сторон — без тёмных граней
  mesh.material = mat;
  mesh.checkCollisions = true;
  mesh.receiveShadows = true;
  mesh.useOctreeForCollisions = true; // ускоряем коллизию большого меша
  mesh.subdivide(48);
  mesh.createOrUpdateSubmeshesOctree(64, 2);

  return { mesh, spawn: new B.Vector3(data.spawn[0], data.spawn[1], data.spawn[2]) };
}
