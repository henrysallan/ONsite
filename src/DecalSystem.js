import * as THREE from 'three';

/**
 * DecalSystem – GPU-instanced bullet-impact decals with textured splats.
 *
 * Each decal is a small quad rendered via InstancedMesh with a custom shader
 * that randomly picks one of 4 bullet-hit textures. The texture serves as both
 * base colour and bump, with screen blending so black areas are transparent.
 *
 * Uses a single InstancedMesh for all decals — no per-decal draw calls.
 */

const MAX_DECALS = 512;
const SURFACE_OFFSET = 0.005; // push decal off surface to avoid z-fight
const TEXTURE_COUNT = 4;

const _dummy = new THREE.Object3D();
const _zAxis = new THREE.Vector3(0, 0, 1);

// ── Vertex shader ──
const decalVert = /* glsl */ `
  attribute float aTexIndex;

  varying vec2 vUv;
  varying float vTexIndex;
  varying vec3 vWorldNormal;

  void main() {
    vUv = uv;
    vTexIndex = aTexIndex;

    // Face normal in world space (plane lies in XY, so local normal = +Z)
    vWorldNormal = normalize((instanceMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);

    vec4 world = instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// ── Fragment shader ──
const decalFrag = /* glsl */ `
  uniform sampler2D uTex0;
  uniform sampler2D uTex1;
  uniform sampler2D uTex2;
  uniform sampler2D uTex3;
  uniform vec3 uLightDir;
  uniform float uBumpStrength;

  varying vec2 vUv;
  varying float vTexIndex;
  varying vec3 vWorldNormal;

  // Sample the correct texture by index
  vec4 sampleTex(vec2 uv) {
    int idx = int(vTexIndex + 0.5);
    if (idx == 1) return texture2D(uTex1, uv);
    if (idx == 2) return texture2D(uTex2, uv);
    if (idx == 3) return texture2D(uTex3, uv);
    return texture2D(uTex0, uv);
  }

  void main() {
    vec4 texColor = sampleTex(vUv);

    // Luminance — drives alpha (black = transparent)
    float lum = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));

    // Simple bump from luminance gradient (finite-difference normal perturbation)
    float eps = 0.01;
    float lumR = dot(sampleTex(vUv + vec2(eps, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
    float lumU = dot(sampleTex(vUv + vec2(0.0, eps)).rgb, vec3(0.299, 0.587, 0.114));
    vec3 bumpNormal = normalize(vWorldNormal + uBumpStrength * vec3(lum - lumR, lum - lumU, 0.0));

    // Simple directional lighting on the bump
    float NdotL = max(dot(bumpNormal, normalize(uLightDir)), 0.0);
    float lighting = 0.5 + 0.5 * NdotL; // half-ambient, half-diffuse

    vec3 col = texColor.rgb * lighting;

    // Discard nearly-black fragments for a clean cutout
    if (lum < 0.04) discard;

    gl_FragColor = vec4(col, lum);
  }
`;

// ── Texture loader (singleton) ──
const _loader = new THREE.TextureLoader();

export class DecalSystem {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.size = 0.5; // half-size of each decal quad

    // ── Load the 4 bullet-hit textures ──
    this._textures = [];
    for (let i = 1; i <= TEXTURE_COUNT; i++) {
      const tex = _loader.load(`/images/bullethit${i}.png`);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      this._textures.push(tex);
    }

    // ── Plane geometry (1×1 in XY plane, normal along +Z) ──
    this._geo = new THREE.PlaneGeometry(1, 1);

    // ── Per-instance attribute: texture index (0-3) ──
    this._texIndices = new Float32Array(MAX_DECALS);
    const texIndexAttr = new THREE.InstancedBufferAttribute(this._texIndices, 1);
    texIndexAttr.setUsage(THREE.DynamicDrawUsage);
    this._geo.setAttribute('aTexIndex', texIndexAttr);

    // ── Custom shader material with screen blending ──
    this._mat = new THREE.ShaderMaterial({
      vertexShader: decalVert,
      fragmentShader: decalFrag,
      uniforms: {
        uTex0: { value: this._textures[0] },
        uTex1: { value: this._textures[1] },
        uTex2: { value: this._textures[2] },
        uTex3: { value: this._textures[3] },
        uLightDir: { value: new THREE.Vector3(0.5, 1.0, 0.5).normalize() },
        uBumpStrength: { value: 3.0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,

      // Screen blend: result = src + dst × (1 – src)
      blending: THREE.NormalBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcColorFactor,
    });

    this._mesh = new THREE.InstancedMesh(this._geo, this._mat, MAX_DECALS);
    this._mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._mesh.frustumCulled = false;
    this._mesh.castShadow = false;
    this._mesh.receiveShadow = false;
    this._mesh.count = 0;
    scene.add(this._mesh);

    this._count = 0;  // how many decals have been placed (wraps at MAX)
    this._cursor = 0; // ring-buffer write index
  }

  /**
   * Place a decal at a world-space hit point aligned to a surface normal.
   * @param {THREE.Vector3} point  – world-space hit location
   * @param {THREE.Vector3} normal – world-space surface normal at hit
   */
  add(point, normal) {
    // Orient the quad so its local +Z faces along the surface normal
    _dummy.position.copy(point).addScaledVector(normal, SURFACE_OFFSET);
    _dummy.quaternion.setFromUnitVectors(_zAxis, normal);

    // Random rotation around the normal so decals don't all look identical
    const spin = Math.random() * Math.PI * 2;
    _dummy.rotateZ(spin);

    _dummy.scale.setScalar(this.size);
    _dummy.updateMatrix();

    this._mesh.setMatrixAt(this._cursor, _dummy.matrix);

    // Pick a random texture for this decal
    this._texIndices[this._cursor] = Math.floor(Math.random() * TEXTURE_COUNT);
    this._geo.getAttribute('aTexIndex').needsUpdate = true;

    this._cursor = (this._cursor + 1) % MAX_DECALS;
    if (this._count < MAX_DECALS) this._count++;

    this._mesh.count = this._count;
    this._mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this._mesh);
    this._geo.dispose();
    this._mat.dispose();
    this._textures.forEach((t) => t.dispose());
  }
}
