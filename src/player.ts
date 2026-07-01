import { Scene, UniversalCamera, Vector3, Ray, AbstractMesh } from '@babylonjs/core';
import { PHYSICS, CAMERA } from './config';
import { initAudio } from './audio';

export class PlayerController {
  public camera: UniversalCamera;
  public held = new Set<string>();
  
  public touchMove = { x: 0, y: 0 };
  public touchStarted = false;
  
  public velY = 0;
  public onGround = true;
  public jumpQueued = false;
  
  public bobPhase = 0;
  public bobX = 0;
  public bobY = 0;
  public isFiring = false;
  public isMoved = false;

  private lastX = 0;
  private lastZ = 0;
  private canvas: HTMLCanvasElement;
  private scene: Scene;

  // callbacks
  private onFire: () => void;
  private onReload: () => void;
  private onSwitchWeapon: (i: number) => void;
  private onNextMap: () => void;

  constructor(
    scene: Scene,
    canvas: HTMLCanvasElement,
    overlay: HTMLDivElement,
    callbacks: {
      onFire: () => void;
      onReload: () => void;
      onSwitchWeapon: (i: number) => void;
      onNextMap: () => void;
    }
  ) {
    this.scene = scene;
    this.canvas = canvas;
    this.onFire = callbacks.onFire;
    this.onReload = callbacks.onReload;
    this.onSwitchWeapon = callbacks.onSwitchWeapon;
    this.onNextMap = callbacks.onNextMap;

    // Create camera
    this.camera = new UniversalCamera('cam', new Vector3(0, PHYSICS.EYE_HEIGHT, -26), scene);
    this.camera.setTarget(new Vector3(0, PHYSICS.EYE_HEIGHT, 0));
    this.camera.attachControl(canvas, true);
    this.camera.minZ = 0.05;
    this.camera.speed = CAMERA.SPEED;
    this.camera.inertia = CAMERA.INERTIA;
    this.camera.checkCollisions = true;
    this.camera.applyGravity = false;
    this.camera.ellipsoid = new Vector3(CAMERA.ELLIPSOID.x, CAMERA.ELLIPSOID.y, CAMERA.ELLIPSOID.z);
    this.camera.ellipsoidOffset = new Vector3(CAMERA.ELLIPSOID_OFFSET.x, CAMERA.ELLIPSOID_OFFSET.y, CAMERA.ELLIPSOID_OFFSET.z);
    
    // Remove default inputs to customize them
    this.camera.inputs.removeByType('FreeCameraMouseInput');
    this.camera.inputs.removeByType('FreeCameraKeyboardMoveInput');

    this.lastX = this.camera.position.x;
    this.lastZ = this.camera.position.z;

    this.setupListeners(overlay);
  }

  public resetPosition(spawn: Vector3, yaw: number) {
    this.camera.position.copyFrom(spawn);
    this.camera.rotation.set(0, yaw, 0);
    this.velY = 0;
    this.onGround = false;
    this.lastX = this.camera.position.x;
    this.lastZ = this.camera.position.z;
  }

