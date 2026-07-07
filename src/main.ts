import * as B from './babylon';
import { loadBsp } from './bsp';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const ammoEl = document.getElementById('ammo') as HTMLDivElement;
const killsEl = document.getElementById('kills') as HTMLDivElement;
const hpEl = document.getElementById('hp') as HTMLDivElement;
const dmgFlashEl = document.getElementById('dmgFlash') as HTMLDivElement;
const deathOverlayEl = document.getElementById('deathOverlay') as HTMLDivElement;
const respawnTextEl = document.getElementById('respawnText') as HTMLDivElement;
const scoreboardEl = document.getElementById('scoreboard') as HTMLDivElement;
const chatLogEl = document.getElementById('chatLog') as HTMLDivElement;
const chatInputEl = document.getElementById('chatInput') as HTMLDivElement;

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
hemi.groundColor = new B.Color3(0.5, 0.49, 0.45); // чуть больше заливки — интерьер ангара не такой тёмный
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

// --- монитор видеонаблюдения (грузовик, карта BSP) ---
let monitorTriggerPos: B.Vector3 | null = null; // задаётся картой (buildBspMap), null на других картах
let monitorActive = false;
let monitorIdx = 0;
let monitorScreenMat: B.StandardMaterial | null = null; // физический экран в кузове — текущая камера как превью
function syncMonitorScreen() { if (monitorScreenMat && cctvRigs.length) monitorScreenMat.emissiveTexture = cctvRigs[monitorIdx].rtt; }
function exitMonitor() {
  if (!monitorActive) return;
  monitorActive = false;
  scene.activeCamera = camera;
  hideMonitorHud();
}

// --- патрульный «террорист» (декоративный, для CCTV) ---
interface Patroller { rig: Humanoid; a: B.Vector3; b: B.Vector3; t: number; dir: number; }
let patroller: Patroller | null = null;
function updatePatroller(dt: number) {
  if (!patroller) return;
  const p = patroller;
  const dist = B.Vector3.Distance(p.a, p.b);
  const speed = 0.03; // юниты/кадр (~2 ед/с при 60fps)
  p.t += (speed / dist) * p.dir * (dt / (1000 / 60));
  if (p.t >= 1) { p.t = 1; p.dir = -1; }
  if (p.t <= 0) { p.t = 0; p.dir = 1; }
  const pos = B.Vector3.Lerp(p.a, p.b, p.t);
  p.rig.root.position.copyFrom(pos);
  p.rig.root.rotation.y = Math.atan2((p.dir > 0 ? p.b.x - p.a.x : p.a.x - p.b.x), (p.dir > 0 ? p.b.z - p.a.z : p.a.z - p.b.z));
  swingLimbs(p.rig, p.t * dist * 3.2); // фаза шага растёт с пройденным путём
}

// --- сетевая игра (этап 1: синхронизация позиций через авторитарный WS-сервер) ---
// N — подключиться/отключиться. Адрес сервера: ?server=wss://... (туннель/VPS для интернета),
// по умолчанию ws://<хост страницы>:8090/ws (локальный npm run server).
interface RemotePlayer { rig: Humanoid; tgt: B.Vector3; tgtYaw: number; phase: number; name: string; label: HTMLDivElement; alive: boolean; }
let hp = 100, alive = true;
let respawnAt = 0;
let net: WebSocket | null = null;
let netId = '';
let netLastSend = 0;
let netWantConnected = false; // хочет ли игрок быть онлайн (тумблер N) — отличаем от обрыва связи
let netReconnectAttempt = 0;
let netReconnectTimer: number | null = null;
const remotes = new Map<string, RemotePlayer>();
// кооп-режим заложников (host-authoritative): один клиент — хост, крутит ИИ ботов и вещает мир;
// гости выключают локальный ИИ и рендерят присланных ботов/заложников по снапшотам 't:pve'.
let pveHostId = '';       // id хоста PvE (от сервера)
let pveGuest = false;     // мы — гость (кто-то другой хост): не симулируем, а принимаем мир
let pveLastSend = 0;
function netToast(msg: string) { showMapName(msg); } // переиспользуем тост смены карты
function myName(): string {
  // персональное имя без экрана ввода: генерим один раз и держим в localStorage —
  // иначе все подключения выглядели бы одинаково как "player" в списке/над головой
  let n = localStorage.getItem('shooterName');
  if (!n) { n = 'Player' + Math.floor(1000 + Math.random() * 9000); localStorage.setItem('shooterName', n); }
  return n;
}
function addRemote(id: string, name: string, x = 0, y = 0, z = 0, yaw = 0) {
  if (remotes.has(id)) return;
  const rig = buildHumanoid('netplayer_' + id);
  rig.root.position.set(x, y, z);
  // помечаем меши тела метаданными — чтобы raycast стрельбы (fire()) находил, в кого попали
  for (const m of rig.root.getChildMeshes(false)) m.metadata = { netId: id };
  const label = document.createElement('div');
  label.textContent = name;
  Object.assign(label.style, {
    position: 'fixed', transform: 'translate(-50%,-100%)', color: '#fff', font: '700 13px system-ui',
    textShadow: '0 1px 2px #000', pointerEvents: 'none', zIndex: '3', whiteSpace: 'nowrap', display: 'none',
  } as any);
  document.body.appendChild(label);
  remotes.set(id, { rig, tgt: new B.Vector3(x, y, z), tgtYaw: yaw, phase: 0, name, label, alive: true });
}
function dropRemote(id: string) {
  const r = remotes.get(id);
  if (r) { r.rig.root.dispose(); r.label.remove(); remotes.delete(id); }
}
function setRemoteAlive(id: string, isAlive: boolean) {
  const r = remotes.get(id);
  if (r) { r.rig.root.setEnabled(isAlive); r.alive = isAlive; }
}
function netDisconnect() {
  if (net) { try { net.close(); } catch { /* ignore */ } }
  net = null; netId = '';
  remotes.forEach((r) => { r.rig.root.dispose(); r.label.remove(); });
  remotes.clear();
  scoreboard = [];
  if (scoreboardVisible) renderScoreboard();
  if (chatOpen) closeChat();
  pveHostId = ''; updatePveRole(); // офлайн → вернуть локальный PvE (если были гостем)
}
function netUrl() {
  // сервер один на всех (VPS), а не у каждого свой локальный — поэтому дефолт фиксированный,
  // а не "хост страницы": иначе у того, кто запускает игру локально (npm run dev), клиент
  // пытался бы достучаться до своего же localhost:8090 вместо настоящего сервера.
  // wss:// через Caddy (Let's Encrypt на 139-28-223-251.sslip.io, постоянный адрес — не через
  // Cloudflare quick tunnel: тот эфемерный и менял адрес при каждом рестарте туннеля, из-за чего
  // мультиплеер периодически "ломался" без видимой причины). sslip.io просто резолвит поддомен
  // в IP, зашитый в его имени — бесплатный способ получить домен для валидного TLS без покупки.
  const q = new URLSearchParams(location.search).get('server');
  return q || 'wss://139-28-223-251.sslip.io/ws';
}
function netOpen() {
  const url = netUrl();
  const sock = new WebSocket(url);
  net = sock;
  sock.onopen = () => { netReconnectAttempt = 0; sock.send(JSON.stringify({ t: 'join', name: myName() })); };
  sock.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'welcome') {
      netId = m.id;
      hp = 100; alive = true; hideDeathOverlay(); hud(); // сервер всегда создаёт нового игрока с полным hp
      for (const p of m.players) { addRemote(p.id, p.name, p.x, p.y, p.z, p.yaw); if (p.alive === false) setRemoteAlive(p.id, false); }
      pveHostId = m.host || ''; updatePveRole();
      netToast(`🌐 В игре (игроков: ${m.players.length + 1})`);
    } else if (m.t === 'host') {
      pveHostId = m.id || ''; updatePveRole();
    } else if (m.t === 'pve') {
      if (pveGuest) applyPveSnapshot(m);
    } else if (m.t === 'joined') {
      addRemote(m.id, m.name);
      netToast('🌐 Подключился: ' + m.name);
    } else if (m.t === 'left') {
      dropRemote(m.id);
    } else if (m.t === 'snap') {
      for (const row of m.p) {
        const [id, x, y, z, yaw] = row;
        if (id === netId) continue;
        const r = remotes.get(id);
        if (!r) { addRemote(id, '?', x, y, z, yaw); continue; }
        r.tgt.set(x, y, z); r.tgtYaw = yaw;
      }
    } else if (m.t === 'full') {
      netToast('🌐 Сервер заполнен');
    } else if (m.t === 'dmg') {
      if (m.id === netId) { hp = m.hp; hud(); dmgFlash(); }
    } else if (m.t === 'kill') {
      if (m.id === netId) { hp = 0; alive = false; hud(); showDeathOverlay(); }
      else setRemoteAlive(m.id, false);
      if (m.by === netId && m.id !== netId) { kills++; hud(); sndKill(); }
    } else if (m.t === 'respawn') {
      if (m.id === netId) {
        hp = 100; alive = true; hud(); hideDeathOverlay();
        camera.position.copyFrom(spawnPoint); velY = 0; onGround = true;
      } else setRemoteAlive(m.id, true);
    } else if (m.t === 'score') {
      scoreboard = m.list.map((row: [string, string, number, number]) => ({ id: row[0], name: row[1], kills: row[2], deaths: row[3] }));
      if (scoreboardVisible) renderScoreboard();
    } else if (m.t === 'chat') {
      addChatLine(m.name, m.text);
    } else if (m.t === 'botshoot') {
      // кооп-хост: гость выстрелил в бота — применяем урон авторитарно + будим соседних террористов
      if (pveHostId === netId && !pveGuest) {
        const bot = bots.find((b) => b.id === m.target);
        if (bot && bot.alive && bot.team === 'T' && Number.isFinite(m.dmg)) {
          damageBot(bot, Math.min(200, m.dmg), false);
          bot.lastSeen = performance.now(); bot.aimMs = DIFFS[diffIdx].react * 0.6;
        }
        const g = m.who ? remotes.get(m.who) : null; // стрельба гостя слышна террористам рядом с ним
        if (g) for (const t of bots) { if (t.team === 'T' && t.alive && B.Vector3.Distance(t.rig.root.position, g.rig.root.position) < 28) t.lastSeen = performance.now(); }
      }
    } else if (m.t === 'takehostage') {
      // кооп-хост: гость (m.who) хочет забрать заложника — берём ближайшего ждущего к нему
      if (pveHostId === netId && !pveGuest && m.who) {
        const g = remotes.get(m.who);
        if (g) for (const h of hostages) {
          if (h.state === 'wait' && B.Vector3.Distance(g.rig.root.position, h.rig.root.position) < 3.0) {
            h.state = 'follow'; h.leader = null; h.leaderGuestId = m.who; break;
          }
        }
      }
    }
  };
  // тоннель (Cloudflare quick tunnel) периодически рвёт соединение сам по себе (QUIC keepalive) —
  // без авто-реконнекта игрок молча оставался «один» до следующего ручного нажатия N.
  sock.onclose = () => {
    if (net !== sock) return;
    netDisconnect();
    if (netWantConnected) {
      netReconnectAttempt++;
      const delay = Math.min(10000, 1000 * netReconnectAttempt);
      netToast(`🌐 Обрыв связи, переподключение через ${Math.round(delay / 1000)} с...`);
      netReconnectTimer = window.setTimeout(() => { if (netWantConnected) netOpen(); }, delay);
    } else {
      netToast('🌐 Отключено');
    }
  };
  sock.onerror = () => { /* onclose придёт следом */ };
}
function netConnect() {
  if (netWantConnected) { // N — тумблер: выключить и больше не переподключаться
    netWantConnected = false;
    if (netReconnectTimer !== null) { clearTimeout(netReconnectTimer); netReconnectTimer = null; }
    netDisconnect();
    netToast('🌐 Отключено');
    return;
  }
  netWantConnected = true;
  netReconnectAttempt = 0;
  netToast('🌐 Подключение: ' + netUrl());
  netOpen();
}
function updateNet(dt: number) {
  if (!net || net.readyState !== WebSocket.OPEN) return;
  // отправка своего состояния ~15 Гц (позиция ног = камера минус рост глаз)
  const now = performance.now();
  if (now - netLastSend > 66 && netId) {
    netLastSend = now;
    net.send(JSON.stringify({ t: 'state', x: +camera.position.x.toFixed(2), y: +(camera.position.y - EYE).toFixed(2), z: +camera.position.z.toFixed(2), yaw: +camera.rotation.y.toFixed(3), c: held.has('ControlLeft') || held.has('ControlRight') }));
  }
  // интерполяция чужих игроков к последнему снапшоту (~20 Гц) + анимация шага по скорости
  const k = Math.min(1, dt / 50);
  const vp = camera.viewport.toGlobal(canvas.clientWidth, canvas.clientHeight);
  const fwd = camera.getDirection(B.Vector3.Forward());
  remotes.forEach((r) => {
    const root = r.rig.root;
    const before = root.position.clone();
    B.Vector3.LerpToRef(root.position, r.tgt, k, root.position);
    let dyaw = r.tgtYaw - root.rotation.y;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    root.rotation.y += dyaw * k;
    const speed = Math.hypot(root.position.x - before.x, root.position.z - before.z);
    if (speed > 0.002) { r.phase += speed * 3.5; swingLimbs(r.rig, r.phase); }
    else swingLimbs(r.rig, 0);
    // имя над головой — билборд-лейбл (DOM), спроецированный из мировых координат;
    // видно только при прямой видимости игрока (не сквозь стены), как и метки NPC
    const headPos = root.position.add(new B.Vector3(0, 2.05, 0));
    const toHead = headPos.subtract(camera.position);
    const inFront = B.Vector3.Dot(fwd, toHead) > 0;
    if (r.alive && inFront && canSee(camera.position, headPos)) {
      const p = B.Vector3.Project(headPos, B.Matrix.IdentityReadOnly, scene.getTransformMatrix(), vp);
      r.label.style.left = p.x + 'px'; r.label.style.top = p.y + 'px';
      r.label.style.display = 'block';
    } else {
      r.label.style.display = 'none';
    }
  });
}

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

