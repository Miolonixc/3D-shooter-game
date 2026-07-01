import { Scene, Camera, Vector3, Matrix, AbstractMesh } from '@babylonjs/core';
import { MINIMAP } from './config';

// DOM elements
let ammoEl: HTMLDivElement | null = null;
let killsEl: HTMLDivElement | null = null;
let objEl: HTMLDivElement | null = null;
let hitMark: HTMLDivElement | null = null;
let mapToast: HTMLDivElement | null = null;

let mmCanvas: HTMLCanvasElement | null = null;
let mmctx: CanvasRenderingContext2D | null = null;

let toastTimer = 0;

export function initUI() {
  ammoEl = document.getElementById('ammo') as HTMLDivElement;
  killsEl = document.getElementById('kills') as HTMLDivElement;

  objEl = document.createElement('div');
  objEl.className = 'hud';
  Object.assign(objEl.style, {
    top: '40px',
    left: '16px',
    font: '600 15px system-ui',
    color: '#bdeff0',
    position: 'fixed',
    zIndex: '4',
    pointerEvents: 'none',
  });
  document.body.appendChild(objEl);

  hitMark = document.createElement('div');
  hitMark.textContent = '✕';
  Object.assign(hitMark.style, {
    position: 'fixed',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%,-50%)',
    font: '700 22px system-ui',
    textShadow: '0 1px 2px #000',
    opacity: '0',
    transition: 'opacity .09s',
    pointerEvents: 'none',
    zIndex: '5',
  });
  document.body.appendChild(hitMark);

  mapToast = document.createElement('div');
  Object.assign(mapToast.style, {
    position: 'fixed',
    top: '46%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    font: '700 26px system-ui',
    color: '#fff',
    textShadow: '0 2px 6px #000',
    background: 'rgba(0,0,0,.45)',
    padding: '10px 22px',
    borderRadius: '10px',
    opacity: '0',
    transition: 'opacity .3s',
    pointerEvents: 'none',
    zIndex: '20',
  });
  document.body.appendChild(mapToast);

  mmCanvas = document.createElement('canvas');
  mmCanvas.width = MINIMAP.SIZE;
  mmCanvas.height = MINIMAP.SIZE;
  Object.assign(mmCanvas.style, {
    position: 'fixed',
    top: '14px',
    right: '14px',
    borderRadius: '8px',
    border: '2px solid rgba(255,255,255,.35)',
    zIndex: '4',
    pointerEvents: 'none',
  });
  document.body.appendChild(mmCanvas);
  mmctx = mmCanvas.getContext('2d');
}

export function updateAmmoHud(reloading: boolean, weaponName: string, ammo: number, mag: number) {
  if (ammoEl) {
    ammoEl.textContent = reloading ? 'Перезарядка…' : weaponName + ': ' + ammo + ' / ' + mag;
  }
}

export function updateKillsHud(kills: number) {
  if (killsEl) {
    killsEl.textContent = 'Убито: ' + kills;
  }
}

export function updateObjectiveHud(collected: number, total: number) {
  if (objEl) {
    objEl.textContent = '🧊 Собрано: ' + collected + ' / ' + total;
  }
}

export function showMapName(name: string) {
  if (!mapToast) return;
  mapToast.textContent = '🗺 ' + name + '  (M — сменить карту)';
  mapToast.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (mapToast) mapToast.style.opacity = '0';
  }, 1600);
}

export function hitMarker(head: boolean) {
  if (!hitMark) return;
  hitMark.style.color = head ? '#ff5a5a' : '#ffffff';
  hitMark.style.opacity = '1';
  setTimeout(() => {
    if (hitMark) hitMark.style.opacity = '0';
  }, 110);
}

export function dmgPopup(scene: Scene, camera: Camera, canvas: HTMLCanvasElement, point: Vector3, dmg: number, head: boolean) {
  const vp = camera.viewport.toGlobal(canvas.clientWidth, canvas.clientHeight);
  const p = Vector3.Project(point, Matrix.IdentityReadOnly, scene.getTransformMatrix(), vp);
  const el = document.createElement('div');
  el.textContent = (head ? '★' : '') + dmg;
  Object.assign(el.style, {
    position: 'fixed',
    left: p.x + 'px',
    top: p.y + 'px',
    color: head ? '#ffd23a' : '#ffe2e2',
    font: '700 ' + (head ? 20 : 16) + 'px system-ui',
    textShadow: '0 1px 3px #000',
    pointerEvents: 'none',
    zIndex: '6',
    transform: 'translate(-50%,-50%)',
    transition: 'top .6s ease-out, opacity .6s ease-out',
    opacity: '1',
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.top = (p.y - 42) + 'px';
    el.style.opacity = '0';
  });
  setTimeout(() => el.remove(), 640);
}

