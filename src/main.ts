import * as B from '@babylonjs/core';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const ammoEl = document.getElementById('ammo') as HTMLDivElement;
const killsEl = document.getElementById('kills') as HTMLDivElement;

const engine = new B.Engine(canvas, true, { stencil: true, adaptToDeviceRatio: true });
const scene = new B.Scene(engine);
scene.clearColor = B.Color4.FromHexString('#9ec9f0ff'); // дневное небо
scene.collisionsEnabled = true;

// туман подальше — глубина без потери видимости
scene.fogMode = B.Scene.FOGMODE_LINEAR;
scene.fogColor = B.Color3.FromHexString('#9ec9f0');
scene.fogStart = 90; scene.fogEnd = 320;

// --- свет (день) ---
const hemi = new B.HemisphericLight('hemi', new B.Vector3(0, 1, 0), scene);
hemi.intensity = 0.8;
hemi.groundColor = new B.Color3(0.4, 0.39, 0.36);
const sun = new B.DirectionalLight('sun', new B.Vector3(-0.5, -1, -0.35), scene);
sun.position = new B.Vector3(50, 90, 40);
sun.intensity = 0.85;

// --- камера (FPS) ---
const camera = new B.UniversalCamera('cam', new B.Vector3(0, 1.7, -26), scene);
camera.setTarget(new B.Vector3(0, 1.7, 0));
camera.attachControl(canvas, true);
camera.minZ = 0.05;
camera.speed = 0.34;
camera.inertia = 0.55;
camera.checkCollisions = true;
camera.applyGravity = false; // вертикаль считаем сами (прыжок/гравитация)
camera.ellipsoid = new B.Vector3(0.5, 0.9, 0.5);
camera.ellipsoidOffset = new B.Vector3(0, -0.8, 0);
// движение и обзор обрабатываем сами (по event.code — раскладка-независимо),
// поэтому убираем встроенные ввод мыши и клавиатуры камеры
camera.inputs.removeByType('FreeCameraMouseInput');
camera.inputs.removeByType('FreeCameraKeyboardMoveInput');

// --- материалы ---
const mat = (name: string, hex: string, spec = 0.04) => {
  const m = new B.StandardMaterial(name, scene);
  m.diffuseColor = B.Color3.FromHexString(hex);
  m.specularColor = new B.Color3(spec, spec, spec);
  return m;
};
const groundMat = mat('ground', '#6e6e66');
const brickMat = mat('brick', '#9c5b40');
const brick2Mat = mat('brick2', '#7d8a8f');
const roofMat = mat('roof', '#5f636b');
const doorMat = mat('door', '#7a4a28', 0.08);
const concreteMat = mat('concrete', '#9a9a9e');

// --- процедурные текстуры (DynamicTexture, без файлов) ---
function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) * f) | 0;
  const g = Math.min(255, ((n >> 8) & 255) * f) | 0;
  const b = Math.min(255, (n & 255) * f) | 0;
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}
function brickTex(name: string, base: string, mortar: string) {
  const dt = new B.DynamicTexture(name, { width: 256, height: 256 }, scene, false);
  const ctx = dt.getContext() as any;
  ctx.fillStyle = mortar; ctx.fillRect(0, 0, 256, 256);
  const bw = 60, bh = 22, gap = 4;
  let row = 0;
  for (let y = 0; y < 256; y += bh + gap, row++) {
    const off = row % 2 ? -bw / 2 : 0;
    for (let x = off - bw; x < 256 + bw; x += bw + gap) {
      ctx.fillStyle = shade(base, 0.82 + Math.random() * 0.32);
      ctx.fillRect(x, y, bw, bh);
    }
  }
  dt.update();
  return dt;
}
function speckleTex(name: string, base: string, fleck: string) {
  const dt = new B.DynamicTexture(name, { width: 256, height: 256 }, scene, false);
  const ctx = dt.getContext() as any;
  ctx.fillStyle = base; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? fleck : base;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  dt.update();
  return dt;
}
// плиточный пол: сетка плит с тёмными швами + лёгкая крапинка — чётко читается
function tileTex(name: string, base: string, grout: string) {
  const dt = new B.DynamicTexture(name, { width: 256, height: 256 }, scene, false);
  const ctx = dt.getContext() as any;
  ctx.fillStyle = grout; ctx.fillRect(0, 0, 256, 256);
  const n = 4, gap = 6, cell = (256 - gap * (n + 1)) / n;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    ctx.fillStyle = shade(base, 0.88 + Math.random() * 0.22);
    ctx.fillRect(gap + c * (cell + gap), gap + r * (cell + gap), cell, cell);
  }
  for (let i = 0; i < 900; i++) { ctx.fillStyle = shade(base, 0.7 + Math.random() * 0.5); ctx.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5); }
  dt.update();
  return dt;
}
const white = () => new B.Color3(1, 1, 1);
function applyTex(m: B.StandardMaterial, dt: B.DynamicTexture, scale: number) {
  dt.uScale = scale; dt.vScale = scale;
  m.diffuseTexture = dt;
  m.diffuseColor = white(); // текстура несёт цвет — иначе двойное затемнение
}
applyTex(brickMat, brickTex('bt1', '#b06848', '#3d2a22'), 5);   // мельче и реалистичнее
applyTex(brick2Mat, brickTex('bt2', '#8b979c', '#33383b'), 5);
applyTex(concreteMat, speckleTex('ct', '#a2a2a6', '#82828a'), 4);
applyTex(groundMat, tileTex('floor', '#9a9a90', '#3c3c36'), 10); // плиточный пол — крупнее и контрастнее

