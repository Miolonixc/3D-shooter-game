import { Scene, Vector3, Mesh, AbstractMesh, StandardMaterial, Color3, DynamicTexture, TransformNode, MeshBuilder } from '@babylonjs/core';
import { loadBsp } from './bsp';
import { MINIMAP } from './config';

export interface Door {
  hinge: TransformNode;
  panel: Mesh;
  open: boolean;
}

export interface Footprint {
  cx: number;
  cz: number;
  w: number;
  d: number;
}

export class MapSystem {
  public levelMeshes: AbstractMesh[] = [];
  public doors: Door[] = [];
  public footprints: Footprint[] = [];
  public targets: Mesh[] = [];
  public pickups: Mesh[] = [];
  
  public curMap = 0;
  public mapLoading = false;
  public collected = 0;
  public pickupTotal = 0;
  public mapGen = 0;
  
  public spawnPoint = new Vector3(0, 1.7, -26);
  public lastBspMinimap: { img: HTMLCanvasElement; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } } | null = null;
  public lastBspYaw = 0;

  public mmBg: HTMLCanvasElement | null = null;
  public mmCenterX = 0;
  public mmCenterZ = 0;
  public mmSpan = MINIMAP.DEFAULT_SPAN;

  private scene: Scene;
  private sink: AbstractMesh[] | null = null;

  // Materials
  private groundMat!: StandardMaterial;
  private brickMat!: StandardMaterial;
  private brick2Mat!: StandardMaterial;
  private roofMat!: StandardMaterial;
  private doorMat!: StandardMaterial;
  private concreteMat!: StandardMaterial;
  private streetMat!: StandardMaterial;
  private vanMat!: StandardMaterial;
  private crateMat!: StandardMaterial;
  private galleryMat!: StandardMaterial;
  private targetMat!: StandardMaterial;
  private pickMat!: StandardMaterial;

  private onObjectiveUpdate: (collected: number, total: number) => void;

  constructor(scene: Scene, onObjectiveUpdate: (collected: number, total: number) => void) {
    this.scene = scene;
    this.onObjectiveUpdate = onObjectiveUpdate;

    this.initMaterials();
  }

  private initMaterials() {
    const mat = (name: string, hex: string, spec = 0.04) => {
      const m = new StandardMaterial(name, this.scene);
      m.diffuseColor = Color3.FromHexString(hex);
      m.specularColor = new Color3(spec, spec, spec);
      return m;
    };

    this.groundMat = mat('ground', '#6e6e66');
    this.brickMat = mat('brick', '#9c5b40');
    this.brick2Mat = mat('brick2', '#7d8a8f');
    this.roofMat = mat('roof', '#5f636b');
    this.doorMat = mat('door', '#7a4a28', 0.08);
    this.concreteMat = mat('concrete', '#9a9a9e');

    // cs_assault materials
    this.streetMat = mat('street', '#3a3d42');
    this.vanMat = mat('van', '#c9a227', 0.2);
    this.crateMat = mat('crate', '#7a5638', 0.05);
    this.galleryMat = mat('gallery', '#565b61', 0.15);

    this.targetMat = mat('target', '#d83030', 0.1);
    this.targetMat.emissiveColor = new Color3(0.25, 0.02, 0.02);

    this.pickMat = mat('pickup', '#34d0c0', 0.2);
    this.pickMat.emissiveColor = new Color3(0.05, 0.36, 0.33);

    // Procedural textures
    const shade = (hex: string, f: number) => {
      const n = parseInt(hex.slice(1), 16);
      const r = Math.min(255, ((n >> 16) & 255) * f) | 0;
      const g = Math.min(255, ((n >> 8) & 255) * f) | 0;
      const b = Math.min(255, (n & 255) * f) | 0;
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    };

    const brickTex = (name: string, base: string, mortar: string) => {
      const dt = new DynamicTexture(name, { width: 256, height: 256 }, this.scene, false);
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
    };

    const speckleTex = (name: string, base: string, fleck: string) => {
      const dt = new DynamicTexture(name, { width: 256, height: 256 }, this.scene, false);
      const ctx = dt.getContext() as any;
      ctx.fillStyle = base; ctx.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 2600; i++) {
        ctx.fillStyle = Math.random() < 0.5 ? fleck : base;
        ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
      }
      dt.update();
      return dt;
    };

    const tileTex = (name: string, base: string, grout: string) => {
      const dt = new DynamicTexture(name, { width: 256, height: 256 }, this.scene, false);
      const ctx = dt.getContext() as any;
      ctx.fillStyle = grout; ctx.fillRect(0, 0, 256, 256);
      const n = 4, gap = 6, cell = (256 - gap * (n + 1)) / n;
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        ctx.fillStyle = shade(base, 0.88 + Math.random() * 0.22);
        ctx.fillRect(gap + c * (cell + gap), gap + r * (cell + gap), cell, cell);
      }
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = shade(base, 0.7 + Math.random() * 0.5);
        ctx.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
      }
      dt.update();
      return dt;
    };

    const applyTex = (m: StandardMaterial, dt: DynamicTexture, scale: number) => {
      dt.uScale = scale; dt.vScale = scale;
      m.diffuseTexture = dt;
      m.diffuseColor = new Color3(1, 1, 1);
    };

    applyTex(this.brickMat, brickTex('bt1', '#b06848', '#3d2a22'), 5);
    applyTex(this.brick2Mat, brickTex('bt2', '#8b979c', '#33383b'), 5);
    applyTex(this.concreteMat, speckleTex('ct', '#a2a2a6', '#82828a'), 4);
    applyTex(this.groundMat, tileTex('floor', '#9a9a90', '#3c3c36'), 10);
    applyTex(this.crateMat, brickTex('crt', '#8a6541', '#43321f'), 1);
    applyTex(this.galleryMat, speckleTex('gst', '#565b61', '#3f4348'), 2);

    [this.brickMat, this.brick2Mat, this.concreteMat, this.roofMat, this.doorMat, this.galleryMat, this.vanMat, this.crateMat].forEach((m) => {
      m.backFaceCulling = false;
    });
  }

  private reg<T extends AbstractMesh>(m: T): T {
    if (this.sink) this.sink.push(m);
    return m;
  }

  private box(name: string, x: number, y: number, z: number, w: number, h: number, d: number, material: StandardMaterial) {
    const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, this.scene);
    m.position.set(x, y, z);
    m.material = material;
    m.checkCollisions = true;
    m.receiveShadows = true;
    return this.reg(m);
  }

  private building(cx: number, cz: number, w: number, d: number, h: number, m: StandardMaterial, openSide: 'none' | 'east' | 'west' = 'none', openBack = false) {
    this.footprints.push({ cx, cz, w, d });
    const t = 0.5;
    const door = 2.6;
    const seg = (w - door) / 2;
    this.box('w', cx - (door / 2 + seg / 2), h / 2, cz - d / 2, seg, h, t, m);
    this.box('w', cx + (door / 2 + seg / 2), h / 2, cz - d / 2, seg, h, t, m);
    const back = this.box('w', cx, h / 2, cz + d / 2, w, h, t, m);
    const wWest = this.box('w', cx - w / 2, h / 2, cz, t, h, d, m);
    const wEast = this.box('w', cx + w / 2, h / 2, cz, t, h, d, m);
    if (openBack) back.checkCollisions = false;
    if (openSide === 'west') wWest.checkCollisions = false;
    if (openSide === 'east') wEast.checkCollisions = false;
    const roof = this.box('roof', cx, h + 0.12, cz, w + 0.3, 0.25, d + 0.3, this.roofMat);
    roof.checkCollisions = false;
    roof.metadata = { floor: true };

    const dh = Math.min(h - 0.4, 2.8);
    const dw = door - 0.15;
    const hinge = new TransformNode('hinge', this.scene);
    hinge.position.set(cx - dw / 2, dh / 2, cz - d / 2);
    const dr = this.box('door', 0, 0, 0, dw, dh, 0.14, this.doorMat);
    dr.parent = hinge;
    dr.position.set(dw / 2, 0, 0);
    dr.checkCollisions = true;
    this.doors.push({ hinge, panel: dr, open: false });
  }

  private ramp(name: string, x: number, y: number, z: number, w: number, d: number, rise: number, run: number, m: StandardMaterial, visible = false, alongX = false) {
    const r = this.box(name, x, y, z, w, 0.3, d, m);
    r.isVisible = visible;
    r.checkCollisions = false;
    r.isPickable = true;
    r.metadata = { floor: true };
    if (alongX) {
      r.rotation.z = Math.atan2(rise, run);
    } else {
      r.rotation.x = -Math.atan2(rise, run);
    }
    return r;
  }

  private doorAt(cx: number, cz: number, width: number, height: number, alongX: boolean) {
    const hinge = new TransformNode('hinge', this.scene);
    hinge.position.set(cx - (alongX ? width / 2 : 0), height / 2, cz - (alongX ? 0 : width / 2));
    const dr = alongX
      ? this.box('door', 0, 0, 0, width, height, 0.16, this.doorMat)
      : this.box('door', 0, 0, 0, 0.16, height, width, this.doorMat);
    dr.parent = hinge;
    dr.position.set(alongX ? width / 2 : 0, 0, alongX ? 0 : width / 2);
    dr.checkCollisions = true;
    this.doors.push({ hinge, panel: dr, open: false });
  }

  public spawnTarget(x: number, z: number, baseY = 0) {
    const t = MeshBuilder.CreateBox('target', { width: 0.85, height: 1.7, depth: 0.4 }, this.scene);
    t.position.set(x, baseY + 0.85, z);
    t.material = this.targetMat.clone('target_' + this.targets.length);
    t.metadata = { hp: 100, x, z, y: baseY };
    t.computeWorldMatrix(true);
    t.refreshBoundingInfo();
    this.targets.push(t);
  }

  public spawnPickup(x: number, z: number, baseY = 0) {
    const c = MeshBuilder.CreateBox('pickup', { size: 0.5 }, this.scene);
    c.position.set(x, baseY + 0.8, z);
    c.material = this.pickMat;
    c.checkCollisions = false;
    c.isPickable = false;
    c.metadata = { baseY };
    this.pickups.push(c);
  }

  private buildCityMap(): Vector3 {
    const ground = MeshBuilder.CreateGround('ground', { width: 220, height: 220 }, this.scene);
    ground.material = this.groundMat;
    ground.checkCollisions = true;
    ground.receiveShadows = true;
    this.reg(ground);

    this.building(-16, -6, 14, 12, 5, this.brickMat);
    this.building(16, -6, 14, 12, 5, this.brick2Mat);
    this.building(-16, 12, 14, 10, 6, this.brickMat);
    this.building(16, 12, 14, 10, 6, this.brick2Mat);
    this.building(0, 26, 18, 12, 7, this.brickMat);

    this.box('b', 0, 2.5, -42, 96, 5, 1, this.concreteMat);
    this.box('b', 0, 2.5, 42, 96, 5, 1, this.concreteMat);
    this.box('b', -42, 2.5, 0, 1, 5, 84, this.concreteMat);
    this.box('b', 42, 2.5, 0, 1, 5, 84, this.concreteMat);

    const LV = 5.25;
    const platform = this.box('platform', 0, LV - 0.2, 0, 14, 0.4, 6, this.concreteMat);
    platform.checkCollisions = false;
    platform.metadata = { floor: true };

    for (let i = 0; i < 10; i++) {
      const sh = (10 - i) * (LV / 10);
      const st = this.box('step', 0, sh / 2, -3 - i * 0.8, 5, sh, 0.8, this.concreteMat);
      st.checkCollisions = false;
      st.metadata = { floor: true };
    }

    for (const sx of [-1, 1]) {
      const b = this.box('bridge', sx * 7.5, LV - 0.2, 0, 5, 0.4, 3.2, this.concreteMat);
      b.checkCollisions = false;
      b.metadata = { floor: true };
    }

    ([[28, 8], [28, 3], [24, 8], [-28, 8], [-24, 3], [0, 33], [12, -20], [-12, -20], [-16, -6, 5.25], [16, -6, 5.25]] as [number, number, number?][])
      .forEach(([x, z, y]) => this.spawnTarget(x, z, y || 0));

    ([[8, -8], [-8, -8], [28, 12], [-28, 12], [0, 12], [28, -8]] as [number, number][])
      .forEach(([x, z]) => this.spawnPickup(x, z));

    return new Vector3(0, 1.7, -26);
  }

  private buildAssaultMap(): Vector3 {
    const H = 7, T = 0.6;
    const street = MeshBuilder.CreateGround('ground', { width: 130, height: 130 }, this.scene);
    street.material = this.streetMat;
    street.checkCollisions = true;
    street.receiveShadows = true;
    this.reg(street);

    const floor = this.box('whfloor', 0, -0.04, 14, 40, 0.1, 28, this.concreteMat);
    floor.checkCollisions = false;
    floor.metadata = { floor: true };

    this.footprints.push({ cx: 0, cz: 14, w: 40, d: 28 });
    this.footprints.push({ cx: -25, cz: 10, w: 5, d: 3 });

    this.box('whw', -11.5, H / 2, 0, 17, H, T, this.concreteMat);
    this.box('whw', 11.5, H / 2, 0, 17, H, T, this.concreteMat);
    this.box('whw', 0, H - 1, 0, 6, 2, T, this.concreteMat);
    this.box('whw', -11, H / 2, 28, 18, H, T, this.concreteMat);
    this.box('whw', 11, H / 2, 28, 18, H, T, this.concreteMat);
    this.box('whw', 0, H - 1, 28, 4, 2, T, this.concreteMat);
    this.box('whw', -20, H / 2, 4, T, H, 8, this.concreteMat);
    this.box('whw', -20, H / 2, 20, T, H, 16, this.concreteMat);
    this.box('whw', -20, 1, 10, T, 2, 4, this.concreteMat);
    this.box('whw', -20, 5.4, 10, T, 3.2, 4, this.concreteMat);
    this.box('whw', 20, H / 2, 8, T, H, 16, this.concreteMat);
    this.box('whw', 20, H / 2, 23.5, T, H, 9, this.concreteMat);
    this.box('whw', 20, 4.8, 17.5, T, 4.4, 3, this.concreteMat);

    this.doorAt(0, 0, 5.6, 4.8, true);
    this.doorAt(0, 28, 3.4, 3.4, true);
    this.doorAt(20, 17.5, 2.8, 2.4, false);

    const galY = 3.5;
    for (const [n, x, z, w, d] of [['galW', -18, 14, 4, 28], ['galE', 18, 14, 4, 28], ['galN', 0, 26, 40, 4]] as [string, number, number, number, number][]) {
      const g = this.box(n, x, galY, z, w, 0.3, d, this.galleryMat);
      g.checkCollisions = false;
      g.metadata = { floor: true };
    }

    this.box('rail', -16, galY + 0.5, 14, 0.15, 1, 28, this.galleryMat).checkCollisions = false;
    this.box('rail', 16, galY + 0.5, 14, 0.15, 1, 28, this.galleryMat).checkCollisions = false;
    this.box('rail', 0, galY + 0.5, 24, 32, 1, 0.15, this.galleryMat).checkCollisions = false;
    this.ramp('gramp', -17, 1.75, 6, 3.6, 7, 3.5, 6.2, this.galleryMat, true);

    this.box('van', -25, 1.1, 10, 5, 2.2, 3, this.vanMat);
    this.box('vancab', -21.9, 0.9, 10, 1.2, 1.8, 2.6, this.vanMat);
    this.ramp('vanramp', -29, 1.1, 10, 3, 2.6, 2.2, 3, this.vanMat, true, true);
    const ledge = this.box('ledgeB', -21.3, 2.2, 10, 3.4, 0.2, 3.4, this.concreteMat);
    ledge.checkCollisions = false;
    ledge.metadata = { floor: true };
    const ledgeIn = this.box('ledgeIn', -18.4, 2.2, 10, 3, 0.2, 3.4, this.concreteMat);
    ledgeIn.checkCollisions = false;
    ledgeIn.metadata = { floor: true };
    this.ramp('bramp', -17, 2.85, 12.6, 3, 3, 1.3, 2.4, this.galleryMat);

    ([[-8, 8, 1.4], [-6, 9.6, 1.4], [7, 7, 1.6], [9, 16, 1.4], [0, 20, 1.5], [-3, 22, 1.3], [6, 13, 1.2], [-6, -12, 1.4], [7, -16, 1.4]] as [number, number, number][])
      .forEach(([x, z, s]) => this.box('crate', x, s / 2, z, s, s, s, this.crateMat));

    const galTop = galY + 0.15;
    this.spawnTarget(-18, 6, galTop);
    this.spawnTarget(-18, 22, galTop);
    this.spawnTarget(18, 10, galTop);
    this.spawnTarget(0, 26, galTop);
    this.spawnTarget(-8, 13);
    this.spawnTarget(8, 18);
    this.spawnTarget(0, 6);

    ([[-8, 20], [11, 10], [0, 14], [-12, 24]] as [number, number][]).forEach(([x, z]) => this.spawnPickup(x, z));

    return new Vector3(0, 1.7, -22);
  }

  private async buildBspMap(): Promise<Vector3> {
    const baseUrl = ((import.meta as any).env && (import.meta as any).env.BASE_URL) || './';
    const r = await loadBsp(this.scene, baseUrl + 'cs_assault.bsp', baseUrl + 'cs_assault.wad', 0.03);
    r.meshes.forEach(m => this.reg(m));
    this.lastBspMinimap = { img: r.minimap, bounds: r.bounds };
    this.lastBspYaw = r.spawnYaw;

    // Truck wheels (GoldSrc truck wheel fix)
    const wheelMat = new StandardMaterial('wheel', this.scene);
    wheelMat.diffuseColor = Color3.FromHexString('#1c1c1c');
    wheelMat.specularColor = new Color3(0.1, 0.1, 0.1);
    
    const rimMat = new StandardMaterial('rim', this.scene);
    rimMat.diffuseColor = Color3.FromHexString('#9a9a9e');
    rimMat.specularColor = new Color3(0.3, 0.3, 0.3);

    const wheel = (x: number, z: number) => {
      const rad = 0.55;
      const tire = MeshBuilder.CreateCylinder('wheel', { diameter: rad * 2, height: 0.35 }, this.scene);
      tire.rotation.z = Math.PI / 2;
      tire.position.set(x, rad, z);
      tire.material = wheelMat;
      tire.isPickable = false;
      this.reg(tire);
      
      const rim = MeshBuilder.CreateCylinder('rim', { diameter: rad * 1.1, height: 0.37 }, this.scene);
      rim.rotation.z = Math.PI / 2;
      rim.position.set(x, rad, z);
      rim.material = rimMat;
      rim.isPickable = false;
      this.reg(rim);
    };

    wheel(-26.1, 6.7);
    wheel(-26.1, 8.4);
    wheel(-24.0, 6.7);
    wheel(-24.0, 8.4);
    wheel(-26.1, 13.0);
    wheel(-24.0, 13.0);

    // Hostage rescues targets inside
    this.spawnTarget(-3.4, 21.0);
    this.spawnTarget(6.8, 17.5);
    this.spawnTarget(-14.0, 14.0, 3.65); // On gallery

    ([[0, -10], [-10, 0], [10, 10], [-5, 20]] as [number, number][]).forEach(([x, z]) => this.spawnPickup(x, z));

    return r.spawn;
  }

  public async loadMap(
    i: number,
    onBeforeLoad: () => void,
    onAfterLoad: (spawn: Vector3, yaw: number, mapName: string) => void
  ) {
    if (this.mapLoading) return;
    this.mapLoading = true;
    onBeforeLoad();

    // Clean up previous map
    for (const m of this.levelMeshes) {
      if (!m.isDisposed()) m.dispose();
    }
    for (const d of this.doors) {
      d.hinge.dispose(true);
    }
    for (const t of this.targets) {
      t.dispose();
    }
    for (const p of this.pickups) {
      p.dispose();
    }

    this.levelMeshes = [];
    this.doors.length = 0;
    this.footprints.length = 0;
    this.targets.length = 0;
    this.pickups.length = 0;
    this.mapGen++;

    const mapDefs = [
      { name: 'cs_assault (BSP)', build: () => this.buildBspMap() },
      { name: 'Арена (город)', build: () => this.buildCityMap() },
      { name: 'cs_assault (клон)', build: () => this.buildAssaultMap() },
    ];

    this.curMap = ((i % mapDefs.length) + mapDefs.length) % mapDefs.length;
    const mapDef = mapDefs[this.curMap];

    let spawn: Vector3;
    try {
      this.sink = this.levelMeshes;
      spawn = await mapDef.build();
    } finally {
      this.sink = null;
      this.mapLoading = false;
    }

    // Set minimap properties
    if (this.curMap === 0 && this.lastBspMinimap) {
      this.mmBg = this.lastBspMinimap.img;
      const b = this.lastBspMinimap.bounds;
      this.mmCenterX = (b.minX + b.maxX) / 2;
      this.mmCenterZ = (b.minZ + b.maxZ) / 2;
      this.mmSpan = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 1.04;
    } else {
      this.mmBg = null;
      this.mmCenterX = 0;
      this.mmCenterZ = 0;
      this.mmSpan = MINIMAP.DEFAULT_SPAN;
    }

    this.collected = 0;
    this.pickupTotal = this.pickups.length;

    this.onObjectiveUpdate(this.collected, this.pickupTotal);

    // Refresh bounding info of all meshes
    this.scene.meshes.forEach((m) => {
      m.refreshBoundingInfo();
      m.computeWorldMatrix(true);
    });

    const targetYaw = (this.curMap === 0) ? this.lastBspYaw : 0;
    onAfterLoad(spawn, targetYaw, mapDef.name);
  }

  // Target killed handling
  public removeTarget(t: Mesh) {
    const idx = this.targets.indexOf(t);
    if (idx !== -1) {
      this.targets.splice(idx, 1);
      const sx = t.metadata.x;
      const sz = t.metadata.z;
      const sy = t.metadata.y || 0;
      const gen = this.mapGen;
      setTimeout(() => {
        if (gen === this.mapGen) {
          this.spawnTarget(sx, sz, sy);
        }
      }, 4000);
    }
  }

  // Update pickable items & automatic door rotation
  public update(playerPosition: Vector3) {
    // Automatic doors rotation
    for (const dr of this.doors) {
      dr.open = Vector3.Distance(playerPosition, dr.hinge.getAbsolutePosition()) < 3;
      dr.panel.checkCollisions = !dr.open;
      const tgt = dr.open ? -Math.PI / 2 : 0;
      dr.hinge.rotation.y += (tgt - dr.hinge.rotation.y) * 0.18;
    }

    // Pickups rotation & collection
    const tms = performance.now();
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const c = this.pickups[i];
      c.rotation.y += 0.04;
      c.rotation.x += 0.02;
      c.position.y = (c.metadata ? c.metadata.baseY : 0) + 0.8 + Math.sin(tms / 400 + i) * 0.12;
      
      if (Math.hypot(playerPosition.x - c.position.x, playerPosition.z - c.position.z) < 1.8) {
        c.dispose();
        this.pickups.splice(i, 1);
        this.collected++;
        this.onObjectiveUpdate(this.collected, this.pickupTotal);
      }
    }
  }
}
