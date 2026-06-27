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
camera.keysUp = [87]; camera.keysDown = [83]; camera.keysLeft = [65]; camera.keysRight = [68];
camera.keysUpward = []; camera.keysDownward = [];
// своё управление обзором — убираем стандартный mouse input
camera.inputs.removeByType('FreeCameraMouseInput');

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

// --- земля ---
const ground = B.MeshBuilder.CreateGround('ground', { width: 220, height: 220 }, scene);
ground.material = groundMat;
ground.checkCollisions = true;
ground.receiveShadows = true;

// --- постройки ---
function box(name: string, x: number, y: number, z: number, w: number, h: number, d: number, material: B.Material) {
  const m = B.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
  m.position.set(x, y, z);
  m.material = material;
  m.checkCollisions = true;
  m.receiveShadows = true;
  return m;
}

function building(cx: number, cz: number, w: number, d: number, h: number, m: B.Material) {
  const t = 0.5;       // толщина стены
  const door = 2.6;    // ширина проёма
  const seg = (w - door) / 2;
  // передняя стена (z = cz - d/2) — два сегмента вокруг двери
  box('w', cx - (door / 2 + seg / 2), h / 2, cz - d / 2, seg, h, t, m);
  box('w', cx + (door / 2 + seg / 2), h / 2, cz - d / 2, seg, h, t, m);
  box('w', cx, h / 2, cz + d / 2, w, h, t, m);              // задняя
  box('w', cx - w / 2, h / 2, cz, t, h, d, m);              // левая
  box('w', cx + w / 2, h / 2, cz, t, h, d, m);              // правая
  box('roof', cx, h + 0.12, cz, w + 0.3, 0.25, d + 0.3, roofMat); // крыша
  // дверь (визуальная, в проёме)
  const dh = Math.min(h - 0.4, 2.8);
  const dr = box('door', cx, dh / 2, cz - d / 2, door - 0.15, dh, 0.14, doorMat);
  dr.checkCollisions = false;
}

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

// --- перепад высоты: платформа + лестница ---
box('platform', 0, 3.4, 0, 12, 0.4, 4, concreteMat);
for (let i = 0; i < 7; i++) {
  const sh = (i + 1) * 0.5;
  box('step', 0, sh / 2, -3 - i * 0.7, 4, sh, 0.7, concreteMat);
}

// --- цели ---
const targetMat = mat('target', '#d83030', 0.1);
targetMat.emissiveColor = new B.Color3(0.25, 0.02, 0.02);
const targets: B.Mesh[] = [];
function spawnTarget(x: number, z: number) {
  const t = B.MeshBuilder.CreateBox('target', { width: 0.85, height: 1.7, depth: 0.4 }, scene);
  t.position.set(x, 0.85, z);
  t.material = targetMat.clone('target_' + targets.length)!; // своя копия — подсветка попадания не задевает остальных
  t.metadata = { hp: 100 };
  targets.push(t);
}
([[28, 8], [28, 3], [24, 8], [-28, 8], [-24, 3], [0, 33], [12, -20], [-12, -20]] as [number, number][])
  .forEach(([x, z]) => spawnTarget(x, z));

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
  reloading = true; hud();
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

// --- стрельба ---
let recoil = 0, lastShot = 0;
function fire() {
  if (reloading || cur.ammo <= 0) return;
  const now = performance.now();
  if (now - lastShot < cur.interval) return;
  lastShot = now;
  cur.ammo--; hud();
  recoil = cur.recoil;
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
      targets.splice(targets.indexOf(t), 1);
      t.dispose();
      kills++; hud();
    } else {
      const em = t.material as B.StandardMaterial;
      em.emissiveColor = new B.Color3(0.85, 0.12, 0.12);
      setTimeout(() => { em.emissiveColor = new B.Color3(0.25, 0.02, 0.02); }, 90);
    }
  }
}

// --- ввод ---
overlay.addEventListener('click', () => canvas.requestPointerLock());
document.addEventListener('pointerlockchange', () => {
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

let jumpQueued = false;
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === ' ') jumpQueued = true;
  if (k === '1') switchWeapon(0);
  if (k === '2') switchWeapon(1);
  if (k === 'r' || k === 'к') reload();
});

// --- вертикаль (гравитация + прыжок) ---
// Камера сама обрабатывает горизонтальные коллизии (WASD + checkCollisions).
// Вертикаль считаем вручную: луч вниз ищет опору, position.y двигаем сами.
let velY = 0;
const GRAV = -0.013, JUMP = 0.23, EYE = 1.7;
scene.onBeforeRenderObservable.add(() => {
  const downRay = new B.Ray(camera.position, new B.Vector3(0, -1, 0), 60);
  const g = scene.pickWithRay(downRay, (m) => m.checkCollisions && targets.indexOf(m as B.Mesh) === -1);
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
  // упал с карты — вернуть на спавн
  if (camera.position.y < -8) { camera.position.set(0, EYE, -26); velY = 0; }

  // автоогонь (SMG): удержание ЛКМ
  if (mouseDown && cur.auto) fire();

  // отдача активного оружия
  if (recoil > 0.001) { recoil *= 0.8; } else recoil = 0;
  cur.node.position.z = gunHome.z - recoil;
  cur.node.rotation.x = recoil * 1.5;
});

// Babylon обновляет мировой bounding box лениво — у статичных мешей,
// которым задали position уже после создания, он остаётся в начале координат,
// из-за чего pickWithRay (стрельба) и лучи опоры промахиваются. Форсируем пересчёт.
scene.meshes.forEach((m) => { m.refreshBoundingInfo(); m.computeWorldMatrix(true); });

engine.runRenderLoop(() => scene.render());
window.addEventListener('resize', () => engine.resize());

// отладка
(window as any).GAME = { engine, scene, camera, targets, weapons, fire, switchWeapon, getCur: () => cur };
