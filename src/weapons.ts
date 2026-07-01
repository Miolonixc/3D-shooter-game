import { Scene, Camera, Vector3, StandardMaterial, Color3, MeshBuilder, TransformNode, Mesh, AbstractMesh } from '@babylonjs/core';
import { WEAPONS, WeaponConfig } from './config';
import { sndShoot, sndReload } from './audio';
import { updateAmmoHud } from './ui';

export interface WeaponState {
  config: WeaponConfig;
  node: TransformNode;
  flash: Mesh;
  ammo: number;
}

export class WeaponSystem {
  public weapons: WeaponState[] = [];
  public wi = 0;
  public reloading = false;
  
  private scene: Scene;
  private camera: Camera;
  private canvas: HTMLCanvasElement;
  
  private recoil = 0;
  private lastShot = 0;
  private gunDip = 0;
  private gunHome = new Vector3(0, 0, 0);

  // Materials
  private bluedMat!: StandardMaterial;
  private polyMat!: StandardMaterial;
  private magMat!: StandardMaterial;
  private flashMat!: StandardMaterial;

  // callbacks
  private onTargetKilled: (sx: number, sz: number, sy: number) => void;
  private onTargetHit: (t: AbstractMesh, headshot: boolean) => void;
  private onHitMarker: (headshot: boolean) => void;
  private onDamagePopup: (point: Vector3, dmg: number, headshot: boolean) => void;

  constructor(
    scene: Scene,
    camera: Camera,
    canvas: HTMLCanvasElement,
    callbacks: {
      onTargetKilled: (sx: number, sz: number, sy: number) => void;
      onTargetHit: (t: AbstractMesh, headshot: boolean) => void;
      onHitMarker: (headshot: boolean) => void;
      onDamagePopup: (point: Vector3, dmg: number, headshot: boolean) => void;
    }
  ) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.onTargetKilled = callbacks.onTargetKilled;
    this.onTargetHit = callbacks.onTargetHit;
    this.onHitMarker = callbacks.onHitMarker;
    this.onDamagePopup = callbacks.onDamagePopup;

