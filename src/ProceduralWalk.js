import * as THREE from 'three';
import { rayDebug } from './RayDebugLogger.js';

/**
 * Procedural walk controller – drives foot target positions using a tripod gait.
 *
 * Tripod groups (classic insect gait – 3 legs planted while 3 step):
 *   Group A: L0 (rear-left),  R1 (mid-right),  L2 (front-left)
 *   Group B: R0 (rear-right), L1 (mid-left),    R2 (front-right)
 *
 * Within each group, legs can be staggered via phaseSpread and randomized via
 * phaseRandomness for an organic look.
 */

const _tmpV = new THREE.Vector3();
const _tmpV2 = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _worldHome = new THREE.Vector3();
const _bodyQuat = new THREE.Quaternion();
const _planeCenter = new THREE.Vector3();
const _planeNorm = new THREE.Vector3();
const _avgNorm = new THREE.Vector3();
const _footLocal = new THREE.Vector3();
const _invBody = new THREE.Matrix4();
const _bodyRight = new THREE.Vector3();
const _bodyFwd   = new THREE.Vector3();
const _spineCenter = new THREE.Vector3();
const _fanOffset = new THREE.Vector3();    // reusable offset for fan rays
const _fanNormal = new THREE.Vector3();    // accumulated normal from fan
const _fanOrigin = new THREE.Vector3();    // origin for fan rays

// ── Surface raycasting helpers ──
const _raycaster = new THREE.Raycaster();
const _worldNormal = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _hitResult = { point: _hitPoint, normal: _hitNormal, object: null };
const _hitsArray = [];  // reusable array for intersectObjects

/** Raycast downward only (fast path for floor-walking).
 *  Rejects hits on non-floor surfaces (normal.y < 0.5) to avoid
 *  snapping to wall side-faces on thin geometry.
 *  @param {number|null} refY — if provided, cast from refY+5 instead of y=50.
 *    This makes the query proximity-aware: it finds the ground nearest to the
 *    player rather than the highest surface (e.g., an overhang above). */
function getGroundY(x, z, groundMeshes, fallback = 0, refY = null, _dbgCategory = 'ground_down') {
  if (!groundMeshes || groundMeshes.length === 0) return fallback;
  const startY = refY !== null ? refY + 5 : 50;
  _rayOrigin.set(x, startY, z);
  const _dir = _tmpV.set(0, -1, 0);
  _raycaster.set(_rayOrigin, _dir);
  const _far = refY !== null ? 15 : 100;
  _raycaster.far = refY !== null ? 15 : Infinity;
  _hitsArray.length = 0;
  _raycaster.intersectObjects(groundMeshes, false, _hitsArray);
  for (let i = 0; i < _hitsArray.length; i++) {
    const h = _hitsArray[i];
    _worldNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
    if (_worldNormal.y > 0.5) {
      if (rayDebug && rayDebug.enabled) rayDebug.log(_dbgCategory, _rayOrigin, _dir, _far, true, h.point, _worldNormal, h.object.name || h.object.uuid, h.distance);
      return h.point.y;
    }
  }
  if (rayDebug && rayDebug.enabled) rayDebug.log(_dbgCategory, _rayOrigin, _dir, _far, false);
  return fallback;
}

/**
 * Cast a single ray from origin along dir, return shared _hitResult or null.
 * Iterates all hits to skip backfaces (normal facing same way as ray).
 * This is critical when geometry overlaps — the first hit may be a backface
 * (e.g., inside of a wall box), and the real surface is behind it.
 * WARNING: returned object is reused — copy values if you need to keep them.
 */
function castSurface(origin, dir, meshes, maxDist, _dbgCategory = 'surface_cast') {
  if (!meshes || meshes.length === 0) return null;
  _raycaster.set(origin, dir);
  _raycaster.far = maxDist;
  _hitsArray.length = 0;
  _raycaster.intersectObjects(meshes, false, _hitsArray);
  for (let i = 0; i < _hitsArray.length; i++) {
    const h = _hitsArray[i];
    _worldNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
    // Accept front-faces only (normal opposes ray direction)
    if (_worldNormal.dot(dir) < 0) {
      _hitPoint.copy(h.point);
      _hitNormal.copy(_worldNormal);
      _hitResult.object = h.object;
      if (rayDebug && rayDebug.enabled) rayDebug.log(_dbgCategory, origin, dir, maxDist, true, _hitPoint, _hitNormal, h.object.name || h.object.uuid, h.distance);
      return _hitResult;
    }
  }
  if (rayDebug && rayDebug.enabled) rayDebug.log(_dbgCategory, origin, dir, maxDist, false);
  return null;
}

/**
 * Place a foot on the surface. In normal mode casts downward; in climb mode
 * casts along the climb "into wall" direction.
 * If climbing and the primary cast misses, retries closer to spineCenter
 * (foot-placement clamping for narrow surfaces).
 */
function placeOnSurface(pos, groundMeshes, climbDir, climbing, fallbackY, spineCenter) {
  if (climbing && climbDir) {
    // Cast into the surface from a point offset away
    _rayOrigin.copy(pos).addScaledVector(climbDir, -1.5);
    const hit = castSurface(_rayOrigin, climbDir, groundMeshes, 3, 'foot_place');
    if (hit) {
      pos.copy(hit.point).addScaledVector(hit.normal, 0.02);
      return hit.normal;
    }

    // Foot-placement clamping: pull toward spine centerline and retry
    if (spineCenter) {
      for (let i = 1; i <= 4; i++) {
        const blend = i * 0.25; // 25%, 50%, 75%, 100% toward spine
        _tmpV.lerpVectors(pos, spineCenter, blend);
        _rayOrigin.copy(_tmpV).addScaledVector(climbDir, -1.5);
        const retry = castSurface(_rayOrigin, climbDir, groundMeshes, 3, 'foot_place_clamp');
        if (retry) {
          pos.copy(retry.point).addScaledVector(retry.normal, 0.02);
          return retry.normal;
        }
      }
    }

    // Fallback 1: downward cast (foot at bottom edge or corner)
    _rayOrigin.set(pos.x, pos.y + 2, pos.z);
    const gHit = castSurface(_rayOrigin, _tmpV.set(0, -1, 0), groundMeshes, 4, 'foot_place_down');
    if (gHit) {
      pos.copy(gHit.point).addScaledVector(gHit.normal, 0.02);
      return gHit.normal;
    }

    // Fallback 2: upward cast (foot below a ledge on complex geometry)
    _rayOrigin.set(pos.x, pos.y - 2, pos.z);
    const uHit = castSurface(_rayOrigin, _tmpV.set(0, 1, 0), groundMeshes, 4, 'foot_place_up');
    if (uHit) {
      pos.copy(uHit.point).addScaledVector(uHit.normal, 0.02);
      return uHit.normal;
    }

    // Fallback 3: outward from wall (foot may have drifted behind surface)
    _rayOrigin.copy(pos).addScaledVector(climbDir, 1.5);
    _tmpV.copy(climbDir).negate();
    const oHit = castSurface(_rayOrigin, _tmpV, groundMeshes, 3, 'foot_place_out');
    if (oHit) {
      pos.copy(oHit.point).addScaledVector(oHit.normal, 0.02);
      return oHit.normal;
    }
  }
  // Normal ground mode: downward ray (proximity-aware)
  const gy = getGroundY(pos.x, pos.z, groundMeshes, NaN, fallbackY, 'foot_place');
  if (!isNaN(gy)) {
    pos.y = gy;
    return _tmpV.set(0, 1, 0);
  }

  // Ground miss — pull foot toward spine center and retry (narrow surfaces)
  if (spineCenter) {
    for (let i = 1; i <= 4; i++) {
      const blend = i * 0.25;
      const tx = pos.x + (spineCenter.x - pos.x) * blend;
      const tz = pos.z + (spineCenter.z - pos.z) * blend;
      const retryY = getGroundY(tx, tz, groundMeshes, NaN, fallbackY, 'foot_place_clamp');
      if (!isNaN(retryY)) {
        pos.x = tx;
        pos.z = tz;
        pos.y = retryY;
        return _tmpV.set(0, 1, 0);
      }
    }
  }

  // Final fallback — keep foot at current Y (foot memory)
  return _tmpV.set(0, 1, 0);
}