// openSide: 'east'|'west' — боковая стена без коллизии (для захода с моста на крышу),
// openBack: задняя стена без коллизии. Стены остаются видимыми.
function building(cx: number, cz: number, w: number, d: number, h: number, m: B.Material, openSide: 'none' | 'east' | 'west' = 'none', openBack = false) {
  footprints.push({ cx, cz, w, d });
  const t = 0.5;       // толщина стены
  const door = 2.6;    // ширина проёма
  const seg = (w - door) / 2;
  // передняя стена (z = cz - d/2) — два сегмента вокруг двери
  box('w', cx - (door / 2 + seg / 2), h / 2, cz - d / 2, seg, h, t, m);
  box('w', cx + (door / 2 + seg / 2), h / 2, cz - d / 2, seg, h, t, m);
  const back = box('w', cx, h / 2, cz + d / 2, w, h, t, m);   // задняя
  const wWest = box('w', cx - w / 2, h / 2, cz, t, h, d, m);  // левая (west)
  const wEast = box('w', cx + w / 2, h / 2, cz, t, h, d, m);  // правая (east)
  if (openBack) back.checkCollisions = false;
  if (openSide === 'west') wWest.checkCollisions = false;
  if (openSide === 'east') wEast.checkCollisions = false;
  const roof = box('roof', cx, h + 0.12, cz, w + 0.3, 0.25, d + 0.3, roofMat); // крыша
  roof.checkCollisions = false;       // не потолок-препятствие
  roof.metadata = { floor: true };    // по крыше можно ходить (через мост)
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

// --- вертикальные лестницы-трубы (climb) ---
// зона перед лестницей: пока игрок в footprint'е и ниже topY — держим W = лезть вверх.
type ClimbZone = { minX: number; maxX: number; minZ: number; maxZ: number; topY: number; exitX: number; exitZ: number };
const climbZones: ClimbZone[] = [];
const ladderMetal = mat('ladderMetal', '#b23a2c', 0.3); // классический красный cs_assault
ladderMetal.emissiveColor = new B.Color3(0.18, 0.03, 0.02); // не темнеет в тени стены
// вертикальная лестница вплотную к любой стене. (wx,wz) — центр стены на уровне лестницы;
// (nx,nz) — единичная нормаль ОТ стены К игроку; topY — высота крыши, куда выходит лестница.
// Меши только визуальные — climb делает физика (climbZones).
function vLadder(wx: number, wz: number, nx: number, nz: number, topY: number) {
  const dx = -nz, dz = nx;                        // направление вдоль стены (перпендикуляр нормали)
  const halfW = 0.42, H = topY + 0.6;
  const rx = wx + nx * 0.12, rz = wz + nz * 0.12; // плоскость стоек (почти касается стены)
  const gx = wx + nx * 0.24, gz = wz + nz * 0.24; // плоскость перекладин (ближе к игроку)
  for (const s of [-halfW, halfW]) {              // две вертикальные стойки
    const rail = B.MeshBuilder.CreateCylinder('vlad_rail', { height: H, diameter: 0.11, tessellation: 8 }, scene);
    rail.position.set(rx + dx * s, H / 2, rz + dz * s);
    rail.material = ladderMetal; rail.checkCollisions = false; rail.isPickable = false;
  }
  const alongX = Math.abs(dx) > Math.abs(dz);     // ориентация перекладины вдоль стены
  for (let y = 0.45; y < topY + 0.3; y += 0.45) { // перекладины на одинаковом расстоянии
    const rung = B.MeshBuilder.CreateCylinder('vlad_rung', { height: halfW * 2 + 0.12, diameter: 0.07, tessellation: 8 }, scene);
    if (alongX) rung.rotation.z = Math.PI / 2; else rung.rotation.x = Math.PI / 2;
    rung.position.set(gx, y, gz);
    rung.material = ladderMetal; rung.checkCollisions = false; rung.isPickable = false;
  }
  // зона перед лестницей: вдоль стены ±0.8, от стены к игроку 0..1.3 по нормали
  const cxs = [wx - dx * 0.8, wx + dx * 0.8, wx - dx * 0.8 + nx * 1.3, wx + dx * 0.8 + nx * 1.3];
  const czs = [wz - dz * 0.8, wz + dz * 0.8, wz - dz * 0.8 + nz * 1.3, wz + dz * 0.8 + nz * 1.3];
  climbZones.push({
    minX: Math.min.apply(null, cxs), maxX: Math.max.apply(null, cxs),
    minZ: Math.min.apply(null, czs), maxZ: Math.max.apply(null, czs),
    topY, exitX: wx - nx * 0.9, exitZ: wz - nz * 0.9, // куда шагнуть на крышу (за стену)
  });
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
  c.metadata = { baseY };
  pickups.push(c);
}

// ===== карта 1: «Арена (город)» =====
function buildCityMap(): B.Vector3 {
  const ground = B.MeshBuilder.CreateGround('ground', { width: 220, height: 220 }, scene);
  ground.material = groundMat; ground.checkCollisions = true; ground.receiveShadows = true; reg(ground);
  // передние два здания — заход на крышу по мосту (стены твёрдые: ходишь поверху на 5.25 > стен 5.0)
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
  // единый уровень крыш: платформа, мосты и крыши в одной ровной плоскости (LV=5.25)
  const LV = 5.25;
  const platform = box('platform', 0, LV - 0.2, 0, 14, 0.4, 6, concreteMat);
  platform.checkCollisions = false; platform.metadata = { floor: true };
  // лестница к платформе: ступени-поверхности (ходим по верху каждой ступени)
  for (let i = 0; i < 10; i++) {
    const sh = (10 - i) * (LV / 10);
    const st = box('step', 0, sh / 2, -3 - i * 0.8, 5, sh, 0.8, concreteMat);
    st.checkCollisions = false; st.metadata = { floor: true };
  }
  // мосты — ПЛОСКИЕ слэбы на уровне LV от платформы к крышам передних зданий
  for (const sx of [-1, 1]) {
    const b = box('bridge', sx * 7.5, LV - 0.2, 0, 5, 0.4, 3.2, concreteMat);
    b.checkCollisions = false; b.metadata = { floor: true };
  }
  ([[28, 8], [28, 3], [24, 8], [-28, 8], [-24, 3], [0, 33], [12, -20], [-12, -20], [-16, -6, 5.25], [16, -6, 5.25]] as [number, number, number?][])
    .forEach(([x, z, y]) => spawnTarget(x, z, y || 0));
  // кубики — в открытых местах, подальше от стен (иначе не подобрать)
  ([[8, -8], [-8, -8], [28, 12], [-28, 12], [0, 12], [28, -8]] as [number, number][])
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
  ([[-8, 20], [11, 10], [0, 14], [-12, 24]] as [number, number][]).forEach(([x, z]) => spawnPickup(x, z));

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
const MM = 168, MMHALF = MM / 2, MM_SPAN = 100; // мир ±50 → весь размер карты (карты-конструкторы)
let mmCenterX = 0, mmCenterZ = 0, mmSpan = MM_SPAN; // для BSP-карты подменяются по её bounds
let mmBg: HTMLCanvasElement | null = null;          // запечённый силуэт BSP-геометрии (или null — рисуем сами)
const mmCanvas = document.createElement('canvas');
mmCanvas.width = MM; mmCanvas.height = MM;
Object.assign(mmCanvas.style, { position: 'fixed', top: '14px', right: '14px', borderRadius: '8px', border: '2px solid rgba(255,255,255,.35)', zIndex: '4', pointerEvents: 'none' } as any);
document.body.appendChild(mmCanvas);
const mmctx = mmCanvas.getContext('2d')!;
// мир (x вправо, z вперёд) → канвас (x вправо, z вверх), с учётом центра/масштаба текущей карты
function w2m(x: number, z: number): [number, number] { return [MMHALF + ((x - mmCenterX) / mmSpan) * MM, MMHALF - ((z - mmCenterZ) / mmSpan) * MM]; }
function drawMinimap() {
  mmctx.clearRect(0, 0, MM, MM);
  if (mmBg) {
    mmctx.drawImage(mmBg, 0, 0, MM, MM); // запечённый силуэт геометрии (BSP)
  } else {
    mmctx.fillStyle = 'rgba(10,14,18,.55)'; mmctx.fillRect(0, 0, MM, MM);
    // граница карты
    const a = w2m(-42, 42), b = w2m(42, -42);
    mmctx.strokeStyle = 'rgba(255,255,255,.5)'; mmctx.lineWidth = 1.5;
    mmctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    // здания
    mmctx.fillStyle = 'rgba(150,160,170,.55)';
    for (const f of footprints) { const tl = w2m(f.cx - f.w / 2, f.cz + f.d / 2); mmctx.fillRect(tl[0], tl[1], (f.w / mmSpan) * MM, (f.d / mmSpan) * MM); }
  }
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

// --- низкополигональный гуманоид (боты, заложники, удалённые игроки в сетевой игре) ---
interface Humanoid { root: B.TransformNode; shL: B.TransformNode; shR: B.TransformNode; hipL: B.TransformNode; hipR: B.TransformNode; flash: B.Mesh | null; collider: B.Mesh | null; }
type HumanKind = 'terror' | 'ct' | 'hostage';
interface HumanMats { torso: B.Material; head: B.Material; legs: B.Material; boot: B.Material; extra: B.Material | null; }
const humanMatsCache: Partial<Record<HumanKind, HumanMats>> = {};
function humanMats(kind: HumanKind): HumanMats {
  const cached = humanMatsCache[kind];
  if (cached) return cached;
  let m: HumanMats;
  if (kind === 'terror') {
    // камуфляжная куртка: случайные пятна трёх оттенков хаки поверх базы
    const dt = new B.DynamicTexture('trrCamo', { width: 64, height: 64 }, scene, true);
    const ctx = dt.getContext() as any;
    ctx.fillStyle = '#3a4030'; ctx.fillRect(0, 0, 64, 64);
    const spots = ['#2b3524', '#57604a', '#20241c', '#4a4436'];
    for (let i = 0; i < 42; i++) {
      ctx.fillStyle = spots[i % spots.length];
      ctx.beginPath();
      ctx.ellipse(Math.random() * 64, Math.random() * 64, 4 + Math.random() * 8, 3 + Math.random() * 5, Math.random() * 3, 0, 7);
      ctx.fill();
    }
    dt.update();
    const torso = new B.StandardMaterial('trrCamoMat', scene);
    torso.diffuseTexture = dt; torso.specularColor = new B.Color3(0.03, 0.03, 0.03);
    m = { torso, head: mat('trrMask', '#1c1c1a', 0.03), legs: mat('trrPants', '#2a2a26', 0.03), boot: mat('trrBoot', '#151513', 0.03), extra: mat('trrBand', '#8a2020', 0.05) };
  } else if (kind === 'ct') {
    // тёмно-синяя форма с светлыми ремнями разгрузки
    const dt = new B.DynamicTexture('ctUniform', { width: 64, height: 64 }, scene, true);
    const ctx = dt.getContext() as any;
    ctx.fillStyle = '#26324a'; ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = '#41526e'; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(16, 64); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(48, 0); ctx.lineTo(48, 64); ctx.stroke();
    ctx.fillStyle = '#8fa3c4'; ctx.fillRect(24, 26, 16, 12); // нагрудная нашивка
    dt.update();
    const torso = new B.StandardMaterial('ctUniformMat', scene);
    torso.diffuseTexture = dt; torso.specularColor = new B.Color3(0.03, 0.03, 0.03);
    m = { torso, head: mat('ctFace', '#c9a184', 0.03), legs: mat('ctPants', '#202838', 0.03), boot: mat('ctBoot', '#10141a', 0.03), extra: mat('ctHelm', '#39434f', 0.06) };
  } else {
    // заложник — гражданский: светлая рубашка, джинсы
    m = { torso: mat('hosShirt', '#cfc9b4', 0.03), head: mat('hosFace', '#c9a184', 0.03), legs: mat('hosJeans', '#3d4f6e', 0.03), boot: mat('hosShoe', '#4a3a28', 0.03), extra: null };
  }
  humanMatsCache[kind] = m;
  return m;
}
function buildHumanoid(name: string, kind: HumanKind = 'terror'): Humanoid {
  const m = humanMats(kind);
  const root = new B.TransformNode(name, scene);
  part(root, 'h_torso', 0.46, 0.62, 0.26, 0, 1.28, 0, m.torso);
  part(root, 'h_head', 0.28, 0.28, 0.28, 0, 1.72, 0, m.head);
  if (kind === 'terror' && m.extra) part(root, 'h_band', 0.30, 0.055, 0.30, 0, 1.81, 0, m.extra);   // красная повязка
  if (kind === 'ct' && m.extra) part(root, 'h_helm', 0.32, 0.14, 0.32, 0, 1.83, 0, m.extra);        // каска
  // плечевой/тазобедренный шарнир — отдельный узел, от него «свисает» конечность (свинг через rotation.x пивота)
  const shL = new B.TransformNode('h_shL', scene); shL.parent = root; shL.position.set(-0.32, 1.55, 0);
  const shR = new B.TransformNode('h_shR', scene); shR.parent = root; shR.position.set(0.32, 1.55, 0);
  const hipL = new B.TransformNode('h_hpL', scene); hipL.parent = root; hipL.position.set(-0.14, 0.95, 0);
  const hipR = new B.TransformNode('h_hpR', scene); hipR.parent = root; hipR.position.set(0.14, 0.95, 0);
  part(shL, 'h_armL', 0.15, 0.56, 0.15, 0, -0.28, 0, m.torso);
  part(shR, 'h_armR', 0.15, 0.56, 0.15, 0, -0.28, 0, m.torso);
  part(hipL, 'h_legL', 0.18, 0.5, 0.2, 0, -0.25, 0, m.legs);
  part(hipR, 'h_legR', 0.18, 0.5, 0.2, 0, -0.25, 0, m.legs);
  part(hipL, 'h_bootL', 0.19, 0.12, 0.24, 0, -0.56, 0.03, m.boot);
  part(hipR, 'h_bootR', 0.19, 0.12, 0.24, 0, -0.56, 0.03, m.boot);
  let flash: B.Mesh | null = null;
  if (kind !== 'hostage') { // автомат в правой руке (боты им стреляют — вспышка на срезе ствола)
    part(shR, 'h_gun', 0.07, 0.09, 0.55, 0.02, -0.5, 0.2, bluedMat);
    part(shR, 'h_gunMag', 0.05, 0.16, 0.09, 0.02, -0.58, 0.12, bluedMat, 0.15);
    flash = makeFlash(shR, new B.Vector3(0.02, -0.5, 0.52));
  }
  return { root, shL, shR, hipL, hipR, flash, collider: null };
}
// невидимый коллайдер-эллипсоид для актёра (движется через moveWithCollisions — тот же
// движковый механизм скольжения вдоль стен, что у камеры игрока; самодельный raycast-чек
// у сложной геометрии (грузовик) ловил стены сбоку и боты ползли/застревали).
function attachCollider(h: Humanoid): B.Mesh {
  const col = B.MeshBuilder.CreateBox('actorCol', { size: 0.6 }, scene);
  col.isVisible = false; col.isPickable = false; col.checkCollisions = true;
  col.ellipsoid = new B.Vector3(0.45, 0.9, 0.45);
  col.position.set(h.root.position.x, h.root.position.y + 0.9, h.root.position.z); // сразу в тело актёра
  h.collider = col;
  return col;
}
function disposeHumanoid(h: Humanoid) {
  if (h.collider) h.collider.dispose();
  h.root.dispose();
}
// покачивание конечностей при ходьбе (общее для NPC и сетевых игроков)
function swingLimbs(h: Humanoid, phase: number, amp = 0.5) {
  const swing = Math.sin(phase) * amp;
  h.hipL.rotation.x = swing; h.hipR.rotation.x = -swing;
  h.shL.rotation.x = -swing; h.shR.rotation.x = swing;
}

// ===== режим «Спасение заложников» (PvE, карта BSP) =====
// Заложники в комнате второго этажа ангара. Террористы охраняют и мешают выводу.
// E — забрать заложника (идёт следом). Довести до зоны эвакуации (фургон или ворота у моста).
// B — вызвать бойца-КТ (сам освобождает и ведёт), Shift+B — добавить террориста, H — сложность.
const DIFFS = [
  { name: 'Лёгкий', react: 950, acc: 0.35, dmg: 8, interval: 950, speed: 2.2, vision: 17 },
  { name: 'Средний', react: 550, acc: 0.55, dmg: 14, interval: 650, speed: 2.9, vision: 24 },
  { name: 'Тяжёлый', react: 280, acc: 0.75, dmg: 22, interval: 430, speed: 3.5, vision: 32 },
];
let diffIdx = 1;

// вэйпоинты BSP-карты (координаты сняты пробингом пола лучами): комната на антресоли (3.84) →
// пандус на восток → коридор (0.96) → ангар (0) → улица в обход зданий → фургон у спавна
const NAV_P = [
  new B.Vector3(-8, 3.84, 76),   // 0 комната заложников
  new B.Vector3(-3, 3.7, 75),    // 1 край антресоли перед пандусом
  new B.Vector3(2, 2.2, 75),     // 2 середина пандуса
  new B.Vector3(8, 0.96, 75),    // 3 коридор (запад пандуса)
  new B.Vector3(10, 0.96, 79),   // 4 конец коридора — ворота у моста (зона)
  new B.Vector3(8, 0.96, 54),    // 5 юг коридора
  new B.Vector3(0, 0, 61),       // 6 центр ангара
  new B.Vector3(8, 0, 49),       // 7 ворота ангара
  new B.Vector3(8, 0, 30),       // 8 улица (середина)
  new B.Vector3(5, 0, 14),       // 9 улица (поворот, в обход здания 15.36)
  new B.Vector3(6, 0, 4),        // 10 юг двора (в обход припаркованных машин x7..15, z8..12)
  new B.Vector3(16, 0, 6),       // 11 юго-восточный угол у грузовика
  new B.Vector3(18, 0, 9),       // 12 фургон, зад кузова (зона)
];
const NAV_E: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [3, 5], [5, 6], [5, 7], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12]];
const NAV_ADJ: number[][] = NAV_P.map(() => []);
for (const [a, b] of NAV_E) { NAV_ADJ[a].push(b); NAV_ADJ[b].push(a); }
function nearestNode(p: B.Vector3): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < NAV_P.length; i++) {
    const n = NAV_P[i];
    const d = Math.hypot(n.x - p.x, n.z - p.z) + Math.abs(n.y - p.y) * 3; // вес по высоте — не путать этажи
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function findPath(from: number, to: number): number[] {
  if (from === to) return [to];
  const prev = new Array(NAV_P.length).fill(-1);
  const q = [from]; prev[from] = from;
  while (q.length) {
    const v = q.shift()!;
    for (const w of NAV_ADJ[v]) if (prev[w] === -1) { prev[w] = v; if (w === to) { q.length = 0; break; } q.push(w); }
  }
  if (prev[to] === -1) return [];
  const path = [to];
  while (path[0] !== from) path.unshift(prev[path[0]]);
  path.shift(); // текущий узел не нужен
  return path;
}

const DOWN = new B.Vector3(0, -1, 0);
function actorFloorAt(x: number, z: number, fromY: number): number | null {
  const ray = new B.Ray(new B.Vector3(x, fromY, z), DOWN, 12);
  // ВАЖНО: исключаем невидимые коллайдеры актёров (actorCol) — они checkCollisions, и луч вниз
  // попадал бы в собственный коллайдер (верх ~y1.2), давая ложный «пол» и блокируя шаг.
  const h = scene.pickWithRay(ray, (m) => (m.checkCollisions || (m.metadata && m.metadata.floor)) && m.name !== 'actorCol' && targets.indexOf(m as B.Mesh) === -1);
  return h && h.hit && h.pickedPoint ? h.pickedPoint.y : null;
}
// шаг актёра к цели по XZ через движковый коллайдер (скольжение вдоль стен) + прилипание к полу
// (пандусы/ступени/этажи). rig.collider — невидимый эллипсоид с checkCollisions. true — дошёл.
const COL_CENTER = 0.9; // высота центра эллипсоида над ногами
function moveActor(rig: Humanoid, tgt: B.Vector3, speed: number, dt: number): boolean {
  const root = rig.root;
  const dx = tgt.x - root.position.x, dz = tgt.z - root.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.5) return true;
  root.rotation.y = Math.atan2(dx, dz);
  const col = rig.collider;
  if (!col) return false;
  const step = Math.min(dist, speed * dt / 1000);
  // ставим коллайдер в тело актёра и двигаем горизонтально — движок сам блокирует/скользит по стенам
  col.position.set(root.position.x, root.position.y + COL_CENTER, root.position.z);
  col.computeWorldMatrix(true);
  col.moveWithCollisions(new B.Vector3((dx / dist) * step, 0, (dz / dist) * step));
  const nx = col.position.x, nz = col.position.z;
  // прилипание к полу под новой позицией (пандус/ступень/этаж); нет пола или большой перепад — не идём туда
  const fy = actorFloorAt(nx, nz, root.position.y + 1.6);
  if (fy !== null && fy - root.position.y <= 1.05 && root.position.y - fy <= 1.6) {
    root.position.set(nx, fy, nz);
  }
  return false;
}
// линия видимости: чисто ли между двумя точками (стены = checkCollisions-меши)
function canSee(from: B.Vector3, to: B.Vector3): boolean {
  const dir = to.subtract(from);
  const dist = dir.length();
  if (dist < 0.5) return true;
  dir.normalize();
  const ray = new B.Ray(from, dir, dist - 0.4);
  const h = scene.pickWithRay(ray, (m) => m.checkCollisions && m.name !== 'actorCol' && targets.indexOf(m as B.Mesh) === -1);
  return !(h && h.hit);
}

