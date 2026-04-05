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

    // ── Smooth follow ──
    this.smoothSpeed = 8;          // higher = snappier (units: 1/s)
    this._currentPos = new THREE.Vector3();
    this._initialised = false;     // snap on first frame

    // ── Occlusion fade ──
    this._raycaster = new THREE.Raycaster();
    this._raycaster.near = 0.05;
    this._groundMeshes = [];

    /** @type {Map<THREE.Mesh, {origOpacity:number, origTransparent:boolean}>} */
    this._fadedMeshes = new Map();  // currently faded meshes → original mat state

    this.fadeOpacity   = 0.15;     // target opacity when occluding
    this.fadeSpeed     = 10;       // lerp speed for fade in/out (1/s)
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
    offset.applyAxisAngle(right, -pitch * 0.5);

    const desiredPos = this.target.position.clone().add(offset);

    // Look target: slightly above player centre (world up)
    const lookTarget = this.target.position.clone();
    lookTarget.y += 1.2;

    // ── 2. Occlusion fade ──
    this._updateOcclusionFade(lookTarget, desiredPos, dt);

    // ── 3. Smooth follow (lerp toward desired) ──
    if (!this._initialised) {
      this._currentPos.copy(desiredPos);
      this._initialised = true;
    } else {
      const alpha = 1 - Math.exp(-this.smoothSpeed * dt);
      this._currentPos.lerp(desiredPos, alpha);
    }

    this.camera.position.copy(this._currentPos);

    // ── 4. Look at player ──
    this.camera.lookAt(lookTarget);

    // Apply Leva-driven pan / tilt tweaks
    this.camera.rotation.y += THREE.MathUtils.degToRad(this.pan);
    this.camera.rotation.x += THREE.MathUtils.degToRad(-this.tilt);
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