/** Parabolic arc height as a function of t ∈ [0,1]. Peak at t = 0.5. */
function arcHeight(t, stepHeight) {
  return 4 * stepHeight * t * (1 - t);
}

/**
 * Lightweight surface probe — returns true if a surface exists at `pos`,
 * false if all casts miss. Does NOT modify pos (non-destructive).
 * Used for look-ahead gait adaptation (Strategy 5).
 */
function probeSurfaceExists(pos, groundMeshes, climbDir, climbing) {
  if (climbing && climbDir) {
    // Into-wall cast
    _rayOrigin.copy(pos).addScaledVector(climbDir, -1.5);
    if (castSurface(_rayOrigin, climbDir, groundMeshes, 3, 'surface_probe')) return true;
    // Downward fallback
    _rayOrigin.set(pos.x, pos.y + 2, pos.z);
    if (castSurface(_rayOrigin, _tmpV.set(0, -1, 0), groundMeshes, 4, 'surface_probe')) return true;
    // Upward fallback
    _rayOrigin.set(pos.x, pos.y - 2, pos.z);
    if (castSurface(_rayOrigin, _tmpV.set(0, 1, 0), groundMeshes, 4, 'surface_probe')) return true;
    return false;
  }
  // Ground mode: downward ray (proximity-aware — use pos.y as reference)
  return !isNaN(getGroundY(pos.x, pos.z, groundMeshes, NaN, pos.y, 'surface_probe'));
}

// Per-limb pseudo-random frequencies for the noise oscillator (irrational-ish)
const NOISE_FREQS = [0.71, 1.13, 0.53, 0.97, 1.37, 0.79];

export class ProceduralWalk {
  /**
   * @param {import('./PlayerSkeleton.js').PlayerSkeleton} skeleton
   */
  constructor(skeleton) {
    this.skeleton = skeleton;

    // ── Gait parameters ──
    this.strideLength = 0.60;
    this.stepHeight   = 0.30;
    this.stepDuration = 0.10;
    this.bodySpeed    = this.strideLength / this.stepDuration;

    // ── Phase controls ──
    this.phaseSpread     = 0.66;
    this.phaseRandomness = 0.42;

    // ── Idle correction ──
    // When standing still, if any foot drifts this far from home (e.g. from turning),
    // trigger a corrective step to bring it back.
    this.idleCorrectionThreshold = 0.3;

    // ── Limb definitions ──
    this.limbs = this._initLimbs();

    // Tripod groups (indices into this.limbs)
    // L0=0, R0=1, L1=2, R1=3, L2=4, R2=5
    this.groupA = [0, 3, 4]; // L0, R1, L2
    this.groupB = [1, 2, 5]; // R0, L1, R2

    // ── Per-leg step state ──
    // Each of the 3 slots in a group has its own timer and delay.
    this.stepping    = false;
    this.activeGroup = null;
    this._nextGroup  = 'A';

    // Per-slot (3 per group)
    this.legState = [
      { timer: 0, delay: 0, started: false, done: false, startPos: new THREE.Vector3(), targetPos: new THREE.Vector3() },
      { timer: 0, delay: 0, started: false, done: false, startPos: new THREE.Vector3(), targetPos: new THREE.Vector3() },
      { timer: 0, delay: 0, started: false, done: false, startPos: new THREE.Vector3(), targetPos: new THREE.Vector3() },
    ];

    // Global elapsed time for noise oscillator
    this._elapsed = 0;

    // ── Idle fidget animation ──
    this._idleTimer      = 0;
    this._idleNextAction  = 1.0 + Math.random() * 2.0;
    this._idleAnimating   = false;
    this._idleType        = null;   // 'shuffle' | 'tap'
    this._idleLegIdx      = -1;
    this._idleProgress    = 0;
    this._idleDuration    = 0;
    this._idleTapHeight   = 0;
    this._idleStartPos    = new THREE.Vector3();
    this._idleTargetPos   = new THREE.Vector3();

    // ── Step cooldown (prevents rapid re-triggering at surface edges) ──
    this._stepCooldown = 0;
    this._stepCooldownDuration = 0.08;

    // ── Active step height (smaller for idle corrections) ──
    this._currentStepHeight = this.stepHeight;

    // ── Climb state ──
    this.climbing = false;              // true when attached to a wall
    this._climbNormal = new THREE.Vector3();  // wall's outward normal
    this._climbDir    = new THREE.Vector3();  // direction INTO the wall (-normal)
    this._bodyUp      = new THREE.Vector3(0, 1, 0); // body "up" from controller
    this.climbDetectDist   = 1.5;       // forward probe range for detection / corners
    this.climbMaintainDist = 2.0;       // proximity probe range for staying attached
    this.climbWrapDist     = 1.5;       // how far past the edge to probe for wrap-around
    this._wrappedEdge      = false;      // true for one frame after an edge wrap
    this._hipScale         = 1.0;        // current uniform foot-area multiplier (0..1)
    this._targetHipScale   = 1.0;        // target scale from surface probes
    this._climbTime        = 0;           // seconds spent climbing (for transition gating)
    this._surfaceRightDist = 10;          // distance to surface edge (+bodyRight)
    this._surfaceLeftDist  = 10;          // distance to surface edge (-bodyRight)
    this._maintainMissCount = 0;          // consecutive frames maintain probe missed

    // ── Movement input ──
    this.inputDir = new THREE.Vector3();
    this._smoothedInput = new THREE.Vector3(); // smoothed velocity for stride lead
    this._yaw = 0;
    this._movedDelta = new THREE.Vector3();

    // ── Transition request (consumed by PlayerController each frame) ──
    // When ProceduralWalk detects a surface change that needs orchestrated animation,
    // it sets this instead of flipping `climbing` directly. PlayerController reads it,
    // starts the FSM, then calls clearTransitionRequest().
    // Shape: { type: 'wall_to_ground'|'wall_to_top', point, normal, climbNormal }
    this._transitionRequest = null;

    // ── Transition lock (set by PlayerController while FSM is active) ──
    // Suppresses idle correction, surface probing, and drift steps that
    // would fight the transition's forced foot placements.
    this._inTransition = false;
  }