// материалы карты cs_assault
const streetMat = mat('street', '#3a3d42');                 // асфальт
const vanMat = mat('van', '#c9a227', 0.2);                  // фургон (жёлтый)
const crateMat = mat('crate', '#7a5638', 0.05);             // ящики-укрытия
const galleryMat = mat('gallery', '#565b61', 0.15);         // сталь галереи
applyTex(crateMat, brickTex('crt', '#8a6541', '#43321f'), 1); // дерево-ящик
applyTex(galleryMat, speckleTex('gst', '#565b61', '#3f4348'), 2);

// стены/постройки видны с обеих сторон — иначе изнутри здания они «невидимые»,
// но коллизия остаётся (эффект невидимых стен)
[brickMat, brick2Mat, concreteMat, roofMat, doorMat, galleryMat, vanMat, crateMat].forEach((m) => { m.backFaceCulling = false; });

// --- постройки ---
// меши текущей карты собираются в sink (для выгрузки при смене карты);
// оружие строится при sink=null и не попадает сюда
let sink: B.AbstractMesh[] | null = null;
function reg<T extends B.AbstractMesh>(m: T): T { if (sink) sink.push(m); return m; }
function box(name: string, x: number, y: number, z: number, w: number, h: number, d: number, material: B.Material) {
  const m = B.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
  m.position.set(x, y, z);
  m.material = material;
  m.checkCollisions = true;
  m.receiveShadows = true;
  return reg(m);
}

// двери открываются на E; петля у левого края проёма, панель тянется вправо
interface Door { hinge: B.TransformNode; panel: B.Mesh; open: boolean; }
const doors: Door[] = [];
// следы построек (для миникарты)
const footprints: { cx: number; cz: number; w: number; d: number }[] = [];

function building(cx: number, cz: number, w: number, d: number, h: number, m: B.Material) {
  footprints.push({ cx, cz, w, d });
  const t = 0.5;       // толщина стены
  const door = 2.6;    // ширина проёма
  const seg = (w - door) / 2;
  // передняя стена (z = cz - d/2) — два сегмента вокруг двери
  box('w', cx - (door / 2 + seg / 2), h / 2, cz - d / 2, seg, h, t, m);
  box('w', cx + (door / 2 + seg / 2), h / 2, cz - d / 2, seg, h, t, m);
  box('w', cx, h / 2, cz + d / 2, w, h, t, m);              // задняя
  box('w', cx - w / 2, h / 2, cz, t, h, d, m);              // левая
  box('w', cx + w / 2, h / 2, cz, t, h, d, m);              // правая
  const roof = box('roof', cx, h + 0.12, cz, w + 0.3, 0.25, d + 0.3, roofMat); // крыша
  roof.checkCollisions = false; // крыша не должна быть невидимым потолком-препятствием
  // дверь — петля у левого края проёма (открывается автоматически при подходе)
  const dh = Math.min(h - 0.4, 2.8);
  const dw = door - 0.15;
  const hinge = new B.TransformNode('hinge', scene);
  hinge.position.set(cx - dw / 2, dh / 2, cz - d / 2);
  const dr = box('door', 0, 0, 0, dw, dh, 0.14, doorMat);
  dr.parent = hinge;
  dr.position.set(dw / 2, 0, 0);   // панель смещена вправо от петли
  dr.checkCollisions = true;       // закрытая дверь блокирует проход
  doors.push({ hinge, panel: dr, open: false });
}

// наклонный пандус-поверхность (для лестниц/подъёмов): луч опоры видит через metadata.floor.
// alongX=true — подъём вдоль X (rotation.z), иначе вдоль Z (rotation.x).
function ramp(name: string, x: number, y: number, z: number, w: number, d: number, rise: number, run: number, m: B.Material, visible = false, alongX = false) {
  const r = box(name, x, y, z, w, 0.3, d, m);
  r.isVisible = visible;
  r.checkCollisions = false;
  r.isPickable = true;
  r.metadata = { floor: true };
  if (alongX) r.rotation.z = Math.atan2(rise, run);
  else r.rotation.x = -Math.atan2(rise, run);
  return r;
}

// одиночная авто-дверь в проёме стены. alongX — дверь поперёк X (южная/северная стена),
// иначе поперёк Z (восточная/западная стена). Петля у края проёма.
function doorAt(cx: number, cz: number, width: number, height: number, alongX: boolean) {
  const hinge = new B.TransformNode('hinge', scene);
  hinge.position.set(cx - (alongX ? width / 2 : 0), height / 2, cz - (alongX ? 0 : width / 2));
  const dr = alongX
    ? box('door', 0, 0, 0, width, height, 0.16, doorMat)
    : box('door', 0, 0, 0, 0.16, height, width, doorMat);
  dr.parent = hinge;
  dr.position.set(alongX ? width / 2 : 0, 0, alongX ? 0 : width / 2);
  dr.checkCollisions = true;
  doors.push({ hinge, panel: dr, open: false });
}

// --- цели ---
const targetMat = mat('target', '#d83030', 0.1);
targetMat.emissiveColor = new B.Color3(0.25, 0.02, 0.02);
const targets: B.Mesh[] = [];
function spawnTarget(x: number, z: number, baseY = 0) {
  const t = B.MeshBuilder.CreateBox('target', { width: 0.85, height: 1.7, depth: 0.4 }, scene);
  t.position.set(x, baseY + 0.85, z);
  t.material = targetMat.clone('target_' + targets.length)!; // своя копия — подсветка попадания не задевает остальных
  t.metadata = { hp: 100, x, z, y: baseY };                  // x/z/y — для респавна
  t.computeWorldMatrix(true); t.refreshBoundingInfo();       // корректный мировой bbox (важно при респавне)
  targets.push(t);
}

