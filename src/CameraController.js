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
    this.groundTiltMax   = 45;     // max upward tilt (degrees)
    this._groundRay = new THREE.Raycaster();
    this._groundRay.near = 0;
    this._groundRay.far  = 50;
    this._groundTilt = 0;          // accumulated tilt in degrees
    this._prevPitch = 0;           // pitch last frame for delta tracking
    this._onGround = false;        // was camera on ground last frame
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

    // ── 1. Compute desired camera position ──
    const offset = new THREE.Vector3(this.offsetX, this.offsetY, this.offsetZ);
    offset.applyAxisAngle(_UP, yaw);

    const right = _RIGHT.clone().applyAxisAngle(_UP, yaw);
    offset.applyAxisAngle(right, -pitch * 0.7);

    const desiredPos = this.target.position.clone().add(offset);

    // Look target: slightly above player centre (world up)
    const lookTarget = this.target.position.clone();
    lookTarget.y += 1.2;

    // ── 2. Occlusion fade ──
    this._updateOcclusionFade(lookTarget, desiredPos, dt);

    // ── 3. Follow with split smoothing ──
    // Orbit (yaw/pitch driven) is INSTANT — no lag on mouse/trackpad input.
    // Only the player's world position is smoothed so body movement spikes
    // don't jerk the camera.
    if (!this._initialised) {
      this._smoothPlayerPos.copy(this.target.position);
      this._smoothLookBase.copy(this.target.position);
      this._initialised = true;
    } else {
      const alpha = 1 - Math.exp(-this.smoothSpeed * dt);

      // Smooth only the player's world position (translation follow)
      _tmpVec.copy(this.target.position).sub(this._smoothPlayerPos).multiplyScalar(alpha);
      const posDist = _tmpVec.length();
      const maxPosDelta = this.maxCamSpeed * dt;
      if (posDist > maxPosDelta) _tmpVec.multiplyScalar(maxPosDelta / posDist);
      this._smoothPlayerPos.add(_tmpVec);

      // Same for look base
      _tmpVec.copy(this.target.position).sub(this._smoothLookBase).multiplyScalar(alpha);
      const lookDist = _tmpVec.length();
      const maxLookDelta = this.maxLookSpeed * dt;
      if (lookDist > maxLookDelta) _tmpVec.multiplyScalar(maxLookDelta / lookDist);
      this._smoothLookBase.add(_tmpVec);

      // Hard-snap fallback: if smoothed position lags too far behind the
      // actual player (e.g. during high fall velocity), teleport to catch up.
      const lagDist = this._smoothPlayerPos.distanceTo(this.target.position);
      if (lagDist > this.maxLagDistance) {
        this._smoothPlayerPos.copy(this.target.position);
        this._smoothLookBase.copy(this.target.position);
      }
    }

    // Recompute camera position from smoothed player pos + instant orbit offset
    this._currentPos.copy(this._smoothPlayerPos).add(offset);
    this._currentLookTarget.copy(this._smoothLookBase);
    this._currentLookTarget.y += 1.2;

    this.camera.position.copy(this._currentPos);

    // ── 4. Look at player ──
    this.camera.lookAt(this._currentLookTarget);

    // Apply Leva-driven pan / tilt tweaks
    // Pan = rotate around world Y (premultiply), Tilt = local pitch (multiply)
    if (this.pan !== 0) {
      _quatLocal.setFromAxisAngle(_UP, THREE.MathUtils.degToRad(this.pan));
      this.camera.quaternion.premultiply(_quatLocal);
    }
    if (this.tilt !== 0) {
      _quatLocal.setFromAxisAngle(_localX, THREE.MathUtils.degToRad(-this.tilt));
      this.camera.quaternion.multiply(_quatLocal);
    }

    // ── Post-orbit offsets (camera-local space) ──
    // Position: translate along the camera's own axes
    if (this.postOffsetX !== 0 || this.postOffsetY !== 0 || this.postOffsetZ !== 0) {
      _tmpVec.set(this.postOffsetX, this.postOffsetY, this.postOffsetZ);
      _tmpVec.applyQuaternion(this.camera.quaternion);
      this.camera.position.add(_tmpVec);
    }
    // Rotation: post-rotation offsets in local space
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

    // ── Ground avoidance (runs LAST, after all offsets) ──
    let grounded = false;
    if (this._groundMeshes.length > 0) {
      _rayOrigin.copy(this.camera.position);
      _rayOrigin.y += 20;
      _downDir.set(0, -1, 0);
      this._groundRay.set(_rayOrigin, _downDir);
      const hits = this._groundRay.intersectObjects(this._groundMeshes, false);
      if (hits.length > 0) {
        const minY = hits[0].point.y + this.groundClearance;
        if (this.camera.position.y < minY) {
          this.camera.position.y = minY;
          grounded = true;
        }
      }
    }

    // Accumulate tilt: while grounded, any downward pitch delta adds tilt
    const pitchDelta = pitch - this._prevPitch; // positive = looking further down
    this._prevPitch = pitch;

    if (grounded || this._onGround) {
      if (pitchDelta > 0) {
        // User is pushing down while on ground → add tilt
        this._groundTilt += THREE.MathUtils.radToDeg(pitchDelta) * 1.0;
      } else if (pitchDelta < 0) {
        // User is pulling up → remove tilt first before camera moves
        this._groundTilt += THREE.MathUtils.radToDeg(pitchDelta) * 1.0;
      }
    }

    // Decay tilt when NOT grounded
    if (!grounded) {
      this._groundTilt *= Math.exp(-8 * dt); // fast decay
      if (Math.abs(this._groundTilt) < 0.1) this._groundTilt = 0;
    }

    // Clamp tilt
    this._groundTilt = Math.max(0, Math.min(this.groundTiltMax, this._groundTilt));
    this._onGround = grounded;

    // Apply tilt (local pitch upward)
    if (this._groundTilt > 0.01) {
      _quatLocal.setFromAxisAngle(_localX, -THREE.MathUtils.degToRad(this._groundTilt));
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
const _downDir = new THREE.Vector3(0, -1, 0);
const _rayOrigin = new THREE.Vector3();
const _quatLocal = new THREE.Quaternion();
const _localX = new THREE.Vector3(1, 0, 0);
const _localY = new THREE.Vector3(0, 1, 0);
const _localZ = new THREE.Vector3(0, 0, 1);