  /** Called by PlayerController after consuming the transition request. */
  clearTransitionRequest() { this._transitionRequest = null; }

  /**
   * Called by PlayerController when wall collision detects a climbable wall.
   * Engages climbing immediately so the creature doesn't have to stop and
   * re-press forward to start climbing (critical for GLB meshes where the
   * wall collision fires before climb detection can run).
   */
  requestClimb(point, normal) {
    if (this.climbing || this._transitionRequest) return; // already climbing or transitioning
    const normalIsWall = Math.abs(normal.y) < 0.5;
    if (!normalIsWall) return;
    this.climbing = true;
    this._climbTime = 0;
    this._climbNormal.copy(normal);
    this._climbDir.copy(normal).negate();
  }

  /** Rotate a home position into world frame. Uses body quaternion when climbing, yaw when on ground.
   *  Applies _hipScale uniformly to both lateral (X) and depth (Z) components. */
  _rotateHome(home, yaw) {
    if (this.climbing) {
      _worldHome.set(home.x * this._hipScale, home.y, home.z * this._hipScale);
      _worldHome.applyQuaternion(_bodyQuat);
      return _worldHome;
    }
    _worldHome.set(home.x * this._hipScale, home.y, home.z * this._hipScale);
    _worldHome.applyAxisAngle(_yAxis, yaw);
    return _worldHome;
  }

  /** Compute rest (home) foot positions based on skeleton dimensions. */
  _initLimbs() {
    const skel = this.skeleton;
    // Limb-attached nodes: 0 (rear), 2 (mid), 4 (front)
    const S1 = skel.spineLengths[0], S2 = skel.spineLengths[1];
    const S3 = skel.spineLengths[2], S4 = skel.spineLengths[3];
    const nodeZs = [-(S1 + S2), 0, S3 + S4];

    const limbs = [];
    for (let i = 0; i < 3; i++) {
      const nz = nodeZs[i];
      const limbIdxL = i * 2;
      const limbIdxR = i * 2 + 1;

      const hL = skel.hipLengths[limbIdxL];
      const hR = skel.hipLengths[limbIdxR];

      limbs.push({
        nodeIndex: i, side: 'L',
        home: new THREE.Vector3( hL, 0, nz),
        current: new THREE.Vector3( hL, 0, nz),
        surfaceNormal: new THREE.Vector3(0, 1, 0),
        grounded: true,
        maxReach: skel.hipLengths[limbIdxL] + skel.legLengths[limbIdxL],
      });
      limbs.push({
        nodeIndex: i, side: 'R',
        home: new THREE.Vector3(-hR, 0, nz),
        current: new THREE.Vector3(-hR, 0, nz),
        surfaceNormal: new THREE.Vector3(0, 1, 0),
        grounded: true,
        maxReach: skel.hipLengths[limbIdxR] + skel.legLengths[limbIdxR],
      });
    }
    return limbs;
  }

  setInput(dir) {
    this.inputDir.copy(dir);
  }

  setSmoothedInput(dir) {
    this._smoothedInput.copy(dir);
  }

  setBodyQuaternion(q) {
    _bodyQuat.copy(q);
  }

  setBodyUp(up) {
    this._bodyUp.copy(up);
  }

  /**
   * Clamp a foot target's lateral (bodyRight) displacement so it stays
   * within the probed surface width. Keeps feet from landing past edges.
   */
  _clampFootToSurface(target, bodyPos) {
    if (this.climbing) return; // only applies to ground mode
    _bodyRight.set(1, 0, 0).applyQuaternion(_bodyQuat);
    // Project foot-to-body offset onto bodyRight
    _tmpV.subVectors(target, bodyPos);
    const lateral = _tmpV.dot(_bodyRight);
    const safeMargin = 0.3; // keep feet this far from detected edge
    const maxRight = this._surfaceRightDist - safeMargin;
    const maxLeft  = this._surfaceLeftDist  - safeMargin;
    if (lateral > 0 && lateral > maxRight && maxRight > 0) {
      // Foot is too far right — pull it back
      target.addScaledVector(_bodyRight, maxRight - lateral);
    } else if (lateral < 0 && -lateral > maxLeft && maxLeft > 0) {
      // Foot is too far left — pull it back
      target.addScaledVector(_bodyRight, -maxLeft - lateral);
    }
  }

  /** Compute the phase delay for slot g (0,1,2) within a group. */
  _getPhaseDelay(g, groupIndices) {
    // Base stagger: evenly space within the step duration
    const baseDelay = g * this.phaseSpread * this.stepDuration / 3;

    // Random drift: smooth sine-based noise per limb
    const limbIdx = groupIndices[g];
    const noise = Math.sin(this._elapsed * NOISE_FREQS[limbIdx] * 2 * Math.PI);
    const randomOffset = noise * this.phaseRandomness * this.stepDuration * 0.5;

    return Math.max(0, baseDelay + randomOffset);
  }

