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
const _nodeWorld = new THREE.Vector3();
const _defaultWallFwd = new THREE.Vector3();
const _pcHitsArray = [];  // reusable array for intersectObjects

// ── Joint collision resolution helpers ──
const _probeOrig = new THREE.Vector3();
const _probeNeg  = new THREE.Vector3();
const _jointW    = new THREE.Vector3();
const JOINT_MIN_CLEARANCE = 0.12; // minimum distance spine nodes keep from wall surfaces
const JOINT_PROBE_LEN     = 3.0;  // how far outside each joint to start the probe ray

// ── Edge transition helpers ──
const _edgePos     = new THREE.Vector3(); // edge point (top of wall face)
const _wallTarget  = new THREE.Vector3(); // target body pos on wall
const _transStart  = new THREE.Vector3(); // body pos at transition start
const _legTargets  = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _edgeWallNrm = new THREE.Vector3(); // wall normal during transition
const _bzA = new THREE.Vector3();
const _bzB = new THREE.Vector3();
const _bzC = new THREE.Vector3();

/**
 * Evaluate a cubic Bezier curve at parameter t ∈ [0,1].
 * B(t) = (1-t)³·P0 + 3(1-t)²t·P1 + 3(1-t)t²·P2 + t³·P3
 * Result is written to `out`.
 */
