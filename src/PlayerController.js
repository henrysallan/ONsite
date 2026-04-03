import * as THREE from 'three';
import { PlayerSkeleton } from './PlayerSkeleton.js';
import { ProceduralWalk } from './ProceduralWalk.js';

// Irrational-ish frequencies for non-repeating noise per axis
const NOISE_FREQS = [
  [0.71, 1.37, 2.03],  // pos X layers
  [0.53, 1.19, 1.89],  // pos Y layers
  [0.97, 1.61, 2.29],  // pos Z layers
  [0.67, 1.31, 2.11],  // rot X layers
  [0.79, 1.47, 1.97],  // rot Y layers
  [0.59, 1.23, 2.17],  // rot Z layers
];

/** Smooth noise: sum of 3 sine layers with different frequencies + phase offsets. */
function layeredNoise(t, freqs) {
  return (
    Math.sin(t * freqs[0] * Math.PI * 2) * 0.5 +
    Math.sin(t * freqs[1] * Math.PI * 2 + 1.3) * 0.3 +
    Math.sin(t * freqs[2] * Math.PI * 2 + 2.7) * 0.2
  );
}

// ── Ground raycasting helpers ──
const _rayOrigin = new THREE.Vector3();
const _rayDown   = new THREE.Vector3(0, -1, 0);
const _raycaster = new THREE.Raycaster();

/** Raycast downward from (x, 50, z) against ground meshes. Returns Y or fallback. */
function getGroundY(x, z, groundMeshes, fallback = 0) {
  _rayOrigin.set(x, 50, z);
  _raycaster.set(_rayOrigin, _rayDown);
  const hits = _raycaster.intersectObjects(groundMeshes, false);
  return hits.length > 0 ? hits[0].point.y : fallback;
}

/**
 * FPS-style player controller.
 * Mouse controls yaw (and pitch is tracked for the camera).
 * WASD sets desired direction; the ProceduralWalk system moves the body
 * at a speed dictated by the leg animation cycle.
 */
