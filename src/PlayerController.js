import * as THREE from 'three';
import { PlayerSkeleton } from './PlayerSkeleton.js';
import { ProceduralWalk } from './ProceduralWalk.js';
import { rayDebug } from './RayDebugLogger.js';

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
const _invBodyMat = new THREE.Matrix4();
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
    this.skeleton.setLiveHeight(0.1); // resting stance height
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

    // ── Position safety: prevent body launches ──
    this._prevPosition = new THREE.Vector3();            // position at start of frame
    this._maxBodySpeed = 40;                             // max units/sec body can move (raised for sprint)

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

    // ── Jump state ──
    this._jump = null;     // null when grounded, { velocity: Vector3, airTime: number } when airborne
    this._jumpVelocity = new THREE.Vector3();
    this._jumpRequested = false; // set true on Space press, consumed on next update
    this._jumpsUsed = 0;         // 0 on ground, incremented per jump (max 2 = double jump)
    this._maxJumps = 2;          // 1 = single, 2 = double jump
    this.jumpStrength = 3.0;     // MAX upward velocity (Leva-tunable)
    this.jumpMinStrength = 1.5;  // tap jump velocity (Leva-tunable)
    this.jumpChargeRate = 25.0;  // velocity added per second while holding (Leva-tunable)
    this.jumpGravity  = 9.8;    // gravity acceleration during jump (Leva-tunable)
    this.jumpAirSteer = 4.0;    // how fast player can steer mid-air (units/sec)
    this.jumpLatchRadius = 2.0; // proximity check distance for mid-air surface latch
    this.jumpTerminalVel = 20.0; // max downward speed (Leva-tunable)
    this._jumpCharging = false;  // true while Space is held during ascent
    this._jumpCharged = 0;       // total velocity added via charging so far
    this._jumpTuckTargets = [];  // per-limb tuck positions (body-local)
    this._jumpTuckNoise = [];    // per-limb noise phase offsets
    for (let i = 0; i < 6; i++) {
      this._jumpTuckTargets.push(new THREE.Vector3());
      this._jumpTuckNoise.push(Math.random() * Math.PI * 2);
    }
    // Landing interpolation state
    this._landing = null; // null | { timer, duration, startPos, endPos, startUp, endUp, isClimb, startFeet[], endFeet[], normal }
    this._landingDuration = 0.12; // seconds for smooth landing
    this._jumpCooldown = 0; // seconds remaining before next jump allowed

    // ── Sprint state ──
    this.sprinting = false;              // true while shift held + moving
    this.sprintMultiplier = 1.5;         // speed multiplier when sprinting
    this._currentSprintBlend = 0;        // smooth 0→1 for camera/FOV effects
    this._sprintBlendSpeed = 6.0;        // how fast sprint blend ramps

    // ── Landing squash (spine height animation) ──
    this._landSquash = null;          // null | { phase: 'squash'|'recover'|'blend', timer, startY }
    this._squashAirY      = 0.6;     // spine height while airborne
    this._squashImpactY   = 0.05;    // lowest point of squash
    this._squashRestY     = 0.1;     // normal resting height
    this._squashDuration  = 0.5;     // seconds for impact squash  (fast)
    this._squashRecoverDur = 0.80;   // seconds for recover phase  (slower)

    // Post-landing foot blend (smooth tuck → walk transition)
    this._footBlend = null;          // null | { timer, duration, startFeet: Vector3[6] }
    this._footBlendDur = 0.2;        // seconds to blend from snapshot → walk
    this._footBlendSnap = [];
    for (let i = 0; i < 6; i++) this._footBlendSnap.push(new THREE.Vector3());

    this._fallTime        = 0;       // seconds of continuous downward velocity
    this._fallPrepDelay   = 0.01;    // start lerping spine after this many seconds of falling
    this._fallPrepDur     = 0.6;     // seconds to lerp from current height to _squashAirY
    this._fallPrepStartY  = 0;       // snapshot of spineHeight when fall-prep begins
    this._fallPrepTimer   = 0;       // progress through the fall-prep lerp

    // Mouse-look state
    this.yaw = 0;
    this.pitch = 0;
    this.mouseSensitivity = 0.002;

    // ── Mouse / trackpad orbit input ──
    this._rawDeltaX = 0;
    this._rawDeltaY = 0;

    // --- Keyboard state ---
    this._keys = {};
    this._onKeyDown = (e) => {
      this._keys[e.code] = true;
      if (e.code === 'Space') this._jumpRequested = true;
    };
    this._onKeyUp = (e) => {
      this._keys[e.code] = false;
      if (e.code === 'Space') this._jumpCharging = false;
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    // --- Pointer lock + mouse move ---
    // Accumulate raw deltas; spike-clamping + deadzone applied per-frame in update().
    this._onMouseMove = (e) => {
      if (document.pointerLockElement !== renderer_domElement) return;
      this._rawDeltaX += e.movementX;
      this._rawDeltaY += e.movementY;
    };
    document.addEventListener('mousemove', this._onMouseMove);
  }

  update(dt) {
    // Snapshot position at frame start for velocity clamping at the end
    this._prevPosition.copy(this.mesh.position);

    // ── Consume accumulated mouse/trackpad input ──
    this.yaw   -= this._rawDeltaX * this.mouseSensitivity;
    this.pitch -= this._rawDeltaY * this.mouseSensitivity;
    this._rawDeltaX = 0;
    this._rawDeltaY = 0;

    // Clamp pitch
    const steepness = 1 - Math.abs(this._bodyUp.y);
    const maxPitch = Math.PI * 0.49 + steepness * Math.PI / 4; // ~88° on flat ground
    this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));

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

    if (this.walk.climbing) {
      // ── Wall-relative input ──
      // On a wall the camera looks "top-down" relative to the creature, so
      // camera-yaw-based directions cause unintuitive drift. Instead, derive
      // movement axes from the wall's natural frame:
      //   "forward" = world-up projected onto wall plane (= up the wall)
      //   "right"   = horizontal along the wall (cross of wall-normal × world-Y)
      // Camera yaw is used ONLY for a secondary rotation within this wall plane
      // so the player can still steer, but the primary axes feel correct.

      // Wall "up" = world Y projected onto wall plane and normalised
      const wn = this.walk._climbNormal;
      _tmpV3.set(0, 1, 0);
      _tmpV3.sub(_tmpV3b.copy(wn).multiplyScalar(_tmpV3.dot(wn)));
      if (_tmpV3.lengthSq() < 0.001) {
        // Degenerate: wall is horizontal (floor/ceiling) — fall back to camera yaw
        _tmpV3.set(0, 0, 1).applyAxisAngle(_yAxis, this.yaw);
        _tmpV3.sub(_tmpV3b.copy(wn).multiplyScalar(_tmpV3.dot(wn)));
      }
      _tmpV3.normalize();
      const wallUp = _tmpV3.clone();  // "up" direction on the wall surface

      // Wall "right" = wn × wallUp (horizontal along wall)
      _rightDir.crossVectors(wn, wallUp).normalize();

      // Apply yaw as a rotation within the wall plane so the player can still
      // steer left/right on the wall. Use only the *difference* from the wall's
      // natural facing to keep the bias centred.
      // Get the wall's "natural yaw" = atan2 of the climb direction projected to XZ
      const climbDir = this.walk._climbDir;
      const wallYaw = Math.atan2(climbDir.x, climbDir.z);
      const deltaYaw = this.yaw - wallYaw;

      // Rotate wallUp and wallRight by deltaYaw around the wall normal
      const cdy = Math.cos(deltaYaw), sdy = Math.sin(deltaYaw);
      _forward.copy(wallUp).multiplyScalar(cdy).addScaledVector(_rightDir, sdy);
      _forward.normalize();
      // Recompute right from the rotated forward
      _rightDir.crossVectors(wn, _forward).normalize();

    } else {
      // ── Ground: camera-yaw based input ──
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

    // ── Sprint: hold shift while moving (ground only, not climbing) ──
    const wantSprint = (k['ShiftLeft'] || k['ShiftRight']) &&
                       _inputDir.lengthSq() > 0.001 &&
                       !this.walk.climbing;
    this.sprinting = wantSprint;
    // Smooth blend for camera effects
    const sprintTarget = wantSprint ? 1 : 0;
    this._currentSprintBlend += (sprintTarget - this._currentSprintBlend) *
      (1 - Math.exp(-this._sprintBlendSpeed * dt));
    if (this._currentSprintBlend < 0.001) this._currentSprintBlend = 0;
    if (this._currentSprintBlend > 0.999) this._currentSprintBlend = 1;
    // Drive walk's sprint multiplier (smoothed so gait transitions aren't jarring)
    const targetMult = wantSprint ? this.sprintMultiplier : 1.0;
    this.walk.sprintMultiplier += (targetMult - this.walk.sprintMultiplier) *
      (1 - Math.exp(-8.0 * dt));

    // ═══════════════════════════════════════════════════════════════════
    //  JUMP SYSTEM — launch, airborne physics, surface latch
    // ═══════════════════════════════════════════════════════════════════
    // Tick post-landing jump cooldown
    if (this._jumpCooldown > 0) this._jumpCooldown -= dt;

    if (this._jumpRequested && !this._landing && this._jumpCooldown <= 0) {
      if (!this._jump) {
        // ── First jump (from ground/wall) ──
        this._jumpRequested = false;
        // Cancel any active transition so we can jump off walls
        if (this._transition) {
          this._transition = null;
          this.walk._inTransition = false;
        }
        this._launchJump();
        this._jumpsUsed = 1;
        this._jumpCharging = true;
        this._jumpCharged = 0;
      } else if (this._jumpsUsed < this._maxJumps) {
        // ── Double jump (while airborne) ──
        this._jumpRequested = false;
        this._launchDoubleJump();
        this._jumpsUsed++;
        this._jumpCharging = true;
        this._jumpCharged = 0;
      }
    }
    this._jumpRequested = false; // consume even if we couldn't jump

    // Smooth landing interpolation
    if (this._landing) {
      this._updateLanding(dt);
      return;
    }

    if (this._jump) {
      // ── Airborne update ──
      this._updateJump(dt, fwd, right);
      return; // skip normal walk/transition logic entirely
    }

    // Tick landing squash (spine height only — walk system handles body height)
    if (this._landSquash) this._updateLandSquash(dt);

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
      this.skeleton.updateGunRest(_invSkelLocal);
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
        // ── Horizontal wall collision ── prevent walking through walls
        // 3-ray fan (center ± 15°) at 3 heights for robust detection on
        // complex geometry.  Blocks ALL wall-like surfaces; climbing still
        // engages because the body stops 0.2 units from the wall, well
        // within the 1.5-unit climbDetectDist.
        const moveDist = movedDelta.length();
        if (moveDist > 0.001) {
          _tmpV3.copy(movedDelta).normalize();
          _tmpV3.y = 0;
          if (_tmpV3.lengthSq() > 0.001) {
            _tmpV3.normalize();
            const WALL_MARGIN = 0.2;
            const moveDir = _tmpV3.clone(); // center direction
            // ±15° fan spread in XZ
            const FAN_ANGLE = 0.26; // ~15°
            const cosFan = Math.cos(FAN_ANGLE), sinFan = Math.sin(FAN_ANGLE);
            const fanDirs = [
              moveDir.clone(), // center
              new THREE.Vector3(moveDir.x * cosFan - moveDir.z * sinFan, 0, moveDir.x * sinFan + moveDir.z * cosFan), // +15°
              new THREE.Vector3(moveDir.x * cosFan + moveDir.z * sinFan, 0, -moveDir.x * sinFan + moveDir.z * cosFan), // -15°
            ];
            const heights = [0.3, 0.8, 1.5]; // low, mid, high
            let blocked = false;
            let wallClimbHit = null; // track closest climbable wall hit
            for (const h of heights) {
              if (blocked) break;
              for (const dir of fanDirs) {
                if (blocked) break;
                _rayOrigin.copy(this.mesh.position);
                _rayOrigin.y += h;
                _raycaster.set(_rayOrigin, dir);
                _raycaster.far = moveDist + WALL_MARGIN;
                _pcHitsArray.length = 0;
                _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
                for (let wi = 0; wi < _pcHitsArray.length; wi++) {
                  const wh = _pcHitsArray[wi];
                  _tmpV3b.copy(wh.face.normal).transformDirection(wh.object.matrixWorld).normalize();
                  if (Math.abs(_tmpV3b.y) < 0.5) {
                    // Check if this wall face has a walkable top within step height.
                    // If so, don't block — let the body approach so step-up logic engages.
                    // This is critical for stairs: each step's vertical face is wall-like
                    // but has a walkable top surface the creature should step onto.
                    if (this._hasSteppableTop(wh.point, this.mesh.position.y)) {
                      break; // steppable — don't block, don't climb
                    }
                    // Climbable wall (not steppable): record the hit so the
                    // climb system engages, but still cap movement to prevent
                    // clipping through the mesh.
                    if (wh.object.userData.climbable) {
                      if (!wallClimbHit) {
                        wallClimbHit = { point: wh.point.clone(), normal: _tmpV3b.clone() };
                      }
                    }
                    // Cap movement at the wall face. Use a tighter margin for
                    // climbable walls so the body gets close enough for the
                    // climb system to engage (climbDetectDist = 1.5).
                    const margin = wh.object.userData.climbable ? 0.05 : WALL_MARGIN;
                    const maxAllowed = Math.max(0, wh.distance - margin);
                    if (moveDist > maxAllowed) {
                      const scale = maxAllowed / moveDist;
                      _candidatePos.copy(this.mesh.position).addScaledVector(movedDelta, scale);
                      blocked = true;
                    }
                    break;
                  }
                }
              }
            }
            // If we found a climbable wall, tell ProceduralWalk to engage
            // climbing now rather than waiting for its own detection pass
            if (wallClimbHit && !this.walk.climbing) {
              this.walk.requestClimb(wallClimbHit.point, wallClimbHit.normal);
            }
          }
        }

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
        // Two-pass selection: first look for the highest walkable surface
        // that is above us but within maxStepHeight (i.e. a stair step top).
        // If none found, fall back to the surface closest to current Y.
        let stepUpHit = null;
        let bestStepUpY = -Infinity;
        for (let i = 0; i < _pcHitsArray.length; i++) {
          const h = _pcHitsArray[i];
          _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
          if (_tmpV3.y > 0.5) {
            const heightAbove = h.point.y - currentY;
            // Candidate for step-up: above us but within stepping reach
            if (heightAbove > 0.01 && heightAbove <= this.maxStepHeight) {
              if (h.point.y > bestStepUpY) {
                bestStepUpY = h.point.y;
                stepUpHit = h;
              }
            }
            // Also track closest-to-current as fallback
            const dy = Math.abs(h.point.y - currentY);
            if (dy < bestFloorDist) {
              bestFloorDist = dy;
              floorHit = h;
            }
          }
        }
        // Prefer the step-up hit when walking toward higher ground
        if (stepUpHit) {
          floorHit = stepUpHit;
        }
        if (rayDebug && rayDebug.enabled) {
          const _bfOrig = _candidatePos.clone().addScaledVector(up, 5);
          const _bfDir = up.clone().negate();
          if (floorHit) {
            const _bfNorm = floorHit.face.normal.clone().transformDirection(floorHit.object.matrixWorld).normalize();
            rayDebug.log('body_floor', _bfOrig, _bfDir, 15, true, floorHit.point, _bfNorm, floorHit.object.name || floorHit.object.uuid, floorHit.distance);
          } else {
            rayDebug.log('body_floor', _bfOrig, _bfDir, 15, false);
          }
        }
        // ── Floor-aware movement for a multi-legged creature ──
        // Philosophy: a 6-legged spider can walk over any drop.  Never block
        // horizontal movement because of a height difference downward.
        // Only block when a wall is too high to step onto.
        // Vertical drops use rate-limited descent so legs can animate smoothly.
        const MAX_DESCENT_RATE = 12.0; // units/sec — how fast body lowers over drops
        const prevX = this.mesh.position.x;
        const prevZ = this.mesh.position.z;

        if (floorHit) {
          const surfaceY = floorHit.point.y;
          const currentSurfaceY = this.mesh.position.y;
          const heightDiff = surfaceY - currentSurfaceY;

          if (heightDiff > this.maxStepHeight) {
            // Floor is ABOVE us (wall / ledge too high to step onto).
            // Check if there's a steppable top just above.
            _rayOrigin.set(_candidatePos.x, currentSurfaceY + this.maxStepHeight + 2, _candidatePos.z);
            _raycaster.set(_rayOrigin, _tmpV3b.set(0, -1, 0));
            _raycaster.far = this.maxStepHeight + 3;
            _pcHitsArray.length = 0;
            _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
            let stepTopHit = null;
            for (let si = 0; si < _pcHitsArray.length; si++) {
              const sh = _pcHitsArray[si];
              _tmpV3.copy(sh.face.normal).transformDirection(sh.object.matrixWorld).normalize();
              if (_tmpV3.y < 0.5) continue;
              const stepUp = sh.point.y - currentSurfaceY;
              if (stepUp > -0.5 && stepUp <= this.maxStepHeight) { stepTopHit = sh; break; }
            }
            if (stepTopHit) {
              this.mesh.position.copy(_candidatePos);
              this.mesh.position.y = stepTopHit.point.y;
            } else {
              // Can't step up — slide along the obstacle
              this._slideAlongBlock(movedDelta);
            }
          } else {
            // Floor is at or BELOW us — always allow horizontal movement.
            this.mesh.position.x = _candidatePos.x;
            this.mesh.position.z = _candidatePos.z;

            if (heightDiff >= -this.maxStepHeight) {
              // Normal walkable step — snap Y directly
              this.mesh.position.y = surfaceY;
              this._edgePushTime = 0;
            } else {
              // Big drop — rate-limit vertical descent so legs can keep up.
              const maxDrop = MAX_DESCENT_RATE * dt;
              this.mesh.position.y = Math.max(surfaceY, this.mesh.position.y - maxDrop);
              // Accumulate edge push time for optional wall-climb transition.
              // This does NOT gate movement — creature always moves.
              this._edgePushTime += dt;
              if (this._edgePushTime >= this._edgeCommitThreshold) {
                if (this._tryEdgeClimb(_candidatePos, _inputDir)) {
                  this._edgePushTime = 0;
                }
              }
            }
          }
        } else {
          // No floor at candidate — move horizontally, apply gravity-like descent.
          this.mesh.position.x = _candidatePos.x;
          this.mesh.position.z = _candidatePos.z;
          this.mesh.position.y -= MAX_DESCENT_RATE * dt;
          // Try wall-climb transition
          this._edgePushTime += dt;
          if (this._edgePushTime >= this._edgeCommitThreshold) {
            if (this._tryEdgeClimb(_candidatePos, _inputDir)) {
              this._edgePushTime = 0;
            }
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
      this.skeleton.updateGunRest(_invSkelLocal);
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
      if (this._landSquash) {
        // During squash animation, snap body height directly so the
        // squash/recover curve is visually accurate (no smooth lag).
        this.mesh.position.addScaledVector(this._bodyUp, heightDiff);
      } else {
        const posAlpha = Math.min(1, this.bodyPosSmooth * dt);
        // Drop-rate limiter: clamp downward movement to prevent plummeting through surfaces
        const maxDrop = 2.0 * dt; // max 2 units/sec downward
        const rawDelta = heightDiff * posAlpha;
        const clampedDelta = rawDelta < -maxDrop ? -maxDrop : rawDelta;
        this.mesh.position.addScaledVector(this._bodyUp, clampedDelta);
      }
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
        if (rayDebug && rayDebug.enabled) {
          if (_pcHitsArray.length > 0) {
            const jh = _pcHitsArray[0];
            const jn = jh.face.normal.clone().transformDirection(jh.object.matrixWorld).normalize();
            rayDebug.log('joint_probe', _probeOrig, _probeNeg, JOINT_PROBE_LEN * 2, true, jh.point, jn, jh.object.name || jh.object.uuid, jh.distance);
          } else {
            rayDebug.log('joint_probe', _probeOrig, _probeNeg, JOINT_PROBE_LEN * 2, false);
          }
        }
        if (_pcHitsArray.length === 0) return;

        // Find the first hit whose normal roughly opposes the probe direction
        // (i.e. it's actually the climb surface, not a slope/floor behind us).
        let h = null;
        for (let ji = 0; ji < _pcHitsArray.length; ji++) {
          const ch = _pcHitsArray[ji];
          _probeOrig.copy(ch.face.normal).transformDirection(ch.object.matrixWorld).normalize();
          // Accept only surfaces whose normal is within ~60° of the expected climbNormal
          if (_probeOrig.dot(wn) > 0.5) { h = ch; break; }
        }
        if (!h) return;

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
        // Cap push to prevent large single-frame launches at geometry intersections
        const maxPushPerFrame = 0.5 * dt * 60; // ~0.5 units at 60fps
        if (maxPush > maxPushPerFrame) maxPush = maxPushPerFrame;
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

    // Tick foot blend
    if (this._footBlend) {
      this._footBlend.timer += dt;
      if (this._footBlend.timer >= this._footBlend.duration) {
        this._footBlend = null;
      }
    }

    this.walk.cacheBodyInverse(this.mesh);
    for (let i = 0; i < 6; i++) {
      const footLocal = this.walk.getFootLocal(i);
      _footTmp.copy(footLocal).applyMatrix4(_invSkelLocal);

      // Blend from snapshot → walk during post-landing transition
      if (this._footBlend) {
        const bt = this._footBlend.timer / this._footBlend.duration;
        const be = bt * bt * (3 - 2 * bt); // smoothstep
        // Get snapshot foot in skeleton-local space
        _tmpV3.copy(this._footBlendSnap[i]);
        // world → body-local → skeleton-local
        _invBodyMat.copy(this.mesh.matrixWorld).invert();
        _tmpV3.applyMatrix4(_invBodyMat).applyMatrix4(_invSkelLocal);
        // Lerp: at be=0 fully snapshot, at be=1 fully walk
        _footTmp.lerpVectors(_tmpV3, _footTmp, be);
      }

      this.skeleton.updateLimb(i, _footTmp);
    }
    this.skeleton.updateGunRest(_invSkelLocal);

    // ── Velocity clamp: prevent body launches ──
    // Cap total displacement this frame to maxBodySpeed * dt.
    _tmpV3.subVectors(this.mesh.position, this._prevPosition);
    const frameDist = _tmpV3.length();
    const maxDist = this._maxBodySpeed * dt;
    if (frameDist > maxDist && frameDist > 0.001) {
      _tmpV3.multiplyScalar(maxDist / frameDist);
      this.mesh.position.copy(this._prevPosition).add(_tmpV3);
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

  // ═══════════════════════════════════════════════════════════════════
  //  JUMP — Launch
  // ═══════════════════════════════════════════════════════════════════
  /**
   * Initiate a jump based on current surface state:
   *   Ground → shoot upward
   *   Wall   → shoot away from wall normal + slight upward
   *   Ceiling (bodyUp.y < -0.5) → just detach and fall
   */
  _launchJump() {
    const vel = this._jumpVelocity;

    if (this.walk.climbing) {
      const wallNormal = this.walk._climbNormal;
      if (this._bodyUp.y < -0.5) {
        // Ceiling — just detach and fall
        vel.set(0, 0, 0);
      } else {
        // Wall — push away from wall + slight upward boost
        vel.copy(wallNormal).multiplyScalar(this.jumpMinStrength * 0.7);
        vel.y += this.jumpMinStrength * 0.5;
      }
      // Exit climbing state
      this.walk.climbing = false;
      this.walk._climbTime = 0;
      this._bodyUp.set(0, 1, 0);
      this._targetUp.set(0, 1, 0);
    } else {
      // Ground — straight up with minimum (tap) strength
      vel.set(0, this.jumpMinStrength, 0);
    }

    this._jump = { airTime: 0 };

    // Cancel any active squash and set spine height to resting value
    // so the jump starts from a known state. Fall-prep will lerp it
    // toward the air-ready height during descent.
    this._landSquash = null;
    this._fallTime = 0;
    this._fallPrepTimer = 0;
    this.skeleton.setLiveHeight(this._squashRestY);

    // Reset skeleton group to neutral so stale body-noise offset
    // doesn't persist through the entire jump
    this.skeleton.group.position.set(0, 0, 0);
    this.skeleton.group.rotation.set(0, 0, 0);

    // Detach all feet from surfaces
    for (const limb of this.walk.limbs) {
      limb.grounded = false;
    }

    // Snapshot tuck targets: pull feet toward body center
    this.walk.cacheBodyInverse(this.mesh);
    for (let i = 0; i < 6; i++) {
      const limb = this.walk.limbs[i];
      // Tuck target = 50% toward body center (in world space)
      const homeWorld = _tmpV3.copy(limb.home)
        .multiplyScalar(this.walk._hipScale * 0.3)  // pull in tight
        .applyMatrix4(this.mesh.matrixWorld);
      this._jumpTuckTargets[i].copy(homeWorld);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  JUMP — Double Jump (while airborne)
  // ═══════════════════════════════════════════════════════════════════
  /**
   * Perform a second jump while already airborne.
   * Direction = current horizontal velocity (the direction the player is
   * already moving), plus an upward boost. If not moving horizontally,
   * just boost straight up.
   */
  _launchDoubleJump() {
    const vel = this._jumpVelocity;

    // Horizontal direction from current velocity
    const hx = vel.x;
    const hz = vel.z;
    const hSpeed = Math.sqrt(hx * hx + hz * hz);

    // Reset velocity, then set the double-jump impulse
    if (hSpeed > 0.01) {
      // Maintain horizontal direction, boost to a consistent speed
      const dirX = hx / hSpeed;
      const dirZ = hz / hSpeed;
      const boostH = Math.max(hSpeed, this.jumpMinStrength * 0.5);
      vel.x = dirX * boostH;
      vel.z = dirZ * boostH;
    }
    // else: keep whatever (near-zero) horizontal vel there is

    // Fresh upward impulse — slightly weaker than the first jump
    vel.y = this.jumpMinStrength * 0.85;

    // Reset fall/tuck timers so spine height management restarts cleanly
    this._fallTime = 0;
    this._fallPrepTimer = 0;

    // Reset air time so latch grace period re-applies
    this._jump.airTime = 0;

    // Re-tuck legs from current positions
    this.mesh.updateMatrixWorld(true);
    for (let i = 0; i < 6; i++) {
      const limb = this.walk.limbs[i];
      const homeWorld = _tmpV3.copy(limb.home)
        .multiplyScalar(this.walk._hipScale * 0.3)
        .applyMatrix4(this.mesh.matrixWorld);
      this._jumpTuckTargets[i].copy(homeWorld);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  JUMP — Airborne Update (called instead of normal walk update)
  // ═══════════════════════════════════════════════════════════════════
  _updateJump(dt, fwd, right) {
    const jump = this._jump;
    jump.airTime += dt;

    // ── Jump charge: boost velocity while Space is held ──
    if (this._jumpCharging) {
      const maxCharge = this.jumpStrength - this.jumpMinStrength;
      const remaining = maxCharge - this._jumpCharged;
      if (remaining > 0) {
        const boost = Math.min(this.jumpChargeRate * dt, remaining);
        this._jumpVelocity.y += boost;
        this._jumpCharged += boost;
      } else {
        this._jumpCharging = false; // cap reached
      }
    }

    // ── Gravity ──
    this._jumpVelocity.y -= this.jumpGravity * dt;
    // Terminal velocity — cap downward speed so high-gravity jumps
    // don't reach absurd speeds at the end of a long fall.
    if (this._jumpVelocity.y < -this.jumpTerminalVel) {
      this._jumpVelocity.y = -this.jumpTerminalVel;
    }

    // ── Air steering ──
    // Use camera-yaw-based forward/right (already computed in _forward/_rightDir)
    // Project onto XZ plane for air control
    if (fwd !== 0 || right !== 0) {
      _tmpV3.set(0, 0, 0);
      _tmpV3.addScaledVector(_forward, fwd);
      _tmpV3.addScaledVector(_rightDir, right);
      _tmpV3.y = 0; // only steer horizontally
      if (_tmpV3.lengthSq() > 0.001) {
        _tmpV3.normalize().multiplyScalar(this.jumpAirSteer * dt);
        this._jumpVelocity.add(_tmpV3);
      }
    }

    // ── Cap horizontal speed ──
    // Prevent air steering from accumulating runaway horizontal velocity.
    const hSpeedSq = this._jumpVelocity.x * this._jumpVelocity.x +
                     this._jumpVelocity.z * this._jumpVelocity.z;
    const maxHSpeed = this.jumpStrength; // horizontal can't exceed launch strength
    if (hSpeedSq > maxHSpeed * maxHSpeed) {
      const scale = maxHSpeed / Math.sqrt(hSpeedSq);
      this._jumpVelocity.x *= scale;
      this._jumpVelocity.z *= scale;
    }

    // ── Spine height management while airborne ──
    if (this._jumpVelocity.y < 0) {
      // Falling — extend legs + raise spine toward landing-ready height
      this._fallTime += dt;
      if (this._fallTime >= this._fallPrepDelay) {
        if (this._fallPrepTimer === 0) {
          this._fallPrepStartY = this.skeleton.spineHeight;
        }
        this._fallPrepTimer += dt;
        const ft = Math.min(1, this._fallPrepTimer / this._fallPrepDur);
        const fe = 1 - (1 - ft) * (1 - ft); // ease-out
        const y = this._fallPrepStartY + (this._squashAirY - this._fallPrepStartY) * fe;
        this.skeleton.setLiveHeight(y);
      }
    } else {
      // Rising or at apex — smoothly tuck spine toward a compact height
      this._fallTime = 0;
      this._fallPrepTimer = 0;
      const tuckTarget = this._squashRestY * 0.8; // slightly below rest for tuck
      const currH = this.skeleton.spineHeight;
      if (Math.abs(currH - tuckTarget) > 0.001) {
        const tuckAlpha = Math.min(1, 6 * dt);
        this.skeleton.setLiveHeight(currH + (tuckTarget - currH) * tuckAlpha);
      }
    }

    // ── Move body ──
    this.mesh.position.addScaledVector(this._jumpVelocity, dt);

    // ── Surface latch check ──
    // Skip latch during the initial launch grace period to avoid
    // immediately re-latching onto the surface we just jumped from.
    const LATCH_GRACE = 0.15; // seconds
    let latched = false;

    if (jump.airTime > LATCH_GRACE) {
      const latchDist = this.jumpLatchRadius;

    // Primary: downward (ground latch)
    _raycaster.set(
      _tmpV3.copy(this.mesh.position).add(_tmpV3b.set(0, 2, 0)),
      _tmpV3b.set(0, -1, 0)
    );
    _raycaster.far = latchDist + 2;
    _pcHitsArray.length = 0;
    _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
    for (let i = 0; i < _pcHitsArray.length; i++) {
      const h = _pcHitsArray[i];
      _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
      if (_tmpV3.y > 0.5) {
        // Floor-like hit — only latch if we're descending and close
        const distAbove = this.mesh.position.y - h.point.y;
        if (distAbove >= -0.3 && distAbove < latchDist && this._jumpVelocity.y <= 0) {
          this._landJump(h.point.clone(), _tmpV3.clone(), false);
          latched = true;
          break;
        }
      }
    }

    // Secondary: forward/sideways/backward wall latch (4 horizontal directions)
    if (!latched) {
      const yawDirs = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
      for (const angle of yawDirs) {
        _tmpV3b.set(Math.sin(this.yaw + angle), 0, Math.cos(this.yaw + angle));
        _raycaster.set(this.mesh.position, _tmpV3b);
        _raycaster.far = latchDist;
        _pcHitsArray.length = 0;
        _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
        for (let i = 0; i < _pcHitsArray.length; i++) {
          const h = _pcHitsArray[i];
          _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
          // Wall-like surface and climbable
          if (Math.abs(_tmpV3.y) < 0.5 && h.object.userData.climbable) {
            this._landJump(h.point.clone(), _tmpV3.clone(), true);
            latched = true;
            break;
          }
        }
        if (latched) break;
      }
    }

    // Upward: ceiling latch
    if (!latched) {
      _raycaster.set(this.mesh.position, _tmpV3b.set(0, 1, 0));
      _raycaster.far = latchDist;
      _pcHitsArray.length = 0;
      _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
      for (let i = 0; i < _pcHitsArray.length; i++) {
        const h = _pcHitsArray[i];
        _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
        if (_tmpV3.y < -0.5 && h.object.userData.climbable && this._jumpVelocity.y > 0) {
          this._landJump(h.point.clone(), _tmpV3.clone(), true);
          latched = true;
          break;
        }
      }
    }
    } // end latch grace period

    if (latched) return;

    // ── Tuck legs / fall-prep legs ──
    this._noiseElapsed += dt;
    if (this._fallPrepTimer > 0) {
      // Fall-prep active: lerp legs from tuck toward extended home positions
      const ft = Math.min(1, this._fallPrepTimer / this._fallPrepDur);
      const fe = 1 - (1 - ft) * (1 - ft); // ease-out
      this.mesh.updateMatrixWorld(true);
      for (let i = 0; i < 6; i++) {
        const limb = this.walk.limbs[i];
        const tuckTarget = this._jumpTuckTargets[i];
        // Compute extended home position (full spread, at body height)
        const homeWorld = _tmpV3.copy(limb.home)
          .multiplyScalar(this.walk._hipScale);
        homeWorld.applyMatrix4(this.mesh.matrixWorld);
        // Lerp from current tuck toward extended home
        tuckTarget.lerp(homeWorld, fe);
        limb.current.copy(tuckTarget);
      }
    } else {
      this._updateJumpLegs(dt);
    }

    // ── Blend skeleton group toward neutral while airborne ──
    // Prevents stale body-noise offset from persisting through the jump
    {
      const blendRate = Math.min(1, 8 * dt);
      this.skeleton.group.position.lerp(_tmpV3.set(0, 0, 0), blendRate);
      // Rotation: lerp each axis toward 0
      const r = this.skeleton.group.rotation;
      r.x += (0 - r.x) * blendRate;
      r.y += (0 - r.y) * blendRate;
      r.z += (0 - r.z) * blendRate;
    }

    // ── Body orientation: smoothly return to upright while airborne ──
    this._bodyUp.lerp(_tmpV3.set(0, 1, 0), Math.min(1, 3 * dt)).normalize();
    this._targetUp.copy(this._bodyUp);

    // Update body orientation from _bodyUp
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

    // Update skeleton IK with tucked legs
    const skelGroup = this.skeleton.group;
    this.mesh.updateMatrixWorld(true);
    skelGroup.updateMatrixWorld(true);
    _invSkelLocal.copy(skelGroup.matrix).invert();
    _invBodyMat.copy(this.mesh.matrixWorld).invert();
    this.walk.cacheBodyInverse(this.mesh);
    for (let i = 0; i < 6; i++) {
      // Use the tucked foot positions (already in world space)
      _footTmp.copy(this._jumpTuckTargets[i]);
      // Convert world → body-local → skeleton-local
      _footTmp.applyMatrix4(_invBodyMat);
      _footTmp.applyMatrix4(_invSkelLocal);
      this.skeleton.updateLimb(i, _footTmp);
    }
    this.skeleton.updateGunRest(_invSkelLocal);
  }

  /**
   * Animate legs toward tuck position with slow random wiggle during jump.
   */
  _updateJumpLegs(dt) {
    const t = this._noiseElapsed;
    for (let i = 0; i < 6; i++) {
      const limb = this.walk.limbs[i];
      const tuckTarget = this._jumpTuckTargets[i];
      const phase = this._jumpTuckNoise[i];

      // Compute tuck position (body-relative, pulled in tight)
      const homeWorld = _tmpV3.copy(limb.home)
        .multiplyScalar(this.walk._hipScale * 0.3);
      // Add tiny random wiggle
      const wiggle = 0.05;
      homeWorld.x += Math.sin(t * 1.3 + phase) * wiggle;
      homeWorld.y += Math.sin(t * 1.7 + phase * 1.5) * wiggle;
      homeWorld.z += Math.sin(t * 1.1 + phase * 0.7) * wiggle;
      // Convert to world space
      homeWorld.applyMatrix4(this.mesh.matrixWorld);

      // Smoothly lerp current foot position toward tuck target
      tuckTarget.lerp(homeWorld, Math.min(1, 8 * dt));
      // Also update the limb.current so walk system knows feet are tucked
      limb.current.copy(tuckTarget);
    }
  }

  /**
   * Land from a jump — begin smooth landing interpolation.
   * @param {THREE.Vector3} point  — surface hit point
   * @param {THREE.Vector3} normal — surface normal (world space)
   * @param {boolean} isClimb      — if true, enter climbing state after landing
   */
  _landJump(point, normal, isClimb) {
    this._jump = null;
    this._jumpVelocity.set(0, 0, 0);
    this._edgePushTime = 0;

    // Compute end position
    const endPos = new THREE.Vector3();
    if (isClimb) {
      endPos.copy(point).addScaledVector(normal, this.skeleton._refSpineHeight * 0.5);
    } else {
      // Use resting spine height for the target (not the inflated air-ready height)
      endPos.set(this.mesh.position.x, point.y + this._squashRestY, this.mesh.position.z);
    }

    // Compute end up
    const endUp = new THREE.Vector3();
    if (isClimb) {
      endUp.copy(normal);
    } else {
      endUp.set(0, 1, 0);
    }

    // Compute end foot positions by raycasting from home positions
    const endFeet = [];
    // Temporarily move mesh to end position for matrixWorld computation
    const savedPos = this.mesh.position.clone();
    const savedQuat = this.mesh.quaternion.clone();
    this.mesh.position.copy(endPos);
    // Build end orientation
    _bodyForward.set(0, 0, 1).applyAxisAngle(_yAxis, this.yaw);
    _bodyForward.sub(_tmpV3.copy(endUp).multiplyScalar(_bodyForward.dot(endUp)));
    if (_bodyForward.lengthSq() < 0.001) {
      _bodyForward.set(1, 0, 0).applyAxisAngle(_yAxis, this.yaw);
      _bodyForward.sub(_tmpV3.copy(endUp).multiplyScalar(_bodyForward.dot(endUp)));
    }
    _bodyForward.normalize();
    _bodyRight.crossVectors(endUp, _bodyForward).normalize();
    _bodyForward.crossVectors(_bodyRight, endUp).normalize();
    _rotMat.makeBasis(_bodyRight, endUp, _bodyForward);
    this.mesh.quaternion.setFromRotationMatrix(_rotMat);
    this.mesh.updateMatrixWorld(true);

    for (let i = 0; i < 6; i++) {
      const limb = this.walk.limbs[i];
      _tmpV3.copy(limb.home).multiplyScalar(this.walk._hipScale);
      _tmpV3.applyMatrix4(this.mesh.matrixWorld);

      if (isClimb) {
        _rayOrigin.copy(_tmpV3).addScaledVector(normal, 2);
        _raycaster.set(_rayOrigin, _tmpV3b.copy(normal).negate());
      } else {
        _rayOrigin.copy(_tmpV3).add(_tmpV3b.set(0, 3, 0));
        _raycaster.set(_rayOrigin, _tmpV3b.set(0, -1, 0));
      }
      _raycaster.far = 6;
      _pcHitsArray.length = 0;
      _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
      if (_pcHitsArray.length > 0) {
        endFeet.push(_pcHitsArray[0].point.clone());
      } else {
        endFeet.push(_tmpV3.clone());
      }
    }

    // Restore mesh
    this.mesh.position.copy(savedPos);
    this.mesh.quaternion.copy(savedQuat);

    // Save start foot positions
    const startFeet = [];
    for (let i = 0; i < 6; i++) {
      startFeet.push(this._jumpTuckTargets[i].clone());
    }

    this._landing = {
      timer: 0,
      duration: this._landingDuration,
      startPos: savedPos.clone(),
      endPos: endPos,
      startUp: this._bodyUp.clone(),
      endUp: endUp,
      isClimb: isClimb,
      startFeet: startFeet,
      endFeet: endFeet,
      normal: normal.clone(),
    };
  }

  /**
   * Smooth landing interpolation — lerps body, orientation, and feet
   * from airborne state to surface over _landingDuration seconds.
   */
  _updateLanding(dt) {
    const L = this._landing;
    L.timer += dt;
    const t = Math.min(1, L.timer / L.duration);
    // Smoothstep easing
    const s = t * t * (3 - 2 * t);

    // Interpolate body position
    this.mesh.position.lerpVectors(L.startPos, L.endPos, s);

    // Interpolate body up
    this._bodyUp.lerpVectors(L.startUp, L.endUp, s).normalize();
    this._targetUp.copy(this._bodyUp);

    // Update body orientation
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

    // Smoothly lerp spine height from air-ready toward rest during landing
    {
      const airH = this.skeleton.spineHeight;
      const landH = this._squashRestY;
      if (Math.abs(airH - landH) > 0.001) {
        const hAlpha = Math.min(1, 8 * dt);
        this.skeleton.setLiveHeight(airH + (landH - airH) * hAlpha);
      }
    }

    // Keep skeleton group blended toward neutral during landing
    {
      const blendRate = Math.min(1, 8 * dt);
      this.skeleton.group.position.lerp(_tmpV3.set(0, 0, 0), blendRate);
      const r = this.skeleton.group.rotation;
      r.x += (0 - r.x) * blendRate;
      r.y += (0 - r.y) * blendRate;
      r.z += (0 - r.z) * blendRate;
    }

    // Interpolate foot positions
    this.mesh.updateMatrixWorld(true);
    const skelGroup = this.skeleton.group;
    skelGroup.updateMatrixWorld(true);
    _invSkelLocal.copy(skelGroup.matrix).invert();
    _invBodyMat.copy(this.mesh.matrixWorld).invert();

    for (let i = 0; i < 6; i++) {
      const limb = this.walk.limbs[i];
      _tmpV3.lerpVectors(L.startFeet[i], L.endFeet[i], s);
      limb.current.copy(_tmpV3);

      // Convert world → body-local → skeleton-local for IK
      _footTmp.copy(_tmpV3);
      _footTmp.applyMatrix4(_invBodyMat);
      _footTmp.applyMatrix4(_invSkelLocal);
      this.skeleton.updateLimb(i, _footTmp);
    }
    this.skeleton.updateGunRest(_invSkelLocal);

    if (t >= 1) {
      // Landing complete — finalize state
      if (L.isClimb) {
        this.walk.climbing = true;
        this.walk._climbTime = 0;
        this.walk._climbNormal.copy(L.normal);
        this.walk._climbDir.copy(L.normal).negate();
      } else {
        this.walk.climbing = false;
      }
      // Re-ground all feet
      for (let i = 0; i < 6; i++) {
        this.walk.limbs[i].grounded = true;
      }
      // Sync _prevPosition to final landing pos so the velocity clamp
      // on the very next frame doesn't see the whole landing interpolation
      // distance as a single-frame displacement.
      this._prevPosition.copy(this.mesh.position);
      // Brief cooldown after wall landings so rapid chain-jumps don't
      // compound into extreme speed.  Ground landings have no cooldown
      // so the creature still feels responsive on flat terrain.
      this._jumpCooldown = L.isClimb ? 0.1 : 0;
      this._jumpsUsed = 0;
      this._landing = null;

      // Begin landing squash from resting height (landing interpolation
      // smoothly brought spine back to rest during the blend)
      this.skeleton.setLiveHeight(this._squashRestY);
      this._landSquash = { phase: 'squash', timer: 0, startY: this._squashRestY };

      // Snapshot current foot positions for smooth blend into walk cycle
      for (let i = 0; i < 6; i++) {
        this._footBlendSnap[i].copy(this.walk.limbs[i].current);
      }
      this._footBlend = { timer: 0, duration: this._footBlendDur };
    }
  }

  /**
   * Animate spine height after landing: squash down (fast-in slow-out)
   * then recover to resting height.
   */
  _updateLandSquash(dt) {
    const sq = this._landSquash;
    sq.timer += dt;

    if (sq.phase === 'squash') {
      const t = Math.min(1, sq.timer / this._squashDuration);
      const e = 1 - (1 - t) * (1 - t); // ease-out
      const y = sq.startY + (this._squashImpactY - sq.startY) * e;
      this.skeleton.setLiveHeight(y);
      if (t >= 1) {
        sq.phase = 'recover';
        sq.timer = 0;
      }
    } else {
      // Recover: ease-out back to resting height
      const t = Math.min(1, sq.timer / this._squashRecoverDur);
      const e = 1 - (1 - t) * (1 - t);
      const y = this._squashImpactY + (this._squashRestY - this._squashImpactY) * e;
      this.skeleton.setLiveHeight(y);
      if (t >= 1) {
        this._landSquash = null;
      }
    }
  }

  /**
   * When movement is blocked by an edge (drop-off), try each axis independently.
   * This lets the player slide along the edge instead of getting stuck.
   * @param {THREE.Vector3} movedDelta — the full movement vector that was rejected
   * @param {THREE.Vector3} candidatePos — the rejected candidate position
   */
  _slideAlongEdge(movedDelta, candidatePos) {
    const up = this._bodyUp;
    // Try X-only movement
    if (Math.abs(movedDelta.x) > 0.0001) {
      _candidatePos.copy(this.mesh.position);
      _candidatePos.x += movedDelta.x;
      _raycaster.set(
        _tmpV3.copy(_candidatePos).addScaledVector(up, 5),
        _tmpV3b.copy(up).negate()
      );
      _raycaster.far = 15;
      _pcHitsArray.length = 0;
      _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
      for (let i = 0; i < _pcHitsArray.length; i++) {
        const h = _pcHitsArray[i];
        _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
        if (_tmpV3.y > 0.5 && Math.abs(h.point.y - this.mesh.position.y) <= this.maxStepHeight) {
          this.mesh.position.x = _candidatePos.x;
          this.mesh.position.y = h.point.y;
          return;
        }
      }
    }
    // Try Z-only movement
    if (Math.abs(movedDelta.z) > 0.0001) {
      _candidatePos.copy(this.mesh.position);
      _candidatePos.z += movedDelta.z;
      _raycaster.set(
        _tmpV3.copy(_candidatePos).addScaledVector(up, 5),
        _tmpV3b.copy(up).negate()
      );
      _raycaster.far = 15;
      _pcHitsArray.length = 0;
      _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
      for (let i = 0; i < _pcHitsArray.length; i++) {
        const h = _pcHitsArray[i];
        _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
        if (_tmpV3.y > 0.5 && Math.abs(h.point.y - this.mesh.position.y) <= this.maxStepHeight) {
          this.mesh.position.z = _candidatePos.z;
          this.mesh.position.y = h.point.y;
          return;
        }
      }
    }
    // Neither axis is safe — stay put (true edge block)
  }

  /**
   * When movement is blocked by a wall too high to step, try to slide along it.
   * Same axis-split logic as _slideAlongEdge but checks for step-height clearance.
   * @param {THREE.Vector3} movedDelta — the full movement vector that was rejected
   */
  _slideAlongBlock(movedDelta) {
    const up = this._bodyUp;
    // Try X-only
    if (Math.abs(movedDelta.x) > 0.0001) {
      _candidatePos.copy(this.mesh.position);
      _candidatePos.x += movedDelta.x;
      _raycaster.set(
        _tmpV3.copy(_candidatePos).addScaledVector(up, 5),
        _tmpV3b.copy(up).negate()
      );
      _raycaster.far = 15;
      _pcHitsArray.length = 0;
      _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
      for (let i = 0; i < _pcHitsArray.length; i++) {
        const h = _pcHitsArray[i];
        _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
        if (_tmpV3.y > 0.5) {
          const diff = h.point.y - this.mesh.position.y;
          if (diff >= -this.maxStepHeight && diff <= this.maxStepHeight) {
            this.mesh.position.x = _candidatePos.x;
            this.mesh.position.y = h.point.y;
            return;
          }
        }
      }
    }
    // Try Z-only
    if (Math.abs(movedDelta.z) > 0.0001) {
      _candidatePos.copy(this.mesh.position);
      _candidatePos.z += movedDelta.z;
      _raycaster.set(
        _tmpV3.copy(_candidatePos).addScaledVector(up, 5),
        _tmpV3b.copy(up).negate()
      );
      _raycaster.far = 15;
      _pcHitsArray.length = 0;
      _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
      for (let i = 0; i < _pcHitsArray.length; i++) {
        const h = _pcHitsArray[i];
        _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
        if (_tmpV3.y > 0.5) {
          const diff = h.point.y - this.mesh.position.y;
          if (diff >= -this.maxStepHeight && diff <= this.maxStepHeight) {
            this.mesh.position.z = _candidatePos.z;
            this.mesh.position.y = h.point.y;
            return;
          }
        }
      }
    }
  }

  /**
   * Probe for a climbable wall face when walking off an edge.
   * Casts along ±inputDir AND ±perpendicular to it from below the wall top
   * to find the side-face the player walked past.
   * Returns true and transitions to climbing if a wall is found.
   */
  _tryEdgeClimb(candidatePos, inputDir) {
    if (inputDir.lengthSq() < 0.001) return false;
    if (this._transitionCooldown > 0) return false;

    // Probe from below the current body so the ray hits the side face
    const probeY = this.mesh.position.y - this.skeleton.spineHeight - 0.5;
    const FAR = 3.5;

    // Build 4 probe directions: ±inputDir and ±perpendicular
    _tmpV3b.copy(inputDir).normalize();
    const perpX = -_tmpV3b.z;  // rotate 90° in XZ plane
    const perpZ =  _tmpV3b.x;

    const probes = [
      { dx: -_tmpV3b.x, dz: -_tmpV3b.z, label: 'edge_climb_back' },  // backward
      { dx:  _tmpV3b.x, dz:  _tmpV3b.z, label: 'edge_climb_fwd'  },  // forward
      { dx:  perpX,      dz:  perpZ,     label: 'edge_climb_fwd'  },  // right perp
      { dx: -perpX,      dz: -perpZ,     label: 'edge_climb_back' },  // left perp
    ];

    for (const probe of probes) {
      _tmpV3.set(candidatePos.x, probeY, candidatePos.z);
      _tmpV3b.set(probe.dx, 0, probe.dz).normalize();
      _raycaster.set(_tmpV3, _tmpV3b);
      _raycaster.far = FAR;
      _pcHitsArray.length = 0;
      _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
      if (rayDebug && rayDebug.enabled) {
        if (_pcHitsArray.length > 0) {
          const eh = _pcHitsArray[0];
          const en = eh.face.normal.clone().transformDirection(eh.object.matrixWorld).normalize();
          rayDebug.log(probe.label, _tmpV3.clone(), _tmpV3b.clone(), FAR, true, eh.point, en, eh.object.name || eh.object.uuid, eh.distance);
        } else {
          rayDebug.log(probe.label, _tmpV3.clone(), _tmpV3b.clone(), FAR, false);
        }
      }
      for (let i = 0; i < _pcHitsArray.length; i++) {
        const h = _pcHitsArray[i];
        if (!h.object.userData.climbable) continue;
        _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
        if (Math.abs(_tmpV3.y) > 0.3) continue; // want a vertical wall face
        if (this._hasSteppableTop(h.point, this.mesh.position.y)) continue;
        return this._enterClimbFromEdge(h, _tmpV3);
      }
    }

    return false;
  }

  /**
   * Check if there is a walkable (floor-like) top surface above a wall hit point
   * that is within maxStepHeight of the player. If so, stepping is preferred over climbing.
   * @param {THREE.Vector3} wallHitPoint — point on the wall face
   * @param {number} bodyY — current player Y
   * @returns {boolean}
   */
  _hasSteppableTop(wallHitPoint, bodyY) {
    // Cast straight down from above the wall hit, offset slightly inward
    // (past the wall face) so the ray lands on the actual top surface,
    // not the ground in front of the wall.
    // We use the last known inputDir to push inward.
    _rayOrigin.set(wallHitPoint.x, bodyY + this.maxStepHeight + 2, wallHitPoint.z);
    _raycaster.set(_rayOrigin, _tmpV3.set(0, -1, 0));
    _raycaster.far = this.maxStepHeight + 4;
    _pcHitsArray.length = 0;
    _raycaster.intersectObjects(this.groundMeshes, false, _pcHitsArray);
    for (let i = 0; i < _pcHitsArray.length; i++) {
      const h = _pcHitsArray[i];
      _tmpV3.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
      if (_tmpV3.y < 0.5) continue; // only floor-like surfaces
      const topY = h.point.y;
      // The top must be ABOVE the wall face hit (it's the actual top of the obstacle,
      // not the ground at its base) and within stepping reach of the player.
      if (topY < wallHitPoint.y + 0.1) continue;
      const stepUp = topY - bodyY;
      if (stepUp > 0 && stepUp <= this.maxStepHeight) return true;
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