function evalBezier(out, p0, p1, p2, p3, t) {
  const u = 1 - t;
  const uu = u * u;
  const uuu = uu * u;
  const tt = t * t;
  const ttt = tt * t;
  out.set(
    uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
    uuu * p0.z + 3 * uu * t * p1.z + 3 * u * tt * p2.z + ttt * p3.z,
  );
  return out;
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
    this.maxStepHeight = 1.2; // max height difference the body can climb onto

    // ── Edge commitment: prevents accidental wall transitions ──
    this._edgePushTime = 0;           // seconds spent pushing into an edge
    this._edgeCommitThreshold = 0.03; // seconds of sustained push before allowing wall transition

    // ── Transition cooldown: prevents rapid state oscillation near complex geometry ──
    this._transitionCooldown = 0;
    this._transitionCooldownDuration = 0.05;

    // ── Unified surface transition FSM ──
    // 3-phase (scout → bridge → complete) with cubic Bezier body path.
    // Handles wall→ground, wall→top, and ledge→wall transitions.
    this._transition = null;           // null | { type, phase }
    this._transPhaseDuration = 0.02;   // seconds per phase
    this._transTimer = 0;
    // Bezier control points: P0 = start, P1 = lift-off handle, P2 = approach handle, P3 = end
    this._transP0 = new THREE.Vector3();
    this._transP1 = new THREE.Vector3();
    this._transP2 = new THREE.Vector3();
    this._transP3 = new THREE.Vector3();
    this._transStartUp   = new THREE.Vector3();
    this._transEndUp     = new THREE.Vector3();
    this._transSrcNormal = new THREE.Vector3(); // source surface normal
    this._transDstNormal = new THREE.Vector3(); // destination surface normal

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

    // ── Momentum-carry for wall transitions ──
    this._climbWallFwd = new THREE.Vector3(0, 1, 0);   // current "forward" on the wall surface
    this._wasClimbing = false;                           // track climb entry
    this._climbIdleTime = 0;                             // seconds idle while climbing
    this._climbResetTime = 0.4;                          // idle time before forward resets to default
    this._prevInputDir = new THREE.Vector3();            // last frame's movement direction

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
      // Expand pitch range on steep surfaces (walls) so camera can look further down
      const steepness = 1 - Math.abs(this._bodyUp.y); // 0 on flat ground, ~1 on vertical wall
      const maxPitch = Math.PI / 3 + steepness * Math.PI / 4; // 60° normally, up to 105° on walls
      this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));
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

    // Build input direction — camera-yaw based, projected onto current surface
    const up = this._bodyUp;

    {
      // Full camera direction (yaw + pitch) projected onto the body's surface plane.
      // Pitch lets you aim up/down walls; on flat ground its effect is negligible.
      _forward.set(0, 0, 1).applyAxisAngle(_yAxis, this.yaw);
      const cy = Math.cos(this.pitch), sy = Math.sin(this.pitch);
      _forward.x *= cy; _forward.z *= cy; _forward.y = sy;

      _rightDir.set(1, 0, 0).applyAxisAngle(_yAxis, this.yaw); // yaw-only for strafe

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
    // During transition, suppress normal input — forced steps handle feet
    if (this._transition) {
      this.walk.setInput(_tmpV3.set(0, 0, 0));
      this.walk.setSmoothedInput(_tmpV3);
    } else {
      this.walk.setInput(_inputDir);
      // Smoothed input for stride lead (uses previous-frame smooth values — 1-frame lag is fine)
      _tmpV3.set(0, 0, 0);
      if (Math.abs(this._smoothFwd) > 0.01 || Math.abs(this._smoothRight) > 0.01) {
        _tmpV3.addScaledVector(_forward, this._smoothFwd);
        _tmpV3.addScaledVector(_rightDir, this._smoothRight);
        if (_tmpV3.lengthSq() > 0.001) _tmpV3.normalize();
      }
      this.walk.setSmoothedInput(_tmpV3);
    }
    this.walk.setBodyUp(this._bodyUp);
    this.walk.setBodyQuaternion(this.walk.climbing ? this._targetQuat : this.mesh.quaternion);
    const { movedDelta } = this.walk.update(dt, this.mesh, this.groundMeshes, this.yaw);

    // Tick transition cooldown
    if (this._transitionCooldown > 0) this._transitionCooldown -= dt;

    // ── Consume transition requests from ProceduralWalk ──
    if (!this._transition && this._transitionCooldown <= 0 && this.walk._transitionRequest) {
      const req = this.walk._transitionRequest;
      // Gate: require minimum time on surface before allowing wall_to_top
      // Prevents rapid oscillation near complex geometry corners
      if (req.type === 'wall_to_top' && this.walk._climbTime < 0.15) {
        this.walk.clearTransitionRequest(); // discard premature request
      } else {
        this._startTransition(req);
        this.walk.clearTransitionRequest();
        this.walk._inTransition = true;
      }
    }

    // ── Unified transition FSM: if active, it drives body pos/orient and skips normal logic ──
    if (this._updateTransition(dt)) {
      // Transition is driving everything — skip to IK update at the end
      this._noiseElapsed += dt;
      // Still update skeleton IK
      const skelGroup = this.skeleton.group;
      skelGroup.updateMatrixWorld(true);
      _invSkelLocal.copy(skelGroup.matrix).invert();
      this.walk.cacheBodyInverse(this.mesh);
      for (let i = 0; i < 6; i++) {
        const footLocal = this.walk.getFootLocal(i);
        _footTmp.copy(footLocal).applyMatrix4(_invSkelLocal);
        this.skeleton.updateLimb(i, _footTmp);
      }
      return;
    }

    // Reset edge commitment when not actively pushing
    if (_inputDir.lengthSq() < 0.001) this._edgePushTime = 0;

    // Apply body movement — check step height limit (skip when climbing)
    if (movedDelta.lengthSq() > 0.0001) {
      _candidatePos.copy(this.mesh.position).add(movedDelta);

      if (this.walk.climbing) {
        // Move along wall — anti-clip is handled below in the per-spine-node pass
        this.mesh.position.copy(_candidatePos);
      } else {
        // Cast a ray from candidate position along -bodyUp to find the surface
        // Filter to floor-like hits (normal.y > 0.5) and prefer the hit closest
        // to current body Y to avoid snapping onto overhangs above.
        _raycaster.set(
          _tmpV3.copy(_candidatePos).addScaledVector(up, 5),
          _tmpV3b.copy(up).negate()
        );
        _raycaster.far = 15;
        _pcHitsArray.length = 0;
        _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
        let floorHit = null;
        let bestFloorDist = Infinity;
        const currentY = this.mesh.position.y;
        for (let i = 0; i < _pcHitsArray.length; i++) {
          const h = _pcHitsArray[i];
          _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
          if (_tmpV3.y > 0.5) {
            const dy = Math.abs(h.point.y - currentY);
            if (dy < bestFloorDist) {
              bestFloorDist = dy;
              floorHit = h;
            }
          }
        }
        if (floorHit) {
          const surfaceY = floorHit.point.y;
          const currentSurfaceY = this.mesh.position.y;
          const heightDiff = surfaceY - currentSurfaceY;
          if (heightDiff > this.maxStepHeight) {
            // Too high to step up — block
            movedDelta.set(0, 0, 0);
          } else if (heightDiff < -this.maxStepHeight) {
            // Edge detected — accumulate push time before allowing wall transition
            this._edgePushTime += dt;
            if (this._edgePushTime >= this._edgeCommitThreshold) {
              if (!this._tryEdgeClimb(_candidatePos, _inputDir)) {
                movedDelta.set(0, 0, 0); // no wall — block
              } else {
                this._edgePushTime = 0; // reset on successful transition
              }
            } else {
              movedDelta.set(0, 0, 0); // not committed yet — block but keep accumulating
            }
          } else {
            this._edgePushTime = 0; // walking on solid ground — reset
            this.mesh.position.copy(_candidatePos);
          }
        } else {
          // No floor at candidate — accumulate push time
          this._edgePushTime += dt;
          if (this._edgePushTime >= this._edgeCommitThreshold) {
            if (!this._tryEdgeClimb(_candidatePos, _inputDir)) {
              movedDelta.set(0, 0, 0);
            } else {
              this._edgePushTime = 0;
            }
          } else {
            movedDelta.set(0, 0, 0);
          }
        }
      }
    }

    // ── Transition just started by _enterClimbFromEdge? Skip to IK. ──
    // Without this, orientation / height-smoothing / joint-collision would run
    // with climb-mode flags but ground-positioned feet, corrupting body state.
    if (this._transition) {
      this._noiseElapsed += dt;
      const skelGroup = this.skeleton.group;
      skelGroup.updateMatrixWorld(true);
      _invSkelLocal.copy(skelGroup.matrix).invert();
      this.walk.cacheBodyInverse(this.mesh);
      for (let i = 0; i < 6; i++) {
        const footLocal = this.walk.getFootLocal(i);
        _footTmp.copy(footLocal).applyMatrix4(_invSkelLocal);
        this.skeleton.updateLimb(i, _footTmp);
      }
      return;
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
    // Use faster rate during edge-wrap or just-dismounted transitions
    const justDismounted = !this.walk.climbing && this._bodyUp.dot(this._targetUp) < 0.85;
    const orientRate = (this.walk._wrappedEdge || justDismounted) ? 25 : this.bodyOrientSmooth;
    const tiltAlpha = Math.min(1, orientRate * dt);
    this._bodyUp.lerp(this._targetUp, tiltAlpha).normalize();

    // Build body quaternion in two stages:
    // 1) Yaw is applied IMMEDIATELY (mouse-driven, must feel instant)
    // 2) Surface tilt is smoothed via _bodyUp lerp above

    if (this.walk.climbing) {
      // On a wall: spine follows full camera direction (yaw + pitch) projected onto wall plane.
      // Pitch is critical — without it, looking straight at the wall causes a degenerate
      // yaw-only projection that points 90° from the actual movement direction.
      _bodyForward.set(0, 0, 1).applyAxisAngle(_yAxis, this.yaw);
      const bcy = Math.cos(this.pitch), bsy = Math.sin(this.pitch);
      _bodyForward.x *= bcy; _bodyForward.z *= bcy; _bodyForward.y = bsy;
      _bodyForward.sub(_tmpV3.copy(this._bodyUp).multiplyScalar(_bodyForward.dot(this._bodyUp)));
      if (_bodyForward.lengthSq() < 0.001) {
        _bodyForward.set(1, 0, 0).applyAxisAngle(_yAxis, this.yaw);
        _bodyForward.x *= bcy; _bodyForward.z *= bcy; _bodyForward.y = bsy;
        _bodyForward.sub(_tmpV3.copy(this._bodyUp).multiplyScalar(_bodyForward.dot(this._bodyUp)));
      }
      _bodyForward.normalize();
      this._climbFacing.copy(_bodyForward);
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
      // Drop-rate limiter: clamp downward movement to prevent plummeting through surfaces
      const maxDrop = 2.0 * dt; // max 2 units/sec downward
      const rawDelta = heightDiff * posAlpha;
      const clampedDelta = rawDelta < -maxDrop ? -maxDrop : rawDelta;
      this.mesh.position.addScaledVector(this._bodyUp, clampedDelta);
    }

    // ── Body centering on narrow surfaces ──
    // When the surface is narrow, nudge body toward center to prevent edge overshoot
    if (this.walk._targetHipScale < 0.95) {
      const rDist = this.walk._surfaceRightDist;
      const lDist = this.walk._surfaceLeftDist;
      const imbalance = rDist - lDist; // positive = more room on right, push right
      if (Math.abs(imbalance) > 0.05) {
        _bodyRight.crossVectors(this._bodyUp, _bodyForward).normalize();
        const nudge = imbalance * 0.5 * Math.min(1, 5 * dt);
        this.mesh.position.addScaledVector(_bodyRight, nudge);
      }
    }

    // ── Joint collision resolution (climb mode only) ──
    // Prevent spine nodes and body center from penetrating the wall surface
    // during climbing. Only pushes along the wall normal direction.
    // Ground mode is excluded — body centering + hip scaling handle narrow surfaces,
    // and multi-axis probing causes oscillation on narrow wall tops.
    if (this.walk.climbing) {
      this.mesh.updateMatrixWorld(true);
      const skelMW = this.skeleton.group.matrixWorld;
      const wn = this.walk._climbNormal;
      let maxPush = 0;

      const testClimbPoint = (wp) => {
        // Cast from outside the wall toward the point
        _probeOrig.copy(wp).addScaledVector(wn, JOINT_PROBE_LEN);
        _probeNeg.copy(wn).negate();
        _raycaster.set(_probeOrig, _probeNeg);
        _raycaster.far = JOINT_PROBE_LEN * 2;
        _pcHitsArray.length = 0;
        _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
        if (_pcHitsArray.length === 0) return;

        const h = _pcHitsArray[0];
        // Distance from surface to the point along the wall normal
        _probeOrig.subVectors(wp, h.point);
        const d = _probeOrig.dot(wn);
        if (d < JOINT_MIN_CLEARANCE) {
          const push = JOINT_MIN_CLEARANCE - d;
          if (push > maxPush) maxPush = push;
        }
      };

      // Spine nodes
      for (const n of this.skeleton.nodes) {
        _jointW.copy(n).applyMatrix4(skelMW);
        testClimbPoint(_jointW);
      }
      // Body center
      testClimbPoint(this.mesh.position);

      if (maxPush > 0) {
        this.mesh.position.addScaledVector(wn, maxPush);
      }
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

  /**
   * Probe for a climbable wall face when walking off an edge.
   * Casts BACKWARD (opposite to input direction) from below the wall top
   * to find the side-face the player just walked past.
   * Returns true and transitions to climbing if a wall is found.
   */
  _tryEdgeClimb(candidatePos, inputDir) {
    if (inputDir.lengthSq() < 0.001) return false;
    if (this._transitionCooldown > 0) return false;

    // Probe from below the current wall top so the ray hits the side face
    const probeY = this.mesh.position.y - this.skeleton.spineHeight - 0.5;

    // Try 1: cast BACKWARD — the wall face we walked past is behind us
    _tmpV3.set(candidatePos.x, probeY, candidatePos.z);
    _tmpV3b.copy(inputDir).negate().normalize();
    _raycaster.set(_tmpV3, _tmpV3b);
    _raycaster.far = 3.0;
    _pcHitsArray.length = 0;
    _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
    for (let i = 0; i < _pcHitsArray.length; i++) {
      const h = _pcHitsArray[i];
      if (!h.object.userData.climbable) continue;
      _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
      if (Math.abs(_tmpV3.y) > 0.3) continue; // want a vertical wall face
      return this._enterClimbFromEdge(h, _tmpV3);
    }

    // Try 2: cast FORWARD — cliff edge with wall ahead
    _tmpV3.set(candidatePos.x, probeY, candidatePos.z);
    _tmpV3b.copy(inputDir).normalize();
    _raycaster.set(_tmpV3, _tmpV3b);
    _raycaster.far = 3.0;
    _pcHitsArray.length = 0;
    _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
    for (let i = 0; i < _pcHitsArray.length; i++) {
      const h = _pcHitsArray[i];
      if (!h.object.userData.climbable) continue;
      _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
      if (Math.abs(_tmpV3.y) > 0.3) continue;
      return this._enterClimbFromEdge(h, _tmpV3);
    }

    return false;
  }

  /**
   * Start a three-phase transition from a wall top down to the wall face.
   * Uses a cubic Bezier curve that arcs outward around the edge.
   */
  _enterClimbFromEdge(hit, wn) {
    const bodyPos = this.mesh.position;
    const spineH = this.skeleton.spineHeight;

    // The edge point: where the wall top meets the side face
    _edgePos.set(
      hit.point.x + wn.x * 0.05,
      bodyPos.y,
      hit.point.z + wn.z * 0.05
    );

    // Final destination: on the wall face, offset outward by spineHeight
    _wallTarget.set(
      hit.point.x + wn.x * (spineH + 0.15),
      bodyPos.y - spineH * 1.5,
      hit.point.z + wn.z * (spineH + 0.15)
    );

    // Don't flip walk.climbing yet — store pending climb state on the transition.
    // Foot landing snaps need climbDir/climbNormal, but the walk system's orientation
    // and home-position math should stay in ground mode until finalization.
    this.walk._climbTime = 0;
    this.walk._climbNormal.copy(wn);
    this.walk._climbDir.copy(wn).negate();

    // ── Bezier control points ──
    // P0: current position (on top of wall)
    // P1: at the edge, lifted along current up — peels body off the top surface
    // P2: outward from the wall near the end position — guides body along wall normal
    // P3: final position on wall face
    this._transP0.copy(bodyPos);
    this._transP1.copy(_edgePos).addScaledVector(this._bodyUp, spineH * 0.3);
    this._transP2.copy(_wallTarget).addScaledVector(wn, spineH * 0.6);
    this._transP3.copy(_wallTarget);

    this._transition = { type: 'ledge_to_wall', phase: 'scout', pendingClimb: true };
    this._transTimer = 0;
    this._transStartUp.copy(this._bodyUp);
    this._transEndUp.copy(wn);
    this._transSrcNormal.set(0, 1, 0);
    this._transDstNormal.copy(wn);

    // Scout: leading legs reach down onto wall
    this._computeWallFootTargets('A', _wallTarget, wn);
    this.walk.forceStepGroup('A', _legTargets, 0.06);
    this.walk._inTransition = true;

    return true;
  }

  /**
   * Compute 3 foot target positions on the wall face for a given leg group.
   * Positions are arranged around targetPos on the wall plane.
   */
  _computeWallFootTargets(groupName, targetPos, wn) {
    const group = groupName === 'A' ? this.walk.groupA : this.walk.groupB;
    // Body axes on the wall
    _bodyForward.set(0, 0, 1).applyAxisAngle(_yAxis, this.yaw);
    _bodyForward.sub(_tmpV3.copy(wn).multiplyScalar(_bodyForward.dot(wn)));
    if (_bodyForward.lengthSq() < 0.001) {
      _bodyForward.set(1, 0, 0);
      _bodyForward.sub(_tmpV3.copy(wn).multiplyScalar(_bodyForward.dot(wn)));
    }
    _bodyForward.normalize();
    _bodyRight.crossVectors(wn, _bodyForward).normalize();

    for (let g = 0; g < 3; g++) {
      const limb = this.walk.limbs[group[g]];
      // Use home positions scaled by current hipScale, projected onto wall plane
      const hx = limb.home.x * this.walk._hipScale;
      const hz = limb.home.z * this.walk._hipScale;
      _legTargets[g].copy(targetPos)
        .addScaledVector(_bodyRight, hx)
        .addScaledVector(_bodyForward, hz);
      // Place on the actual wall surface
      _rayOrigin.copy(_legTargets[g]).addScaledVector(wn, 1.5);
      _raycaster.set(_rayOrigin, _tmpV3.copy(wn).negate());
      _raycaster.far = 3;
      _pcHitsArray.length = 0;
      _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
      if (_pcHitsArray.length > 0) {
        _legTargets[g].copy(_pcHitsArray[0].point).addScaledVector(wn, 0.02);
      }
    }
  }

  /**
   * Start the unified transition FSM from a ProceduralWalk transition request.
   * Computes cubic Bezier control points that arc the body safely around edges.
   */
  _startTransition(req) {
    const bodyPos = this.mesh.position;
    const spineH = this.skeleton.spineHeight;

    if (req.type === 'wall_to_ground') {
      // Body arcs DOWN from wall face, outward, then settles on ground.
      const groundY = req.point.y;
      // Final position: standing on ground, offset away from wall
      _wallTarget.set(
        bodyPos.x + req.climbNormal.x * (spineH * 0.8),
        groundY + spineH,
        bodyPos.z + req.climbNormal.z * (spineH * 0.8)
      );

      // P0: current wall position
      // P1: push outward from wall (along wall normal) — lifts body off surface
      // P2: above final ground position — guides arc downward
      // P3: standing on ground
      this._transP0.copy(bodyPos);
      this._transP1.copy(bodyPos).addScaledVector(req.climbNormal, spineH * 0.8);
      this._transP2.copy(_wallTarget).addScaledVector(req.normal, spineH * 0.5);
      this._transP3.copy(_wallTarget);

      this._transition = { type: 'wall_to_ground', phase: 'scout' };
      this._transTimer = 0;
      this._transStartUp.copy(this._bodyUp);
      this._transEndUp.copy(req.normal);
      this._transSrcNormal.copy(req.climbNormal);
      this._transDstNormal.copy(req.normal);

      // Scout: leading legs reach down to ground
      this._computeGroundFootTargets('A', _wallTarget, req.normal);
      this.walk.forceStepGroup('A', _legTargets, 0.05);

    } else if (req.type === 'wall_to_top') {
      // Body arcs UP from wall face, over the edge, onto the top surface.
      const topY = req.point.y;
      // Final position: standing on top, inward from edge
      _wallTarget.copy(req.point);
      _wallTarget.y = topY + spineH;
      // Push inward (OPPOSITE to climbNormal since climbNormal points away from wall)
      // On a wall, climbNormal points outward. The top surface is "behind" the normal.
      // So to go inward we move along -climbNormal projected onto the floor plane.
      const inwardX = -req.climbNormal.x;
      const inwardZ = -req.climbNormal.z;
      const inLen = Math.sqrt(inwardX * inwardX + inwardZ * inwardZ);
      if (inLen > 0.01) {
        _wallTarget.x += (inwardX / inLen) * spineH * 0.5;
        _wallTarget.z += (inwardZ / inLen) * spineH * 0.5;
      }

      // P0: current wall position
      // P1: push outward + up from wall — lifts body off and above edge
      // P2: above final position on top — guides body onto surface
      // P3: standing on top
      this._transP0.copy(bodyPos);
      this._transP1.copy(bodyPos)
        .addScaledVector(req.climbNormal, spineH * 0.6)
        .addScaledVector(req.normal, spineH * 0.8);
      this._transP2.copy(_wallTarget).addScaledVector(req.normal, spineH * 0.4);
      this._transP3.copy(_wallTarget);

      this._transition = { type: 'wall_to_top', phase: 'scout' };
      this._transTimer = 0;
      this._transStartUp.copy(this._bodyUp);
      this._transEndUp.copy(req.normal);
      this._transSrcNormal.copy(req.climbNormal);
      this._transDstNormal.copy(req.normal);

      // Scout: leading legs reach up onto the top surface
      this._computeGroundFootTargets('A', _wallTarget, req.normal);
      this.walk.forceStepGroup('A', _legTargets, 0.06);
    }

    // Suppress walk input during transition
    this.walk.setInput(_tmpV3.set(0, 0, 0));
    this.walk.setSmoothedInput(_tmpV3);
  }

  /**
   * Advance the unified 3-phase transition FSM.
   * Body follows a cubic Bezier curve; orientation slerps smoothly across the full duration.
   * Returns true while a transition is active (caller should skip normal update logic).
   */
  _updateTransition(dt) {
    if (!this._transition) return false;

    this._transTimer += dt;
    const t = Math.min(this._transTimer / this._transPhaseDuration, 1);
    // Smooth ease-in-out per phase
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const phase = this._transition.phase;
    const type  = this._transition.type;

    // ── Overall progress across all 3 phases (0..1) ──
    const phaseIdx = phase === 'scout' ? 0 : phase === 'bridge' ? 1 : 2;
    const overallT = (phaseIdx + ease) / 3;

    // ── Body position: evaluate Bezier at overall progress ──
    evalBezier(this.mesh.position, this._transP0, this._transP1, this._transP2, this._transP3, overallT);

    // ── Orientation blend: type-dependent curve ──
    // ledge_to_wall: body stays upright during scout phase, rotates during bridge+complete.
    //   This prevents a jarring 90° snap while the creature is still on the ledge.
    // wall_to_ground/wall_to_top: commit orientation earlier so body looks attached to
    //   the destination surface before the animation ends.
    let orientT;
    if (type === 'ledge_to_wall' || type === 'wall_to_ground') {
      // Delay: no rotation until bridge phase (overallT > 0.33)
      // For ledge_to_wall: body stays upright while scouts reach the wall
      // For wall_to_ground: body stays wall-attached while scouts reach the ground
      orientT = Math.min(1, Math.max(0, (overallT - 0.33) / 0.67));
    } else {
      // wall_to_top: commit earlier so body looks attached before animation ends
      orientT = Math.min(1, overallT * 1.4);
    }
    const smoothOrient = orientT * orientT * (3 - 2 * orientT);
    this._bodyUp.lerpVectors(this._transStartUp, this._transEndUp, smoothOrient).normalize();

    // ── Phase advancement ──
    if (t >= 1) {
      if (phase === 'scout') {
        // Scout complete → Bridge: step the trailing group
        this._transition.phase = 'bridge';
        this._transTimer = 0;
        if (type === 'wall_to_ground') {
          this._computeGroundFootTargets('B', this._transP3, this._transDstNormal);
          this.walk.forceStepGroup('B', _legTargets, 0.05);
        } else if (type === 'wall_to_top') {
          this._computeGroundFootTargets('B', this._transP3, this._transDstNormal);
          this.walk.forceStepGroup('B', _legTargets, 0.06);
        } else if (type === 'ledge_to_wall') {
          this._computeWallFootTargets('B', this._transP3, this._transDstNormal);
          this.walk.forceStepGroup('B', _legTargets, 0.06);
        }
      } else if (phase === 'bridge') {
        // Bridge complete → Complete: final settling, re-step leading group to home
        this._transition.phase = 'complete';
        this._transTimer = 0;
        if (type === 'wall_to_ground' || type === 'wall_to_top') {
          this._computeGroundFootTargets('A', this._transP3, this._transDstNormal);
          this.walk.forceStepGroup('A', _legTargets, 0.04);
        } else if (type === 'ledge_to_wall') {
          this._computeWallFootTargets('A', this._transP3, this._transDstNormal);
          this.walk.forceStepGroup('A', _legTargets, 0.04);
        }
      } else if (phase === 'complete') {
        // ── Transition finished — finalize state ──
        this._finalizeTransition();
      }
    }

    // ── Update body orientation during transition ──
    _bodyForward.set(0, 0, 1).applyAxisAngle(_yAxis, this.yaw);
    _bodyForward.sub(_tmpV3.copy(this._bodyUp).multiplyScalar(_bodyForward.dot(this._bodyUp)));
    if (_bodyForward.lengthSq() < 0.001) {
      _bodyForward.set(1, 0, 0).applyAxisAngle(_yAxis, this.yaw);
      _bodyForward.sub(_tmpV3.copy(this._bodyUp).multiplyScalar(_bodyForward.dot(this._bodyUp)));
    }
    _bodyForward.normalize();
    _bodyRight.crossVectors(this._bodyUp, _bodyForward).normalize();
    _bodyForward.crossVectors(_bodyRight, this._bodyUp).normalize();
    _rotMat.makeBasis(_bodyRight, this._bodyUp, _bodyForward);
    this.mesh.quaternion.setFromRotationMatrix(_rotMat);

    return true;
  }

  /** Finalize the transition: commit climbing state, reset FSM. */
  _finalizeTransition() {
    const type = this._transition.type;

    // Snap body to the exact end position
    this.mesh.position.copy(this._transP3);
    this._bodyUp.copy(this._transEndUp).normalize();
    this._targetUp.copy(this._transEndUp);

    if (type === 'wall_to_ground' || type === 'wall_to_top') {
      // Now on the ground/top surface
      this.walk.climbing = false;
      this.walk._climbTime = 0;
    } else if (type === 'ledge_to_wall') {
      // Now on the wall — commit the deferred climb state
      this.walk.climbing = true;
      this.walk._climbTime = 0;
    }

    this._transition = null;
    this._edgePushTime = 0;
    // Clear any stale transition request to prevent immediate re-triggering
    this.walk.clearTransitionRequest();
    this.walk._inTransition = false;
    this._transitionCooldown = this._transitionCooldownDuration;
  }

  /**
   * Compute 3 foot target positions on a ground/floor surface for a given leg group.
   * Positions are arranged around targetPos on the horizontal plane.
   */
  _computeGroundFootTargets(groupName, targetPos, surfNormal) {
    const group = groupName === 'A' ? this.walk.groupA : this.walk.groupB;
    // Use yaw-based axes for ground placement
    _bodyForward.set(0, 0, 1).applyAxisAngle(_yAxis, this.yaw);
    _bodyForward.sub(_tmpV3.copy(surfNormal).multiplyScalar(_bodyForward.dot(surfNormal)));
    if (_bodyForward.lengthSq() < 0.001) {
      _bodyForward.set(1, 0, 0);
      _bodyForward.sub(_tmpV3.copy(surfNormal).multiplyScalar(_bodyForward.dot(surfNormal)));
    }
    _bodyForward.normalize();
    _bodyRight.crossVectors(surfNormal, _bodyForward).normalize();

    for (let g = 0; g < 3; g++) {
      const limb = this.walk.limbs[group[g]];
      const hx = limb.home.x * this.walk._hipScale;
      const hz = limb.home.z * this.walk._hipScale;
      _legTargets[g].copy(targetPos)
        .addScaledVector(_bodyRight, hx)
        .addScaledVector(_bodyForward, hz);
      // Snap to actual ground surface — prefer the hit closest to target Y
      // to avoid snapping to overhangs above.
      _rayOrigin.copy(_legTargets[g]);
      _rayOrigin.y += 3;
      _raycaster.set(_rayOrigin, _tmpV3.set(0, -1, 0));
      _raycaster.far = 10;
      _pcHitsArray.length = 0;
      _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
      let bestHit = null;
      let bestDist = Infinity;
      for (let i = 0; i < _pcHitsArray.length; i++) {
        const h = _pcHitsArray[i];
        _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
        if (_tmpV3.y > 0.5) {
          const dy = Math.abs(h.point.y - targetPos.y);
          if (dy < bestDist) {
            bestDist = dy;
            bestHit = h;
          }
        }
      }
      if (bestHit) {
        _legTargets[g].copy(bestHit.point);
      }
    }
  }
}

// Will be set from main.jsx so the controller can check pointer lock
export let renderer_domElement = null;
export function setRendererDomElement(el) { renderer_domElement = el; }
