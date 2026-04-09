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
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  varying vec3 vLocalPos;
  void main() {
    vec4 world = instanceMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vUv = uv;
    vLocalPos = position; // raw quad vertex in local space
    // Approximate normal from instance orientation (bullets are thin quads)
    vWorldNormal = normalize((instanceMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const bulletFrag = /* glsl */`
  uniform vec3 uShadow;
  uniform vec3 uMid;
  uniform vec3 uHighlight;
  uniform float uThreshold1;
  uniform float uThreshold2;
  uniform vec3 uLightDir;
  uniform float uEmissive;
  uniform float uEdgeSoftness;

  varying vec3 vWorldNormal;
  varying vec2 vUv;
  varying vec3 vLocalPos;

  void main() {
    float NdotL = dot(normalize(vWorldNormal), normalize(uLightDir));
    float lighting = NdotL * 0.5 + 0.5;

    vec3 col;
    if (lighting < uThreshold1) col = uShadow;
    else if (lighting < uThreshold2) col = uMid;
    else col = uHighlight;

    // Radial distance from the center axis of the streak.
    // Quad A spans X (y=0), Quad B spans Y (x=0).
    // Both have their cross-section in the XY plane; Z is along the streak.
    float radial = length(vLocalPos.xy) * 2.0; // 0 at center, 1 at edge

    // Soft radial fade from center to edge
    float edgeFade = 1.0 - smoothstep(1.0 - uEdgeSoftness, 1.0, radial);

    // Soft tip fade along the length (Z: 0 = tail, 1 = head)
    float along = vLocalPos.z; // 0→1
    float tipFade = smoothstep(0.0, 0.15, along) * (1.0 - smoothstep(0.85, 1.0, along));

    float alpha = edgeFade * tipFade;

    // Output HDR with soft alpha
    gl_FragColor = vec4(col * uEmissive, alpha);
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
    this.shadow     = new THREE.Color('#444444');
    this.mid        = new THREE.Color('#888888');
    this.highlight  = new THREE.Color('#ffffff');
    this.fireRate   = 12;    // shots per second
    this.spawnOffset = 1.0;  // distance to push spawn point forward along aim dir
    this.emissive    = 3.0;  // emissive intensity multiplier (>1 triggers bloom)

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
    this.edgeSoftness = 0.6; // 0 = hard edge, 1 = fully soft

    this._material = new THREE.ShaderMaterial({
      vertexShader: bulletVert,
      fragmentShader: bulletFrag,
      uniforms: {
        uShadow:       { value: this.shadow },
        uMid:          { value: this.mid },
        uHighlight:    { value: this.highlight },
        uThreshold1:   { value: 0.3 },
        uThreshold2:   { value: 0.6 },
        uLightDir:     { value: new THREE.Vector3(0.5, 1.0, 0.5).normalize() },
        uEmissive:     { value: this.emissive },
        uEdgeSoftness: { value: this.edgeSoftness },
      },
      transparent: true,
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
    this._mesh.layers.set(1); // exclude from outline pre-pass (layer 0 only)
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
          const hitNormal = hits[0].face.normal.clone()
            .transformDirection(hits[0].object.matrixWorld).normalize();
          if (this.sparks) {
            this.sparks.emit(hits[0].point, hitNormal, _dir);
          }
          if (this.decals) {
            this.decals.add(hits[0].point, hitNormal);
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
    this._material.uniforms.uShadow.value.copy(this.shadow);
    this._material.uniforms.uMid.value.copy(this.mid);
    this._material.uniforms.uHighlight.value.copy(this.highlight);
    this._material.uniforms.uEmissive.value = this.emissive;
    this._material.uniforms.uEdgeSoftness.value = this.edgeSoftness;
  }

  dispose() {
    this.scene.remove(this._mesh);
    this._mesh.geometry.dispose();
    this._material.dispose();
  }
}
