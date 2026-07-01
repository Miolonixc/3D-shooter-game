import {
  Engine,
  Scene,
  Color3,
  Color4,
  Vector3,
  HemisphericLight,
  DirectionalLight,
  StandardMaterial
} from '@babylonjs/core';
import { PlayerController } from './player';
import { WeaponSystem } from './weapons';
import { MapSystem } from './maps';
import { sndHit, sndKill } from './audio';
import {
  initUI,
  updateKillsHud,
  updateObjectiveHud,
  showMapName,
  hitMarker,
  dmgPopup,
  drawMinimap,
  getMmCanvas
} from './ui';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;

const engine = new Engine(canvas, true, { stencil: true, adaptToDeviceRatio: true });
const scene = new Scene(engine);
scene.clearColor = Color4.FromHexString('#9ec9f0ff'); // дневное небо
scene.collisionsEnabled = true;

// туман подальше — глубина без потери видимости
scene.fogMode = Scene.FOGMODE_LINEAR;
scene.fogColor = Color3.FromHexString('#9ec9f0');
scene.fogStart = 90;
scene.fogEnd = 320;

// --- свет (день) ---
const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
hemi.intensity = 0.8;
hemi.groundColor = new Color3(0.4, 0.39, 0.36);

const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, -0.35), scene);
sun.position = new Vector3(50, 90, 40);
sun.intensity = 0.85;

// Инициализация интерфейса
initUI();

let kills = 0;

// Инициализация карт
const mapSystem = new MapSystem(scene, (collected, total) => {
  updateObjectiveHud(collected, total);
});

// Инициализация игрока
const player = new PlayerController(scene, canvas, overlay, {
  onFire: () => {
    weaponSystem.fire(mapSystem.targets);
  },
  onReload: () => {
    weaponSystem.reload();
  },
  onSwitchWeapon: (idx) => {
    if (idx === -1) {
      weaponSystem.switchWeapon();
    } else {
      weaponSystem.switchWeapon(idx);
    }
  },
  onNextMap: () => {
    loadMap(mapSystem.curMap + 1);
  }
});

// Инициализация оружия
const weaponSystem = new WeaponSystem(scene, player.camera, canvas, {
  onTargetKilled: (sx, sz, sy) => {
    kills++;
    updateKillsHud(kills);
    sndKill();
    
    // Очищаем массив мишеней от уничтоженных объектов
    mapSystem.targets = mapSystem.targets.filter(t => !t.isDisposed());
    
    const currentGen = mapSystem.mapGen;
    setTimeout(() => {
      if (currentGen === mapSystem.mapGen) {
        mapSystem.spawnTarget(sx, sz, sy);
      }
    }, 4000);
  },
  onTargetHit: (t, headshot) => {
    sndHit();
    const em = t.material as StandardMaterial;
    if (em) {
      em.emissiveColor = new Color3(0.85, 0.12, 0.12);
      setTimeout(() => {
        if (!t.isDisposed()) {
          em.emissiveColor = new Color3(0.25, 0.02, 0.02);
        }
      }, 90);
    }
  },
  onHitMarker: (headshot) => {
    hitMarker(headshot);
  },
  onDamagePopup: (point, dmg, headshot) => {
    dmgPopup(scene, player.camera, canvas, point, dmg, headshot);
  }
});

// Асинхронная загрузка карт
async function loadMap(i: number) {
  const mapNames = ['cs_assault (BSP)', 'Арена (город)', 'cs_assault (клон)'];
  const targetMapIndex = ((i % mapNames.length) + mapNames.length) % mapNames.length;
  
  await mapSystem.loadMap(
    targetMapIndex,
    () => {
      showMapName('Загрузка: ' + mapNames[targetMapIndex] + '…');
    },
    (spawn, yaw, mapName) => {
      kills = 0;
      updateKillsHud(kills);
      player.resetPosition(spawn, yaw);
      weaponSystem.switchWeapon(weaponSystem.wi); // Обновить UI оружия
      showMapName(mapName);
    }
  );
}

// Загружаем начальную карту
loadMap(0);

// Игровой цикл обновлений
scene.onBeforeRenderObservable.add(() => {
  // 1. Физика перемещения игрока
  player.update(mapSystem.targets, mapSystem.spawnPoint);
  
  // 2. Автоматическая стрельба при удержании ЛКМ/сенсорной кнопки
  if (player.isFiring && weaponSystem.getActiveWeapon().config.auto) {
    weaponSystem.fire(mapSystem.targets);
  }
  
  // 3. Анимации покачивания и отдачи оружия
  weaponSystem.update(player.isMoved, player.bobX, player.bobY);
  
  // 4. Движение собираемых предметов и работа автоматических дверей
  mapSystem.update(player.camera.position);
  
  // 5. Отрисовка миникарты
  drawMinimap(
    player.camera,
    mapSystem.targets,
    mapSystem.pickups,
    mapSystem.footprints,
    mapSystem.mmBg,
    mapSystem.mmCenterX,
    mapSystem.mmCenterZ,
    mapSystem.mmSpan
  );
});

// Запуск Babylon рендеринга
engine.runRenderLoop(() => scene.render());
window.addEventListener('resize', () => engine.resize());

// Глобальный объект отладки
(window as any).GAME = {
  engine,
  scene,
  camera: player.camera,
  targets: mapSystem.targets,
  pickups: mapSystem.pickups,
  weapons: weaponSystem.weapons,
  fire: () => weaponSystem.fire(mapSystem.targets),
  switchWeapon: (idx: number) => weaponSystem.switchWeapon(idx),
  getCur: () => weaponSystem.getActiveWeapon(),
  held: player.held,
  footprints: mapSystem.footprints,
  loadMap,
  getMap: () => mapSystem.curMap,
  mmCanvas: getMmCanvas()
};
