import * as THREE from 'three';

/**
 * DecalSystem – GPU-instanced bullet-impact decals.
 *
 * Each decal is a small dark circle rendered as a flat disc (CircleGeometry)
 * oriented to match the surface normal at the hit point, pushed slightly
 * off the surface to avoid z-fighting.
 *
 * Uses a single InstancedMesh for all decals — no per-decal draw calls.
 */

const MAX_DECALS = 512;
const SURFACE_OFFSET = 0.005; // push decal off surface to avoid z-fight

const _dummy = new THREE.Object3D();
const _up = new THREE.Vector3(0, 1, 0);

export class DecalSystem {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.size = 0.15;          // radius of each decal dot

    // Flat circle geometry (16 segments is plenty for a small dot)
    this._geo = new THREE.CircleGeometry(1, 16);

    // Dark grey unlit material — doesn't react to light
    this._mat = new THREE.MeshBasicMaterial({
      color: 0x222222,
      side: THREE.DoubleSide,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this._mesh = new THREE.InstancedMesh(this._geo, this._mat, MAX_DECALS);
    this._mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._mesh.frustumCulled = false;
    this._mesh.castShadow = false;
    this._mesh.receiveShadow = false;
    this._mesh.count = 0;
    scene.add(this._mesh);

    this._count = 0;       // how many decals have been placed (wraps at MAX)
    this._cursor = 0;      // ring-buffer write index
  }

  /**
   * Place a decal at a world-space hit point aligned to a surface normal.
   * @param {THREE.Vector3} point  – world-space hit location
   * @param {THREE.Vector3} normal – world-space surface normal at hit
   */
  add(point, normal) {
    // Orient the circle so its local +Z faces along the surface normal
    _dummy.position.copy(point).addScaledVector(normal, SURFACE_OFFSET);
    // CircleGeometry lies in XY plane with +Z as its face normal
    _dummy.quaternion.setFromUnitVectors(_up.set(0, 0, 1), normal);
    _dummy.scale.setScalar(this.size);
    _dummy.updateMatrix();

    this._mesh.setMatrixAt(this._cursor, _dummy.matrix);

    this._cursor = (this._cursor + 1) % MAX_DECALS;
    if (this._count < MAX_DECALS) this._count++;

    this._mesh.count = this._count;
    this._mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this._mesh);
    this._geo.dispose();
    this._mat.dispose();
  }
}
