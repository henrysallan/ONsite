import * as THREE from 'three';

/**
 * GPU-instanced bullet streak system.
 *
 * Each bullet is a single thin quad (2 triangles) drawn via InstancedMesh
 * with a custom shader that stretches it along the velocity direction and
 * fades it over its lifetime.
 *
 * The quad geometry is a unit-length strip along local +Z (length=1, width=1),
 * centered at origin. The shader transforms each instance using:
 *   - instanceMatrix  → positions the streak's TAIL at the bullet origin
 *   - velocity dir    → orients +Z along travel direction
 *   - streak length   → scales Z
 *   - streak width    → scales X
 *   - age / lifetime  → alpha fade
 */

const MAX_BULLETS = 128;

// ── Shared geometry: two quads crossed at 90° (X-billboard) ──
// Quad A lies in XZ plane, Quad B lies in YZ plane
const _quadPositions = new Float32Array([
  // Quad A  (XZ plane)
  -0.5, 0, 0,   0.5, 0, 0,   0.5, 0, 1,
  -0.5, 0, 0,   0.5, 0, 1,  -0.5, 0, 1,
  // Quad B  (YZ plane)
  0, -0.5, 0,   0, 0.5, 0,   0, 0.5, 1,
  0, -0.5, 0,   0, 0.5, 1,  0, -0.5, 1,
]);
const _quadUVs = new Float32Array([
  0, 0,  1, 0,  1, 1,
  0, 0,  1, 1,  0, 1,
  0, 0,  1, 0,  1, 1,
  0, 0,  1, 1,  0, 1,
]);

const _quadGeo = new THREE.BufferGeometry();
_quadGeo.setAttribute('position', new THREE.BufferAttribute(_quadPositions, 3));
_quadGeo.setAttribute('uv', new THREE.BufferAttribute(_quadUVs, 2));

// ── Shader ──
const bulletVert = /* glsl */`
  void main() {
    vec4 world = instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const bulletFrag = /* glsl */`
  uniform vec3 uColor;
  void main() {
    gl_FragColor = vec4(uColor, 1.0);
  }
`;

// Reusable temporaries
const _dir = new THREE.Vector3();
const _up  = new THREE.Vector3(0, 1, 0);
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _pos  = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _dummy = new THREE.Object3D();

export class BulletSystem {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene, collidables = []) {
    this.scene = scene;
    this.collidables = collidables; // meshes to collide against
    this.sparks = null; // set to a SparkSystem instance to emit on hit

    // ── Tunables (set from Leva) ──
    this.speed      = 60;    // units/sec
    this.lifetime   = 0.6;   // seconds
    this.width      = 0.04;  // world units
    this.length     = 1.2;   // world units
    this.color      = new THREE.Color(1, 1, 1);
    this.fireRate   = 12;    // shots per second
    this.spawnOffset = 1.0;  // distance to push spawn point forward along aim dir

    // ── Collision raycaster ──
    this._collisionRay = new THREE.Raycaster();
    this._collisionRay.firstHitOnly = true; // for BVH

    // ── Bullet pool ──
    this._bullets = [];
    for (let i = 0; i < MAX_BULLETS; i++) {
      this._bullets.push({
        alive: false,
        age: 0,
        lifetime: 0,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
      });
    }
    this._aliveCount = 0;

    // ── Material ──
    this._material = new THREE.ShaderMaterial({
      vertexShader: bulletVert,
      fragmentShader: bulletFrag,
      uniforms: {
        uColor: { value: this.color },
      },
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // ── Instanced mesh ──
    const geo = _quadGeo.clone();
    this._mesh = new THREE.InstancedMesh(geo, this._material, MAX_BULLETS);
    this._mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._mesh.frustumCulled = false;
    this._mesh.castShadow = false;
    this._mesh.receiveShadow = false;
    this._mesh.count = 0; // start with 0 visible instances
    scene.add(this._mesh);
  }

  /**
   * Fire a bullet from `origin` in `direction`.
   * @param {THREE.Vector3} origin    – world-space start position
   * @param {THREE.Vector3} direction – normalised world-space direction
   */
  fire(origin, direction) {
    // Find a dead slot
    let slot = null;
    for (let i = 0; i < MAX_BULLETS; i++) {
      if (!this._bullets[i].alive) { slot = this._bullets[i]; slot._index = i; break; }
    }
    if (!slot) {
      // Recycle oldest
      let oldest = this._bullets[0];
      for (let i = 1; i < MAX_BULLETS; i++) {
        if (this._bullets[i].age > oldest.age) oldest = this._bullets[i];
      }
      slot = oldest;
      slot._index = this._bullets.indexOf(slot);
    }

    slot.alive = true;
    slot.age = 0;
    slot.lifetime = this.lifetime;
    slot.pos.copy(origin).addScaledVector(direction, this.spawnOffset);
    slot.vel.copy(direction).multiplyScalar(this.speed);
  }

  /**
   * Advance all bullets, update instance transforms.
   * @param {number} dt – seconds
   */
  update(dt) {
    let count = 0;

    for (let i = 0; i < MAX_BULLETS; i++) {
      const b = this._bullets[i];
      if (!b.alive) continue;

      b.age += dt;
      if (b.age >= b.lifetime) {
        b.alive = false;
        continue;
      }

      // Move
      b.pos.addScaledVector(b.vel, dt);

      // Collision: raycast a short segment along velocity
      if (this.collidables.length > 0) {
        const step = b.vel.length() * dt;
        _dir.copy(b.vel).normalize();
        this._collisionRay.set(b.pos, _dir);
        this._collisionRay.far = step * 1.5; // slight lookahead
        const hits = this._collisionRay.intersectObjects(this.collidables, false);
        if (hits.length > 0) {
          if (this.sparks) {
            this.sparks.emit(hits[0].point, hits[0].face.normal, _dir);
          }
          b.alive = false;
          continue;
        }
      }

      // Build instance matrix: translate + orient + scale
      _dir.copy(b.vel).normalize();
      _lookTarget.copy(b.pos).add(_dir);
      _dummy.position.copy(b.pos);
      _dummy.lookAt(_lookTarget); // orients -Z toward target, so +Z is travel dir
      _dummy.rotateY(Math.PI);    // flip so +Z of quad aligns with travel direction
      _dummy.scale.set(this.width, this.width, this.length);
      _dummy.updateMatrix();

      this._mesh.setMatrixAt(count, _dummy.matrix);
      count++;
    }

    this._mesh.count = count;
    if (count > 0) {
      this._mesh.instanceMatrix.needsUpdate = true;
    }

    // Sync uniforms
    this._material.uniforms.uColor.value.copy(this.color);
  }

  dispose() {
    this.scene.remove(this._mesh);
    this._mesh.geometry.dispose();
    this._material.dispose();
  }
}
