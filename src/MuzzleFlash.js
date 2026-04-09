import * as THREE from 'three';

/**
 * Muzzle flash card system.
 *
 * Places several textured 1×1 quads at the gun tip — some face-on (perpendicular
 * to the barrel), some edge-on (their plane contains the barrel axis) — so the
 * flash reads from any camera angle.
 *
 * Black backgrounds are handled by an additive-blend custom shader so they
 * disappear naturally.
 *
 * Usage:
 *   const muzzle = new MuzzleFlash(skeletonGroup);
 *   muzzle.fire();           // call each time a bullet is fired
 *   muzzle.update(dt, tipWorldPos, aimDir);  // call every frame
 */

// ── Additive-blend shader (black → transparent) ──
const flashVert = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const flashFrag = /* glsl */`
  uniform sampler2D uTex;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec4 tex = texture2D(uTex, vUv);
    // Luminance-based alpha so black areas are fully transparent
    float lum = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
    gl_FragColor = vec4(tex.rgb, lum * uOpacity);
  }
`;

// Shared 1×1 quad geometry (XY plane, centered at origin)
const _quadGeo = new THREE.PlaneGeometry(1, 1);

// Reusable temporaries
const _tipWorld = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();
const _tmpQ = new THREE.Quaternion();

/**
 * Card descriptor — how each quad is oriented relative to the barrel.
 *   type: 'front' → perpendicular to barrel (faces camera/aim direction)
 *   type: 'side'  → edge-on, plane contains barrel axis
 *   angle: extra rotation (degrees) around the barrel axis (for variety)
 */
const CARD_DEFS = [
  // Front cards: face toward camera (perpendicular to barrel)
  { tex: 'front1.jpg', type: 'front', angle: 0 },
  { tex: 'front2.jpg', type: 'front', angle: 45 },

  // Side cards: plane contains barrel axis, rotated at intervals
  { tex: 'Side1.jpg',  type: 'side', angle: 0 },
  { tex: 'side2.jpg',  type: 'side', angle: 60 },
  { tex: 'side3.jpg',  type: 'side', angle: 120 },
  { tex: 'side4.jpg',  type: 'side', angle: 30 },
  { tex: 'side6.jpg',  type: 'side', angle: 90 },
];

export class MuzzleFlash {
  /**
   * @param {THREE.Scene} scene – cards are added to the scene (world space)
   */
  constructor(scene) {
    this.scene = scene;
    this.cards = [];       // { mesh, def }
    this.duration = 0.03;  // seconds (30 ms)
    this.size = 1.0;       // quad scale
    this.opacity = 1.0;    // peak opacity
    this._timer = 0;       // countdown
    this._active = false;

    const loader = new THREE.TextureLoader();

    for (const def of CARD_DEFS) {
      const tex = loader.load(`/images/${def.tex}`);
      tex.colorSpace = THREE.SRGBColorSpace;

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTex:     { value: tex },
          uOpacity: { value: 0.0 },
        },
        vertexShader: flashVert,
        fragmentShader: flashFrag,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(_quadGeo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 999; // render on top
      mesh.layers.set(1);    // layer 1 only — excluded from outline pre-pass
      scene.add(mesh);

      this.cards.push({ mesh, def, mat });
    }
  }

  /** Trigger a flash. Call each time a bullet is fired. */
  fire() {
    this._timer = this.duration;
    this._active = true;
    // Randomise rotation offset per flash so consecutive shots look different
    this._randomSeed = Math.random() * 360;
  }

  /**
   * Call every frame.
   * @param {number} dt – delta seconds
   * @param {THREE.Vector3} tipWorld – gun tip in world space
   * @param {THREE.Vector3} aimDir  – normalised aim/barrel direction
   */
  update(dt, tipWorld, aimDir) {
    if (this._active) {
      this._timer -= dt;
      if (this._timer <= 0) {
        this._active = false;
        this._timer = 0;
      }
    }

    const show = this._active;
    // Fade: full brightness at start, quick fade at the end
    const t = this.duration > 0 ? Math.max(0, this._timer / this.duration) : 0;

    for (const card of this.cards) {
      card.mesh.visible = show;
      if (!show) {
        card.mat.uniforms.uOpacity.value = 0;
        continue;
      }

      // Opacity: ease-out fade
      card.mat.uniforms.uOpacity.value = t * this.opacity;

      // Position: at gun tip, pushed slightly forward along aim so it
      // doesn't z-fight with the barrel
      card.mesh.position.copy(tipWorld).addScaledVector(aimDir, 0.15);
      card.mesh.scale.setScalar(this.size);

      const def = card.def;
      const extraAngle = (def.angle + (this._randomSeed || 0)) * (Math.PI / 180);

      if (def.type === 'front') {
        // Face perpendicular to barrel (look along -aimDir)
        _tmpQ.setFromUnitVectors(new THREE.Vector3(0, 0, 1), aimDir);
        card.mesh.quaternion.copy(_tmpQ);
        // Spin around barrel axis for variety
        card.mesh.rotateOnAxis(new THREE.Vector3(0, 0, 1), extraAngle);
      } else {
        // Side card: plane contains the barrel axis.
        // Start with the quad facing +Z (its normal is +Z in PlaneGeometry).
        // We want the quad's plane to contain the aimDir, rotated around it.

        // Build a basis: aimDir is the "forward" of the barrel.
        // Get an arbitrary perpendicular axis.
        if (Math.abs(aimDir.y) > 0.99) {
          _right.set(1, 0, 0);
        } else {
          _right.crossVectors(aimDir, _up).normalize();
        }
        // Rotate the perpendicular axis around aimDir by extraAngle
        _right.applyAxisAngle(aimDir, extraAngle);

        // The quad's normal should be _right (so the quad surface contains aimDir)
        _tmpQ.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _right);
        card.mesh.quaternion.copy(_tmpQ);
      }
    }
  }

  dispose() {
    for (const card of this.cards) {
      this.scene.remove(card.mesh);
      card.mat.uniforms.uTex.value.dispose();
      card.mat.dispose();
    }
    this.cards = [];
  }
}