  private setupListeners(overlay: HTMLDivElement) {
    const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

    overlay.addEventListener('click', () => {
      initAudio();
      if (isTouch) {
        this.touchStarted = true;
        overlay.style.display = 'none';
      } else {
        this.canvas.requestPointerLock();
      }
    });

    document.addEventListener('pointerlockchange', () => {
      if (isTouch) return;
      overlay.style.display = document.pointerLockElement === this.canvas ? 'none' : 'flex';
    });

    const locked = () => document.pointerLockElement === this.canvas;

    document.addEventListener('mousemove', (e) => {
      if (!locked()) return;
      this.camera.rotation.y += e.movementX * 0.0022;
      this.camera.rotation.x = Math.max(-1.45, Math.min(1.45, this.camera.rotation.x + e.movementY * 0.0022));
    });

    document.addEventListener('mousedown', (e) => {
      if (locked() && e.button === 0) {
        this.isFiring = true;
        this.onFire();
      }
    });

    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this.isFiring = false;
      }
    });

    const gameKeys = new Set(['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ControlLeft', 'ControlRight']);
    window.addEventListener('keydown', (e) => {
      if (gameKeys.has(e.code)) e.preventDefault();
      this.held.add(e.code);
      if (e.code === 'Space') this.jumpQueued = true;
      if (e.code === 'Digit1') this.onSwitchWeapon(0);
      if (e.code === 'Digit2') this.onSwitchWeapon(1);
      if (e.code === 'KeyR') this.onReload();
      if (e.code === 'KeyM') this.onNextMap();
    });

    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());

    if (isTouch) {
      this.setupTouchControls(overlay);
    }
  }

  private setupTouchControls(overlay: HTMLDivElement) {
    const css = (el: HTMLElement, s: Record<string, string>) => Object.assign(el.style, s as any);
    const mk = (s: Record<string, string>) => {
      const d = document.createElement('div');
      css(d, s);
      document.body.appendChild(d);
      return d;
    };

    const stickZone = mk({ position: 'fixed', width: '100px', height: '100px', borderRadius: '50%', border: '2px solid rgba(255,255,255,.4)', background: 'rgba(255,255,255,.08)', display: 'none', pointerEvents: 'none', zIndex: '8' });
    const stickNub = mk({ position: 'fixed', width: '40px', height: '40px', borderRadius: '50%', background: 'rgba(255,255,255,.5)', display: 'none', pointerEvents: 'none', zIndex: '9' });

    const btn = (label: string, right: string, bottom: string) => mk({ position: 'fixed', right, bottom, width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(255,255,255,.14)', border: '2px solid rgba(255,255,255,.4)', color: '#fff', font: '600 13px system-ui', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none', zIndex: '9', userSelect: 'none' });
    const fireBtn = btn('🔫', '20px', '24px');
    const jumpBtn = btn('⤒', '96px', '24px');
    const swBtn = btn('1/2', '20px', '100px');

    let moveId = -1, moveCX = 0, moveCY = 0, lookId = -1, lookX = 0, lookY = 0;
    const MAXR = 50;
    const start = () => {
      if (!this.touchStarted) {
        this.touchStarted = true;
        overlay.style.display = 'none';
        initAudio();
      }
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      start();
      if (e.clientX < window.innerWidth * 0.5 && moveId < 0) {
        moveId = e.pointerId; moveCX = e.clientX; moveCY = e.clientY;
        css(stickZone, { left: (moveCX - 50) + 'px', top: (moveCY - 50) + 'px', display: 'block' });
        css(stickNub, { left: (moveCX - 20) + 'px', top: (moveCY - 20) + 'px', display: 'block' });
      } else if (lookId < 0) {
        lookId = e.pointerId; lookX = e.clientX; lookY = e.clientY;
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId === moveId) {
        const dx = e.clientX - moveCX, dy = e.clientY - moveCY;
        const mag = Math.min(1, Math.hypot(dx, dy) / MAXR);
        const ang = Math.atan2(dy, dx);
        this.touchMove.x = Math.cos(ang) * mag;
        this.touchMove.y = -Math.sin(ang) * mag;
        css(stickNub, { left: (moveCX + Math.cos(ang) * mag * MAXR - 20) + 'px', top: (moveCY + Math.sin(ang) * mag * MAXR - 20) + 'px' });
      } else if (e.pointerId === lookId) {
        this.camera.rotation.y += (e.clientX - lookX) * 0.004;
        this.camera.rotation.x = Math.max(-1.45, Math.min(1.45, this.camera.rotation.x + (e.clientY - lookY) * 0.004));
        lookX = e.clientX; lookY = e.clientY;
      }
    });

    const end = (e: PointerEvent) => {
      if (e.pointerId === moveId) {
        moveId = -1;
        this.touchMove.x = 0;
        this.touchMove.y = 0;
        css(stickZone, { display: 'none' });
        css(stickNub, { display: 'none' });
      }
      if (e.pointerId === lookId) lookId = -1;
    };

    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);

    fireBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      start();
      this.isFiring = true;
      this.onFire();
    });
    fireBtn.addEventListener('pointerup', (e) => {
      e.preventDefault();
      this.isFiring = false;
    });
    fireBtn.addEventListener('pointercancel', (e) => {
      e.preventDefault();
      this.isFiring = false;
    });
    jumpBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.jumpQueued = true;
    });
    swBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.onSwitchWeapon(-1); // -1 switches to next weapon
    });
  }

  public update(targets: AbstractMesh[], spawnPoint: Vector3) {
    const crouching = this.held.has('ControlLeft') || this.held.has('ControlRight');
    const eyeNow = crouching ? PHYSICS.CROUCH_EYE_HEIGHT : PHYSICS.EYE_HEIGHT;
    const downRay = new Ray(this.camera.position, new Vector3(0, -1, 0), 60);
    const g = this.scene.pickWithRay(downRay, (m) => (m.checkCollisions || (m.metadata && m.metadata.floor)) && targets.indexOf(m as any) === -1);
    
    const floorY = (g && g.hit && g.pickedPoint) ? g.pickedPoint.y : -1e9;
    if (this.onGround) {
      if (this.camera.position.y - eyeNow <= floorY + 1.0) {
        this.camera.position.y = floorY + eyeNow;
        this.velY = 0;
        if (this.jumpQueued) {
          this.velY = crouching ? 0.28 : PHYSICS.JUMP_FORCE;
          this.onGround = false;
        }
      } else {
        this.onGround = false;
      }
    } else {
      this.velY += PHYSICS.GRAVITY;
      this.camera.position.y += this.velY;
      if (this.camera.position.y - eyeNow <= floorY) {
        this.camera.position.y = floorY + eyeNow;
        this.velY = 0;
        this.onGround = true;
      }
    }
    this.jumpQueued = false;

    // Fall out of bounds
    if (this.camera.position.y < -8) {
      this.camera.position.copyFrom(spawnPoint);
      this.velY = 0;
      this.onGround = true;
    }

    // Horizontal Movement
    const locked = () => document.pointerLockElement === this.canvas;
    let inX = this.touchMove.x, inZ = this.touchMove.y;
    if (locked() || this.touchStarted) {
      if (locked()) {
        inZ += (this.held.has('KeyW') ? 1 : 0) - (this.held.has('KeyS') ? 1 : 0);
        inX += (this.held.has('KeyD') ? 1 : 0) - (this.held.has('KeyA') ? 1 : 0);
        if (this.held.has('ArrowLeft')) this.camera.rotation.y -= 0.035;
        if (this.held.has('ArrowRight')) this.camera.rotation.y += 0.035;
      }
    }
    const inMag = Math.hypot(inX, inZ);
    if (inMag > 0.001) {
      const spdInX = inMag > 1 ? inX / inMag : inX;
      const spdInZ = inMag > 1 ? inZ / inMag : inZ;
      const spd = PHYSICS.MOVE_SPEED * (crouching ? PHYSICS.CROUCH_SPEED_MULTIPLIER : 1);
      const fwd = this.camera.getDirection(Vector3.Forward()); fwd.y = 0; fwd.normalize();
      const right = this.camera.getDirection(Vector3.Right()); right.y = 0; right.normalize();
      this.camera.cameraDirection.addInPlace(fwd.scale(spdInZ * spd));
      this.camera.cameraDirection.addInPlace(right.scale(spdInX * spd));
    }

    // Calculate Weapon bobbing
    this.isMoved = Math.hypot(this.camera.position.x - this.lastX, this.camera.position.z - this.lastZ) > 0.004;
    this.lastX = this.camera.position.x;
    this.lastZ = this.camera.position.z;
    this.bobPhase += this.isMoved ? 0.22 : 0.05;
    this.bobY = this.isMoved ? Math.abs(Math.sin(this.bobPhase)) * 0.014 : 0;
    this.bobX = this.isMoved ? Math.cos(this.bobPhase * 0.5) * 0.01 : 0;
  }
}
