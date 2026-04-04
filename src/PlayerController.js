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
const _tmpV3  = new THREE.Vector3();
const _tmpV3b = new THREE.Vector3();
const _yAxis  = new THREE.Vector3(0, 1, 0);
const _forward  = new THREE.Vector3();
const _rightDir = new THREE.Vector3();
const _inputDir = new THREE.Vector3();
const _candidatePos = new THREE.Vector3();
const _bodyForward = new THREE.Vector3();
const _bodyRight = new THREE.Vector3();
const _rotMat = new THREE.Matrix4();
const _invSkelLocal = new THREE.Matrix4();
const _footTmp = new THREE.Vector3();
const _pcHitsArray = [];  // reusable array for intersectObjects

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
    this.maxStepHeight = 1.2; // max height difference the body can climb onto

    // ── Body orientation (quaternion-based for wall climbing) ──
    this._bodyUp = new THREE.Vector3(0, 1, 0);        // current smooth body "up"
    this._targetUp = new THREE.Vector3(0, 1, 0);      // target up from foot plane
    this._bodyQuat = new THREE.Quaternion();            // full body orientation
    this._targetQuat = new THREE.Quaternion();          // stable target quat for walk homes
    this.bodyOrientSmooth = 5;                          // slerp speed for body normal alignment
    this.bodyPosSmooth = 10;                            // how fast body position adapts to surface

    // ── Climb facing: spine follows movement direction on walls ──
    this._climbFacing = new THREE.Vector3(0, 1, 0);    // smoothed movement direction on wall
    this.climbFacingSmooth = 14;                         // how fast facing tracks movement dir

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
    const k = this._keys;

    // Build movement direction relative to facing (yaw only for input)
    let fwd = 0;
    let right = 0;
    if (k['KeyW'] || k['ArrowUp'])    fwd += 1;
    if (k['KeyS'] || k['ArrowDown'])  fwd -= 1;
    if (k['KeyA'] || k['ArrowLeft'])  right += 1;
    if (k['KeyD'] || k['ArrowRight']) right -= 1;

    // Build input direction — different model for climbing vs ground
    const up = this._bodyUp;

    if (this.walk.climbing) {
      // Wall-space 2D movement: W/S = up/down the wall, A/D = sideways on the wall.
      // "Forward" on the wall = world-up projected onto the wall plane.
      const wn = this.walk._climbNormal;
      _forward.set(0, 1, 0).sub(_tmpV3.copy(wn).multiplyScalar(wn.y));
      if (_forward.lengthSq() < 0.001) {
        // Ceiling / floor edge-case: fall back to camera forward projected onto surface
        _forward.set(0, 0, 1).applyAxisAngle(_yAxis, this.yaw);
        _forward.sub(_tmpV3.copy(wn).multiplyScalar(_forward.dot(wn)));
      }
      _forward.normalize();

      // "Right" = perpendicular to forward and normal, oriented to match camera's right
      _rightDir.crossVectors(wn, _forward).normalize();
      _tmpV3.set(1, 0, 0).applyAxisAngle(_yAxis, this.yaw); // camera right
      if (_rightDir.dot(_tmpV3) < 0) _rightDir.negate();
    } else {
      // Ground: camera yaw drives direction
      _forward.set(0, 0, 1).applyAxisAngle(_yAxis, this.yaw);
      _rightDir.set(1, 0, 0).applyAxisAngle(_yAxis, this.yaw);

      _forward.sub(_tmpV3.copy(up).multiplyScalar(_forward.dot(up)));
      if (_forward.lengthSq() < 0.001) {
        _forward.set(1, 0, 0).applyAxisAngle(_yAxis, this.yaw);
        _forward.sub(_tmpV3.copy(up).multiplyScalar(_forward.dot(up)));
      }
      _forward.normalize();
      _rightDir.sub(_tmpV3.copy(up).multiplyScalar(_rightDir.dot(up)));
      if (_rightDir.lengthSq() < 0.001) _rightDir.crossVectors(up, _forward);
      _rightDir.normalize();
    }

    _inputDir.set(0, 0, 0);
    if (fwd !== 0 || right !== 0) {
      _inputDir.addScaledVector(_forward, fwd);
      _inputDir.addScaledVector(_rightDir, right);
      _inputDir.normalize();
    }

    // Drive the walk system (pass yaw explicitly so walk doesn't depend on Euler decomposition)
    // When climbing, the walk system needs the body quaternion for home rotation
    this.walk.setInput(_inputDir);
    this.walk.setBodyUp(this._bodyUp);
    this.walk.setBodyQuaternion(this.walk.climbing ? this._targetQuat : this.mesh.quaternion);
    const { movedDelta } = this.walk.update(dt, this.mesh, this.groundMeshes, this.yaw);

    // Apply body movement — check step height limit (skip when climbing)
    if (movedDelta.lengthSq() > 0.0001) {
      _candidatePos.copy(this.mesh.position).add(movedDelta);

      if (this.walk.climbing) {
        // Move along wall, then constrain to prevent clipping
        this.mesh.position.copy(_candidatePos);
        // Anti-clip: push body back if it penetrates the surface
        const wn = this.walk._climbNormal;
        _tmpV3.copy(this.mesh.position).addScaledVector(wn, 2);
        _raycaster.set(_tmpV3, _tmpV3b.copy(wn).negate());
        _raycaster.far = 5;
        _pcHitsArray.length = 0;
        _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
        if (_pcHitsArray.length > 0 && _pcHitsArray[0].object.userData.climbable) {
          _tmpV3.subVectors(this.mesh.position, _pcHitsArray[0].point);
          const surfDist = _tmpV3.dot(wn);
          if (surfDist < 0.05) {
            this.mesh.position.addScaledVector(wn, 0.05 - surfDist);
          }
        }
      } else {
        // Cast a ray from candidate position along -bodyUp to find the surface
        _raycaster.set(
          _tmpV3.copy(_candidatePos).addScaledVector(up, 2),
          _tmpV3b.copy(up).negate()
        );
        _raycaster.far = 10;
        _pcHitsArray.length = 0;
        _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
        if (_pcHitsArray.length > 0) {
          const surfaceY = _pcHitsArray[0].point.y;
          const currentSurfaceY = this.mesh.position.y;
          const heightDiff = surfaceY - currentSurfaceY;
          if (heightDiff > this.maxStepHeight) {
            movedDelta.set(0, 0, 0);
          } else {
            this.mesh.position.copy(_candidatePos);
          }
        } else {
          this.mesh.position.copy(_candidatePos);
        }
      }
    }

    // ── Body orientation from foot plane / wall normal ──
    const footPlane = this.walk.getFootPlane();

    if (this.walk.climbing) {
      // When climbing, body "up" is the wall's outward normal
      this._targetUp.copy(this.walk._climbNormal);
    } else {
      this._targetUp.copy(footPlane.normal);
    }

    // Smoothly interpolate body up toward the target surface normal
    // Use faster rate during edge-wrap transitions so orientation snaps quickly
    const orientRate = this.walk._wrappedEdge ? 25 : this.bodyOrientSmooth;
    const tiltAlpha = Math.min(1, orientRate * dt);
    this._bodyUp.lerp(this._targetUp, tiltAlpha).normalize();

    // Build body quaternion in two stages:
    // 1) Yaw is applied IMMEDIATELY (mouse-driven, must feel instant)
    // 2) Surface tilt is smoothed via _bodyUp lerp above

    if (this.walk.climbing) {
      // On a wall: spine follows the movement direction, not the camera
      // Update climb facing when there's input
      if (_inputDir.lengthSq() > 0.001) {
        // Project input onto wall plane (remove component along wall normal)
        _tmpV3.copy(_inputDir);
        _tmpV3.sub(_tmpV3b.copy(this._bodyUp).multiplyScalar(_tmpV3.dot(this._bodyUp)));
        if (_tmpV3.lengthSq() > 0.001) {
          _tmpV3.normalize();
          const facingAlpha = Math.min(1, this.climbFacingSmooth * dt);
          this._climbFacing.lerp(_tmpV3, facingAlpha).normalize();
        }
      }
      _bodyForward.copy(this._climbFacing);
      // Ensure it's orthogonal to bodyUp
      _bodyForward.sub(_tmpV3.copy(this._bodyUp).multiplyScalar(_bodyForward.dot(this._bodyUp)));
      if (_bodyForward.lengthSq() < 0.001) _bodyForward.set(0, 1, 0); // default: up on wall
      _bodyForward.normalize();
    } else {
      // On ground: spine follows camera yaw instantly
      _bodyForward.set(0, 0, 1).applyAxisAngle(_yAxis, this.yaw);
      _bodyForward.sub(_tmpV3.copy(this._bodyUp).multiplyScalar(_bodyForward.dot(this._bodyUp)));
      if (_bodyForward.lengthSq() < 0.001) {
        _bodyForward.set(1, 0, 0).applyAxisAngle(_yAxis, this.yaw);
        _bodyForward.sub(_tmpV3.copy(this._bodyUp).multiplyScalar(_bodyForward.dot(this._bodyUp)));
      }
      _bodyForward.normalize();
      // Keep climbFacing in sync so it's ready when we enter climb
      this._climbFacing.copy(_bodyForward);
    }
    _bodyRight.crossVectors(this._bodyUp, _bodyForward).normalize();
    _bodyForward.crossVectors(_bodyRight, this._bodyUp).normalize();

    _rotMat.makeBasis(_bodyRight, this._bodyUp, _bodyForward);
    this.mesh.quaternion.setFromRotationMatrix(_rotMat);

    // Build stable target quaternion for walk home computation (prevents stationary twitching)
    if (this.walk.climbing) {
      _tmpV3.copy(this._climbFacing);
      _tmpV3.sub(_tmpV3b.copy(this._targetUp).multiplyScalar(_tmpV3.dot(this._targetUp)));
      if (_tmpV3.lengthSq() < 0.001) _tmpV3.set(0, 1, 0);
      _tmpV3.normalize();
      _tmpV3b.crossVectors(this._targetUp, _tmpV3).normalize();
      _tmpV3.crossVectors(_tmpV3b, this._targetUp).normalize();
      _rotMat.makeBasis(_tmpV3b, this._targetUp, _tmpV3);
      this._targetQuat.setFromRotationMatrix(_rotMat);
    }

    // Smooth body height along the body's up axis toward the foot plane.
    // Horizontal position stays delta-driven; only height tracks the surface.
    const footCentroid = footPlane.centroid;
    const targetHeight = footCentroid.dot(this._bodyUp) + this.skeleton.spineHeight;
    const currentHeight = this.mesh.position.dot(this._bodyUp);
    const heightDiff = targetHeight - currentHeight;
    // Deadband: skip tiny adjustments to prevent correction-loop feedback on walls
    if (Math.abs(heightDiff) > 0.01) {
      const posAlpha = Math.min(1, this.bodyPosSmooth * dt);
      this.mesh.position.addScaledVector(this._bodyUp, heightDiff * posAlpha);
    }

    // ── Apply body noise to skeleton group ──
    this._noiseElapsed += dt;
    const bn = this.bodyNoise;
    const t = this._noiseElapsed;

    // Smooth the raw input for gentle transitions
    const smoothRate = 6;
    this._smoothFwd   += (fwd   - this._smoothFwd)   * Math.min(1, smoothRate * dt);
    this._smoothRight += (right - this._smoothRight) * Math.min(1, smoothRate * dt);

    // Compute noise damping factor
    const absFwd   = Math.abs(this._smoothFwd);
    const absRight = Math.abs(this._smoothRight);
    const fwdDamp  = 1 - absFwd   * bn.moveDamping;
    const latDamp  = 1 - absRight * bn.lateralDamping;
    const noiseMul = fwdDamp * latDamp;

    // Forward/backward tilt bias
    const tiltBias = this._smoothFwd > 0
      ? this._smoothFwd * bn.fwdTilt
      : this._smoothFwd * -bn.bwdTilt;

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
    // Transform foot targets into skeleton.group-local space
    const skelGroup = this.skeleton.group;
    skelGroup.updateMatrixWorld(true);
    _invSkelLocal.copy(skelGroup.matrix).invert();

    this.walk.cacheBodyInverse(this.mesh);
    for (let i = 0; i < 6; i++) {
      const footLocal = this.walk.getFootLocal(i);
      _footTmp.copy(footLocal).applyMatrix4(_invSkelLocal);
      this.skeleton.updateLimb(i, _footTmp);
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