type Team = 'T' | 'CT';
interface Bot {
  id: number; team: Team; rig: Humanoid; hp: number; alive: boolean;
  path: number[];               // оставшиеся вэйпоинты маршрута
  patrolA: B.Vector3 | null; patrolB: B.Vector3 | null; patrolT: number; patrolDir: number; // сторожевой маршрут (Т)
  task: 'guard' | 'toHostage' | 'toZone' | 'hunt' | 'idle';
  escortee: Hostage | null;     // КТ: кого ведёт
  zoneIdx: number;              // КТ: куда ведёт
  engageAt: number;             // (не используется) старый таймер реакции
  aimMs: number;                // накопленное время прицеливания в цель (реакция по сложности)
  lastSeen: number;             // когда в последний раз видел врага (для alertTerroristsByGunfire)
  cooldown: number;             // время следующего выстрела
  phase: number;                // фаза анимации ходьбы
  stuckMs: number; prevDist: number; // анти-стак: не приближается к вэйпоинту → пропустить его
  label: HTMLDivElement;
  net?: { x: number; y: number; z: number; yaw: number }; // цель интерполяции у гостя (host-authoritative)
}
interface Hostage {
  rig: Humanoid; state: 'wait' | 'follow' | 'saved';
  leader: 'player' | Bot | null;
  leaderGuestId?: string;         // кооп: ведёт удалённый игрок (гость) с этим netId — у хоста
  phase: number; label: HTMLDivElement;
  net?: { x: number; y: number; z: number; yaw: number }; // цель интерполяции у гостя
}
const bots: Bot[] = [];
const hostages: Hostage[] = [];
let lastRescueTick = performance.now();
interface RescueZone { pos: B.Vector3; node: number; label: HTMLDivElement; disc: B.Mesh; }
const rescueZones: RescueZone[] = [];
let botSeq = 1;
let hostagesTotal = 0, hostagesSaved = 0;
let rescueResetTimer: number | null = null;

const rescueEl = document.createElement('div');
rescueEl.className = 'hud';
Object.assign(rescueEl.style, { top: '62px', left: '16px', font: '600 15px system-ui', color: '#ffd9a0', display: 'none' } as any);
document.body.appendChild(rescueEl);
function rescueHud() {
  rescueEl.style.display = hostagesTotal > 0 ? 'block' : 'none';
  rescueEl.textContent = `🧍 Заложники: спасено ${hostagesSaved} / ${hostagesTotal}`;
}
const hostagePrompt = document.createElement('div');
hostagePrompt.textContent = 'E — забрать заложника';
hostagePrompt.style.cssText = 'position:fixed;left:50%;bottom:28%;transform:translateX(-50%);z-index:15;'
  + 'background:rgba(0,0,0,.55);color:#ffe9b0;font:600 18px system-ui;padding:8px 16px;border-radius:8px;'
  + 'pointer-events:none;white-space:nowrap;opacity:0;transition:opacity .15s;';