  /**
   * Advance the walk cycle.
   * @param {number} dt – seconds
   * @param {THREE.Group} bodyGroup
   * @param {THREE.Mesh[]} groundMeshes
   * @param {number} yaw – player's yaw angle (radians)
   * @returns {{ movedDelta: THREE.Vector3 }}
   */
  update(dt, bodyGroup, groundMeshes, yaw) {
    this._elapsed += dt;
    this._yaw = yaw;
    const moving = this.inputDir.lengthSq() > 0.001;
    this._movedDelta.set(0, 0, 0);
    this._groundMeshes = groundMeshes || [];

    // Debug data for ClimbDebugVis — reset each frame
    if (!this._dbg) this._dbg = {};
    this._dbg.maintain = null;
    this._dbg.corner = null;
    this._dbg.wrap = null;
    this._wrappedEdge = false;

    // ── Climb detection / maintenance ──
    // Skip if a transition request is already pending (PlayerController hasn't consumed it yet)
    if (!this._transitionRequest) {
      const bodyPos = bodyGroup.position;

      if (this.climbing) {
        this._climbTime += dt;

        // ── GROUND DISMOUNT: exit climb near the bottom of the wall ──
        // Two triggers:
        //   A) Intentional: moving downward (inputDir has negative Y component)
        //   B) Automatic: body is close to the ground regardless of input
        //   C) Emergency: body is at or below ground level
        const onVerticalWall = Math.abs(this._climbNormal.y) < 0.3;
        if (onVerticalWall && this._climbTime > 0.3) {
          _rayOrigin.copy(bodyPos);
          // Cast downward for ground
          let groundHit = castSurface(_rayOrigin, _tmpV.set(0, -1, 0), this._groundMeshes, this.skeleton._refSpineHeight + 3.0, 'climb_dismount');
          // Also cast UPWARD — if body clipped below floor, downward ray misses it
          if (!groundHit) {
            groundHit = castSurface(_rayOrigin, _tmpV.set(0, 1, 0), this._groundMeshes, this.skeleton._refSpineHeight + 3.0, 'climb_dismount_up');
          }
          if (groundHit && groundHit.normal.y > 0.7) {
            const distToGround = bodyPos.y - groundHit.point.y;
            if (distToGround <= 0) {
              // C) Emergency: body is at or below ground — force immediate dismount
              this._transitionRequest = {
                type: 'wall_to_ground',
                point: groundHit.point.clone(),
                normal: groundHit.normal.clone(),
                climbNormal: this._climbNormal.clone(),
              };
            } else {
              // A) Intentional dismount: moving downward and close to ground
              const movingDown = this.inputDir.y < -0.05 ||
                (this.inputDir.lengthSq() > 0.001 && this.inputDir.dot(_tmpV.set(0, -1, 0)) > 0.02);
              // B) Automatic: very close to ground (within half spineHeight)
              const veryClose = distToGround < this.skeleton._refSpineHeight * 0.8;
              if (distToGround < this.skeleton._refSpineHeight + 1.5 && (movingDown || veryClose)) {
                this._transitionRequest = {
                  type: 'wall_to_ground',
                  point: groundHit.point.clone(),
                  normal: groundHit.normal.clone(),
                  climbNormal: this._climbNormal.clone(),
                };
              }
            }
          }
        }
      }

      if (this.climbing) {
        if (moving) {
          // ── MAINTAIN: 3-ray fan into the wall ──
          // Center ray + two offset along the wall plane (±bodyRight).
          // Averaging the normals from all hits dramatically reduces jitter
          // near edges where a single ray alternates between faces.
          this._dbg.maintain = {
            ox: bodyPos.x, oy: bodyPos.y, oz: bodyPos.z,
            dx: this._climbDir.x, dy: this._climbDir.y, dz: this._climbDir.z,
            len: this.climbMaintainDist,
          };
          _bodyRight.crossVectors(this._bodyUp, this._climbDir);
          if (_bodyRight.lengthSq() < 0.001) _bodyRight.crossVectors(_tmpV.set(0, 1, 0), this._climbDir);
          _bodyRight.normalize();

          const fanSpread = 0.4; // lateral offset for side rays
          let fanHits = 0;
          _fanNormal.set(0, 0, 0);
          let maintainHit = null; // keep the best center-ish hit for point reference

          for (let fi = -1; fi <= 1; fi++) {
            _fanOrigin.copy(bodyPos).addScaledVector(_bodyRight, fi * fanSpread);
            const fHit = castSurface(_fanOrigin, this._climbDir, this._groundMeshes, this.climbMaintainDist, 'climb_maintain');
            if (fHit && fHit.object.userData.climbable && fHit.normal.y > -0.3) {
              // Reject ceiling normals (y < -0.3) to prevent wrapping onto undersides
              _fanNormal.add(fHit.normal);
              fanHits++;
              if (fi === 0 || !maintainHit) {
                // Stash hit data (castSurface reuses shared objects, so clone what we need)
                if (!maintainHit) maintainHit = { point: fHit.point.clone(), normal: fHit.normal.clone(), object: fHit.object };
                else { maintainHit.point.copy(fHit.point); maintainHit.normal.copy(fHit.normal); maintainHit.object = fHit.object; }
              }
            }
          }

          if (fanHits > 0 && maintainHit) {
            this._maintainMissCount = 0;
            // Average normal from all fan hits
            _fanNormal.divideScalar(fanHits).normalize();

            const normalDot = _fanNormal.dot(this._climbNormal);
            if (normalDot < 0.995) {
              const normalAlpha = Math.min(1, 10 * dt);
              this._climbNormal.lerp(_fanNormal, normalAlpha).normalize();
              this._climbDir.copy(this._climbNormal).negate();
            }

            // ── LOOK-AHEAD: 3-ray fan one stride ahead ──
            // Center + ±bodyRight offset catches edges that are slightly off-center.
            let lookaheadHits = 0;
            for (let li = -1; li <= 1; li++) {
              _fanOrigin.copy(bodyPos)
                .addScaledVector(this.inputDir, this.strideLength)
                .addScaledVector(_bodyRight, li * fanSpread * 0.7);
              const laHit = castSurface(_fanOrigin, this._climbDir, this._groundMeshes, this.climbMaintainDist, 'climb_lookahead');
              if (laHit) lookaheadHits++;
            }

            if (lookaheadHits === 0) {
              // Edge is imminent — find the adjacent face and start blending NOW.
              // Probe from inside the wall volume, past the edge, cast back.
              _rayOrigin.copy(maintainHit.point)       // on the surface
                .addScaledVector(this._climbDir, 0.3)  // into the wall volume
                .addScaledVector(this.inputDir, this.strideLength); // past the edge
              _tmpV2.copy(this.inputDir).negate();
              this._dbg.wrap = {
                ox: _rayOrigin.x, oy: _rayOrigin.y, oz: _rayOrigin.z,
                dx: _tmpV2.x, dy: _tmpV2.y, dz: _tmpV2.z,
                len: this.strideLength + 1,
              };
              const adj = castSurface(_rayOrigin, _tmpV2, this._groundMeshes, this.strideLength + 1, 'climb_wrap_adj');
              if (adj && adj.normal.dot(this._climbNormal) < 0.85 && adj.normal.y > -0.3) {
                const isFloor = adj.normal.y > 0.7;
                if (adj.object.userData.climbable || isFloor) {
                  if (isFloor) {
                    this._transitionRequest = {
                      type: 'wall_to_top',
                      point: adj.point.clone(),
                      normal: adj.normal.clone(),
                      climbNormal: this._climbNormal.clone(),
                    };
                  } else {
                    this._climbNormal.lerp(adj.normal, Math.min(1, 10 * dt)).normalize();
                    this._climbDir.copy(this._climbNormal).negate();
                  }
                }
              }
            }

            // ── CORNER: probe in movement direction for perpendicular walls ──
            this._dbg.corner = {
              ox: bodyPos.x, oy: bodyPos.y, oz: bodyPos.z,
              dx: this.inputDir.x, dy: this.inputDir.y, dz: this.inputDir.z,
              len: this.climbDetectDist,
            };
            const ahead = castSurface(bodyPos, this.inputDir, this._groundMeshes, this.climbDetectDist, 'climb_corner');
            if (ahead && (ahead.object.userData.climbable || ahead.normal.y > 0.7) && ahead.normal.y > -0.3) {
              const dot = ahead.normal.dot(this._climbNormal);
              if (dot < 0.85) {
                if (ahead.normal.y > 0.7) {
                  this._transitionRequest = {
                    type: 'wall_to_top',
                    point: ahead.point.clone(),
                    normal: ahead.normal.clone(),
                    climbNormal: this._climbNormal.clone(),
                  };
                } else {
                  this._climbNormal.lerp(ahead.normal, Math.min(1, 10 * dt)).normalize();
                  this._climbDir.copy(this._climbNormal).negate();
                }
              }
            }

          } else {
            // ── EDGE WRAP: maintain missed — require sustained miss before acting ──
            this._maintainMissCount++;
            let wrapped = false;

            // Require consecutive misses before triggering edge wrap probes.
            // Single-frame misses are common on complex meshes (ray/tri precision).
            if (this._maintainMissCount < 3) wrapped = true; // hold state, skip probes

            // Probe A — Adjacent face: start from the wall surface (not from body),
            // go INTO the wall, past the edge, and cast back.
            // Use _climbDir * 0.3 from bodyPos to approximate the surface point,
            // then add another 0.3 to be inside the wall volume.
            _rayOrigin.copy(bodyPos)
              .addScaledVector(this._climbDir, 0.5)    // past the surface into volume
              .addScaledVector(this.inputDir, this.climbWrapDist);
            _tmpV2.copy(this.inputDir).negate();
            this._dbg.wrap = {
              ox: _rayOrigin.x, oy: _rayOrigin.y, oz: _rayOrigin.z,
              dx: _tmpV2.x, dy: _tmpV2.y, dz: _tmpV2.z,
              len: this.climbWrapDist + 1,
            };
            const edgeHit = castSurface(_rayOrigin, _tmpV2, this._groundMeshes, this.climbWrapDist + 1, 'climb_wrap_adj');
            if (edgeHit && edgeHit.normal.dot(this._climbNormal) < 0.9 && edgeHit.normal.y > -0.3) {
              const isFloor = edgeHit.normal.y > 0.7;
              if (edgeHit.object.userData.climbable || isFloor) {
                if (isFloor) {
                  // Request orchestrated wall→top transition
                  this._transitionRequest = {
                    type: 'wall_to_top',
                    point: edgeHit.point.clone(),
                    normal: edgeHit.normal.clone(),
                    climbNormal: this._climbNormal.clone(),
                  };
                  this._movedDelta.set(0, 0, 0);
                  wrapped = true;
                } else {
                  // Wall-to-wall edge wrap
                  this._climbNormal.copy(edgeHit.normal);
                  this._climbDir.copy(edgeHit.normal).negate();
                  bodyPos.copy(edgeHit.point).addScaledVector(edgeHit.normal, 0.15);
                  this._wrappedEdge = true;
                  this._movedDelta.set(0, 0, 0);
                  wrapped = true;
                }
              }
            }

            // Probe B — Back face: from well past the wall, cast back toward us.
            // Stay at the SAME height as body (no inputDir offset).
            if (!wrapped) {
              _rayOrigin.copy(bodyPos)
                .addScaledVector(this._climbDir, 4.0);
              this._dbg.wrap = {
                ox: _rayOrigin.x, oy: _rayOrigin.y, oz: _rayOrigin.z,
                dx: this._climbNormal.x, dy: this._climbNormal.y, dz: this._climbNormal.z,
                len: 6,
              };
              const backHit = castSurface(_rayOrigin, this._climbNormal, this._groundMeshes, 6, 'climb_wrap_back');
              if (backHit && (backHit.object.userData.climbable || backHit.normal.y > 0.7) && backHit.normal.y > -0.3) {
                const isFloor = backHit.normal.y > 0.7;
                if (isFloor) {
                  // Request orchestrated wall→top transition
                  this._transitionRequest = {
                    type: 'wall_to_top',
                    point: backHit.point.clone(),
                    normal: backHit.normal.clone(),
                    climbNormal: this._climbNormal.clone(),
                  };
                  this._movedDelta.set(0, 0, 0);
                  wrapped = true;
                } else {
                  // Wall-to-wall back-face wrap
                  this._climbNormal.copy(backHit.normal);
                  this._climbDir.copy(backHit.normal).negate();
                  bodyPos.copy(backHit.point).addScaledVector(backHit.normal, 0.15);
                  this._wrappedEdge = true;
                  this._movedDelta.set(0, 0, 0);
                  wrapped = true;
                }
              }
            }

            // Probe C — Ground below: last resort before detaching.
            // If we lost the wall, check if there's ground to land on.
            if (!wrapped) {
              _rayOrigin.copy(bodyPos);
              const gBelow = castSurface(_rayOrigin, _tmpV.set(0, -1, 0), this._groundMeshes, this.skeleton._refSpineHeight + 3, 'climb_wrap_ground');
              if (gBelow && gBelow.normal.y > 0.7) {
                this._transitionRequest = {
                  type: 'wall_to_ground',
                  point: gBelow.point.clone(),
                  normal: gBelow.normal.clone(),
                  climbNormal: this._climbNormal.clone(),
                };
                this._movedDelta.set(0, 0, 0);
                wrapped = true;
              }
            }

            if (!wrapped) {
              this.climbing = false;
            }
          }
        }
        // When idle + climbing: keep current state unchanged
      } else if (moving) {
        // ENTER: probe for initial climb detection in forward + perpendicular directions.
        // Perpendicular probes are critical for catching walls while strafing along edges.
        let climbHit = null;
        // 1. Forward (along input direction)
        const fwdHit = castSurface(bodyPos, this.inputDir, this._groundMeshes, this.climbDetectDist, 'climb_corner');
        if (fwdHit && fwdHit.object.userData.climbable && !this._hasSteppableTop(fwdHit.point, bodyPos.y)) {
          climbHit = { point: fwdHit.point.clone(), normal: fwdHit.normal.clone() };
        }
        // 2. Right perpendicular
        if (!climbHit) {
          _fanOffset.set(-this.inputDir.z, 0, this.inputDir.x).normalize();
          const rHit = castSurface(bodyPos, _fanOffset, this._groundMeshes, this.climbDetectDist, 'climb_corner');
          if (rHit && rHit.object.userData.climbable && !this._hasSteppableTop(rHit.point, bodyPos.y)) {
            climbHit = { point: rHit.point.clone(), normal: rHit.normal.clone() };
          }
        }
        // 3. Left perpendicular
        if (!climbHit) {
          _fanOffset.set(this.inputDir.z, 0, -this.inputDir.x).normalize();
          const lHit = castSurface(bodyPos, _fanOffset, this._groundMeshes, this.climbDetectDist, 'climb_corner');
          if (lHit && lHit.object.userData.climbable && !this._hasSteppableTop(lHit.point, bodyPos.y)) {
            climbHit = { point: lHit.point.clone(), normal: lHit.normal.clone() };
          }
        }
        if (climbHit) {
          // Validate: normal must be wall-like (not a slope) and body must be
          // close enough that maintain probes will actually see the wall.
          const normalIsWall = Math.abs(climbHit.normal.y) < 0.5;
          // Distance from body to wall surface along the wall normal direction
          _tmpV.subVectors(climbHit.point, bodyPos);
          const distToWall = Math.abs(_tmpV.dot(climbHit.normal));
          const closeEnough = distToWall < this.skeleton._refSpineHeight * 2.5;
          if (normalIsWall && closeEnough) {
            this.climbing = true;
            this._climbTime = 0;
            this._climbNormal.copy(climbHit.normal);
            this._climbDir.copy(climbHit.normal).negate();
          }
        }
      }
    }

    if (this.stepping) {
      const group = this.activeGroup;
      let allDone = true;

      for (let g = 0; g < 3; g++) {
        const ls = this.legState[g];
        if (ls.done) continue;

        // Check if this leg's delay has passed
        ls.timer += dt;
        if (ls.timer < ls.delay) {
          allDone = false;
          continue;
        }

        // This leg is actively stepping
        if (!ls.started) ls.started = true;

        const elapsed = ls.timer - ls.delay;
        const t = Math.min(elapsed / this.stepDuration, 1);

        const limb = this.limbs[group[g]];
        limb.current.lerpVectors(ls.startPos, ls.targetPos, t);
        // Step arc perpendicular to the current surface
        limb.current.addScaledVector(this._bodyUp, arcHeight(t, this._currentStepHeight));

        if (t >= 1) {
          limb.current.copy(ls.targetPos);
          // Re-snap to surface at landing — body may have moved since step start.
          // During transitions, _climbDir/_climbNormal are pre-set even if climbing
          // flag hasn't flipped yet, so use _inTransition to force climb-mode casting.
          const bp = bodyGroup.position;
          const useClimb = this.climbing || this._inTransition;
          const landNorm = placeOnSurface(limb.current, this._groundMeshes,
            this._climbDir, useClimb, bp.y, bp);
          limb.surfaceNormal.copy(landNorm);
          limb.grounded = true;
          ls.done = true;
        } else {
          allDone = false;
        }
      }

      // Move body while step is in progress
      if (moving && !this._wrappedEdge) {
        this._movedDelta.copy(this.inputDir).multiplyScalar(this.bodySpeed * dt);
      }

      if (allDone) {
        this.stepping = false;
        this._stepCooldown = this._stepCooldownDuration;
      }
    }

    // Tick cooldown
    if (this._stepCooldown > 0) this._stepCooldown -= dt;

    if (!this.stepping && moving && !this._inTransition) {
      const bodyPos = bodyGroup.position;

      if (this._stepCooldown <= 0 && this._checkNeedStep(bodyPos, yaw)) {
        this._triggerStep(bodyPos, yaw);
      } else if (!this._wrappedEdge) {
        this._movedDelta.copy(this.inputDir).multiplyScalar(this.bodySpeed * dt);
      }
    }

    // ── Idle behaviour: correction + fidget (shuffle / tap) ──
    // Skip entirely during controller-driven transitions — forced steps handle feet.
    if (!this.stepping && !moving && !this._inTransition) {
      const bodyPos = bodyGroup.position;

      // Keep surface-width probe up to date while idle so hip scale adapts
      this._probeSurfaceWidth(bodyPos);

      if (this._idleAnimating) {
        // Advance the single-leg fidget animation
        this._updateIdleAnimation(dt);
      } else {
        // Priority 1 – drift correction after rotation
        const driftA = this._maxGroupDrift(this.groupA, bodyPos, this._yaw);
        const driftB = this._maxGroupDrift(this.groupB, bodyPos, this._yaw);
        const corrThresh = this.climbing ? 0.5 : this.idleCorrectionThreshold;

        if (driftA > corrThresh || driftB > corrThresh) {
          const correctGroup = driftA >= driftB ? 'A' : 'B';
          this._nextGroup = correctGroup;
          this._triggerIdleCorrection(bodyPos, this._yaw);
        } else if (!this.climbing) {
          // Priority 2 – fidget timer (skip fidgets while climbing)
          this._idleTimer += dt;
          if (this._idleTimer >= this._idleNextAction) {
            this._startIdleAction(bodyPos, this._yaw);
          }
        }
      }
    } else {
      // Moving or stepping – cancel any fidget and reset timer
      if (this._idleAnimating) this._cancelIdleAnimation();
      this._idleTimer = 0;
    }

    // Grounded feet stay locked where they landed.
    // No per-frame re-snapping — this prevents oscillation at surface edges.

    // Smooth uniform scale toward target
    this._hipScale += (this._targetHipScale - this._hipScale) * Math.min(1, 8 * dt);

    return { movedDelta: this._movedDelta };
  }

