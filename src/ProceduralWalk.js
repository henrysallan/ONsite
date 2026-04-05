import * as THREE from 'three';

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
function getGroundY(x, z, groundMeshes, fallback = 0, refY = null) {
  if (!groundMeshes || groundMeshes.length === 0) return fallback;
  const startY = refY !== null ? refY + 5 : 50;
  _rayOrigin.set(x, startY, z);
  _raycaster.set(_rayOrigin, _tmpV.set(0, -1, 0));
  _raycaster.far = refY !== null ? 15 : Infinity;
  _hitsArray.length = 0;
  _raycaster.intersectObjects(groundMeshes, false, _hitsArray);
  for (let i = 0; i < _hitsArray.length; i++) {
    const h = _hitsArray[i];
    _worldNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
    if (_worldNormal.y > 0.5) return h.point.y;
  }
  return fallback;
}

/**
 * Cast a single ray from origin along dir, return shared _hitResult or null.
 * Iterates all hits to skip backfaces (normal facing same way as ray).
 * This is critical when geometry overlaps — the first hit may be a backface
 * (e.g., inside of a wall box), and the real surface is behind it.
 * WARNING: returned object is reused — copy values if you need to keep them.
 */
function castSurface(origin, dir, meshes, maxDist) {
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
      return _hitResult;
    }
  }
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
    const hit = castSurface(_rayOrigin, climbDir, groundMeshes, 3);
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
        const retry = castSurface(_rayOrigin, climbDir, groundMeshes, 3);
        if (retry) {
          pos.copy(retry.point).addScaledVector(retry.normal, 0.02);
          return retry.normal;
        }
      }
    }

    // Fallback 1: downward cast (foot at bottom edge or corner)
    _rayOrigin.set(pos.x, pos.y + 2, pos.z);
    const gHit = castSurface(_rayOrigin, _tmpV.set(0, -1, 0), groundMeshes, 4);
    if (gHit) {
      pos.copy(gHit.point).addScaledVector(gHit.normal, 0.02);
      return gHit.normal;
    }

    // Fallback 2: upward cast (foot below a ledge on complex geometry)
    _rayOrigin.set(pos.x, pos.y - 2, pos.z);
    const uHit = castSurface(_rayOrigin, _tmpV.set(0, 1, 0), groundMeshes, 4);
    if (uHit) {
      pos.copy(uHit.point).addScaledVector(uHit.normal, 0.02);
      return uHit.normal;
    }

    // Fallback 3: outward from wall (foot may have drifted behind surface)
    _rayOrigin.copy(pos).addScaledVector(climbDir, 1.5);
    _tmpV.copy(climbDir).negate();
    const oHit = castSurface(_rayOrigin, _tmpV, groundMeshes, 3);
    if (oHit) {
      pos.copy(oHit.point).addScaledVector(oHit.normal, 0.02);
      return oHit.normal;
    }
  }
  // Normal ground mode: downward ray (proximity-aware)
  const gy = getGroundY(pos.x, pos.z, groundMeshes, NaN, fallbackY);
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
      const retryY = getGroundY(tx, tz, groundMeshes, NaN, fallbackY);
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
    if (castSurface(_rayOrigin, climbDir, groundMeshes, 3)) return true;
    // Downward fallback
    _rayOrigin.set(pos.x, pos.y + 2, pos.z);
    if (castSurface(_rayOrigin, _tmpV.set(0, -1, 0), groundMeshes, 4)) return true;
    // Upward fallback
    _rayOrigin.set(pos.x, pos.y - 2, pos.z);
    if (castSurface(_rayOrigin, _tmpV.set(0, 1, 0), groundMeshes, 4)) return true;
    return false;
  }
  // Ground mode: downward ray (proximity-aware — use pos.y as reference)
  return !isNaN(getGroundY(pos.x, pos.z, groundMeshes, NaN, pos.y));
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
    const nodeZs = [-skel.spineLengths[0], 0, skel.spineLengths[1]];

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
        const onVerticalWall = Math.abs(this._climbNormal.y) < 0.3;
        if (onVerticalWall && this._climbTime > 0.3) {
          _rayOrigin.copy(bodyPos);
          const groundBelow = castSurface(_rayOrigin, _tmpV.set(0, -1, 0), this._groundMeshes, this.skeleton.spineHeight + 1.5);
          if (groundBelow && groundBelow.normal.y > 0.7) {
            const distToGround = bodyPos.y - groundBelow.point.y;
            // A) Intentional dismount: moving downward and close to ground
            const movingDown = this.inputDir.y < -0.05 ||
              (this.inputDir.lengthSq() > 0.001 && this.inputDir.dot(_tmpV.set(0, -1, 0)) > 0.02);
            // B) Automatic: very close to ground (within half spineHeight)
            const veryClose = distToGround > 0 && distToGround < this.skeleton.spineHeight * 0.6;
            if (distToGround > 0 && distToGround < this.skeleton.spineHeight + 0.8 && (movingDown || veryClose)) {
              this._transitionRequest = {
                type: 'wall_to_ground',
                point: groundBelow.point.clone(),
                normal: groundBelow.normal.clone(),
                climbNormal: this._climbNormal.clone(),
              };
            }
          }
        }
      }

      if (this.climbing) {
        if (moving) {
          // ── MAINTAIN: probe into the wall ──
          this._dbg.maintain = {
            ox: bodyPos.x, oy: bodyPos.y, oz: bodyPos.z,
            dx: this._climbDir.x, dy: this._climbDir.y, dz: this._climbDir.z,
            len: this.climbMaintainDist,
          };
          const maintain = castSurface(bodyPos, this._climbDir, this._groundMeshes, this.climbMaintainDist);

          if (maintain && maintain.object.userData.climbable) {
            this._maintainMissCount = 0; // reset miss counter on hit
            // Smooth-adopt the hit's normal with angular gating.
            // Ignore tiny jitter from mesh tessellation (< ~5.7° difference).
            const normalDot = maintain.normal.dot(this._climbNormal);
            if (normalDot < 0.995) {
              const normalAlpha = Math.min(1, 10 * dt);
              this._climbNormal.lerp(maintain.normal, normalAlpha).normalize();
              this._climbDir.copy(this._climbNormal).negate();
            }

            // ── LOOK-AHEAD: will we lose the surface next stride? ──
            // Cast from a point one stride ahead, along _climbDir
            _rayOrigin.copy(bodyPos).addScaledVector(this.inputDir, this.strideLength);
            const lookahead = castSurface(_rayOrigin, this._climbDir, this._groundMeshes, this.climbMaintainDist);

            if (!lookahead) {
              // Edge is imminent — find the adjacent face and start blending NOW.
              // Probe from inside the wall volume, past the edge, cast back.
              _rayOrigin.copy(maintain.point)          // on the surface
                .addScaledVector(this._climbDir, 0.3)  // into the wall volume
                .addScaledVector(this.inputDir, this.strideLength); // past the edge
              _tmpV2.copy(this.inputDir).negate();
              this._dbg.wrap = {
                ox: _rayOrigin.x, oy: _rayOrigin.y, oz: _rayOrigin.z,
                dx: _tmpV2.x, dy: _tmpV2.y, dz: _tmpV2.z,
                len: this.strideLength + 1,
              };
              const adj = castSurface(_rayOrigin, _tmpV2, this._groundMeshes, this.strideLength + 1);
              if (adj && adj.normal.dot(this._climbNormal) < 0.85) {
                const isFloor = adj.normal.y > 0.7;
                if (adj.object.userData.climbable || isFloor) {
                  if (isFloor) {
                    // Request orchestrated wall→top transition
                    this._transitionRequest = {
                      type: 'wall_to_top',
                      point: adj.point.clone(),
                      normal: adj.normal.clone(),
                      climbNormal: this._climbNormal.clone(),
                    };
                  } else {
                    // Wall-to-wall: smooth blend (no FSM needed)
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
            const ahead = castSurface(bodyPos, this.inputDir, this._groundMeshes, this.climbDetectDist);
            if (ahead && (ahead.object.userData.climbable || ahead.normal.y > 0.7)) {
              const dot = ahead.normal.dot(this._climbNormal);
              if (dot < 0.85) { // require significant angle (>~32°) to avoid tessellation jitter
                if (ahead.normal.y > 0.7) {
                  // Request orchestrated wall→top transition
                  this._transitionRequest = {
                    type: 'wall_to_top',
                    point: ahead.point.clone(),
                    normal: ahead.normal.clone(),
                    climbNormal: this._climbNormal.clone(),
                  };
                } else {
                  // Wall-to-wall corner: smooth blend (no FSM needed)
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
            if (this._maintainMissCount < 2) wrapped = true; // hold state, skip probes

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
            const edgeHit = castSurface(_rayOrigin, _tmpV2, this._groundMeshes, this.climbWrapDist + 1);
            if (edgeHit && edgeHit.normal.dot(this._climbNormal) < 0.9) {
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
              const backHit = castSurface(_rayOrigin, this._climbNormal, this._groundMeshes, 6);
              if (backHit && (backHit.object.userData.climbable || backHit.normal.y > 0.7)) {
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
              const gBelow = castSurface(_rayOrigin, _tmpV.set(0, -1, 0), this._groundMeshes, this.skeleton.spineHeight + 3);
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
        // ENTER: forward probe for initial climb detection
        const hit = castSurface(bodyPos, this.inputDir, this._groundMeshes, this.climbDetectDist);
        if (hit && hit.object.userData.climbable) {
          this.climbing = true;
          this._climbTime = 0;
          this._climbNormal.copy(hit.normal);
          this._climbDir.copy(hit.normal).negate();
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
          const hit = castSurface(_rayOrigin, dir, this._groundMeshes, probeLen);
          if (!hit) {
            // Back-cast from far out
            _rayOrigin.copy(bodyPos).addScaledVector(axis, sign * probeLen)
              .addScaledVector(this._climbDir, 0.3);
            const backDir = _tmpV2.copy(axis).multiplyScalar(-sign);
            const bHit = castSurface(_rayOrigin, backDir, this._groundMeshes, probeLen);
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
              this._groundMeshes, NaN, bodyPos.y
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