// --- собираемые кубики ---
const pickMat = mat('pickup', '#34d0c0', 0.2);
pickMat.emissiveColor = new B.Color3(0.05, 0.36, 0.33);
const pickups: B.Mesh[] = [];
function spawnPickup(x: number, z: number, baseY = 0) {
  const c = B.MeshBuilder.CreateBox('pickup', { size: 0.5 }, scene);
  c.position.set(x, baseY + 0.8, z);
  c.material = pickMat;
  c.checkCollisions = false; c.isPickable = false;
  pickups.push(c);
}

// ===== карта 1: «Арена (город)» =====
function buildCityMap(): B.Vector3 {
  const ground = B.MeshBuilder.CreateGround('ground', { width: 220, height: 220 }, scene);
  ground.material = groundMat; ground.checkCollisions = true; ground.receiveShadows = true; reg(ground);
  building(-16, -6, 14, 12, 5, brickMat);
  building(16, -6, 14, 12, 5, brick2Mat);
  building(-16, 12, 14, 10, 6, brickMat);
  building(16, 12, 14, 10, 6, brick2Mat);
  building(0, 26, 18, 12, 7, brickMat);
  // граница карты
  box('b', 0, 2.5, -42, 96, 5, 1, concreteMat);
  box('b', 0, 2.5, 42, 96, 5, 1, concreteMat);
  box('b', -42, 2.5, 0, 1, 5, 84, concreteMat);
  box('b', 42, 2.5, 0, 1, 5, 84, concreteMat);
  // платформа (floor-поверхность, без боковой коллизии) + визуальные ступени + пандус
  const platform = box('platform', 0, 3.4, 0, 12, 0.4, 4, concreteMat);
  platform.checkCollisions = false; platform.metadata = { floor: true };
  for (let i = 0; i < 7; i++) {
    const sh = (7 - i) * 0.5;
    box('step', 0, sh / 2, -3 - i * 0.7, 4, sh, 0.7, concreteMat).checkCollisions = false;
  }
  ramp('ramp', 0, 1.75, -5, 4, 6.6, 3.5, 5.4, concreteMat);
  ([[28, 8], [28, 3], [24, 8], [-28, 8], [-24, 3], [0, 33], [12, -20], [-12, -20]] as [number, number][])
    .forEach(([x, z]) => spawnTarget(x, z));
  ([[8, -8], [-8, -8], [16, 18], [-16, 18], [0, 12], [20, -16]] as [number, number][])
    .forEach(([x, z]) => spawnPickup(x, z));
  return new B.Vector3(0, 1.7, -26);
}

// ===== карта 2: «cs_assault» (клон) =====
// Склад 40×28 (x∈[-20,20], z∈[0,28]), улица к югу (z<0, спавн CT). Высоты: пол 0,
// фургон/окно ~2.2, галерея 3.5, стены 7. Входы: A ворота (юг), B окно+фургон (запад),
// C боковая дверь (восток), D задняя (север).
function buildAssaultMap(): B.Vector3 {
  const H = 7, T = 0.6;
  const street = B.MeshBuilder.CreateGround('ground', { width: 130, height: 130 }, scene);
  street.material = streetMat; street.checkCollisions = true; street.receiveShadows = true; reg(street);
  const floor = box('whfloor', 0, -0.04, 14, 40, 0.1, 28, concreteMat);
  floor.checkCollisions = false; floor.metadata = { floor: true };
  footprints.push({ cx: 0, cz: 14, w: 40, d: 28 });   // склад на миникарте
  footprints.push({ cx: -25, cz: 10, w: 5, d: 3 });   // фургон

  // стены склада с проёмами
  box('whw', -11.5, H / 2, 0, 17, H, T, concreteMat);     // юг, лево от ворот A
  box('whw', 11.5, H / 2, 0, 17, H, T, concreteMat);      // юг, право
  box('whw', 0, H - 1, 0, 6, 2, T, concreteMat);          // перемычка над A
  box('whw', -11, H / 2, 28, 18, H, T, concreteMat);      // север, лево от двери D
  box('whw', 11, H / 2, 28, 18, H, T, concreteMat);       // север, право
  box('whw', 0, H - 1, 28, 4, 2, T, concreteMat);         // перемычка над D
  box('whw', -20, H / 2, 4, T, H, 8, concreteMat);        // запад z0..8
  box('whw', -20, H / 2, 20, T, H, 16, concreteMat);      // запад z12..28
  box('whw', -20, 1, 10, T, 2, 4, concreteMat);           // под окном B (y0..2)
  box('whw', -20, 5.4, 10, T, 3.2, 4, concreteMat);       // над окном B (y3.8..7)
  box('whw', 20, H / 2, 8, T, H, 16, concreteMat);        // восток z0..16
  box('whw', 20, H / 2, 23.5, T, H, 9, concreteMat);      // восток z19..28
  box('whw', 20, 4.8, 17.5, T, 4.4, 3, concreteMat);      // перемычка над дверью C

  // авто-двери в проёмах A/C/D
  doorAt(0, 0, 5.6, 4.8, true);     // A — ворота (юг)
  doorAt(0, 28, 3.4, 3.4, true);    // D — задняя (север)
  doorAt(20, 17.5, 2.8, 2.4, false);// C — боковая (восток)

  // галерея 2-го яруса (T-зона) по трём стенам + перила + пандус наверх
  const galY = 3.5;
  for (const [n, x, z, w, d] of [['galW', -18, 14, 4, 28], ['galE', 18, 14, 4, 28], ['galN', 0, 26, 40, 4]] as [string, number, number, number, number][]) {
    const g = box(n, x, galY, z, w, 0.3, d, galleryMat); g.checkCollisions = false; g.metadata = { floor: true };
  }
  box('rail', -16, galY + 0.5, 14, 0.15, 1, 28, galleryMat).checkCollisions = false;
  box('rail', 16, galY + 0.5, 14, 0.15, 1, 28, galleryMat).checkCollisions = false;
  box('rail', 0, galY + 0.5, 24, 32, 1, 0.15, galleryMat).checkCollisions = false;
  ramp('gramp', -17, 1.75, 6, 3.6, 7, 3.5, 6.2, galleryMat, true); // пол → западная галерея

  // фургон (точка B) + заезд на крышу + мостик через окно на галерею
  box('van', -25, 1.1, 10, 5, 2.2, 3, vanMat);
  box('vancab', -21.9, 0.9, 10, 1.2, 1.8, 2.6, vanMat);
  ramp('vanramp', -29, 1.1, 10, 3, 2.6, 2.2, 3, vanMat, true, true); // заезд на крышу фургона (вдоль X)
  const ledge = box('ledgeB', -21.3, 2.2, 10, 3.4, 0.2, 3.4, concreteMat); ledge.checkCollisions = false; ledge.metadata = { floor: true };
  const ledgeIn = box('ledgeIn', -18.4, 2.2, 10, 3, 0.2, 3.4, concreteMat); ledgeIn.checkCollisions = false; ledgeIn.metadata = { floor: true };
  ramp('bramp', -17, 2.85, 12.6, 3, 3, 1.3, 2.4, galleryMat); // уступ 2.2 → галерея 3.5

  // ящики-укрытия (склад + улица)
  ([[-8, 8, 1.4], [-6, 9.6, 1.4], [7, 7, 1.6], [9, 16, 1.4], [0, 20, 1.5], [-3, 22, 1.3], [6, 13, 1.2], [-6, -12, 1.4], [7, -16, 1.4]] as [number, number, number][])
    .forEach(([x, z, s]) => box('crate', x, s / 2, z, s, s, s, crateMat));

  // мишени (T): на галерее (на поверхности слэба) + на полу
  const galTop = galY + 0.15;
  spawnTarget(-18, 6, galTop); spawnTarget(-18, 22, galTop); spawnTarget(18, 10, galTop); spawnTarget(0, 26, galTop);
  spawnTarget(-8, 13); spawnTarget(8, 18); spawnTarget(0, 6);
  ([[-8, 20], [8, 8], [0, 14], [-12, 24]] as [number, number][]).forEach(([x, z]) => spawnPickup(x, z));

  return new B.Vector3(0, 1.7, -22); // CT спавн на улице у ворот A
}