// Translate world coordinates to minimap coordinates
export function w2m(x: number, z: number, mmCenterX: number, mmCenterZ: number, mmSpan: number): [number, number] {
  return [
    MINIMAP.HALF_SIZE + ((x - mmCenterX) / mmSpan) * MINIMAP.SIZE,
    MINIMAP.HALF_SIZE - ((z - mmCenterZ) / mmSpan) * MINIMAP.SIZE,
  ];
}

export function drawMinimap(
  camera: Camera,
  targets: AbstractMesh[],
  pickups: AbstractMesh[],
  footprints: { cx: number; cz: number; w: number; d: number }[],
  mmBg: HTMLCanvasElement | null,
  mmCenterX: number,
  mmCenterZ: number,
  mmSpan: number
) {
  if (!mmctx) return;
  mmctx.clearRect(0, 0, MINIMAP.SIZE, MINIMAP.SIZE);
  
  if (mmBg) {
    mmctx.drawImage(mmBg, 0, 0, MINIMAP.SIZE, MINIMAP.SIZE);
  } else {
    mmctx.fillStyle = 'rgba(10,14,18,.55)';
    mmctx.fillRect(0, 0, MINIMAP.SIZE, MINIMAP.SIZE);
    
    // Draw default city boundaries
    const a = w2m(-42, 42, mmCenterX, mmCenterZ, mmSpan);
    const b = w2m(42, -42, mmCenterX, mmCenterZ, mmSpan);
    mmctx.strokeStyle = 'rgba(255,255,255,.5)';
    mmctx.lineWidth = 1.5;
    mmctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    
    // Draw buildings
    mmctx.fillStyle = 'rgba(150,160,170,.55)';
    for (const f of footprints) {
      const tl = w2m(f.cx - f.w / 2, f.cz + f.d / 2, mmCenterX, mmCenterZ, mmSpan);
      mmctx.fillRect(tl[0], tl[1], (f.w / mmSpan) * MINIMAP.SIZE, (f.d / mmSpan) * MINIMAP.SIZE);
    }
  }

  // Draw targets
  mmctx.fillStyle = '#e64545';
  for (const t of targets) {
    if (t.isDisposed()) continue;
    const p = w2m(t.position.x, t.position.z, mmCenterX, mmCenterZ, mmSpan);
    mmctx.beginPath();
    mmctx.arc(p[0], p[1], 2.6, 0, 7);
    mmctx.fill();
  }

  // Draw pickups
  mmctx.fillStyle = '#34d0c0';
  for (const c of pickups) {
    if (c.isDisposed()) continue;
    const p = w2m(c.position.x, c.position.z, mmCenterX, mmCenterZ, mmSpan);
    mmctx.beginPath();
    mmctx.arc(p[0], p[1], 2, 0, 7);
    mmctx.fill();
  }

  // Draw player arrow
  const fwd = camera.getDirection(Vector3.Forward());
  const pp = w2m(camera.position.x, camera.position.z, mmCenterX, mmCenterZ, mmSpan);
  const pa = w2m(camera.position.x + fwd.x, camera.position.z + fwd.z, mmCenterX, mmCenterZ, mmSpan);
  const ang = Math.atan2(pa[1] - pp[1], pa[0] - pp[0]);

  mmctx.save();
  mmctx.translate(pp[0], pp[1]);
  mmctx.rotate(ang);
  mmctx.fillStyle = '#ffd23a';
  mmctx.beginPath();
  mmctx.moveTo(7, 0);
  mmctx.lineTo(-4, -4.5);
  mmctx.lineTo(-4, 4.5);
  mmctx.closePath();
  mmctx.fill();
  mmctx.restore();
}

export function getMmCanvas() {
  return mmCanvas;
}
