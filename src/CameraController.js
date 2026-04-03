import * as THREE from 'three';

/**
 * Locked third-person camera.
 * Stays at a fixed offset behind the player, rotating with the player's yaw.
 * Pitch from the player controller tilts the camera up/down.
 * X/Y/Z offset, pan, tilt, and FOV are tunable via Leva.
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
  }

  /** Call once per frame. */
  update() {
    const yaw = this.playerCtrl.yaw;
    const pitch = this.playerCtrl.pitch;

    // Compute offset rotated by the player's yaw
    const offset = new THREE.Vector3(this.offsetX, this.offsetY, this.offsetZ);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

    // Tilt the offset up/down by the pitch so the camera arcs when looking up/down
    const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    offset.applyAxisAngle(right, -pitch * 0.5);

    const desiredPos = this.target.position.clone().add(offset);
    this.camera.position.copy(desiredPos);

    // Look target: slightly above player centre, shifted forward by pitch
    const lookTarget = this.target.position.clone();
    lookTarget.y += 1.2;
    this.camera.lookAt(lookTarget);

    // Apply Leva-driven pan / tilt tweaks
    this.camera.rotation.y += THREE.MathUtils.degToRad(this.pan);
    this.camera.rotation.x += THREE.MathUtils.degToRad(-this.tilt);
  }
}