let pickupTotal = 0;
let collected = 0;
let mapGen = 0; // поколение карты — чтобы отложенные респавны со старой карты не утекали
const objEl = document.createElement('div');
objEl.className = 'hud';
Object.assign(objEl.style, { top: '40px', left: '16px', font: '600 15px system-ui', color: '#bdeff0' } as any);
document.body.appendChild(objEl);
function objHud() { objEl.textContent = '🧊 Собрано: ' + collected + ' / ' + pickupTotal; }
objHud();

// --- миникарта (вид сверху) ---
const MM = 168, MMHALF = MM / 2, MM_SPAN = 100; // мир ±50 → весь размер карты
const mmCanvas = document.createElement('canvas');
mmCanvas.width = MM; mmCanvas.height = MM;
Object.assign(mmCanvas.style, { position: 'fixed', top: '14px', right: '14px', borderRadius: '8px', border: '2px solid rgba(255,255,255,.35)', zIndex: '4', pointerEvents: 'none' } as any);
document.body.appendChild(mmCanvas);
const mmctx = mmCanvas.getContext('2d')!;
// мир (x вправо, z вперёд) → канвас (x вправо, z вверх)
function w2m(x: number, z: number): [number, number] { return [MMHALF + (x / MM_SPAN) * MM, MMHALF - (z / MM_SPAN) * MM]; }
function drawMinimap() {
  mmctx.clearRect(0, 0, MM, MM);
  mmctx.fillStyle = 'rgba(10,14,18,.55)'; mmctx.fillRect(0, 0, MM, MM);
  // граница карты (±42)
  const a = w2m(-42, 42), b = w2m(42, -42);
  mmctx.strokeStyle = 'rgba(255,255,255,.5)'; mmctx.lineWidth = 1.5;
  mmctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
  // здания
  mmctx.fillStyle = 'rgba(150,160,170,.55)';
  for (const f of footprints) { const tl = w2m(f.cx - f.w / 2, f.cz + f.d / 2); mmctx.fillRect(tl[0], tl[1], (f.w / MM_SPAN) * MM, (f.d / MM_SPAN) * MM); }
  // мишени
  mmctx.fillStyle = '#e64545';
  for (const t of targets) { const p = w2m(t.position.x, t.position.z); mmctx.beginPath(); mmctx.arc(p[0], p[1], 2.6, 0, 7); mmctx.fill(); }
  // кубики
  mmctx.fillStyle = '#34d0c0';
  for (const c of pickups) { const p = w2m(c.position.x, c.position.z); mmctx.beginPath(); mmctx.arc(p[0], p[1], 2, 0, 7); mmctx.fill(); }
  // игрок — стрелка по направлению взгляда (тот же маппинг, что и для позиций)
  const fwd = camera.getDirection(B.Vector3.Forward());
  const pp = w2m(camera.position.x, camera.position.z);
  const pa = w2m(camera.position.x + fwd.x, camera.position.z + fwd.z);
  const ang = Math.atan2(pa[1] - pp[1], pa[0] - pp[0]);
  mmctx.save(); mmctx.translate(pp[0], pp[1]); mmctx.rotate(ang);
  mmctx.fillStyle = '#ffd23a';
  mmctx.beginPath(); mmctx.moveTo(7, 0); mmctx.lineTo(-4, -4.5); mmctx.lineTo(-4, 4.5); mmctx.closePath(); mmctx.fill();
  mmctx.restore();
}

