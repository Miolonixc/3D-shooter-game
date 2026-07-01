export const PHYSICS = {
  GRAVITY: -0.013,
  JUMP_FORCE: 0.23,
  EYE_HEIGHT: 1.7,
  CROUCH_EYE_HEIGHT: 1.05,
  MOVE_SPEED: 0.06,
  CROUCH_SPEED_MULTIPLIER: 0.5,
};

export const CAMERA = {
  SPEED: 0.34,
  INERTIA: 0.55,
  ELLIPSOID: { x: 0.5, y: 0.9, z: 0.5 },
  ELLIPSOID_OFFSET: { x: 0, y: -0.8, z: 0 },
};

export const MINIMAP = {
  SIZE: 168,
  HALF_SIZE: 84,
  DEFAULT_SPAN: 100,
};

export interface WeaponConfig {
  name: string;
  mag: number;
  interval: number;
  auto: boolean;
  dmgBody: number;
  dmgHead: number;
  recoil: number;
  reloadMs: number;
}

export const WEAPONS: WeaponConfig[] = [
  {
    name: 'Пистолет',
    mag: 12,
    interval: 170,
    auto: false,
    dmgBody: 50,
    dmgHead: 100,
    recoil: 0.13,
    reloadMs: 800,
  },
  {
    name: 'SMG',
    mag: 30,
    interval: 75,
    auto: true,
    dmgBody: 24,
    dmgHead: 55,
    recoil: 0.07,
    reloadMs: 1100,
  },
];