  _checkNeedStep(bodyPos, yaw) {
    const group = this._nextGroup === 'A' ? this.groupA : this.groupB;
    const threshold = this.strideLength * 0.5;

    for (const idx of group) {
      const limb = this.limbs[idx];
      this._rotateHome(limb.home, yaw).add(bodyPos);
      const dx = limb.current.x - _worldHome.x;
      const dy = this.climbing ? limb.current.y - _worldHome.y : 0;
      const dz = limb.current.z - _worldHome.z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) > threshold) return true;
    }
    return false;
  }

  /**
   * Check if there is a walkable (floor-like) top surface above a wall hit point
   * that is within maxStepHeight of the player. If so, stepping is preferred over climbing.
   * Uses the skeleton's spineHeight as a proxy for maxStepHeight (matches PlayerController).
   */
  _hasSteppableTop(wallHitPoint, bodyY) {
    const maxStep = 1.2; // matches PlayerController.maxStepHeight
    _rayOrigin.set(wallHitPoint.x, bodyY + maxStep + 2, wallHitPoint.z);
    _raycaster.set(_rayOrigin, _tmpV.set(0, -1, 0));
    _raycaster.far = maxStep + 4;
    _hitsArray.length = 0;
    _raycaster.intersectObjects(this._groundMeshes, false, _hitsArray);
    for (let i = 0; i < _hitsArray.length; i++) {
      const h = _hitsArray[i];
      _worldNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
      if (_worldNormal.y < 0.5) continue;
      const topY = h.point.y;
      // Must be above the wall face hit (actual top of the obstacle, not ground at its base)
      if (topY < wallHitPoint.y + 0.1) continue;
      const stepUp = topY - bodyY;
      if (stepUp > 0 && stepUp <= maxStep) return true;
    }
    return false;
  }

  /**
   * Probe surface extent in both width (±bodyRight) and depth (±bodyForward).
   * Uses the tightest constraint to scale hip offsets so feet stay on surface.
   */
  _probeSurfaceWidth(bodyPos) {
    _bodyRight.set(1, 0, 0).applyQuaternion(_bodyQuat);
    _bodyFwd.set(0, 0, 1).applyQuaternion(_bodyQuat);

    // Find the widest hip and longest spine extent among all limbs
    let maxHip = 0;
    let maxDepth = 0;
    for (const limb of this.limbs) {
      const absX = Math.abs(limb.home.x);
      const absZ = Math.abs(limb.home.z);
      if (absX > maxHip) maxHip = absX;
      if (absZ > maxDepth) maxDepth = absZ;
    }
    if (maxHip < 0.01) { this._targetHipScale = 1.0; return; }

    // Probe along an axis: returns distance to edge in + and - directions
    const probeAxis = (axis, reach) => {
      const probeLen = reach + 0.5;
      let posDist = probeLen;
      let negDist = probeLen;

      if (this.climbing) {
        // Wall mode: cast along axis from surface-offset origin
        for (let s = 0; s < 2; s++) {
          const sign = s === 0 ? 1 : -1;
          const dir = _tmpV2.copy(axis).multiplyScalar(sign);
          _rayOrigin.copy(bodyPos).addScaledVector(this._climbDir, 0.3);
          const hit = castSurface(_rayOrigin, dir, this._groundMeshes, probeLen, 'width_probe');
          if (!hit) {
            // Back-cast from far out
            _rayOrigin.copy(bodyPos).addScaledVector(axis, sign * probeLen)
              .addScaledVector(this._climbDir, 0.3);
            const backDir = _tmpV2.copy(axis).multiplyScalar(-sign);
            const bHit = castSurface(_rayOrigin, backDir, this._groundMeshes, probeLen, 'width_probe');
            if (bHit) {
              _tmpV.subVectors(bHit.point, bodyPos);
              const d = Math.abs(_tmpV.dot(axis));
              if (s === 0) posDist = d; else negDist = d;
            } else {
              if (s === 0) posDist = 0.1; else negDist = 0.1;
            }
          }
        }
      } else {
        // Ground mode: search inward from far for surface edge
        for (let s = 0; s < 2; s++) {
          const sign = s === 0 ? 1 : -1;
          let edgeDist = probeLen;
          let found = false;
          for (let d = probeLen; d >= 0.1; d -= 0.15) {
            const gy = getGroundY(
              bodyPos.x + axis.x * d * sign,
              bodyPos.z + axis.z * d * sign,
              this._groundMeshes, NaN, bodyPos.y, 'width_probe'
            );
            if (!isNaN(gy) && Math.abs(gy - bodyPos.y) < 2.0) {
              edgeDist = d;
              found = true;
              break;
            }
          }
          if (!found) edgeDist = 0.1;
          if (s === 0) posDist = edgeDist; else negDist = edgeDist;
        }
      }
      return { posDist, negDist };
    };

    // Width (lateral) probe
    const w = probeAxis(_bodyRight, maxHip);
    this._surfaceRightDist = w.posDist;
    this._surfaceLeftDist  = w.negDist;
    const halfWidth = Math.min(w.posDist, w.negDist);

    // Depth (forward/back) probe
    const d = probeAxis(_bodyFwd, maxDepth);
    const halfDepth = Math.min(d.posDist, d.negDist);

    // Scale: use tightest axis, target 0.5× surface extent
    const margin = 0.15;
    const maxExtent = Math.max(maxHip, maxDepth); // largest foot reach in any direction
    const tightest = Math.min(halfWidth, halfDepth); // narrowest surface dimension
    // Fit feet within 50% of the surface width
    const scale = Math.min(1, Math.max(0.1, (tightest * 0.5 - margin) / maxExtent));

    this._targetHipScale = scale;
  }

  _triggerStep(bodyPos, yaw) {
    this._probeSurfaceWidth(bodyPos);
    const group = this._nextGroup === 'A' ? this.groupA : this.groupB;
    this.activeGroup = group;
    this._nextGroup = this._nextGroup === 'A' ? 'B' : 'A';
    this.stepping = true;
    this._currentStepHeight = this.stepHeight;

    for (let g = 0; g < 3; g++) {
      const limb = this.limbs[group[g]];
      limb.grounded = false;

      const ls = this.legState[g];
      ls.timer   = 0;
      ls.delay   = this._getPhaseDelay(g, group);
      ls.started = false;
      ls.done    = false;
      ls.startPos.copy(limb.current);

      this._rotateHome(limb.home, yaw).add(bodyPos);
      ls.targetPos.copy(_worldHome)
        .addScaledVector(this._smoothedInput, this.strideLength * 0.5);

      // Reachability clamp — pull target inward if it exceeds leg reach
      _tmpV.subVectors(ls.targetPos, bodyPos);
      const dist = _tmpV.length();
      const maxDist = limb.maxReach * 0.9;
      if (dist > maxDist) {
        ls.targetPos.copy(bodyPos).addScaledVector(_tmpV.normalize(), maxDist);
      }

      // Lateral clamp — keep feet within probed surface bounds
      this._clampFootToSurface(ls.targetPos, bodyPos);

      const norm = placeOnSurface(ls.targetPos, this._groundMeshes,
        this._climbDir, this.climbing, bodyPos.y, bodyPos);
      limb.surfaceNormal.copy(norm);
    }
  }

  /** Get the maximum drift of any limb in a group from its home position. */
  _maxGroupDrift(group, bodyPos, yaw) {
    let maxDist = 0;
    for (const idx of group) {
      const limb = this.limbs[idx];
      this._rotateHome(limb.home, yaw).add(bodyPos);
      const dx = limb.current.x - _worldHome.x;
      const dy = this.climbing ? limb.current.y - _worldHome.y : 0;
      const dz = limb.current.z - _worldHome.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > maxDist) maxDist = dist;
    }
    return maxDist;
  }

  _triggerIdleCorrection(bodyPos, yaw) {
    this._probeSurfaceWidth(bodyPos);
    const group = this._nextGroup === 'A' ? this.groupA : this.groupB;
    this.activeGroup = group;
    this._nextGroup = this._nextGroup === 'A' ? 'B' : 'A';
    this.stepping = true;
    this._currentStepHeight = this.climbing ? 0.03 : this.stepHeight * 0.4;

    for (let g = 0; g < 3; g++) {
      const limb = this.limbs[group[g]];
      limb.grounded = false;

      const ls = this.legState[g];
      ls.timer   = 0;
      ls.delay   = this._getPhaseDelay(g, group);
      ls.started = false;
      ls.done    = false;
      ls.startPos.copy(limb.current);

      // Target is exactly the home position (no overshoot)
      this._rotateHome(limb.home, yaw).add(bodyPos);
      ls.targetPos.copy(_worldHome);

      // Lateral clamp — keep feet within probed surface bounds
      this._clampFootToSurface(ls.targetPos, bodyPos);

      const norm = placeOnSurface(ls.targetPos, this._groundMeshes,
        this._climbDir, this.climbing, bodyPos.y, bodyPos);
      limb.surfaceNormal.copy(norm);
    }
  }

  // ── Idle fidget helpers ────────────────────────────────────────────────

  _startIdleAction(bodyPos, yaw) {
    // Pick a random leg
    this._idleLegIdx = Math.floor(Math.random() * 6);

    // 35 % chance of a tap, otherwise a small shuffle step
    this._idleType = Math.random() < 0.35 ? 'tap' : 'shuffle';

    const limb = this.limbs[this._idleLegIdx];
    this._idleStartPos.copy(limb.current);

    if (this._idleType === 'shuffle') {
      // Small step to a random spot near the limb's home
      this._rotateHome(limb.home, yaw).add(bodyPos);

      const angle = Math.random() * Math.PI * 2;
      const dist  = 0.05 + Math.random() * 0.15;
      this._idleTargetPos.copy(_worldHome);
      this._idleTargetPos.x += Math.cos(angle) * dist;
      this._idleTargetPos.z += Math.sin(angle) * dist;

      const norm = placeOnSurface(this._idleTargetPos, this._groundMeshes,
        this._climbDir, this.climbing, bodyPos.y, bodyPos);
      limb.surfaceNormal.copy(norm);

      this._idleDuration = 0.20 + Math.random() * 0.15;
    } else {
      // Tap – foot stays in place; only Y animates
      this._idleTargetPos.copy(limb.current);
      this._idleTapHeight = 0.05 + Math.random() * 0.04;
      this._idleDuration  = 0.30 + Math.random() * 0.15;
    }

    this._idleProgress  = 0;
    this._idleAnimating = true;
    limb.grounded = false;

    // Schedule next fidget
    this._idleTimer      = 0;
    this._idleNextAction = 0.4 + Math.random() * 1.5;
  }

  _updateIdleAnimation(dt) {
    this._idleProgress += dt;
    const t = Math.min(this._idleProgress / this._idleDuration, 1);
    const limb = this.limbs[this._idleLegIdx];

    if (this._idleType === 'shuffle') {
      limb.current.lerpVectors(this._idleStartPos, this._idleTargetPos, t);
      limb.current.y += arcHeight(t, 0.06); // subtle lift on top of terrain
    } else {
      // Tap: slow rise (65 % of time), fast drop (35 %)
      const upPhase = 0.65;
      const h = this._idleTapHeight;
      const groundY = getGroundY(limb.current.x, limb.current.z, this._groundMeshes, 0, limb.current.y);
      if (t < upPhase) {
        const u = t / upPhase;
        limb.current.y = groundY + h * u * u * (3 - 2 * u); // smoothstep rise
      } else {
        const d = (t - upPhase) / (1 - upPhase);
        limb.current.y = groundY + h * (1 - d);              // linear fast drop
      }
    }

    if (t >= 1) {
      limb.current.y = getGroundY(limb.current.x, limb.current.z, this._groundMeshes, 0, limb.current.y);
      limb.grounded  = true;
      this._idleAnimating = false;
    }
  }

  _cancelIdleAnimation() {
    const limb = this.limbs[this._idleLegIdx];
    limb.current.y = getGroundY(limb.current.x, limb.current.z, this._groundMeshes, 0, limb.current.y);
    limb.grounded  = true;
    this._idleAnimating = false;
    this._idleTimer     = 0;
  }

  /**
   * Force a specific group of legs to step toward given world-space targets.
   * Used by the edge transition system to coordinate leg placement on the wall.
   * @param {'A'|'B'} groupName – which tripod group to step
   * @param {THREE.Vector3[]} targets – array of 3 world-space positions (one per leg in group)
   * @param {number} stepHeight – arc height for these steps
   */
  forceStepGroup(groupName, targets, stepHeight = 0.15) {
    const group = groupName === 'A' ? this.groupA : this.groupB;
    if (this._idleAnimating) this._cancelIdleAnimation();
    this.activeGroup = group;
    this.stepping = true;
    this._currentStepHeight = stepHeight;

    for (let g = 0; g < 3; g++) {
      const limb = this.limbs[group[g]];
      limb.grounded = false;

      const ls = this.legState[g];
      ls.timer   = 0;
      ls.delay   = g * 0.03; // slight stagger
      ls.started = false;
      ls.done    = false;
      ls.startPos.copy(limb.current);
      ls.targetPos.copy(targets[g]);
    }
  }

  /** Check if a forced/normal step is currently in progress. */
  isStepComplete() {
    if (!this.stepping) return true;
    return this.legState.every(ls => ls.done);
  }

  /** Cache the body inverse matrix once per frame (call before getFootLocal loop). */
  cacheBodyInverse(bodyGroup) {
    bodyGroup.updateMatrixWorld(true);
    _invBody.copy(bodyGroup.matrixWorld).invert();
  }

  getFootLocal(limbIndex) {
    _footLocal.copy(this.limbs[limbIndex].current);
    _footLocal.applyMatrix4(_invBody);
    return _footLocal;
  }

  /** Get the surface normal averaged across all grounded feet. */
  getAverageSurfaceNormal() {
    _avgNorm.set(0, 0, 0);
    let count = 0;
    for (const limb of this.limbs) {
      if (limb.grounded) {
        _avgNorm.add(limb.surfaceNormal);
        count++;
      }
    }
    if (count > 0) {
      _avgNorm.divideScalar(count).normalize();
    } else {
      _avgNorm.set(0, 1, 0);
    }
    return _avgNorm;
  }

  /** Get the best-fit plane from foot positions.
   *  Centroid uses only grounded feet to avoid arc-peak pull during steps.
   *  Normal uses all 6 feet for stability. */
  getFootPlane() {
    // Centroid from grounded feet only
    _planeCenter.set(0, 0, 0);
    let groundedCount = 0;
    for (const limb of this.limbs) {
      if (limb.grounded) {
        _planeCenter.add(limb.current);
        groundedCount++;
      }
    }
    if (groundedCount > 0) {
      _planeCenter.divideScalar(groundedCount);
    } else {
      // Fallback: all 6
      for (const limb of this.limbs) _planeCenter.add(limb.current);
      _planeCenter.divideScalar(this.limbs.length);
    }

    _planeNorm.set(0, 0, 0);
    const pts = this.limbs;
    for (let i = 0; i < pts.length; i++) {
      const curr = pts[i].current;
      const next = pts[(i + 1) % pts.length].current;
      _planeNorm.x += (curr.y - next.y) * (curr.z + next.z);
      _planeNorm.y += (curr.z - next.z) * (curr.x + next.x);
      _planeNorm.z += (curr.x - next.x) * (curr.y + next.y);
    }
    if (_planeNorm.lengthSq() < 0.0001) {
      _planeNorm.set(0, 1, 0);
    } else {
      _planeNorm.normalize();
      if (_planeNorm.y < -0.5) _planeNorm.negate();
    }

    // Use grounded-feet normals for tilt (more accurate than position-derived)
    const avgNormal = this.getAverageSurfaceNormal();
    if (avgNormal.lengthSq() > 0.5) {
      _planeNorm.copy(avgNormal);
    }
    return { centroid: _planeCenter, normal: _planeNorm };
  }
}