// --- материалы оружия ---
const bluedMat = mat('blued', '#15161b', 0.55);          // воронёная сталь
bluedMat.specularColor = new B.Color3(0.5, 0.52, 0.6);
const polyMat = mat('poly', '#26282e', 0.22);            // полимер рамы/корпуса
const magMat = mat('mag', '#1a1c21', 0.3);               // магазин

// дульная вспышка (билборд, своя на каждый ствол)
const flashMat = new B.StandardMaterial('flashMat', scene);
flashMat.emissiveColor = new B.Color3(1, 0.84, 0.4);
flashMat.diffuseColor = new B.Color3(0, 0, 0);
flashMat.disableLighting = true;
function makeFlash(parent: B.TransformNode, local: B.Vector3) {
  const f = B.MeshBuilder.CreateDisc('flash', { radius: 0.15, tessellation: 8 }, scene);
  f.material = flashMat; f.parent = parent; f.position.copyFrom(local);
  f.billboardMode = B.Mesh.BILLBOARDMODE_ALL;
  f.isPickable = false; f.checkCollisions = false; f.setEnabled(false);
  return f;
}

interface Weapon {
  name: string; node: B.TransformNode; flash: B.Mesh;
  mag: number; ammo: number; interval: number; auto: boolean;
  dmgBody: number; dmgHead: number; recoil: number; reloadMs: number;
}

// деталь оружия (бокс), привязанная к узлу ствола
function part(node: B.TransformNode, n: string, w: number, h: number, d: number, x: number, y: number, z: number, m: B.Material, rx = 0) {
  const b = box(n, 0, 0, 0, w, h, d, m);
  b.parent = node; b.position.set(x, y, z); b.rotation.x = rx;
  b.checkCollisions = false; b.isPickable = false;
  return b;
}

function buildPistol(): Weapon {
  const node = new B.TransformNode('pistol', scene); node.parent = camera;
  const ox = 0.22, oy = -0.2, oz = 0.55;
  part(node, 'p_slide', 0.12, 0.14, 0.5, ox, oy + 0.02, oz + 0.18, bluedMat);  // затвор
  part(node, 'p_frame', 0.11, 0.10, 0.42, ox, oy - 0.08, oz + 0.14, polyMat);  // рама
  part(node, 'p_grip', 0.10, 0.24, 0.13, ox, oy - 0.26, oz - 0.02, polyMat, 0.22); // рукоять
  part(node, 'p_sight', 0.02, 0.03, 0.03, ox, oy + 0.11, oz + 0.4, bluedMat);  // мушка
  const bar = B.MeshBuilder.CreateCylinder('p_barrel', { diameter: 0.05, height: 0.16 }, scene);
  bar.material = bluedMat; bar.parent = node; bar.rotation.x = Math.PI / 2;
  bar.position.set(ox, oy + 0.02, oz + 0.46); bar.isPickable = false; bar.checkCollisions = false;
  const flash = makeFlash(node, new B.Vector3(ox, oy + 0.02, oz + 0.57));
  return { name: 'Пистолет', node, flash, mag: 12, ammo: 12, interval: 170, auto: false, dmgBody: 50, dmgHead: 100, recoil: 0.13, reloadMs: 800 };
}

function buildSMG(): Weapon {
  const node = new B.TransformNode('smg', scene); node.parent = camera; node.setEnabled(false);
  const ox = 0.2, oy = -0.22, oz = 0.5;
  part(node, 's_body', 0.12, 0.16, 0.7, ox, oy + 0.04, oz + 0.22, bluedMat);   // корпус
  part(node, 's_rail', 0.06, 0.05, 0.46, ox, oy + 0.14, oz + 0.24, polyMat);   // планка
  part(node, 's_mag', 0.08, 0.3, 0.12, ox, oy - 0.2, oz + 0.08, magMat, 0.14); // магазин
  part(node, 's_grip', 0.09, 0.2, 0.12, ox, oy - 0.16, oz - 0.12, polyMat, 0.3); // рукоять
  part(node, 's_stock', 0.08, 0.1, 0.24, ox, oy + 0.02, oz - 0.32, polyMat);   // приклад
  const bar = B.MeshBuilder.CreateCylinder('s_barrel', { diameter: 0.05, height: 0.34 }, scene);
  bar.material = bluedMat; bar.parent = node; bar.rotation.x = Math.PI / 2;
  bar.position.set(ox, oy + 0.06, oz + 0.62); bar.isPickable = false; bar.checkCollisions = false;
  const flash = makeFlash(node, new B.Vector3(ox, oy + 0.06, oz + 0.8));
  return { name: 'SMG', node, flash, mag: 30, ammo: 30, interval: 75, auto: true, dmgBody: 24, dmgHead: 55, recoil: 0.07, reloadMs: 1100 };
}

const weapons: Weapon[] = [buildPistol(), buildSMG()];
let wi = 0;
let cur = weapons[wi];
const gunHome = new B.Vector3(0, 0, 0);
weapons.forEach((w) => w.node.position.copyFrom(gunHome));

// --- HUD ---
let kills = 0, reloading = false;
function hud() {
  ammoEl.textContent = reloading ? 'Перезарядка…' : cur.name + ': ' + cur.ammo + ' / ' + cur.mag;
  killsEl.textContent = 'Убито: ' + kills;
}
hud();

function switchWeapon(i: number) {
  if (i === wi || i < 0 || i >= weapons.length || reloading) return;
  cur.node.setEnabled(false);
  wi = i; cur = weapons[wi];
  cur.node.setEnabled(true);
  hud();
}

function reload() {
  if (reloading || cur.ammo >= cur.mag) return;
  reloading = true; hud(); sndReload();
  const w = cur;
  setTimeout(() => { w.ammo = w.mag; if (cur === w) { reloading = false; } hud(); }, cur.reloadMs);
}