export class PlayerController {
  constructor(scene) {
    const group = new THREE.Group();

    // --- Skeleton-based player body ---
    this.skeleton = new PlayerSkeleton();
    group.add(this.skeleton.group);

    // --- Procedural walk system ---
    this.walk = new ProceduralWalk(this.skeleton);

    group.position.y = 0;
    scene.add(group);

    this.mesh = group;

    // ── Ground collision meshes (set via setGroundMeshes) ──
    this.groundMeshes = [];
    this._smoothBodyY = 0; // smoothed ground height under body
    this.maxStepHeight = 1.2; // max height difference the body can climb onto

    // ── Body noise parameters ──
    this.bodyNoise = {
      posSpeed: 0.2,
      posMinX: 0.02, posMaxX: 0.61,
      posMinY: 0.01, posMaxY: 0.57,
      posMinZ: 0.00, posMaxZ: 0.04,
      rotSpeed: 0.2,
      rotMinX: 0.00, rotMaxX: 0.38,
      rotMinY: 0.02, rotMaxY: 0.41,
      rotMinZ: 0.03, rotMaxZ: 0.38,
      // Movement bias: how much the spine tilts toward the movement direction
      fwdTilt: 0.14,       // radians – forward pitch when moving forward
      bwdTilt: 0.08,       // radians – backward pitch when moving backward
      moveDamping: 1.0,    // 0-1 – how much to reduce noise while moving fwd/bwd
      lateralDamping: 1.0, // 0-1 – how much to reduce noise while strafing
    };
    this._noiseElapsed = 0;
    this._smoothFwd = 0;   // smoothed forward input  (-1..1)
    this._smoothRight = 0; // smoothed lateral input   (-1..1)

    // Mouse-look state
    this.yaw = 0;
    this.pitch = 0;
    this.mouseSensitivity = 0.002;

    // --- Keyboard state ---
    this._keys = {};
    this._onKeyDown = (e) => { this._keys[e.code] = true; };
    this._onKeyUp = (e) => { this._keys[e.code] = false; };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    // --- Pointer lock + mouse move ---
    this._onMouseMove = (e) => {
      if (document.pointerLockElement !== renderer_domElement) return;
      this.yaw -= e.movementX * this.mouseSensitivity;
      this.pitch -= e.movementY * this.mouseSensitivity;
      this.pitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, this.pitch));
    };
    document.addEventListener('mousemove', this._onMouseMove);
  }

  update(dt) {
    // Apply yaw to the player mesh
    this.mesh.rotation.y = this.yaw;

    const k = this._keys;

    // Build movement direction relative to facing
    let fwd = 0;
    let right = 0;
    if (k['KeyW'] || k['ArrowUp'])    fwd += 1;
    if (k['KeyS'] || k['ArrowDown'])  fwd -= 1;
    if (k['KeyA'] || k['ArrowLeft'])  right += 1;
    if (k['KeyD'] || k['ArrowRight']) right -= 1;

    const inputDir = new THREE.Vector3();
    if (fwd !== 0 || right !== 0) {
      inputDir.set(right, 0, fwd).normalize();
      inputDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    }

    // Drive the walk system (pass ground meshes for foot raycasting)
    this.walk.setInput(inputDir);
    const { movedDelta } = this.walk.update(dt, this.mesh, this.groundMeshes);

    // Apply body movement computed by the walk system
    const candidatePos = this.mesh.position.clone().add(movedDelta);

    // Check max step height — reject movement if ground ahead is too high
    const candidateGroundY = getGroundY(candidatePos.x, candidatePos.z, this.groundMeshes, this._smoothBodyY);
    const heightDiff = candidateGroundY - this._smoothBodyY;
    if (heightDiff > this.maxStepHeight) {
      // Block horizontal movement, allow vertical adaptation at current position
      movedDelta.set(0, 0, 0);
    } else {
      this.mesh.position.copy(candidatePos);
    }

    // Raycast body Y from ground under the body center
    const bx = this.mesh.position.x;
    const bz = this.mesh.position.z;
    const targetY = getGroundY(bx, bz, this.groundMeshes, this._smoothBodyY);
    const bodySmooth = 10; // how fast body height adapts
    this._smoothBodyY += (targetY - this._smoothBodyY) * Math.min(1, bodySmooth * dt);
    this.mesh.position.y = this._smoothBodyY;

    // ── Apply body noise to skeleton group ──
    this._noiseElapsed += dt;
    const bn = this.bodyNoise;
    const t = this._noiseElapsed;

    // Smooth the raw input for gentle transitions (local-space: fwd = +Z, right = +X)
    const smoothRate = 6; // how fast the smoothing catches up
    this._smoothFwd   += (fwd   - this._smoothFwd)   * Math.min(1, smoothRate * dt);
    this._smoothRight += (right - this._smoothRight) * Math.min(1, smoothRate * dt);

    // Compute noise damping factor: reduce noise proportional to movement
    const absFwd   = Math.abs(this._smoothFwd);
    const absRight = Math.abs(this._smoothRight);
    const fwdDamp  = 1 - absFwd   * bn.moveDamping;
    const latDamp  = 1 - absRight * bn.lateralDamping;
    const noiseMul = fwdDamp * latDamp; // combined damping

    // Forward/backward tilt bias (rotX = pitch in local spine space)
    const tiltBias = this._smoothFwd > 0
      ? this._smoothFwd * bn.fwdTilt
      : this._smoothFwd * -bn.bwdTilt; // bwdTilt is negative, so negate to get positive for backward

    const nPosX = layeredNoise(t * bn.posSpeed, NOISE_FREQS[0]) * noiseMul;
    const nPosY = layeredNoise(t * bn.posSpeed, NOISE_FREQS[1]) * noiseMul;
    const nPosZ = layeredNoise(t * bn.posSpeed, NOISE_FREQS[2]) * noiseMul;
    this.skeleton.group.position.set(
      THREE.MathUtils.lerp(bn.posMinX, bn.posMaxX, nPosX * 0.5 + 0.5),
      THREE.MathUtils.lerp(bn.posMinY, bn.posMaxY, nPosY * 0.5 + 0.5),
      THREE.MathUtils.lerp(bn.posMinZ, bn.posMaxZ, nPosZ * 0.5 + 0.5),
    );

    const nRotX = layeredNoise(t * bn.rotSpeed, NOISE_FREQS[3]) * noiseMul;
    const nRotY = layeredNoise(t * bn.rotSpeed, NOISE_FREQS[4]) * noiseMul;
    const nRotZ = layeredNoise(t * bn.rotSpeed, NOISE_FREQS[5]) * noiseMul;
    this.skeleton.group.rotation.set(
      THREE.MathUtils.lerp(bn.rotMinX, bn.rotMaxX, nRotX * 0.5 + 0.5) + tiltBias,
      THREE.MathUtils.lerp(bn.rotMinY, bn.rotMaxY, nRotY * 0.5 + 0.5),
      THREE.MathUtils.lerp(bn.rotMinZ, bn.rotMaxZ, nRotZ * 0.5 + 0.5),
    );

    // --- Update skeleton limbs via IK ---
    // Foot targets are in player-local space, but the skeleton.group now has
    // its own position/rotation from the noise. Transform foot targets into
    // skeleton.group-local space so feet stay planted on the ground.
    const skelGroup = this.skeleton.group;
    skelGroup.updateMatrixWorld(true);
    const invSkelLocal = new THREE.Matrix4().copy(skelGroup.matrix).invert();

    const bodyPos = this.mesh.position;
    const yaw = this.yaw;
    for (let i = 0; i < 6; i++) {
      const footLocal = this.walk.getFootLocal(i, bodyPos, yaw);
      footLocal.applyMatrix4(invSkelLocal);
      this.skeleton.updateLimb(i, footLocal);
    }
  }

  /** Register meshes that act as walkable ground for raycasting. */
  setGroundMeshes(meshes) {
    this.groundMeshes = meshes;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
  }
}

// Will be set from main.jsx so the controller can check pointer lock
export let renderer_domElement = null;
export function setRendererDomElement(el) { renderer_domElement = el; }