document.body.appendChild(hostagePrompt);

function makeActorLabel(text: string, color: string): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = text;
  Object.assign(el.style, {
    position: 'fixed', transform: 'translate(-50%,-100%)', color, font: '700 12px system-ui',
    textShadow: '0 1px 2px #000', pointerEvents: 'none', zIndex: '3', whiteSpace: 'nowrap', display: 'none',
  } as any);
  document.body.appendChild(el);
  return el;
}
function projectActorLabel(el: HTMLDivElement, headPos: B.Vector3, show: boolean, losCheck = true) {
  if (!show) { el.style.display = 'none'; return; }
  const fwd = camera.getDirection(B.Vector3.Forward());
  if (B.Vector3.Dot(fwd, headPos.subtract(camera.position)) <= 0) { el.style.display = 'none'; return; }
  // метку NPC видно, только если реально видишь его — нет стены на линии взгляда (не «сквозь текстуры»).
  // у зон эвакуации losCheck=false: их метка — навигационная подсказка, нужна и сквозь стены.
  if (losCheck && !canSee(camera.position, headPos)) { el.style.display = 'none'; return; }
  const vp = camera.viewport.toGlobal(canvas.clientWidth, canvas.clientHeight);
  const p = B.Vector3.Project(headPos, B.Matrix.IdentityReadOnly, scene.getTransformMatrix(), vp);
  el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  el.style.display = 'block';
}

