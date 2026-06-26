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
  t.material = targetMat;
  t.metadata = { hp: 100 };
  targets.push(t);
}
([[28, 8], [28, 3], [24, 8], [-28, 8], [-24, 3], [0, 33], [12, -20], [-12, -20]] as [number, number][])
  .forEach(([x, z]) => spawnTarget(x, z));

// --- пистолет (привязан к камере) ---
const gunMat = mat('gun', '#16171c', 0.5);
gunMat.specularColor = new B.Color3(0.4, 0.42, 0.5);
const gun = new B.TransformNode('gun', scene);
gun.parent = camera;
const slide = box('slide', 0, 0, 0, 0.12, 0.13, 0.5, gunMat); slide.parent = gun; slide.position.set(0.22, -0.2, 0.7); slide.checkCollisions = false;
const grip = box('grip', 0, 0, 0, 0.1, 0.22, 0.12, gunMat); grip.parent = gun; grip.position.set(0.22, -0.36, 0.5); grip.rotation.x = 0.25; grip.checkCollisions = false;
const barrel = B.MeshBuilder.CreateCylinder('barrel', { diameter: 0.06, height: 0.18 }, scene);
barrel.material = gunMat; barrel.parent = gun; barrel.rotation.x = Math.PI / 2; barrel.position.set(0.22, -0.18, 0.96); barrel.checkCollisions = false;
const gunHome = new B.Vector3(0, 0, 0);
gun.position.copyFrom(gunHome);

// --- HUD ---
let ammo = 30; const MAG = 30; let kills = 0; let reloading = false; let lastShot = 0;
function hud() {
  ammoEl.textContent = (reloading ? 'Перезарядка…' : 'Патроны: ' + ammo) + ' / ' + MAG;
  killsEl.textContent = 'Убито: ' + kills;
}
hud();

// --- стрельба ---
let recoil = 0;
function fire() {
  if (reloading || ammo <= 0) return;
  if (performance.now() - lastShot < 140) return;
  lastShot = performance.now();
  ammo--; hud();
  recoil = 0.12;
  const ray = camera.getForwardRay(220);
  const hit = scene.pickWithRay(ray, (m) => targets.indexOf(m as B.Mesh) !== -1);
  if (hit && hit.pickedMesh) {
    const t = hit.pickedMesh as B.Mesh;
    const headshot = hit.pickedPoint ? hit.pickedPoint.y > t.position.y + 0.45 : false;
    t.metadata.hp -= headshot ? 100 : 50;
    if (t.metadata.hp <= 0) {
      targets.splice(targets.indexOf(t), 1);
      t.dispose();
      kills++; hud();
    } else {
      const em = (t.material as B.StandardMaterial);
      em.emissiveColor = new B.Color3(0.8, 0.1, 0.1);
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
  if ((k === 'r' || k === 'к') && !reloading && ammo < MAG) {
    reloading = true; hud();
    setTimeout(() => { ammo = MAG; reloading = false; hud(); }, 850);
  }
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

  // отдача оружия
  if (recoil > 0.001) { recoil *= 0.8; } else recoil = 0;
  gun.position.z = gunHome.z - recoil;
  gun.rotation.x = recoil * 1.5;
});

engine.runRenderLoop(() => scene.render());
window.addEventListener('resize', () => engine.resize());

// отладка
(window as any).GAME = { engine, scene, camera, targets };
