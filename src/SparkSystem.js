import * as THREE from 'three';

/**
 * GPU-instanced spark particle system.
 * Call emit(position, normal) to burst sparks at an impact point.
 * Each spark is a small billboard quad that flies outward with gravity and fades.
 */

const MAX_SPARKS = 512;

// Shared geometry: tiny quad (two tris)
const _geo = new THREE.BufferGeometry();
const _verts = new Float32Array([
  -0.5, -0.5, 0,  0.5, -0.5, 0,  0.5, 0.5, 0,
  -0.5, -0.5, 0,  0.5,  0.5, 0, -0.5, 0.5, 0,
]);
const _uvs = new Float32Array([
  0, 0, 1, 0, 1, 1,
  0, 0, 1, 1, 0, 1,
]);
_geo.setAttribute('position', new THREE.BufferAttribute(_verts, 3));
_geo.setAttribute('uv', new THREE.BufferAttribute(_uvs, 2));

// Shader: billboard quad that fades with age
const sparkVert = /* glsl */`
  attribute float instanceAge; // 0..1 normalised
  varying float vAge;

  void main() {
    vAge = instanceAge;

    // Billboard: extract camera-right and camera-up from view matrix
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    // Instance position is stored in the 4th column of instanceMatrix
    vec3 center = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);

    // Scale from instanceMatrix (X scale = uniform size)
    float size = length(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2]));

    vec3 worldPos = center
      + camRight * position.x * size
      + camUp    * position.y * size;

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const sparkFrag = /* glsl */`
  uniform vec3 uColor;
  varying float vAge;

  void main() {
    // Fade out with age
    float alpha = 1.0 - smoothstep(0.3, 1.0, vAge);
    if (alpha < 0.01) discard;

    // Bright core
    gl_FragColor = vec4(uColor * (1.0 + (1.0 - vAge) * 0.5), alpha);
  }
`;

// Reusable temporaries
const _tmpVec = new THREE.Vector3();
const _reflect = new THREE.Vector3();

export class SparkSystem {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;

    // Tunables
    this.sparksPerHit = 12;     // how many sparks per impact
    this.speed        = 8;      // initial burst speed
    this.spread       = 1.0;    // angular spread (1 = hemisphere)
    this.gravity      = 20;     // downward acceleration
    this.lifetime     = 0.4;    // seconds
    this.size         = 0.06;   // world-space quad size
    this.color        = new THREE.Color(1, 1, 1);

    // Spark pool
    this._sparks = [];
    for (let i = 0; i < MAX_SPARKS; i++) {
      this._sparks.push({
        alive: false,
        age: 0,
        lifetime: 0,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
      });
    }
    this._nextSlot = 0;

    // Instance age attribute
    this._ageArray = new Float32Array(MAX_SPARKS);
    const ageAttr = new THREE.InstancedBufferAttribute(this._ageArray, 1);
    ageAttr.setUsage(THREE.DynamicDrawUsage);

    // Material
    this._material = new THREE.ShaderMaterial({
      vertexShader: sparkVert,
      fragmentShader: sparkFrag,
      uniforms: {
        uColor: { value: this.color },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    // Instanced mesh
    const geo = _geo.clone();
    geo.setAttribute('instanceAge', ageAttr);
    this._mesh = new THREE.InstancedMesh(geo, this._material, MAX_SPARKS);
    this._mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._mesh.frustumCulled = false;
    this._mesh.castShadow = false;
    this._mesh.receiveShadow = false;
    this._mesh.count = 0;
    scene.add(this._mesh);

    // Identity matrix for building instance transforms
    this._mat4 = new THREE.Matrix4();
  }

  /**
   * Emit a burst of sparks at a hit point.
   * @param {THREE.Vector3} position  – world-space hit point
   * @param {THREE.Vector3} normal    – surface normal at hit (sparks reflect off this)
   * @param {THREE.Vector3} incomingDir – normalised direction of the incoming bullet
   */
  emit(position, normal, incomingDir) {
    // Reflect incoming direction off the surface normal
    _reflect.copy(incomingDir).reflect(normal).normalize();

    for (let s = 0; s < this.sparksPerHit; s++) {
      // Round-robin allocation
      const spark = this._sparks[this._nextSlot];
      this._nextSlot = (this._nextSlot + 1) % MAX_SPARKS;

      spark.alive = true;
      spark.age = 0;
      // Randomise lifetime slightly
      spark.lifetime = this.lifetime * (0.5 + Math.random() * 0.5);
      spark.pos.copy(position);

      // Random direction biased toward the reflected direction
      _tmpVec.set(
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
      ).normalize();

      // Blend between reflect direction and random direction
      spark.vel.copy(_reflect).lerp(_tmpVec, this.spread * 0.6).normalize();
      // Ensure sparks go outward from surface (same hemisphere as normal)
      if (spark.vel.dot(normal) < 0) spark.vel.reflect(normal);

      const spd = this.speed * (0.5 + Math.random() * 0.5);
      spark.vel.multiplyScalar(spd);
    }
  }

  /**
   * Update all sparks. Call once per frame.
   * @param {number} dt – seconds
   */
  update(dt) {
    let count = 0;

    for (let i = 0; i < MAX_SPARKS; i++) {
      const s = this._sparks[i];
      if (!s.alive) continue;

      s.age += dt;
      if (s.age >= s.lifetime) {
        s.alive = false;
        continue;
      }

      // Physics: gravity
      s.vel.y -= this.gravity * dt;

      // Move
      s.pos.addScaledVector(s.vel, dt);

      // Build instance matrix (just translation + uniform scale, billboard in shader)
      const t = s.age / s.lifetime;
      const scale = this.size * (1 - t * 0.5); // shrink slightly over lifetime
      this._mat4.makeScale(scale, scale, scale);
      this._mat4.setPosition(s.pos);
      this._mesh.setMatrixAt(count, this._mat4);
      this._ageArray[count] = t;
      count++;
    }

    this._mesh.count = count;
    if (count > 0) {
      this._mesh.instanceMatrix.needsUpdate = true;
      this._mesh.geometry.attributes.instanceAge.needsUpdate = true;
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