function addBot(team: Team, pos: B.Vector3, patrol?: [B.Vector3, B.Vector3], explicitId?: number) {
  // explicitId — для ботов, создаваемых у гостя по id хоста (совпадение id между клиентами)
  const id = explicitId !== undefined ? explicitId : botSeq++;
  const rig = buildHumanoid('bot_' + team + '_' + id, team === 'T' ? 'terror' : 'ct');
  rig.root.position.copyFrom(pos);
  attachCollider(rig);
  for (const m of rig.root.getChildMeshes(false)) m.metadata = { botId: id };
  const bot: Bot = {
    id, team, rig, hp: 100, alive: true, path: [],
    patrolA: patrol ? patrol[0] : null, patrolB: patrol ? patrol[1] : null, patrolT: 0, patrolDir: 1,
    task: team === 'T' ? (patrol ? 'guard' : 'idle') : 'toHostage',
    escortee: null, zoneIdx: 0, engageAt: 0, aimMs: 0, lastSeen: 0, cooldown: 0, phase: 0, stuckMs: 0, prevDist: Infinity,
    label: makeActorLabel(team === 'T' ? 'Террорист' : 'Боец', team === 'T' ? '#ff7a6a' : '#7fd4ff'),
  };
  bots.push(bot);
  return bot;
}
function addHostage(pos: B.Vector3) {
  const rig = buildHumanoid('hostage_' + hostages.length, 'hostage');
  rig.root.position.copyFrom(pos);
  attachCollider(rig);
  const h: Hostage = { rig, state: 'wait', leader: null, phase: 0, label: makeActorLabel('Заложник', '#ffe9b0') };
  hostages.push(h);
  hostagesTotal++;
  return h;
}
function damagePlayer(dmg: number) {
  if (!alive) return;
  hp = Math.max(0, hp - dmg);
  dmgFlash(); hud();
  if (hp <= 0) {
    alive = false; showDeathOverlay();
    // локальный PvE-респавн (сервер тут ни при чём — боты живут только на клиенте)
    window.setTimeout(() => {
      hp = 100; alive = true; hud(); hideDeathOverlay();
      camera.position.copyFrom(spawnPoint); velY = 0; onGround = true;
    }, 3000);
  }
}
function damageBot(bot: Bot, dmg: number, byPlayer: boolean) {
  if (!bot.alive) return;
  bot.hp -= dmg;
  if (bot.hp <= 0) {
    bot.alive = false;
    bot.rig.root.rotation.x = -Math.PI / 2; // «упал»
    bot.rig.root.position.y += 0.25;
    bot.label.style.display = 'none';
    if (byPlayer) { kills++; hud(); sndKill(); }
    // ведомый заложник останавливается и снова ждёт
    hostages.forEach((h) => { if (h.leader === bot) { h.leader = null; h.state = 'wait'; } });
    const dead = bot;
    setTimeout(() => {
      const i = bots.indexOf(dead);
      if (i >= 0) bots.splice(i, 1);
      disposeHumanoid(dead.rig); dead.label.remove();
    }, 6000);
  }
}
function tracer(from: B.Vector3, to: B.Vector3) {
  const len = B.Vector3.Distance(from, to);
  if (len < 0.5) return;
  const line = B.MeshBuilder.CreateBox('tracer', { width: 0.03, height: 0.03, depth: len }, scene);
  line.material = flashMat; line.isPickable = false; line.checkCollisions = false;
  line.position = B.Vector3.Center(from, to);
  line.lookAt(to);
  setTimeout(() => line.dispose(), 55);
}
function botShoot(bot: Bot, targetPos: B.Vector3, victim: BotVictim) {
  const d = DIFFS[diffIdx];
  bot.cooldown = performance.now() + d.interval * (0.8 + Math.random() * 0.4);
  if (bot.rig.flash) {
    bot.rig.flash.setEnabled(true);
    const f = bot.rig.flash;
    setTimeout(() => { if (!f.isDisposed()) f.setEnabled(false); }, 50);
  }
  const muzzle = bot.rig.root.position.add(new B.Vector3(0, 1.35, 0));
  const dist = B.Vector3.Distance(muzzle, targetPos);
  // трассер летит с промахом-разбросом вокруг цели — чем хуже точность, тем шире
  const spread = (1 - d.acc) * 1.6;
  const aim = targetPos.add(new B.Vector3((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread));
  tracer(muzzle, aim);
  const vol = Math.max(0.02, 0.16 - dist * 0.003);
  noiseBurst(0.07, vol, 1700);
  const hitChance = d.acc * Math.max(0.25, 1 - dist / d.vision);
  if (Math.random() < hitChance) {
    if (victim === 'player') damagePlayer(d.dmg);
    else if ('guest' in victim) { // кооп: урон гостю применяет сервер (авторитарно по hp)
      if (net && net.readyState === WebSocket.OPEN) net.send(JSON.stringify({ t: 'botdmg', target: victim.guest, dmg: d.dmg }));
    } else damageBot(victim, d.dmg, false);
  }
}
// видимый враг для бота: у Т это игрок (свой + гости) и КТ-боты, у КТ — только Т-боты.
type BotVictim = 'player' | Bot | { guest: string };
function findEnemy(bot: Bot): { pos: B.Vector3; victim: BotVictim } | null {
  const d = DIFFS[diffIdx];
  const eye = bot.rig.root.position.add(new B.Vector3(0, 1.6, 0));
  const fwd = new B.Vector3(Math.sin(bot.rig.root.rotation.y), 0, Math.cos(bot.rig.root.rotation.y));
  const engaged = performance.now() - bot.lastSeen < 1500; // уже в бою — крутится к цели без FOV
  function visible(p: B.Vector3): boolean {
    const to = p.subtract(eye);
    const dist = to.length();
    if (dist > d.vision) return false;
    // конус обзора нужен только вдали и вне боя; вблизи (<7) охранник замечает любого рядом,
    // иначе игрок беспрепятственно проходил у него за спиной к заложникам
    if (!engaged && dist > 7) {
      const flat = new B.Vector3(to.x, 0, to.z).normalize();
      if (B.Vector3.Dot(fwd, flat) < 0.17) return false; // ~160° спереди
    }
    return canSee(eye, p);
  }
  if (bot.team === 'T') {
    if (alive && visible(camera.position)) return { pos: camera.position.clone(), victim: 'player' };
    // кооп: террорист хоста видит и гостей (удалённых игроков) — цель для стрельбы
    for (const [rid, r] of remotes) {
      if (!r.alive) continue;
      const p = r.rig.root.position.add(new B.Vector3(0, 1.35, 0));
      if (visible(p)) return { pos: p, victim: { guest: rid } };
    }
  }
  for (const other of bots) {
    if (other.team === bot.team || !other.alive) continue;
    const p = other.rig.root.position.add(new B.Vector3(0, 1.3, 0));
    if (visible(p)) return { pos: p, victim: other };
  }
  return null;
}
function setBotRoute(bot: Bot, targetNode: number) {
  bot.path = findPath(nearestNode(bot.rig.root.position), targetNode);
}
// выстрел игрока: террористы в радиусе слышимости «настораживаются» — помечаем lastSeen, чтобы
// findEnemy в этот момент игнорировал конус обзора (engaged) и бот развернулся на игрока
function alertTerroristsByGunfire() {
  const now = performance.now();
  for (const bot of bots) {
    if (bot.team !== 'T' || !bot.alive) continue;
    if (B.Vector3.Distance(bot.rig.root.position, camera.position) < 28) bot.lastSeen = now;
  }
}
function walkPath(bot: Bot, dt: number): boolean { // true — маршрут пройден
  const d = DIFFS[diffIdx];
  while (bot.path.length) {
    const tgt = NAV_P[bot.path[0]];
    if (moveActor(bot.rig, tgt, d.speed, dt)) { bot.path.shift(); bot.stuckMs = 0; bot.prevDist = Infinity; continue; }
    // анти-стак: если к текущему вэйпоинту не приближаемся ~1.5с (уступ/угол/огрех графа) — пропускаем его
    const dist = Math.hypot(tgt.x - bot.rig.root.position.x, tgt.z - bot.rig.root.position.z);
    if (dist < bot.prevDist - 0.03) { bot.stuckMs = 0; } else { bot.stuckMs += dt; }
    bot.prevDist = dist;
    if (bot.stuckMs > 1500) { bot.path.shift(); bot.stuckMs = 0; bot.prevDist = Infinity; continue; }
    bot.phase += d.speed * dt / 1000 * 3.2;
    swingLimbs(bot.rig, bot.phase);
    return false;
  }
  swingLimbs(bot.rig, 0);
  return true;
}
function updateBots(dt: number) {
  dt = Math.min(dt, 50); // клампим дельту: после фриза/фоновой вкладки большой шаг протуннелил бы бота сквозь стену
  const now = performance.now();
  const d = DIFFS[diffIdx];
  for (const bot of bots) {
    if (!bot.alive) continue;
    const root = bot.rig.root;
    // --- бой: видим врага → стоим, целимся (аккумулятор реакции), стреляем ---
    const enemy = findEnemy(bot);
    if (enemy) {
      bot.lastSeen = now;
      bot.aimMs += dt;                    // держим цель на прицеле — растёт время прицеливания
      root.rotation.y = Math.atan2(enemy.pos.x - root.position.x, enemy.pos.z - root.position.z);
      swingLimbs(bot.rig, 0);
      if (bot.aimMs >= d.react && now >= bot.cooldown) botShoot(bot, enemy.pos, enemy.victim);
      continue;
    }
    bot.aimMs = Math.max(0, bot.aimMs - dt * 1.5); // потерял из виду — прицел «остывает»
    // --- задачи ---
    if (bot.team === 'T') {
      // идёт охота: заложника ведут — все Т сходятся к нему
      const escorted = hostages.find((h) => h.state === 'follow');
      if (escorted) {
        if (bot.task !== 'hunt' || bot.path.length === 0) {
          bot.task = 'hunt';
          setBotRoute(bot, nearestNode(escorted.rig.root.position));
        }
        if (walkPath(bot, dt)) { // дошёл до узла — добежать напрямую
          if (!moveActor(bot.rig, escorted.rig.root.position, d.speed, dt)) { bot.phase += d.speed * dt / 1000 * 3.2; swingLimbs(bot.rig, bot.phase); }
          else swingLimbs(bot.rig, 0);
        }
      } else if (bot.task === 'hunt') {
        bot.task = bot.patrolA ? 'guard' : 'idle'; bot.path = [];
      } else if (bot.task === 'guard' && bot.patrolA && bot.patrolB) {
        // сторожевой маршрут туда-сюда (как старый декоративный патрульный)
        const tgt = bot.patrolDir > 0 ? bot.patrolB : bot.patrolA;
        if (moveActor(bot.rig, tgt, d.speed * 0.6, dt)) bot.patrolDir *= -1;
        bot.phase += d.speed * 0.6 * dt / 1000 * 3.2;
        swingLimbs(bot.rig, bot.phase);
      }
    } else {
      // КТ: освободить заложника и вести в зону; нет ждущих — патруль у комнаты
      if (bot.task === 'toHostage') {
        const target = hostages.find((h) => h.state === 'wait');
        if (!target) { bot.task = 'idle'; bot.path = []; continue; }
        if (walkPath(bot, dt)) {
          if (moveActor(bot.rig, target.rig.root.position, d.speed, dt)) {
            target.leader = bot; target.state = 'follow';
            bot.escortee = target;
            bot.zoneIdx = hostagesSaved % rescueZones.length; // чередуем: мост / фургон
            bot.task = 'toZone';
            setBotRoute(bot, rescueZones[bot.zoneIdx].node);
            netToast('🛡 Боец ведёт заложника');
          } else { bot.phase += d.speed * dt / 1000 * 3.2; swingLimbs(bot.rig, bot.phase); }
        }
      } else if (bot.task === 'toZone') {
        if (walkPath(bot, dt)) {
          // у зоны: ждём пока ведомый дойдёт (спасение засчитает updateHostages)
          if (!bot.escortee || bot.escortee.state !== 'follow') { bot.task = 'toHostage'; bot.escortee = null; setBotRoute(bot, 0); }
        }
      } else if (bot.task === 'idle') {
        if (hostages.some((h) => h.state === 'wait')) { bot.task = 'toHostage'; setBotRoute(bot, 0); }
      }
    }
  }
}
function updateHostages(dt: number) {
  dt = Math.min(dt, 50);
  let nearWaiting = false;
  for (const h of hostages) {
    if (h.state === 'saved') continue;
    const root = h.rig.root;
    if (h.state === 'wait') {
      swingLimbs(h.rig, 0);
      if (alive && B.Vector3.Distance(camera.position, root.position) < 2.4) nearWaiting = true;
    } else if (h.state === 'follow') {
      // за кем идём: свой игрок / КТ-бот / удалённый игрок-гость (кооп)
      const guest = h.leaderGuestId ? remotes.get(h.leaderGuestId) : null;
      if (h.leaderGuestId && !guest) { h.leaderGuestId = undefined; h.state = 'wait'; continue; } // гость ушёл — заложник ждёт
      const leadPos = guest ? guest.rig.root.position : h.leader === 'player' ? camera.position : h.leader ? h.leader.rig.root.position : root.position;
      const dist = Math.hypot(leadPos.x - root.position.x, leadPos.z - root.position.z);
      if (dist > 1.7) {
        if (!moveActor(h.rig, leadPos, 3.4, dt)) { h.phase += 3.4 * dt / 1000 * 3.2; swingLimbs(h.rig, h.phase); }
      } else swingLimbs(h.rig, 0);
      if ((h.leader === 'player' || guest) && dist > 26) { h.leader = null; h.leaderGuestId = undefined; h.state = 'wait'; netToast('🧍 Заложник отстал и ждёт'); }
      // дошёл до зоны эвакуации?
      for (const z of rescueZones) {
        if (B.Vector3.Distance(root.position, z.pos) < 2.6) {
          h.state = 'saved';
          hostagesSaved++;
          rescueHud();
          netToast(`✅ Заложник спасён (${hostagesSaved}/${hostagesTotal})`);
          disposeHumanoid(h.rig); h.label.remove();
          if (hostagesSaved >= hostagesTotal && rescueResetTimer === null) {
            netToast('🎉 Все заложники спасены! Новая смена через 15 с…');
            rescueResetTimer = window.setTimeout(() => { rescueResetTimer = null; resetRescueRound(); }, 15000);
          }
          break;
        }
      }
    }
  }
  hostagePrompt.style.opacity = nearWaiting ? '1' : '0';
  projectRescueLabels();
}
// проекция подписей над головами (общая для хоста/офлайна и гостя)
function projectRescueLabels() {
  for (const bot of bots) projectActorLabel(bot.label, bot.rig.root.position.add(new B.Vector3(0, 2.05, 0)), bot.alive);
  for (const h of hostages) if (h.state !== 'saved') projectActorLabel(h.label, h.rig.root.position.add(new B.Vector3(0, 2.05, 0)), true);
  for (const z of rescueZones) projectActorLabel(z.label, z.pos.add(new B.Vector3(0, 1.6, 0)), true, false);
}

// ===== кооп: синхронизация мира заложников (host-authoritative) =====
// Хост шлёт компактный снапшот; гость применяет: создаёт/удаляет/интерполирует ботов и заложников.
const HOST_HZ = 15;
function sendPveSnapshot() {
  if (!net || net.readyState !== WebSocket.OPEN) return;
  const b = bots.map((x) => [x.id, x.team === 'T' ? 0 : 1, +x.rig.root.position.x.toFixed(2), +x.rig.root.position.y.toFixed(2), +x.rig.root.position.z.toFixed(2), +x.rig.root.rotation.y.toFixed(2), Math.max(0, x.hp | 0), x.alive ? 1 : 0]);
  const h = hostages.map((x, i) => [i, +x.rig.root.position.x.toFixed(2), +x.rig.root.position.y.toFixed(2), +x.rig.root.position.z.toFixed(2), +x.rig.root.rotation.y.toFixed(2), x.state === 'wait' ? 0 : x.state === 'follow' ? 1 : 2]);
  net.send(JSON.stringify({ t: 'pve', b, h, saved: hostagesSaved, total: hostagesTotal }));
}
function applyPveSnapshot(m: any) {
  // --- боты ---
  const seen = new Set<number>();
  for (const row of m.b) {
    const [id, tc, x, y, z, yaw, bhp, al] = row;
    seen.add(id);
    let bot = bots.find((b) => b.id === id);
    if (!bot) bot = addBot(tc === 0 ? 'T' : 'CT', new B.Vector3(x, y, z), undefined, id);
    bot.hp = bhp;
    bot.net = { x, y, z, yaw };
    if (al && !bot.alive) { bot.alive = true; bot.rig.root.setEnabled(true); bot.rig.root.rotation.x = 0; }
    if (!al && bot.alive) { bot.alive = false; bot.rig.root.rotation.x = -Math.PI / 2; bot.rig.root.position.y += 0.25; bot.label.style.display = 'none'; }
  }
  for (const b of bots.slice()) if (!seen.has(b.id)) { disposeHumanoid(b.rig); b.label.remove(); bots.splice(bots.indexOf(b), 1); }
  // --- заложники --- (индекс = порядковый; создаём недостающих)
  for (const row of m.h) {
    const [i, x, y, z, yaw, st] = row;
    let hos = hostages[i];
    if (!hos && st !== 2) hos = addHostage(new B.Vector3(x, y, z));
    if (!hos) continue;
    hos.net = { x, y, z, yaw };
    const newState = st === 0 ? 'wait' : st === 1 ? 'follow' : 'saved';
    if (newState === 'saved' && hos.state !== 'saved') { disposeHumanoid(hos.rig); hos.label.style.display = 'none'; }
    hos.state = newState;
  }
  hostagesSaved = m.saved; hostagesTotal = m.total; rescueHud();
}
// гость: интерполяция присланных сущностей к целям + анимация шага (без ИИ)
function interpolatePve(dt: number) {
  const k = Math.min(1, dt / 60);
  for (const b of bots) {
    if (!b.alive || !b.net) continue;
    const root = b.rig.root;
    const before = root.position.clone();
    B.Vector3.LerpToRef(root.position, new B.Vector3(b.net.x, b.net.y, b.net.z), k, root.position);
    let dy = b.net.yaw - root.rotation.y; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
    root.rotation.y += dy * k;
    const sp = Math.hypot(root.position.x - before.x, root.position.z - before.z);
    if (sp > 0.003) { b.phase += sp * 3.5; swingLimbs(b.rig, b.phase); } else swingLimbs(b.rig, 0);
  }
  let nearWaiting = false;
  for (const h of hostages) {
    if (h.state === 'saved' || !h.net) continue;
    const root = h.rig.root;
    const before = root.position.clone();
    B.Vector3.LerpToRef(root.position, new B.Vector3(h.net.x, h.net.y, h.net.z), k, root.position);
    let dy = h.net.yaw - root.rotation.y; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
    root.rotation.y += dy * k;
    const sp = Math.hypot(root.position.x - before.x, root.position.z - before.z);
    if (sp > 0.003) { h.phase += sp * 3.5; swingLimbs(h.rig, h.phase); } else swingLimbs(h.rig, 0);
    if (h.state === 'wait' && alive && B.Vector3.Distance(camera.position, root.position) < 2.4) nearWaiting = true; // подсказка E у гостя
  }
  hostagePrompt.style.opacity = nearWaiting ? '1' : '0';
  projectRescueLabels();
}
// смена роли host↔guest при изменении хоста/подключения
function updatePveRole() {
  const wasGuest = pveGuest;
  pveGuest = !!net && net.readyState === WebSocket.OPEN && !!pveHostId && pveHostId !== netId && curMap === 0;
  if (pveGuest && !wasGuest) { disposeRescue(); if (curMap === 0) setupRescueZones(); netToast('🤝 Кооп: мир ведёт хост'); } // гость — сносим локальный ИИ, но зоны свои
  else if (!pveGuest && wasGuest) { disposeRescue(); if (curMap === 0) setupRescue(); }          // стал хостом/офлайн — свой ИИ
}
function playerTakeHostage(): boolean {
  if (!alive) return false;
  for (const h of hostages) {
    if (h.state === 'wait' && B.Vector3.Distance(camera.position, h.rig.root.position) < 2.4) {
      h.state = 'follow'; h.leader = 'player';
      netToast('🧍 Заложник идёт за вами — ведите к зоне эвакуации');
      return true;
    }
  }
  return false;
}
function disposeRescue() {
  for (const b of bots) { disposeHumanoid(b.rig); b.label.remove(); }
  bots.length = 0;
  for (const h of hostages) { if (h.state !== 'saved') disposeHumanoid(h.rig); h.label.remove(); }
  hostages.length = 0;
  for (const z of rescueZones) { z.label.remove(); if (!z.disc.isDisposed()) z.disc.dispose(); }
  rescueZones.length = 0;
  hostagesTotal = 0; hostagesSaved = 0;
  if (rescueResetTimer !== null) { clearTimeout(rescueResetTimer); rescueResetTimer = null; }
  rescueHud();
  hostagePrompt.style.opacity = '0';
}
function resetRescueRound() {
  disposeRescue();
  setupRescue();
  netToast('🔄 Новая смена заложников');
}
// зоны эвакуации статичны и одинаковы на всех клиентах — создаём и у хоста, и у гостя
function setupRescueZones() {
  const zoneMat = new B.StandardMaterial('zoneMat', scene);
  zoneMat.emissiveColor = new B.Color3(0.15, 0.75, 0.3);
  zoneMat.diffuseColor = new B.Color3(0, 0, 0);
  zoneMat.alpha = 0.45;
  zoneMat.disableLighting = true;
  const mkZone = (pos: B.Vector3, node: number, name: string) => {
    const disc = B.MeshBuilder.CreateDisc('zone_' + name, { radius: 2.6, tessellation: 28 }, scene);
    disc.material = zoneMat; disc.rotation.x = Math.PI / 2;
    disc.position.set(pos.x, pos.y + 0.08, pos.z);
    disc.isPickable = false; disc.checkCollisions = false;
    reg(disc);
    rescueZones.push({ pos, node, label: makeActorLabel('⛑ ' + name, '#7dffa0'), disc });
  };
  mkZone(new B.Vector3(10, 0.96, 79), 4, 'Эвакуация: мост');
  mkZone(new B.Vector3(18, 0, 9), 12, 'Эвакуация: фургон');
}
function setupRescue() {
  // заложники в комнате второго этажа
  addHostage(new B.Vector3(-9.5, 3.84, 78));
  addHostage(new B.Vector3(-6.5, 3.84, 74));
  // охрана: один на антресоли у комнаты, один в коридоре (маршрут старого патрульного)
  addBot('T', new B.Vector3(-10, 3.84, 72), [new B.Vector3(-11, 3.84, 72), new B.Vector3(-4, 3.84, 79)]);
  addBot('T', new B.Vector3(8, 0.96, 60), [new B.Vector3(8, 0.96, 56), new B.Vector3(8, 0.96, 79)]);
  setupRescueZones();
  rescueHud();
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
  hpEl.textContent = '❤ ' + hp;
}
hud();

// --- ХП/смерть/респавн (PvP, этап 2 сетевой игры — валидирует сервер) ---
let respawnTimer: number | null = null;
function dmgFlash() {
  dmgFlashEl.style.opacity = '1';
  setTimeout(() => { dmgFlashEl.style.opacity = '0'; }, 250);
}
function showDeathOverlay() {
  deathOverlayEl.style.display = 'flex';
  let left = 3;
  respawnTextEl.textContent = `Возрождение через ${left}…`;
  if (respawnTimer !== null) clearInterval(respawnTimer);
  respawnTimer = window.setInterval(() => {
    left--;
    respawnTextEl.textContent = left > 0 ? `Возрождение через ${left}…` : 'Возрождение…';
    if (left <= 0 && respawnTimer !== null) { clearInterval(respawnTimer); respawnTimer = null; }
  }, 1000);
}
function hideDeathOverlay() {
  deathOverlayEl.style.display = 'none';
  if (respawnTimer !== null) { clearInterval(respawnTimer); respawnTimer = null; }
}

// --- таблица результатов (Tab) — счёт kills/deaths с сервера (этап 3 сетевой игры) ---
interface ScoreRow { id: string; name: string; kills: number; deaths: number; }
let scoreboard: ScoreRow[] = [];
let scoreboardVisible = false;
function escapeHtml(s: string): string {
  // имена игроков приходят от сервера, но их текст задаёт клиент (join.name) — экранируем
  // перед interpolation в innerHTML, иначе имя вида "<img onerror=...>" исполнилось бы как HTML
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}
function renderScoreboard() {
  const rows = [...scoreboard].sort((a, b) => b.kills - a.kills);
  scoreboardEl.innerHTML = '<h2>Таблица результатов</h2>' + rows.map((r) => (
    `<div class="row${r.id === netId ? ' me' : ''}"><span class="nm">${escapeHtml(r.name)}</span><span>${r.kills}</span><span>${r.deaths}</span></div>`
  )).join('') || '<p>Нет игроков</p>';
}
function toggleScoreboard(show: boolean) {
  scoreboardVisible = show;
  scoreboardEl.style.display = show ? 'block' : 'none';
  if (show) renderScoreboard();
}

// --- чат (Enter — открыть/отправить, Esc — отмена) ---
let chatOpen = false;
let chatBuffer = '';
function addChatLine(name: string, text: string) {
  const line = document.createElement('div');
  line.className = 'chatLine';
  const nm = document.createElement('span');
  nm.className = 'nm'; nm.textContent = name + ': ';
  line.appendChild(nm);
  line.appendChild(document.createTextNode(text));
  chatLogEl.appendChild(line);
  while (chatLogEl.children.length > 6) chatLogEl.removeChild(chatLogEl.firstChild!);
  setTimeout(() => { line.style.opacity = '0'; setTimeout(() => line.remove(), 500); }, 6000);
}
function renderChatInput() {
  chatInputEl.textContent = '💬 ' + chatBuffer + '▌';
  chatInputEl.style.display = chatOpen ? 'block' : 'none';
}
function openChat() { chatOpen = true; chatBuffer = ''; renderChatInput(); }
function closeChat() { chatOpen = false; chatBuffer = ''; renderChatInput(); }
function sendChat() {
  const text = chatBuffer.trim();
  if (text && net && net.readyState === WebSocket.OPEN && netId) {
    net.send(JSON.stringify({ t: 'chat', text: text.slice(0, 140) }));
  }
  closeChat();
}

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
  if (!actx) {
    actx = new (window.AudioContext || (window as any).webkitAudioContext)();
    // тихий keep-alive генератор держит аудио-конвейер «прогретым» —
    // иначе у первого выстрела (и после паузы) большая задержка звука
    const ka = actx.createOscillator(), kg = actx.createGain();
    kg.gain.value = 0.0001; ka.connect(kg).connect(actx.destination); ka.start();
  }
  if (actx.state === 'suspended') actx.resume();
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
  if (!alive || chatOpen) return; // мёртв или печатает в чат — ждём
  if (reloading || cur.ammo <= 0) return;
  const now = performance.now();
  if (now - lastShot < cur.interval) return;
  lastShot = now;
  cur.ammo--; hud();
  recoil = cur.recoil;
  sndShoot(cur.name === 'SMG');
  alertTerroristsByGunfire(); // выстрел слышно — ближние террористы разворачиваются на игрока
  // вспышка
  cur.flash.scaling.setAll(0.7 + Math.random() * 0.7);
  cur.flash.setEnabled(true);
  const fl = cur.flash;
  setTimeout(() => fl.setEnabled(false), 45);
  if (cur.ammo === 0) reload();
  // хитскан
  const ray = camera.getForwardRay(240);
  const hit = scene.pickWithRay(ray, (m) => targets.indexOf(m as B.Mesh) !== -1 || !!(m.metadata && (m.metadata.netId || m.metadata.botId !== undefined)));
  if (hit && hit.pickedMesh && hit.pickedPoint) {
    const pickedMesh = hit.pickedMesh as B.Mesh;
    if (pickedMesh.metadata && pickedMesh.metadata.botId !== undefined) {
      // --- бот PvE: у своих (КТ) дружественный огонь выключен ---
      const bot = bots.find((b) => b.id === pickedMesh.metadata.botId);
      if (bot && bot.alive) {
        if (bot.team === 'CT') return; // не бьём союзников
        const headshot = hit.pickedPoint.y > bot.rig.root.position.y + 1.5;
        const dmg = headshot ? cur.dmgHead : cur.dmgBody;
        hitMarker(headshot);
        dmgPopup(hit.pickedPoint, dmg, headshot);
        sndHit();
        if (pveGuest) {
          // кооп-гость: урон по боту считает ХОСТ (у него авторитарный бот) — шлём заявку
          if (net && net.readyState === WebSocket.OPEN) net.send(JSON.stringify({ t: 'botshoot', target: bot.id, dmg, head: headshot }));
        } else {
          damageBot(bot, dmg, true);
          // получив пулю, охранник сразу «в бою» — развернётся на игрока в updateBots
          bot.lastSeen = performance.now(); bot.aimMs = DIFFS[diffIdx].react * 0.6; // получил пулю — уже почти прицелился, ответит быстрее
        }
      }
      return;
    }
    if (pickedMesh.metadata && pickedMesh.metadata.netId) {
      // --- живой игрок: урон/смерть/респавн авторитарно считает сервер, здесь только фидбек ---
      const rid = pickedMesh.metadata.netId as string;
      const r = remotes.get(rid);
      const rootY = r ? r.rig.root.position.y : 0;
      const headshot = hit.pickedPoint.y > rootY + 1.5;
      const dmg = headshot ? cur.dmgHead : cur.dmgBody;
      hitMarker(headshot);
      dmgPopup(hit.pickedPoint, dmg, headshot);
      sndHit();
      if (net && net.readyState === WebSocket.OPEN && netId) {
        net.send(JSON.stringify({ t: 'shoot', target: rid, weapon: cur.name, head: headshot }));
      }
      return;
    }
    const t = pickedMesh;
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
  if (!locked() || chatOpen) return;
  camera.rotation.y += e.movementX * 0.0022;
  camera.rotation.x = Math.max(-1.45, Math.min(1.45, camera.rotation.x + e.movementY * 0.0022));
});
let mouseDown = false;
document.addEventListener('mousedown', (e) => { if (locked() && e.button === 0 && !monitorActive) { mouseDown = true; fire(); } });
document.addEventListener('mouseup', () => { mouseDown = false; });