// --- индикаторы попадания (DOM) ---
const hitMark = document.createElement('div');
hitMark.textContent = '✕';
Object.assign(hitMark.style, { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', font: '700 22px system-ui', textShadow: '0 1px 2px #000', opacity: '0', transition: 'opacity .09s', pointerEvents: 'none', zIndex: '5' } as any);
document.body.appendChild(hitMark);
function hitMarker(head: boolean) {
  hitMark.style.color = head ? '#ff5a5a' : '#ffffff';
  hitMark.style.opacity = '1';
  setTimeout(() => { hitMark.style.opacity = '0'; }, 110);
}
function dmgPopup(point: B.Vector3, dmg: number, head: boolean) {
  const vp = camera.viewport.toGlobal(canvas.clientWidth, canvas.clientHeight);
  const p = B.Vector3.Project(point, B.Matrix.IdentityReadOnly, scene.getTransformMatrix(), vp);
  const el = document.createElement('div');
  el.textContent = (head ? '★' : '') + dmg;
  Object.assign(el.style, { position: 'fixed', left: p.x + 'px', top: p.y + 'px', color: head ? '#ffd23a' : '#ffe2e2', font: '700 ' + (head ? 20 : 16) + 'px system-ui', textShadow: '0 1px 3px #000', pointerEvents: 'none', zIndex: '6', transform: 'translate(-50%,-50%)', transition: 'top .6s ease-out, opacity .6s ease-out', opacity: '1' } as any);
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.top = (p.y - 42) + 'px'; el.style.opacity = '0'; });
  setTimeout(() => el.remove(), 640);
}

// --- звук (синтез через WebAudio, без файлов) ---
let actx: AudioContext | null = null;
function audio() {
  if (!actx) actx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return actx;
}
function blip(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
  const a = audio(); const t = a.currentTime;
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur);
}
function noiseBurst(dur: number, vol: number, cutoff: number) {
  const a = audio(); const t = a.currentTime;
  const n = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, n, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
  const src = a.createBufferSource(); src.buffer = buf;
  const g = a.createGain(); g.gain.value = vol;
  const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
  src.connect(f).connect(g).connect(a.destination); src.start(t);
}
function sndShoot(smg: boolean) { noiseBurst(smg ? 0.07 : 0.11, smg ? 0.16 : 0.26, smg ? 2200 : 1600); blip(smg ? 320 : 200, 0.06, 'square', 0.1, 90); }
function sndHit() { blip(880, 0.05, 'triangle', 0.16); }
function sndKill() { blip(660, 0.18, 'sawtooth', 0.18, 180); }
function sndReload() { blip(150, 0.04, 'square', 0.13); setTimeout(() => blip(230, 0.05, 'square', 0.13), 170); }

// --- стрельба ---
let recoil = 0, lastShot = 0;
function fire() {
  if (reloading || cur.ammo <= 0) return;
  const now = performance.now();
  if (now - lastShot < cur.interval) return;
  lastShot = now;
  cur.ammo--; hud();
  recoil = cur.recoil;
  sndShoot(cur.name === 'SMG');
  // вспышка
  cur.flash.scaling.setAll(0.7 + Math.random() * 0.7);
  cur.flash.setEnabled(true);
  const fl = cur.flash;
  setTimeout(() => fl.setEnabled(false), 45);
  if (cur.ammo === 0) reload();
  // хитскан
  const ray = camera.getForwardRay(240);
  const hit = scene.pickWithRay(ray, (m) => targets.indexOf(m as B.Mesh) !== -1);
  if (hit && hit.pickedMesh && hit.pickedPoint) {
    const t = hit.pickedMesh as B.Mesh;
    const headshot = hit.pickedPoint.y > t.position.y + 0.45;
    const dmg = headshot ? cur.dmgHead : cur.dmgBody;
    t.metadata.hp -= dmg;
    hitMarker(headshot);
    dmgPopup(hit.pickedPoint, dmg, headshot);
    if (t.metadata.hp <= 0) {
      const sx = t.metadata.x, sz = t.metadata.z, sy = t.metadata.y || 0, gen = mapGen;
      targets.splice(targets.indexOf(t), 1);
      t.dispose();
      kills++; hud(); sndKill();
      setTimeout(() => { if (gen === mapGen) spawnTarget(sx, sz, sy); }, 4000); // респавн через 4 c (только если карта та же)
    } else {
      sndHit();
      const em = t.material as B.StandardMaterial;
      em.emissiveColor = new B.Color3(0.85, 0.12, 0.12);
      setTimeout(() => { em.emissiveColor = new B.Color3(0.25, 0.02, 0.02); }, 90);
    }
  }
}

// --- ввод ---
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
let touchStarted = false;
overlay.addEventListener('click', () => {
  audio().resume();
  if (isTouch) { touchStarted = true; overlay.style.display = 'none'; }
  else canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  if (isTouch) return;
  overlay.style.display = document.pointerLockElement === canvas ? 'none' : 'flex';
});
const locked = () => document.pointerLockElement === canvas;

document.addEventListener('mousemove', (e) => {
  if (!locked()) return;
  camera.rotation.y += e.movementX * 0.0022;
  camera.rotation.x = Math.max(-1.45, Math.min(1.45, camera.rotation.x + e.movementY * 0.0022));
});
let mouseDown = false;
document.addEventListener('mousedown', (e) => { if (locked() && e.button === 0) { mouseDown = true; fire(); } });
document.addEventListener('mouseup', () => { mouseDown = false; });