    this.initMaterials();
    this.buildWeapons();
  }

  private initMaterials() {
    const mat = (name: string, hex: string, spec = 0.04) => {
      const m = new StandardMaterial(name, this.scene);
      m.diffuseColor = Color3.FromHexString(hex);
      m.specularColor = new Color3(spec, spec, spec);
      return m;
    };
    
    this.bluedMat = mat('blued', '#15161b', 0.55);
    this.bluedMat.specularColor = new Color3(0.5, 0.52, 0.6);
    this.polyMat = mat('poly', '#26282e', 0.22);
    this.magMat = mat('mag', '#1a1c21', 0.3);

    this.flashMat = new StandardMaterial('flashMat', this.scene);
    this.flashMat.emissiveColor = new Color3(1, 0.84, 0.4);
    this.flashMat.diffuseColor = new Color3(0, 0, 0);
    this.flashMat.disableLighting = true;
  }

  private makeFlash(parent: TransformNode, local: Vector3): Mesh {
    const f = MeshBuilder.CreateDisc('flash', { radius: 0.15, tessellation: 8 }, this.scene);
    f.material = this.flashMat;
    f.parent = parent;
    f.position.copyFrom(local);
    f.billboardMode = Mesh.BILLBOARDMODE_ALL;
    f.isPickable = false;
    f.checkCollisions = false;
    f.setEnabled(false);
    return f;
  }

  private part(node: TransformNode, n: string, w: number, h: number, d: number, x: number, y: number, z: number, m: StandardMaterial, rx = 0) {
    const b = MeshBuilder.CreateBox(n, { width: w, height: h, depth: d }, this.scene);
    b.parent = node;
    b.position.set(x, y, z);
    b.rotation.x = rx;
    b.checkCollisions = false;
    b.isPickable = false;
    return b;
  }

  private buildWeapons() {
    // --- build Pistol ---
    const pNode = new TransformNode('pistol', this.scene);
    pNode.parent = this.camera;
    const px = 0.22, py = -0.2, pz = 0.55;
    this.part(pNode, 'p_slide', 0.12, 0.14, 0.5, px, py + 0.02, pz + 0.18, this.bluedMat);
    this.part(pNode, 'p_frame', 0.11, 0.10, 0.42, px, py - 0.08, pz + 0.14, this.polyMat);
    this.part(pNode, 'p_grip', 0.10, 0.24, 0.13, px, py - 0.26, pz - 0.02, this.polyMat, 0.22);
    this.part(pNode, 'p_sight', 0.02, 0.03, 0.03, px, py + 0.11, pz + 0.4, this.bluedMat);
    
    const pBar = MeshBuilder.CreateCylinder('p_barrel', { diameter: 0.05, height: 0.16 }, this.scene);
    pBar.material = this.bluedMat;
    pBar.parent = pNode;
    pBar.rotation.x = Math.PI / 2;
    pBar.position.set(px, py + 0.02, pz + 0.46);
    pBar.isPickable = false;
    pBar.checkCollisions = false;

    const pFlash = this.makeFlash(pNode, new Vector3(px, py + 0.02, pz + 0.57));
    
    this.weapons.push({
      config: WEAPONS[0],
      node: pNode,
      flash: pFlash,
      ammo: WEAPONS[0].mag,
    });

    // --- build SMG ---
    const sNode = new TransformNode('smg', this.scene);
    sNode.parent = this.camera;
    sNode.setEnabled(false);
    const sx = 0.2, sy = -0.22, sz = 0.5;
    this.part(sNode, 's_body', 0.12, 0.16, 0.7, sx, sy + 0.04, sz + 0.22, this.bluedMat);
    this.part(sNode, 's_rail', 0.06, 0.05, 0.46, sx, sy + 0.14, sz + 0.24, this.polyMat);
    this.part(sNode, 's_mag', 0.08, 0.3, 0.12, sx, sy - 0.2, sz + 0.08, this.magMat, 0.14);
    this.part(sNode, 's_grip', 0.09, 0.2, 0.12, sx, sy - 0.16, sz - 0.12, this.polyMat, 0.3);
    this.part(sNode, 's_stock', 0.08, 0.1, 0.24, sx, sy + 0.02, sz - 0.32, this.polyMat);

    const sBar = MeshBuilder.CreateCylinder('s_barrel', { diameter: 0.05, height: 0.34 }, this.scene);
    sBar.material = this.bluedMat;
    sBar.parent = sNode;
    sBar.rotation.x = Math.PI / 2;
    sBar.position.set(sx, sy + 0.06, sz + 0.62);
    sBar.isPickable = false;
    sBar.checkCollisions = false;

    const sFlash = this.makeFlash(sNode, new Vector3(sx, sy + 0.06, sz + 0.8));

    this.weapons.push({
      config: WEAPONS[1],
      node: sNode,
      flash: sFlash,
      ammo: WEAPONS[1].mag,
    });

    this.weapons.forEach((w) => w.node.position.copyFrom(this.gunHome));
  }

  public getActiveWeapon() {
    return this.weapons[this.wi];
  }

  public switchWeapon(index?: number) {
    if (this.reloading) return;
    
    let targetIdx = this.wi;
    if (index === undefined || index === -1) {
      targetIdx = (this.wi + 1) % this.weapons.length;
    } else {
      targetIdx = index;
    }

    if (targetIdx === this.wi || targetIdx < 0 || targetIdx >= this.weapons.length) return;

    this.weapons[this.wi].node.setEnabled(false);
    this.wi = targetIdx;
    this.weapons[this.wi].node.setEnabled(true);
    
    this.updateHud();
  }

  public reload() {
    const cur = this.weapons[this.wi];
    if (this.reloading || cur.ammo >= cur.config.mag) return;
    
    this.reloading = true;
    this.updateHud();
    sndReload();

    setTimeout(() => {
      cur.ammo = cur.config.mag;
      if (this.weapons[this.wi] === cur) {
        this.reloading = false;
      }
      this.updateHud();
    }, cur.config.reloadMs);
  }

  public fire(targets: AbstractMesh[]) {
    const cur = this.weapons[this.wi];
    if (this.reloading || cur.ammo <= 0) return;
    
    const now = performance.now();
    if (now - this.lastShot < cur.config.interval) return;
    
    this.lastShot = now;
    cur.ammo--;
    this.updateHud();
    
    this.recoil = cur.config.recoil;
    sndShoot(cur.config.name === 'SMG');

    // Trigger flash animation
    cur.flash.scaling.setAll(0.7 + Math.random() * 0.7);
    cur.flash.setEnabled(true);
    const fl = cur.flash;
    setTimeout(() => fl.setEnabled(false), 45);

    if (cur.ammo === 0) {
      this.reload();
    }

    // Hitscan check
    const ray = this.camera.getForwardRay(240);
    const hit = this.scene.pickWithRay(ray, (m) => targets.indexOf(m as any) !== -1);
    if (hit && hit.pickedMesh && hit.pickedPoint) {
      const t = hit.pickedMesh;
      const headshot = hit.pickedPoint.y > t.position.y + 0.45;
      const dmg = headshot ? cur.config.dmgHead : cur.config.dmgBody;
      
      t.metadata.hp -= dmg;
      this.onHitMarker(headshot);
      this.onDamagePopup(hit.pickedPoint, dmg, headshot);

      if (t.metadata.hp <= 0) {
        const sx = t.metadata.x;
        const sz = t.metadata.z;
        const sy = t.metadata.y || 0;
        this.onTargetKilled(sx, sz, sy);
        t.dispose();
      } else {
        this.onTargetHit(t, headshot);
      }
    }
  }

  public updateHud() {
    const cur = this.weapons[this.wi];
    updateAmmoHud(this.reloading, cur.config.name, cur.ammo, cur.config.mag);
  }

  public update(isMoved: boolean, bobX: number, bobY: number) {
    this.gunDip += ((this.reloading ? 1 : 0) - this.gunDip) * 0.15;
    if (this.recoil > 0.001) {
      this.recoil *= 0.8;
    } else {
      this.recoil = 0;
    }

    const cur = this.weapons[this.wi];
    cur.node.position.set(
      this.gunHome.x + bobX,
      this.gunHome.y + bobY - this.gunDip * 0.28,
      this.gunHome.z - this.recoil
    );
    cur.node.rotation.x = this.recoil * 1.5 + this.gunDip * 0.7;
  }
}