// движение по физическим кодам клавиш (event.code) — любая раскладка (WASD == ЦФЫВ).
// Стрелки ←/→ — поворот камеры, Ctrl — присед (вертикаль/движение в render-loop).
let jumpQueued = false;
const held = new Set<string>();
const gameKeys = new Set(['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ControlLeft', 'ControlRight', 'Tab']);
window.addEventListener('keydown', (e) => {
  if (chatOpen) {
    // пока открыт ввод чата — клавиши идут в текст, а не в игру (движение/стрельба/оружие)
    e.preventDefault();
    if (e.code === 'Enter') sendChat();
    else if (e.code === 'Escape') closeChat();
    else if (e.code === 'Backspace') { chatBuffer = chatBuffer.slice(0, -1); renderChatInput(); }
    else if (e.key.length === 1 && chatBuffer.length < 140) { chatBuffer += e.key; renderChatInput(); }
    return;
  }
  if (e.code === 'Enter' && netWantConnected) { openChat(); return; } // Enter — открыть чат (только в сети)
  if (gameKeys.has(e.code)) e.preventDefault(); // не скроллить страницу / не триггерить шорткаты
  held.add(e.code);
  if (e.code === 'Space') jumpQueued = true;
  if (e.code === 'Digit1') switchWeapon(0);
  if (e.code === 'Digit2') switchWeapon(1);
  if (e.code === 'KeyR') reload();
  if (e.code === 'KeyM') loadMap(curMap + 1);
  if (e.code === 'KeyP') showPos();   // отладка: показать координаты на экране
  if (e.code === 'KeyN') netConnect(); // сетевая игра: подключиться/отключиться
  if (e.code === 'Tab' && !scoreboardVisible) toggleScoreboard(true); // Tab (зажать) — таблица результатов
  if (e.code === 'KeyE') {
    if (monitorActive) {
      // в мониторе E листает камеры по кругу
      if (cctvRigs.length) { monitorIdx = (monitorIdx + 1) % cctvRigs.length; scene.activeCamera = cctvRigs[monitorIdx].cam; showMonitorHud(); syncMonitorScreen(); }
    } else if (monitorTriggerPos && cctvRigs.length && B.Vector3.Distance(camera.position, monitorTriggerPos) < 3.2) {
      monitorActive = true; monitorIdx = 0; scene.activeCamera = cctvRigs[0].cam;
      showMonitorPrompt(false); showMonitorHud(); syncMonitorScreen();
    } else if (pveGuest) {
      // кооп-гость: заявку на подбор заложника решает хост
      if (net && net.readyState === WebSocket.OPEN) net.send(JSON.stringify({ t: 'takehostage' }));
    } else playerTakeHostage(); // рядом с ждущим заложником — берём с собой
  }
  if (e.code === 'KeyB' && hostagesTotal > 0) {
    // подкрепление: B — боец-КТ (у фургона), Shift+B — террорист (в ангаре)
    if (e.shiftKey) {
      if (bots.filter((b) => b.team === 'T').length >= 5) netToast('Террористов уже максимум (5)');
      else { addBot('T', new B.Vector3(0, 0, 61)); netToast('☠ Террорист прибыл в ангар'); }
    } else {
      if (bots.filter((b) => b.team === 'CT').length >= 4) netToast('Бойцов уже максимум (4)');
      else { const b2 = addBot('CT', new B.Vector3(18, 0, 9)); b2.task = 'toHostage'; setBotRoute(b2, 0); netToast('🛡 Боец-КТ выдвинулся от фургона'); }
    }
  }
  if (e.code === 'KeyH' && hostagesTotal > 0) {
    diffIdx = (diffIdx + 1) % DIFFS.length;
    netToast('⚙ Сложность ботов: ' + DIFFS[diffIdx].name);
  }
  if (e.code === 'Escape') exitMonitor(); // Esc и так снимает pointer lock — логично им же выйти из монитора
});

// --- HUD монитора видеонаблюдения ---
const monitorPrompt = document.createElement('div');
monitorPrompt.textContent = 'E — монитор видеонаблюдения';
monitorPrompt.style.cssText = 'position:fixed;left:50%;bottom:22%;transform:translateX(-50%);z-index:15;'
  + 'background:rgba(0,0,0,.55);color:#fff;font:600 18px system-ui;padding:8px 16px;border-radius:8px;'
  + 'pointer-events:none;white-space:nowrap;opacity:0;transition:opacity .15s;';
document.body.appendChild(monitorPrompt);
function showMonitorPrompt(show: boolean) { monitorPrompt.style.opacity = show ? '1' : '0'; }

const monitorHud = document.createElement('div');
monitorHud.style.cssText = 'position:fixed;left:50%;bottom:6%;transform:translateX(-50%);z-index:15;'
  + 'background:rgba(0,0,0,.6);color:#7fd4ff;font:700 16px system-ui;padding:8px 18px;border-radius:8px;'
  + 'pointer-events:none;white-space:nowrap;display:none;';
document.body.appendChild(monitorHud);
function showMonitorHud() {
  monitorHud.textContent = `📹 Камера ${monitorIdx + 1}/${cctvRigs.length}   ·   E — след. камера   ·   Esc — выход`;
  monitorHud.style.display = 'block';
}
function hideMonitorHud() { monitorHud.style.display = 'none'; }

