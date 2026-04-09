import * as THREE from 'three';

/**
 * Locked third-person camera.
 * Follows the player, rotating with yaw and tilting with pitch.
 * Maintains a world-relative horizon so the camera stays comfortable
 * even when the body tilts on walls/slopes.
 *
 * Features:
 *  - Occlusion fade  (meshes between player & camera go transparent)
 *  - Smooth position follow (exponential lerp)
 */
export class CameraController {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('./PlayerController.js').PlayerController} playerCtrl
   */
  constructor(camera, playerCtrl) {
    this.camera = camera;
    this.playerCtrl = playerCtrl;
    this.target = playerCtrl.mesh;

    // Offset from target in target-local space (behind + above)
    this.offsetX = 0;
    this.offsetY = 3;
    this.offsetZ = -6;
    this._baseOffsetZ = -6;  // Leva default (used by shoot lerp)
    this._baseFOV = 95;      // Leva default (used by shoot lerp)

    // Extra rotation tweaks (degrees) driven by Leva
    this.pan = 0;
    this.tilt = 0;

    // ── Post-orbit offsets (applied AFTER follow + lookAt in camera-local space) ──
    this.postOffsetX = 0;   // camera-local right
    this.postOffsetY = 0;   // camera-local up
    this.postOffsetZ = 0;   // camera-local forward
    this.postRotX = 0;      // pitch offset (degrees)
    this.postRotY = 0;      // yaw offset (degrees)
    this.postRotZ = 0;      // roll offset (degrees)

    // ── Smooth follow (only player position, not orbit) ──
    this.smoothSpeed = 8;          // higher = snappier (units: 1/s)
    this._smoothPlayerPos = new THREE.Vector3();   // smoothed player world pos
    this._smoothLookBase  = new THREE.Vector3();   // smoothed look-at base pos
    this._currentPos = new THREE.Vector3();
    this._currentLookTarget = new THREE.Vector3();
    this._initialised = false;     // snap on first frame

    // ── Velocity clamping (absorbs body spikes) ──
    this.maxCamSpeed = 60;         // max units/s the camera can travel
    this.maxLookSpeed = 60;        // max units/s the look-target can travel
    this.maxLagDistance = 8;       // if smoothed pos lags this far behind, hard-snap

    // ── Occlusion fade ──
    this._raycaster = new THREE.Raycaster();
    this._raycaster.near = 0.05;
    this._groundMeshes = [];

    /** @type {Map<THREE.Mesh, {origOpacity:number, origTransparent:boolean}>} */
    this._fadedMeshes = new Map();  // currently faded meshes → original mat state

    this.fadeOpacity   = 0.15;     // target opacity when occluding
    this.fadeSpeed     = 10;       // lerp speed for fade in/out (1/s)

    // ── Ground avoidance ──
    this.groundClearance = 0.3;    // min height above ground surface
    this.groundTiltMax   = 60;     // max upward tilt (degrees)
    this._groundRay = new THREE.Raycaster();
    this._groundRay.near = 0;
    this._groundRay.far  = 50;
  }

  /** Provide the array of scene meshes used for occlusion raycasting. */
  setGroundMeshes(meshes) {
    this._groundMeshes = meshes;
  }

  /**
   * Call once per frame.
   * @param {number} dt – frame delta in seconds
   */
  update(dt = 0.016) {
    const yaw = this.playerCtrl.yaw;
    const pitch = this.playerCtrl.pitch;

    // ── 1. Compute desired camera offset ──
    const offset = new THREE.Vector3(this.offsetX, this.offsetY, this.offsetZ);
    offset.applyAxisAngle(_UP, yaw);

    const right = _RIGHT.clone().applyAxisAngle(_UP, yaw);

    // Save yaw-rotated offset BEFORE pitch is applied (needed for ground search)
    _baseOffset.copy(offset);

    offset.applyAxisAngle(right, -pitch * 0.7);

    const desiredPos = this.target.position.clone().add(offset);

    // Look target: slightly above player centre (world up)
    const lookTarget = this.target.position.clone();
    lookTarget.y += 1.2;

    // ── 2. Occlusion fade ──
    this._updateOcclusionFade(lookTarget, desiredPos, dt);

    // ── 3. Follow with split smoothing ──
    if (!this._initialised) {
      this._smoothPlayerPos.copy(this.target.position);
      this._smoothLookBase.copy(this.target.position);
      this._initialised = true;
    } else {
      const alpha = 1 - Math.exp(-this.smoothSpeed * dt);

      _tmpVec.copy(this.target.position).sub(this._smoothPlayerPos).multiplyScalar(alpha);
      const posDist = _tmpVec.length();
      const maxPosDelta = this.maxCamSpeed * dt;
      if (posDist > maxPosDelta) _tmpVec.multiplyScalar(maxPosDelta / posDist);
      this._smoothPlayerPos.add(_tmpVec);

      _tmpVec.copy(this.target.position).sub(this._smoothLookBase).multiplyScalar(alpha);
      const lookDist = _tmpVec.length();
      const maxLookDelta = this.maxLookSpeed * dt;
      if (lookDist > maxLookDelta) _tmpVec.multiplyScalar(maxLookDelta / lookDist);
      this._smoothLookBase.add(_tmpVec);

      const lagDist = this._smoothPlayerPos.distanceTo(this.target.position);
      if (lagDist > this.maxLagDistance) {
        this._smoothPlayerPos.copy(this.target.position);
        this._smoothLookBase.copy(this.target.position);
      }
    }

    // ── 4. Ground-aware offset ──
    // Orbit freely until the arc goes below ground.  When it does,
    // binary-search for the pitch angle at ground contact, freeze the
    // camera there, and convert excess pitch → upward tilt.
    let groundTiltDeg = 0;
    let finalOffset = offset;  // default: full orbit

    if (this._groundMeshes.length > 0) {
      // Raycast down from player position to get a stable ground height
      // (player XZ doesn't change with pitch, so this is consistent)
      _rayOrigin.copy(this._smoothPlayerPos);
      _rayOrigin.y += 20;
      _downDir.set(0, -1, 0);
      this._groundRay.set(_rayOrigin, _downDir);
      const hits = this._groundRay.intersectObjects(this._groundMeshes, false);
      if (hits.length > 0) {
        const minY = hits[0].point.y + this.groundClearance;
        const desiredY = this._smoothPlayerPos.y + offset.y;
        if (desiredY < minY) {
          // Binary search: find max pitch where camera stays above minY
          let lo = 0, hi = pitch;
          for (let i = 0; i < 12; i++) {
            const mid = (lo + hi) * 0.5;
            _tmpVec2.copy(_baseOffset).applyAxisAngle(right, -mid * 0.7);
            const testY = this._smoothPlayerPos.y + _tmpVec2.y;
            if (testY < minY) hi = mid;
            else lo = mid;
          }
          // Recompute offset at the ground-contact pitch
          _tmpVec2.copy(_baseOffset).applyAxisAngle(right, -lo * 0.7);
          finalOffset = _tmpVec2;

          // Excess pitch beyond contact → tilt (with orbit multiplier)
          const excessAngle = (pitch - lo) * 0.7;
          groundTiltDeg = Math.min(
            this.groundTiltMax,
            THREE.MathUtils.radToDeg(excessAngle)
          );
        }
      }
    }

    // Set camera position from smoothed player pos + (possibly limited) offset
    this._currentPos.copy(this._smoothPlayerPos).add(finalOffset);
    this._currentLookTarget.copy(this._smoothLookBase);
    this._currentLookTarget.y += 1.2;

    this.camera.position.copy(this._currentPos);

    // ── 5. Look at player ──
    this.camera.lookAt(this._currentLookTarget);

    // Apply Leva-driven pan / tilt tweaks
    if (this.pan !== 0) {
      _quatLocal.setFromAxisAngle(_UP, THREE.MathUtils.degToRad(this.pan));
      this.camera.quaternion.premultiply(_quatLocal);
    }
    if (this.tilt !== 0) {
      _quatLocal.setFromAxisAngle(_localX, THREE.MathUtils.degToRad(-this.tilt));
      this.camera.quaternion.multiply(_quatLocal);
    }

    // ── Post-orbit offsets (camera-local space) ──
    if (this.postOffsetX !== 0 || this.postOffsetY !== 0 || this.postOffsetZ !== 0) {
      _tmpVec.set(this.postOffsetX, this.postOffsetY, this.postOffsetZ);
      _tmpVec.applyQuaternion(this.camera.quaternion);
      this.camera.position.add(_tmpVec);
    }
    if (this.postRotX !== 0) {
      _quatLocal.setFromAxisAngle(_localX, THREE.MathUtils.degToRad(this.postRotX));
      this.camera.quaternion.multiply(_quatLocal);
    }
    if (this.postRotY !== 0) {
      _quatLocal.setFromAxisAngle(_localY, THREE.MathUtils.degToRad(this.postRotY));
      this.camera.quaternion.multiply(_quatLocal);
    }
    if (this.postRotZ !== 0) {
      _quatLocal.setFromAxisAngle(_localZ, THREE.MathUtils.degToRad(this.postRotZ));
      this.camera.quaternion.multiply(_quatLocal);
    }

    // ── Apply ground tilt (local pitch upward, after all other rotations) ──
    if (groundTiltDeg > 0.01) {
      _quatLocal.setFromAxisAngle(_localX, THREE.MathUtils.degToRad(groundTiltDeg));
      this.camera.quaternion.multiply(_quatLocal);
    }
  }

  // ───────────────────────────────────────────
  //  Occlusion fade internals
  // ───────────────────────────────────────────

  /**
   * Raycast from lookTarget → camera.  Any mesh hit gets faded out.
   * Meshes no longer occluding are faded back in and cleaned up.
   */
  _updateOcclusionFade(lookTarget, cameraPos, dt) {
    const dir = _tmpVec.copy(cameraPos).sub(lookTarget);
    const maxDist = dir.length();
    if (maxDist < 0.001) return;

    dir.divideScalar(maxDist);
    this._raycaster.set(lookTarget, dir);
    this._raycaster.far = maxDist;

    const hits = this._raycaster.intersectObjects(this._groundMeshes, false);

    // Collect the set of currently-occluding meshes
    const occluding = new Set();
    for (const hit of hits) {
      const mesh = hit.object;
      if (!mesh.isMesh) continue;
      occluding.add(mesh);

      // If not already tracked, store original material state
      if (!this._fadedMeshes.has(mesh)) {
        const mat = mesh.material;
        this._fadedMeshes.set(mesh, {
          origOpacity: mat.opacity,
          origTransparent: mat.transparent,
        });
        // Enable transparency so opacity changes are visible
        mat.transparent = true;
      }
    }

    const fadeAlpha = 1 - Math.exp(-this.fadeSpeed * dt);

    // Fade occluding meshes toward fadeOpacity
    for (const mesh of occluding) {
      const mat = mesh.material;
      mat.opacity += (this.fadeOpacity - mat.opacity) * fadeAlpha;
    }

    // Fade non-occluding meshes back toward original opacity
    for (const [mesh, orig] of this._fadedMeshes) {
      if (occluding.has(mesh)) continue;

      const mat = mesh.material;
      mat.opacity += (orig.origOpacity - mat.opacity) * fadeAlpha;

      // Once nearly restored, snap back fully and clean up
      if (Math.abs(mat.opacity - orig.origOpacity) < 0.01) {
        mat.opacity = orig.origOpacity;
        mat.transparent = orig.origTransparent;
        this._fadedMeshes.delete(mesh);
      }
    }
  }
}

// Reusable temporaries (avoid per-frame allocations)
const _UP = new THREE.Vector3(0, 1, 0);
const _RIGHT = new THREE.Vector3(1, 0, 0);
const _tmpVec = new THREE.Vector3();
const _tmpVec2 = new THREE.Vector3();
const _baseOffset = new THREE.Vector3();
const _downDir = new THREE.Vector3(0, -1, 0);
const _rayOrigin = new THREE.Vector3();
const _quatLocal = new THREE.Quaternion();
const _localX = new THREE.Vector3(1, 0, 0);
const _localY = new THREE.Vector3(0, 1, 0);
const _localZ = new THREE.Vector3(0, 0, 1);