// движение по физическим кодам клавиш (event.code) — работает на любой
// раскладке (WASD == ЦФЫВ), плюс стрелки
let jumpQueued = false;
const held = new Set<string>();
window.addEventListener('keydown', (e) => {
  held.add(e.code);
  if (e.code === 'Space') jumpQueued = true;
  if (e.code === 'Digit1') switchWeapon(0);
  if (e.code === 'Digit2') switchWeapon(1);
  if (e.code === 'KeyR') reload();
  if (e.code === 'KeyM') loadMap(curMap + 1);
});
window.addEventListener('keyup', (e) => held.delete(e.code));
window.addEventListener('blur', () => held.clear()); // не залипать при потере фокуса

// --- сенсорное управление (телефон) ---
// touchMove на уровне модуля — render-loop двигает камеру через cameraDirection.
const touchMove = { x: 0, y: 0 };
if (isTouch) {
  const css = (el: HTMLElement, s: Record<string, string>) => Object.assign(el.style, s as any);
  const mk = (s: Record<string, string>) => { const d = document.createElement('div'); css(d, s); document.body.appendChild(d); return d; };
  // визуальный джойстик (появляется под пальцем)
  const stickZone = mk({ position: 'fixed', width: '100px', height: '100px', borderRadius: '50%', border: '2px solid rgba(255,255,255,.4)', background: 'rgba(255,255,255,.08)', display: 'none', pointerEvents: 'none', zIndex: '8' });
  const stickNub = mk({ position: 'fixed', width: '40px', height: '40px', borderRadius: '50%', background: 'rgba(255,255,255,.5)', display: 'none', pointerEvents: 'none', zIndex: '9' });
  // кнопки действий
  const btn = (label: string, right: string, bottom: string) => mk({ position: 'fixed', right, bottom, width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(255,255,255,.14)', border: '2px solid rgba(255,255,255,.4)', color: '#fff', font: '600 13px system-ui', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none', zIndex: '9', userSelect: 'none' });
  const fireBtn = btn('ОГОНЬ', '20px', '24px'); fireBtn.textContent = '🔫';
  const jumpBtn = btn('', '96px', '24px'); jumpBtn.textContent = '⤒';
  const swBtn = btn('', '20px', '100px'); swBtn.textContent = '1/2';

  let moveId = -1, moveCX = 0, moveCY = 0, lookId = -1, lookX = 0, lookY = 0;
  const MAXR = 50;
  const start = () => { if (!touchStarted) { touchStarted = true; overlay.style.display = 'none'; audio().resume(); } };

  canvas.addEventListener('pointerdown', (e) => {
    start();
    if (e.clientX < window.innerWidth * 0.5 && moveId < 0) {
      moveId = e.pointerId; moveCX = e.clientX; moveCY = e.clientY;
      css(stickZone, { left: (moveCX - 50) + 'px', top: (moveCY - 50) + 'px', display: 'block' });
      css(stickNub, { left: (moveCX - 20) + 'px', top: (moveCY - 20) + 'px', display: 'block' });
    } else if (lookId < 0) {
      lookId = e.pointerId; lookX = e.clientX; lookY = e.clientY;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId === moveId) {
      const dx = e.clientX - moveCX, dy = e.clientY - moveCY;
      const mag = Math.min(1, Math.hypot(dx, dy) / MAXR);
      const ang = Math.atan2(dy, dx);
      touchMove.x = Math.cos(ang) * mag; touchMove.y = -Math.sin(ang) * mag; // вперёд = палец вверх
      css(stickNub, { left: (moveCX + Math.cos(ang) * mag * MAXR - 20) + 'px', top: (moveCY + Math.sin(ang) * mag * MAXR - 20) + 'px' });
    } else if (e.pointerId === lookId) {
      camera.rotation.y += (e.clientX - lookX) * 0.004;
      camera.rotation.x = Math.max(-1.45, Math.min(1.45, camera.rotation.x + (e.clientY - lookY) * 0.004));
      lookX = e.clientX; lookY = e.clientY;
    }
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId === moveId) { moveId = -1; touchMove.x = 0; touchMove.y = 0; css(stickZone, { display: 'none' }); css(stickNub, { display: 'none' }); }
    if (e.pointerId === lookId) lookId = -1;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  fireBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); start(); mouseDown = true; fire(); });
  fireBtn.addEventListener('pointerup', () => { mouseDown = false; });
  jumpBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); jumpQueued = true; });
  swBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); switchWeapon(wi === 0 ? 1 : 0); });
}