// отладочный вывод позиции: тост на экране + копирование в буфер (для расстановки лестниц и т.п.)
function showPos() {
  const p = camera.position, r = camera.rotation;
  const txt = `x:${p.x.toFixed(1)}  y:${p.y.toFixed(1)}  z:${p.z.toFixed(1)}   (yaw ${(r.y).toFixed(2)})`;
  try { navigator.clipboard?.writeText(txt); } catch { /* ignore */ }
  let el = document.getElementById('posToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'posToast';
    el.style.cssText = 'position:fixed;left:50%;top:38%;transform:translateX(-50%);z-index:9999;'
      + 'background:rgba(0,0,0,.8);color:#7fff9f;font:700 22px/1.4 monospace;padding:14px 22px;'
      + 'border-radius:10px;pointer-events:none;white-space:nowrap;';
    document.body.appendChild(el);
  }
  el.textContent = txt;
  el.style.opacity = '1';
  clearTimeout((el as any)._t);
  (el as any)._t = setTimeout(() => { el!.style.opacity = '0'; el!.style.transition = 'opacity .5s'; }, 4000);
}
window.addEventListener('keyup', (e) => { held.delete(e.code); if (e.code === 'Tab') toggleScoreboard(false); });
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
let velY = 0, onGround = true;
const GRAV = -0.013, JUMP = 0.23, EYE = 1.7, MOVE = 0.06; // MOVE — ускорение ходьбы (≈8 ед/с)
const spawnPoint = new B.Vector3(0, EYE, -26);             // точка спавна текущей карты
let bobPhase = 0, gunDip = 0, lastX = camera.position.x, lastZ = camera.position.z;
scene.onBeforeRenderObservable.add(() => {
  // монитор видеонаблюдения: показать подсказку рядом с грузовиком; пока смотрим камеры —
  // вся остальная игровая логика (физика/стрельба/движение) на паузе
  if (monitorTriggerPos) showMonitorPrompt(!monitorActive && B.Vector3.Distance(camera.position, monitorTriggerPos) < 3.2);
  updatePatroller(engine.getDeltaTime()); // ходит и пока открыт монитор — иначе замер бы в кадре камеры
  updateNet(engine.getDeltaTime());       // сеть тоже живёт при открытом мониторе (чужие игроки в кадре камер)
  // боты и заложники живут всегда (видны в CCTV); дельту считаем своими часами —
  // engine.getDeltaTime() равен 0 при ручном scene.render() вне родного цикла (фон/тесты)
  const rescueNow = performance.now();
  const rescueDt = Math.min(rescueNow - lastRescueTick, 50);
  lastRescueTick = rescueNow;
  if (pveGuest) {
    interpolatePve(rescueDt);              // гость: только рендер присланного мира, без ИИ
  } else {
    updateBots(rescueDt);                  // хост/офлайн: локальный ИИ
    updateHostages(rescueDt);
    if (net && net.readyState === WebSocket.OPEN && pveHostId === netId && remotes.size > 0 && rescueNow - pveLastSend > 1000 / HOST_HZ) {
      pveLastSend = rescueNow; sendPveSnapshot(); // хост вещает мир, если есть гости
    }
  }
  if (monitorActive) return;
  if (!alive) return; // мёртв — камера/физика на паузе до респавна (сервер пришлёт 'respawn')
  if (chatOpen) return; // печатает в чат — камера/движение на паузе, чтобы не улетел, пока набирает текст

  const crouching = held.has('ControlLeft') || held.has('ControlRight');
  const eyeNow = crouching ? 1.05 : EYE; // присед опускает камеру
  const downRay = new B.Ray(camera.position, new B.Vector3(0, -1, 0), 60);
  const g = scene.pickWithRay(downRay, (m) => (m.checkCollisions || (m.metadata && m.metadata.floor)) && m.name !== 'actorCol' && targets.indexOf(m as B.Mesh) === -1);
  const floorY = (g && g.hit && g.pickedPoint) ? g.pickedPoint.y : -1e9;

  // --- вертикальные лестницы: подъём в зоне лестницы (W = вверх, S = вниз) ---
  let onLadder = false;
  for (const L of climbZones) {
    if (camera.position.x > L.minX && camera.position.x < L.maxX &&
        camera.position.z > L.minZ && camera.position.z < L.maxZ &&
        camera.position.y - eyeNow < L.topY + 0.3) {
      onLadder = true; velY = 0; onGround = false;
      const up = ((held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0)) + touchMove.y;
      const feet = camera.position.y - eyeNow;
      if (up > 0.05) {
        if (feet >= L.topY - 0.12) {                 // у вершины — выход на крышу за стену
          camera.position.set(L.exitX, L.topY + eyeNow, L.exitZ);
          onLadder = false;                          // дальше обычная физика удержит на уступе
        } else {
          camera.position.y = Math.min(camera.position.y + 0.10, L.topY + eyeNow);
        }
      } else if (up < -0.05) {                        // спуск, но не ниже пола
        camera.position.y = Math.max(camera.position.y - 0.10, floorY + eyeNow);
        if (feet <= floorY + 0.05) onLadder = false;  // сошёл на землю
      }
      break;
    }
  }

  if (onLadder) {
    jumpQueued = false;
  } else if (onGround) {
    // приклеены к полу на текущей высоте глаз (мгновенный присед, ступени/спуски до 1 м)
    if (camera.position.y - eyeNow <= floorY + 1.0) {
      camera.position.y = floorY + eyeNow;
      velY = 0;
      if (jumpQueued) { velY = crouching ? 0.28 : JUMP; onGround = false; } // присед-прыжок выше
    } else {
      onGround = false; // пол ушёл вниз — падаем
    }
  } else {
    velY += GRAV;
    camera.position.y += velY;
    if (camera.position.y - eyeNow <= floorY) { camera.position.y = floorY + eyeNow; velY = 0; onGround = true; }
  }
  jumpQueued = false;
  // упал с карты — вернуть на спавн текущей карты
  if (camera.position.y < -8) { camera.position.copyFrom(spawnPoint); velY = 0; onGround = true; }

  // автоогонь (SMG): удержание ЛКМ
  if (mouseDown && cur.auto) fire();

  // движение: WASD/ЦФЫВ (по event.code) + джойстик (телефон). Стрелки ←/→ — поворот камеры.
  let inX = touchMove.x, inZ = touchMove.y;
  if (locked()) {
    inZ += (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0);
    inX += (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
    if (held.has('ArrowLeft')) camera.rotation.y -= 0.035;
    if (held.has('ArrowRight')) camera.rotation.y += 0.035;
  }
  if (onLadder) inZ = 0; // на лестнице W/S = вверх/вниз (см. climb выше), а не ход вперёд
  const inMag = Math.hypot(inX, inZ);
  if (inMag > 0.001) {
    if (inMag > 1) { inX /= inMag; inZ /= inMag; } // по диагонали не быстрее
    const spd = MOVE * (crouching ? 0.5 : 1); // в приседе медленнее
    const fwd = camera.getDirection(B.Vector3.Forward()); fwd.y = 0; fwd.normalize();
    const right = camera.getDirection(B.Vector3.Right()); right.y = 0; right.normalize();
    camera.cameraDirection.addInPlace(fwd.scale(inZ * spd));
    camera.cameraDirection.addInPlace(right.scale(inX * spd));
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

  // кубики: вращение, парение, подбор при касании (по горизонтали — высота не мешает)
  const tms = performance.now();
  for (let i = pickups.length - 1; i >= 0; i--) {
    const c = pickups[i];
    c.rotation.y += 0.04; c.rotation.x += 0.02;
    c.position.y = (c.metadata ? c.metadata.baseY : 0) + 0.8 + Math.sin(tms / 400 + i) * 0.12;
    if (Math.hypot(camera.position.x - c.position.x, camera.position.z - c.position.z) < 1.8) {
      c.dispose(); pickups.splice(i, 1); collected++; objHud();
    }
  }

  drawMinimap();
});

// ===== карта из настоящего BSP (Counter-Strike cs_assault) =====
// сюда buildBspMap кладёт запечённую миникарту+bounds, чтобы loadMap применил их к mmBg/mmCenter/mmSpan
let lastBspMinimap: { img: HTMLCanvasElement; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } } | null = null;
let lastBspYaw = 0; // угол взгляда на спавне (из entity "angle"), т.к. mapDefs.build() возвращает только позицию
async function buildBspMap(): Promise<B.Vector3> {
  climbZones.length = 0; // сбросить зоны лестниц предыдущей карты
  const baseUrl = ((import.meta as any).env && (import.meta as any).env.BASE_URL) || './';
  const r = await loadBsp(scene, baseUrl + 'cs_assault.bsp', baseUrl + 'cs_assault.wad', 0.03);
  r.meshes.forEach(reg); // в текущую карту (sink) для выгрузки при смене
  lastBspMinimap = { img: r.minimap, bounds: r.bounds };
  lastBspYaw = r.spawnYaw;

  // --- колёса грузовика: в мире BSP нет геометрии шин (только текстуры trk_tire/trk_rim
  // без реальных граней), поэтому грузовик визуально «висит в воздухе» — добавляем колёса
  const wheelMat = mat('wheel', '#1c1c1c', 0.1);
  const rimMat = mat('rim', '#9a9a9e', 0.3);
  function wheel(x: number, z: number) {
    const rad = 0.55;
    // грузовик стоит вдоль X → ось колеса поперёк (вдоль Z): rotation.x (не .z — иначе колесо «лежит» боком)
    const tire = B.MeshBuilder.CreateCylinder('wheel', { diameter: rad * 2, height: 0.35 }, scene);
    tire.rotation.x = Math.PI / 2; tire.position.set(x, rad, z); tire.material = wheelMat; tire.isPickable = false;
    reg(tire);
    const rim = B.MeshBuilder.CreateCylinder('rim', { diameter: rad * 1.1, height: 0.37 }, scene);
    rim.rotation.x = Math.PI / 2; rim.position.set(x, rad, z); rim.material = rimMat; rim.isPickable = false;
    reg(rim);
  }
  wheel(9.2, 8.3); wheel(9.2, 11.4); wheel(14.8, 8.3); wheel(14.8, 11.4);

  // невидимые коллизии грузовика (сам он из декоративных trk_* граней без коллизии — в стыках
  // застревал коллайдер). Простые выпуклые коробки: кабина целиком; у кузова стенки/перед/крыша,
  // ЗАД ОТКРЫТ — в кузов можно зайти сзади (пол кузова y1.0 — ровно наш шаг), как в оригинале.
  function solidBox(name: string, cx: number, cy: number, cz: number, w: number, h: number, d: number) {
    const bx = B.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
    bx.position.set(cx, cy, cz); bx.isVisible = false; bx.checkCollisions = true;
    reg(bx);
  }
  solidBox('trk_col_cab', 7.55, 0.95, 9.85, 1.9, 1.9, 4.3);   // кабина+капот
  solidBox('trk_col_front', 8.55, 1.7, 9.85, 0.3, 3.4, 4.3);  // передняя стенка кузова
  solidBox('trk_col_left', 11.95, 1.7, 7.85, 7.1, 3.4, 0.3);  // левый борт
  solidBox('trk_col_right', 11.95, 1.7, 11.85, 7.1, 3.4, 0.3); // правый борт
  solidBox('trk_col_roof', 11.95, 3.3, 9.85, 7.1, 0.2, 4.3);  // крыша (на ней можно стоять)

  // невидимый барьер у мусорных контейнеров (запад): за тротуаром (x<-57.6) в оригинале стояла
  // невидимая clip-кисть, которую мы выбрасываем вместе со SKIP_TEX-текстурой — без неё там
  // открытый обрыв без пола, и игрок проваливался под карту, пятясь назад от контейнеров.
  solidBox('void_barrier_west', -57.6, 8, 30, 0.6, 26, 130);

  // --- видеонаблюдение: 3 статичные камеры → RenderTargetTexture → экраны в кузове ---
  function cctvCamera(name: string, px: number, py: number, pz: number, tx: number, ty: number, tz: number) {
    const cam = new B.UniversalCamera(name, new B.Vector3(px, py, pz), scene);
    cam.setTarget(new B.Vector3(tx, ty, tz));
    cam.minZ = 0.1; cam.maxZ = 150; cam.fov = 1.0;
    const rtt = new B.RenderTargetTexture(name + '_rtt', 256, scene, false);
    rtt.activeCamera = cam;
    rtt.renderList = scene.meshes; // тот же мир, что и в основном виде
    scene.customRenderTargets.push(rtt);
    cctvRigs.push({ cam, rtt });
    return rtt;
  }
  const rttGate = cctvCamera('cctvGate', 8, 5, 51, 8, 3, 90);          // вход со стороны моста (гаражные ворота)
  const rttUpper = cctvCamera('cctvUpper', -14, 9, 78, -21, 5, 63);     // комната второго этажа (пол 3.8, вид на дверной проём)
  const rttExit = cctvCamera('cctvExit', 11.5, 12, 80, 11.5, 9.6, 88); // выход из ангара: дорожка+ступенька+дверной проём у моста

  // Один монитор внутри кузова (в фургоне), на левом борту — единственное найденное место
  // с чистой линией обзора: передняя стенка изнутри заставлена декоративным реквизитом
  // соседней лаборатории (lab1_comp*/recharged), который перекрывает вид с любой высоты и
  // почти любой позиции в кузове, а сам тент подходит вплотную к полу у стенки. Борт свободнее.
  // Показывает ТЕКУЩУЮ выбранную камеру (monitorIdx) — переключение и полноэкранный режим по
  // E делает уже существующий монитор-режим (см. keydown/exitMonitor).
  box('monitorStand', 11, 1.15, 8.05, 0.5, 0.7, 0.15, mat('monitorStandMat', '#33352f', 0.08)).checkCollisions = false;
  const monitorScreen = B.MeshBuilder.CreatePlane('cctvScreen', { width: 0.7, height: 0.5 }, scene);
  monitorScreen.position.set(11, 1.5, 8.02); // нормаль +Z по умолчанию — вглубь кузова, к левому борту
  monitorScreenMat = new B.StandardMaterial('cctvScreenMat', scene);
  monitorScreenMat.diffuseColor = new B.Color3(0, 0, 0); monitorScreenMat.specularColor = new B.Color3(0, 0, 0);
  monitorScreenMat.backFaceCulling = false;
  monitorScreen.material = monitorScreenMat; monitorScreen.checkCollisions = false; monitorScreen.isPickable = false;
  reg(monitorScreen);
  syncMonitorScreen(); // сразу показать камеру 1/3, не дожидаясь первого переключения

  // спутниковая антенна на крыше кузова (декоративная — обоснование для камер)
  const antMat = mat('antenna', '#c9cbce', 0.3);
  const mast = B.MeshBuilder.CreateCylinder('antMast', { diameter: 0.08, height: 1.1 }, scene);
  mast.position.set(9.4, 3.95, 8.2); mast.material = antMat; mast.isPickable = false; reg(mast);
  const dish = B.MeshBuilder.CreateCylinder('antDish', { diameterTop: 0.05, diameterBottom: 0.7, height: 0.28, tessellation: 16 }, scene);
  dish.position.set(9.4, 4.55, 8.2); dish.rotation.x = -0.9; dish.material = antMat; dish.isPickable = false; reg(dish);

  // --- красные вертикальные лестницы (climb) на крыши ---
  vLadder(20.6, 13.4, 0, -1, 15.4); // на крышу здания c_bldg4 (уступ c_sidewlk1)
  vLadder(-21.1, 47.5, 1, 0, 11.3); // на верх коричневого ящика c3a1_crate (запад)
  vLadder(21.1, 51.7, 1, 0, 12.5);  // на галв-крышу out_galv1 (восток)

  // --- предупреждающая разметка на тупиковых стенах (жёлто-чёрные полосы) ---
  const hazardDt = new B.DynamicTexture('hazardTex', { width: 128, height: 128 }, scene, true);
  { const ctx = hazardDt.getContext() as any;
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#e8b93c';
    for (let i = -128; i < 256; i += 32) { ctx.save(); ctx.translate(i, 0); ctx.rotate(Math.PI / 4);
      ctx.fillRect(-8, -64, 16, 320); ctx.restore(); }
    hazardDt.update(); }
  const hazardMat = new B.StandardMaterial('hazard', scene);
  hazardMat.diffuseTexture = hazardDt; hazardMat.emissiveColor = new B.Color3(0.35, 0.28, 0.1);
  hazardMat.specularColor = new B.Color3(0.05, 0.05, 0.05); hazardMat.backFaceCulling = false;
  // px/py/pz — точка на стене, nx/nz — нормаль (наружу, к игроку); панель ставится вплотную
  // перед стеной вдоль нормали, развёрнута к игроку — видна издалека, коллизии не имеет.
  function deadEndMark(px: number, py: number, pz: number, nx: number, nz: number, width = 3.4, height = 2.6) {
    const p = B.MeshBuilder.CreatePlane('deadend', { width, height }, scene);
    // отступ 0.1 — заметный запас, иначе неровности/группировка граней стены могут
    // оказаться чуть впереди панели и перекрыть её (полигон стены не идеально плоский)
    p.position.set(px + nx * 0.1, py, pz + nz * 0.1);
    p.rotation.y = Math.atan2(nx, nz);
    p.material = hazardMat; p.checkCollisions = false; p.isPickable = false;
    reg(p);
  }
  deadEndMark(-49.24, 1.9, -32.64, 0, 1); // тупик у карьера (запад)
  deadEndMark(0.12, 1.9, -5.76, 0, 1);    // тупик у офисной стены
  deadEndMark(24.96, 1.9, 7.03, -1, 0);   // тупик у спавна/грузовика

  // точка входа в монитор видеонаблюдения — внутри кузова, у экрана на левом борту
  // (заходить через открытый зад кузова, х>15.5, коллизии там нет — см. trk_col_* выше)
  monitorTriggerPos = new B.Vector3(12, 1.5, 9);

  // --- режим «Спасение заложников»: заложники на втором этаже, охрана-террористы,
  // зоны эвакуации у моста и у фургона (декоративного патрульного заменили живые боты) ---
  setupRescue();

  // --- большие гаражные ворота на въезде с моста (в BSP это просто открытый проём без
  // отдельного объекта-двери — обрамляем его рамой с гофрированной текстурой роллет-ворот) ---
  const gateDt = new B.DynamicTexture('gateTex', { width: 128, height: 256 }, scene, true);
  { const ctx = gateDt.getContext() as any;
    ctx.fillStyle = '#5a6068'; ctx.fillRect(0, 0, 128, 256);           // серо-голубой металл
    for (let y = 0; y < 256; y += 18) {                                // горизонтальные ламели рольставни
      ctx.fillStyle = '#454b52'; ctx.fillRect(0, y, 128, 3);
      ctx.fillStyle = '#7a828c'; ctx.fillRect(0, y + 3, 128, 2);
    }
    ctx.fillStyle = '#e8b93c'; ctx.fillRect(0, 226, 128, 10);           // предупреждающая полоса снизу
    ctx.fillStyle = '#1a1a1a';
    for (let x = 0; x < 128; x += 20) { ctx.save(); ctx.translate(x, 226); ctx.rotate(Math.PI / 4); ctx.fillRect(-6, -6, 8, 22); ctx.restore(); }
    ctx.strokeStyle = '#2c3036'; ctx.lineWidth = 6; ctx.strokeRect(3, 3, 122, 250); // рама
    gateDt.update(); }
  const gateMat = new B.StandardMaterial('gateMat', scene);
  gateMat.diffuseTexture = gateDt; gateMat.specularColor = new B.Color3(0.08, 0.08, 0.08);
  const gatePillarMat = mat('gatePillar', '#3a3e44', 0.1);
  box('gate_header', 8, 8.9, 50, 17, 0.9, 0.5, gatePillarMat);          // верхняя балка проёма
  box('gate_pillarL', 0.2, 4.25, 50, 0.6, 8.5, 0.6, gatePillarMat);     // левый столб
  box('gate_pillarR', 15.8, 4.25, 50, 0.6, 8.5, 0.6, gatePillarMat);    // правый столб
  // сами роллет-ворота подняты (открыты) — скрученным рулоном под балкой, проезд свободен;
  // гофра/полоса видны на самой ткани рулона и на коротких боковых направляющих у столбов
  const gateRoll = B.MeshBuilder.CreateCylinder('gate_roll', { diameter: 0.9, height: 15.6, tessellation: 12 }, scene);
  gateRoll.rotation.z = Math.PI / 2; gateRoll.position.set(8, 8.3, 50.15);
  gateRoll.material = gateMat; gateRoll.checkCollisions = false; gateRoll.isPickable = false;
  reg(gateRoll);
  const railL = box('gate_railL', 1.0, 4.4, 50.3, 0.35, 8.2, 0.1, gateMat); railL.checkCollisions = false; railL.isPickable = false;
  const railR = box('gate_railR', 15.0, 4.4, 50.3, 0.35, 8.2, 0.1, gateMat); railR.checkCollisions = false; railR.isPickable = false;

  return new B.Vector3(r.spawn.x, r.spawn.y + EYE, r.spawn.z); // камера = точка спавна + рост глаз
}

// ===== система карт =====
const mapDefs: { name: string; build: () => B.Vector3 | Promise<B.Vector3> }[] = [
  { name: 'cs_assault (BSP)', build: buildBspMap },
  { name: 'Арена (город)', build: buildCityMap },
  { name: 'cs_assault (клон)', build: buildAssaultMap },
];
let curMap = 0;
let levelMeshes: B.AbstractMesh[] = [];
let mapLoading = false;
// камеры наблюдения (RenderTargetTexture) — не обычные меши, reg()/levelMeshes их не подхватывает,
// поэтому чистим отдельно при смене карты (иначе на второй загрузке BSP-карты будут дублироваться).
let cctvRigs: { cam: B.UniversalCamera; rtt: B.RenderTargetTexture }[] = [];
function disposeCctv() {
  for (const r of cctvRigs) {
    scene.customRenderTargets.splice(scene.customRenderTargets.indexOf(r.rtt), 1);
    r.rtt.dispose();
    r.cam.dispose();
  }
  cctvRigs = [];
}

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

async function loadMap(i: number) {
  if (mapLoading) return;            // не запускать загрузку поверх загрузки
  mapLoading = true;
  // выгрузка прошлой карты
  for (const m of levelMeshes) if (!m.isDisposed()) m.dispose();
  for (const d of doors) d.hinge.dispose(true);
  for (const t of targets) t.dispose();
  for (const p of pickups) p.dispose();
  exitMonitor(); // на случай смены карты прямо во время просмотра камер — не оставлять activeCamera на удаляемой cctv-камере
  disposeCctv();
  monitorTriggerPos = null; showMonitorPrompt(false); monitorScreenMat = null;
  patroller?.rig.root.dispose(); patroller = null;
  disposeRescue();
  levelMeshes = []; doors.length = 0; footprints.length = 0; targets.length = 0; pickups.length = 0;
  mapGen++; // отменяем отложенные респавны прошлой карты
  // сборка новой
  curMap = ((i % mapDefs.length) + mapDefs.length) % mapDefs.length;
  showMapName('Загрузка: ' + mapDefs[curMap].name + '…');
  const meshes: B.AbstractMesh[] = [];
  sink = meshes;
  let spawn: B.Vector3;
  try { spawn = await mapDefs[curMap].build(); }
  finally { sink = null; mapLoading = false; }
  levelMeshes = meshes;
  // миникарта: у BSP — запечённый силуэт с его bounds, у остальных — обычный конструктор с фиксированным span
  if (curMap === 0 && lastBspMinimap) {
    mmBg = lastBspMinimap.img;
    const b = lastBspMinimap.bounds;
    mmCenterX = (b.minX + b.maxX) / 2; mmCenterZ = (b.minZ + b.maxZ) / 2;
    mmSpan = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 1.04; // те же 1.04, что и при запекании
  } else {
    mmBg = null; mmCenterX = 0; mmCenterZ = 0; mmSpan = MM_SPAN;
  }
  // сброс состояния игры
  kills = 0; collected = 0; pickupTotal = pickups.length; reloading = false;
  hud(); objHud();
  // спавн + корректный мировой bbox (Babylon обновляет его лениво — иначе стрельба/опора мажут)
  spawnPoint.copyFrom(spawn);
  camera.position.copyFrom(spawn);
  camera.rotation.set(0, curMap === 0 ? lastBspYaw : 0, 0); // BSP: смотрим туда, куда указывает info_player_start
  velY = 0; onGround = false;
  scene.meshes.forEach((m) => { m.refreshBoundingInfo(false, false); m.computeWorldMatrix(true); });
  showMapName(mapDefs[curMap].name);
}

loadMap(0);

engine.runRenderLoop(() => scene.render());
window.addEventListener('resize', () => engine.resize());

// отладка
(window as any).GAME = { engine, scene, camera, targets, pickups, weapons, fire, switchWeapon, getCur: () => cur, held, footprints, w2m, drawMinimap, MM, MMHALF, MM_SPAN, loadMap, mapDefs, getMap: () => curMap, getMmCenterX: () => mmCenterX, getMmCenterZ: () => mmCenterZ, getMmSpan: () => mmSpan, getBspBounds: () => lastBspMinimap && lastBspMinimap.bounds, mmCanvas, netState: () => ({ connected: !!net, ready: net ? net.readyState : -1, id: netId, remotes: [...remotes.keys()], tgts: [...remotes.values()].map((r) => [r.tgt.x, r.tgt.y, r.tgt.z]) }), rescueState: () => ({ diff: DIFFS[diffIdx].name, saved: hostagesSaved, total: hostagesTotal, hostages: hostages.map((h) => ({ st: h.state, pos: [h.rig.root.position.x, h.rig.root.position.y, h.rig.root.position.z].map((v) => +v.toFixed(1)), leader: h.leader === 'player' ? 'player' : h.leader ? 'bot' + h.leader.id : null })), bots: bots.map((b) => ({ id: b.id, team: b.team, task: b.task, hp: b.hp, alive: b.alive, path: b.path.slice(), pos: [b.rig.root.position.x, b.rig.root.position.y, b.rig.root.position.z].map((v) => +v.toFixed(1)) })) }), addBot, playerTakeHostage };
