// Точечные импорты Babylon по под-путям вместо барреля `@babylonjs/core`.
// `import * as B from '@babylonjs/core'` тянул ВЕСЬ движок (~5 МБ) — barrel почти не
// tree-shake'ится. Здесь реэкспортируем только используемые классы (см. grep "B\.<Symbol>"
// по main.ts/bsp.ts) плюс side-effect модули, которые барр подключал за нас: коллизии
// (camera.checkCollisions / scene.collisionsEnabled) и raycasting (scene.pickWithRay,
// camera.getForwardRay). Без них игра компилируется, но падает в рантайме, поэтому
// покрыто ручной проверкой в превью (стрельба, опора под ногами, CCTV-RTT, коллизии стен).
//
// В коде остаётся `import * as B from './babylon'` — префикс B. не меняется.

// side-effects: регистрация в прототипах Scene/AbstractMesh (импортируются ради побочек)
import '@babylonjs/core/Collisions/collisionCoordinator';
import '@babylonjs/core/Culling/ray';
// AbstractMesh.createOrUpdateSubmeshesOctree / useOctreeForCollisions — оптимизация коллизий
// крупных BSP-мешей (bsp.ts): sub-mesh октодерево. Барр подключал за нас.
import '@babylonjs/core/Culling/Octrees/octreeSceneComponent';

export { Engine } from '@babylonjs/core/Engines/engine';
export { Scene } from '@babylonjs/core/scene';
export { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector';
export { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
export { Ray } from '@babylonjs/core/Culling/ray';

export { TransformNode } from '@babylonjs/core/Meshes/transformNode';
export { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
export { Mesh } from '@babylonjs/core/Meshes/mesh';
export { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
export { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';

export { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
export { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
export { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';

export { Material } from '@babylonjs/core/Materials/material';
export { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
export { Texture } from '@babylonjs/core/Materials/Textures/texture';
export { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
export { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
export { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture';