// --- вертикаль (гравитация + прыжок) ---
// Камера сама обрабатывает горизонтальные коллизии (WASD + checkCollisions).
// Вертикаль считаем вручную: луч вниз ищет опору, position.y двигаем сами.
let velY = 0;
const GRAV = -0.013, JUMP = 0.23, EYE = 1.7, MOVE = 0.06; // MOVE — ускорение ходьбы (≈8 ед/с)
const spawnPoint = new B.Vector3(0, EYE, -26);             // точка спавна текущей карты
let bobPhase = 0, gunDip = 0, lastX = camera.position.x, lastZ = camera.position.z;
scene.onBeforeRenderObservable.add(() => {
  const downRay = new B.Ray(camera.position, new B.Vector3(0, -1, 0), 60);
  const g = scene.pickWithRay(downRay, (m) => (m.checkCollisions || (m.metadata && m.metadata.floor)) && targets.indexOf(m as B.Mesh) === -1);
  const standY = (g && g.hit && g.pickedPoint) ? g.pickedPoint.y + EYE : -Infinity;
  const grounded = camera.position.y <= standY + 0.05 && velY <= 0;
  if (grounded) {
    camera.position.y = standY;
    velY = jumpQueued ? JUMP : 0;
  } else {
    velY += GRAV;
    camera.position.y += velY;
    if (camera.position.y < standY) { camera.position.y = standY; velY = 0; }
  }
  jumpQueued = false;
  // упал с карты — вернуть на спавн текущей карты
  if (camera.position.y < -8) { camera.position.copyFrom(spawnPoint); velY = 0; }

  // автоогонь (SMG): удержание ЛКМ
  if (mouseDown && cur.auto) fire();

  // движение: клавиатура (по event.code, любая раскладка) + джойстик (телефон).
  // Добавляем в cameraDirection — камера применит со встроенными коллизиями.
  let inX = touchMove.x, inZ = touchMove.y;
  if (locked()) {
    inZ += (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0) - (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0);
    inX += (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0) - (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0);
  }
  const inMag = Math.hypot(inX, inZ);
  if (inMag > 0.001) {
    if (inMag > 1) { inX /= inMag; inZ /= inMag; } // по диагонали не быстрее
    const fwd = camera.getDirection(B.Vector3.Forward()); fwd.y = 0; fwd.normalize();
    const right = camera.getDirection(B.Vector3.Right()); right.y = 0; right.normalize();
    camera.cameraDirection.addInPlace(fwd.scale(inZ * MOVE));
    camera.cameraDirection.addInPlace(right.scale(inX * MOVE));
  }

  // покачивание оружия при ходьбе + просадка при перезарядке + отдача
  const moved = Math.hypot(camera.position.x - lastX, camera.position.z - lastZ) > 0.004;
  lastX = camera.position.x; lastZ = camera.position.z;
  bobPhase += moved ? 0.22 : 0.05;
  const bobY = moved ? Math.abs(Math.sin(bobPhase)) * 0.014 : 0;
  const bobX = moved ? Math.cos(bobPhase * 0.5) * 0.01 : 0;
  gunDip += ((reloading ? 1 : 0) - gunDip) * 0.15; // плавная просадка ствола при перезарядке
  if (recoil > 0.001) { recoil *= 0.8; } else recoil = 0;
  cur.node.position.set(gunHome.x + bobX, gunHome.y + bobY - gunDip * 0.28, gunHome.z - recoil);
  cur.node.rotation.x = recoil * 1.5 + gunDip * 0.7;

  // двери: автооткрытие рядом с игроком + плавный доворот, коллизия по состоянию
  for (const dr of doors) {
    dr.open = B.Vector3.Distance(camera.position, dr.hinge.getAbsolutePosition()) < 3;
    dr.panel.checkCollisions = !dr.open;
    const tgt = dr.open ? -Math.PI / 2 : 0;
    dr.hinge.rotation.y += (tgt - dr.hinge.rotation.y) * 0.18;
  }

  // кубики: вращение, парение, подбор при касании
  const tms = performance.now();
  for (let i = pickups.length - 1; i >= 0; i--) {
    const c = pickups[i];
    c.rotation.y += 0.04; c.rotation.x += 0.02;
    c.position.y = 0.8 + Math.sin(tms / 400 + i) * 0.12;
    if (B.Vector3.Distance(camera.position, c.position) < 1.5) {
      c.dispose(); pickups.splice(i, 1); collected++; objHud();
    }
  }

  drawMinimap();
});

// ===== система карт =====
const mapDefs: { name: string; build: () => B.Vector3 }[] = [
  { name: 'Арена (город)', build: buildCityMap },
  { name: 'cs_assault', build: buildAssaultMap },
];
let curMap = 0;
let levelMeshes: B.AbstractMesh[] = [];

const mapToast = document.createElement('div');
Object.assign(mapToast.style, { position: 'fixed', top: '46%', left: '50%', transform: 'translate(-50%,-50%)', font: '700 26px system-ui', color: '#fff', textShadow: '0 2px 6px #000', background: 'rgba(0,0,0,.45)', padding: '10px 22px', borderRadius: '10px', opacity: '0', transition: 'opacity .3s', pointerEvents: 'none', zIndex: '20' } as any);
document.body.appendChild(mapToast);
let toastTimer = 0;
function showMapName(name: string) {
  mapToast.textContent = '🗺 ' + name + '  (M — сменить карту)';
  mapToast.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { mapToast.style.opacity = '0'; }, 1600);
}

function loadMap(i: number) {
  // выгрузка прошлой карты
  for (const m of levelMeshes) if (!m.isDisposed()) m.dispose();
  for (const d of doors) d.hinge.dispose(true);
  for (const t of targets) t.dispose();
  for (const p of pickups) p.dispose();
  levelMeshes = []; doors.length = 0; footprints.length = 0; targets.length = 0; pickups.length = 0;
  mapGen++; // отменяем отложенные респавны прошлой карты
  // сборка новой
  curMap = ((i % mapDefs.length) + mapDefs.length) % mapDefs.length;
  const meshes: B.AbstractMesh[] = [];
  sink = meshes;
  const spawn = mapDefs[curMap].build();
  sink = null;
  levelMeshes = meshes;
  // сброс состояния игры
  kills = 0; collected = 0; pickupTotal = pickups.length; reloading = false;
  hud(); objHud();
  // спавн + корректный мировой bbox (Babylon обновляет его лениво — иначе стрельба/опора мажут)
  spawnPoint.copyFrom(spawn);
  camera.position.copyFrom(spawn);
  camera.rotation.set(0, 0, 0);
  velY = 0;
  scene.meshes.forEach((m) => { m.refreshBoundingInfo(); m.computeWorldMatrix(true); });
  showMapName(mapDefs[curMap].name);
}

loadMap(0);

engine.runRenderLoop(() => scene.render());
window.addEventListener('resize', () => engine.resize());

// отладка
(window as any).GAME = { engine, scene, camera, targets, pickups, weapons, fire, switchWeapon, getCur: () => cur, held, footprints, w2m, drawMinimap, MM, MMHALF, MM_SPAN, loadMap, mapDefs, getMap: () => curMap };
