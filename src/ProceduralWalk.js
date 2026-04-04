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

// ── Surface raycasting helpers ──
const _raycaster = new THREE.Raycaster();
const _worldNormal = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _hitResult = { point: _hitPoint, normal: _hitNormal, object: null };
const _hitsArray = [];  // reusable array for intersectObjects

/** Raycast downward only (fast path for floor-walking). */
function getGroundY(x, z, groundMeshes, fallback = 0) {
  if (!groundMeshes || groundMeshes.length === 0) return fallback;
  _rayOrigin.set(x, 50, z);
  _raycaster.set(_rayOrigin, _tmpV.set(0, -1, 0));
  _raycaster.far = Infinity;
  _hitsArray.length = 0;
  _raycaster.intersectObjects(groundMeshes, false, _hitsArray);
  return _hitsArray.length > 0 ? _hitsArray[0].point.y : fallback;
}

/**
 * Cast a single ray from origin along dir, return shared _hitResult or null.
 * Rejects backfaces (normal facing same way as ray).
 * WARNING: returned object is reused — copy values if you need to keep them.
 */
function castSurface(origin, dir, meshes, maxDist) {
  if (!meshes || meshes.length === 0) return null;
  _raycaster.set(origin, dir);
  _raycaster.far = maxDist;
  _hitsArray.length = 0;
  _raycaster.intersectObjects(meshes, false, _hitsArray);
  if (_hitsArray.length > 0) {
    const h = _hitsArray[0];
    _worldNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
    // Reject backfaces
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
 */
function placeOnSurface(pos, groundMeshes, climbDir, climbing, fallbackY) {
  if (climbing && climbDir) {
    // Cast into the surface from a point offset away
    _rayOrigin.copy(pos).addScaledVector(climbDir, -1.5);
    const hit = castSurface(_rayOrigin, climbDir, groundMeshes, 3);
    if (hit) {
      pos.copy(hit.point).addScaledVector(hit.normal, 0.02);
      return hit.normal;
    }
    // Fallback: try downward cast (foot may be at an edge/corner)
    _rayOrigin.set(pos.x, pos.y + 2, pos.z);
    const gHit = castSurface(_rayOrigin, _tmpV.set(0, -1, 0), groundMeshes, 4);
    if (gHit) {
      pos.copy(gHit.point).addScaledVector(gHit.normal, 0.02);
      return gHit.normal;
    }
  }
  // Normal ground mode: downward ray
  pos.y = getGroundY(pos.x, pos.z, groundMeshes, fallbackY);
  return _tmpV.set(0, 1, 0);
}

/** Parabolic arc height as a function of t ∈ [0,1]. Peak at t = 0.5. */
function arcHeight(t, stepHeight) {
  return 4 * stepHeight * t * (1 - t);
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

    // ── Movement input ──
    this.inputDir = new THREE.Vector3();
    this._yaw = 0;
    this._movedDelta = new THREE.Vector3();
  }

  /** Rotate a home position into world frame. Uses body quaternion when climbing, yaw when on ground. */
  _rotateHome(home, yaw) {
    if (this.climbing) {
      return _worldHome.copy(home).applyQuaternion(_bodyQuat);
    }
    return _worldHome.copy(home).applyAxisAngle(_yAxis, yaw);
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
      });
      limbs.push({
        nodeIndex: i, side: 'R',
        home: new THREE.Vector3(-hR, 0, nz),
        current: new THREE.Vector3(-hR, 0, nz),
        surfaceNormal: new THREE.Vector3(0, 1, 0),
        grounded: true,
      });
    }
    return limbs;
  }

  setInput(dir) {
    this.inputDir.copy(dir);
  }

  setBodyQuaternion(q) {
    _bodyQuat.copy(q);
  }

  setBodyUp(up) {
    this._bodyUp.copy(up);
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
    {
      const bodyPos = bodyGroup.position;

      if (this.climbing) {
        let cornerHandled = false;

        // CORNER TRANSITION first — prevents maintain probe from undoing the blend
        if (moving) {
          this._dbg.corner = {
            ox: bodyPos.x, oy: bodyPos.y, oz: bodyPos.z,
            dx: this.inputDir.x, dy: this.inputDir.y, dz: this.inputDir.z,
            len: this.climbDetectDist,
          };
          const ahead = castSurface(bodyPos, this.inputDir, this._groundMeshes, this.climbDetectDist);
          if (ahead && ahead.object.userData.climbable) {
            const dot = ahead.normal.dot(this._climbNormal);
            if (dot < 0.95) {
              // Adjacent face detected – blend aggressively toward it
              this._climbNormal.lerp(ahead.normal, Math.min(1, 15 * dt)).normalize();
              this._climbDir.copy(this._climbNormal).negate();
              cornerHandled = true;
            }
          }
        }

        // MAINTAIN: only when corner isn't driving, and only when moving
        // (idle on wall → wall isn't moving, skip the raycast)
        if (!cornerHandled) {
          if (moving) {
            this._dbg.maintain = {
              ox: bodyPos.x, oy: bodyPos.y, oz: bodyPos.z,
              dx: this._climbDir.x, dy: this._climbDir.y, dz: this._climbDir.z,
              len: this.climbMaintainDist,
            };
            const maintain = castSurface(bodyPos, this._climbDir, this._groundMeshes, this.climbMaintainDist);
            if (maintain && maintain.object.userData.climbable) {
              this._climbNormal.copy(maintain.normal);
              this._climbDir.copy(maintain.normal).negate();
            } else {
              // EDGE WRAP: the maintain probe missed — we're at or past an edge.
              // Try to find the adjacent surface (top, side, or back face).
              let wrapped = false;

              // Probe 1 — Edge face: step past the edge, stay in the wall plane,
              // then cast back along -inputDir. The origin is pulled inward along
              // _climbDir by only 0.1 (just enough to be over the surface, not
              // deep inside thick walls).
              _rayOrigin.copy(bodyPos)
                .addScaledVector(this._climbDir, 0.1)    // barely inward — over the surface
                .addScaledVector(this.inputDir, this.climbWrapDist);
              _tmpV2.copy(this.inputDir).negate();
              this._dbg.wrap = {
                ox: _rayOrigin.x, oy: _rayOrigin.y, oz: _rayOrigin.z,
                dx: _tmpV2.x, dy: _tmpV2.y, dz: _tmpV2.z,
                len: this.climbWrapDist + 1,
              };
              const edgeHit = castSurface(_rayOrigin, _tmpV2, this._groundMeshes, this.climbWrapDist + 1);
              if (edgeHit && edgeHit.object.userData.climbable) {
                if (edgeHit.normal.dot(this._climbNormal) < 0.9) {
                  this._climbNormal.copy(edgeHit.normal);
                  this._climbDir.copy(edgeHit.normal).negate();
                  bodyPos.copy(edgeHit.point).addScaledVector(edgeHit.normal, 0.15);
                  this._wrappedEdge = true;
                  this._movedDelta.set(0, 0, 0);  // kill movement on wrap frame
                  wrapped = true;
                }
              }

              // Probe 2 — Back face: cast from far on the other side of the wall
              // back toward us. Uses climbNormal (outward) so the opposite face
              // is a front-face hit. Origin starts well outside the wall.
              if (!wrapped) {
                _rayOrigin.copy(bodyPos)
                  .addScaledVector(this._climbDir, 3.0)   // well past any wall thickness
                  .addScaledVector(this.inputDir, this.climbWrapDist * 0.3);
                this._dbg.wrap = {
                  ox: _rayOrigin.x, oy: _rayOrigin.y, oz: _rayOrigin.z,
                  dx: this._climbNormal.x, dy: this._climbNormal.y, dz: this._climbNormal.z,
                  len: 5,
                };
                const backHit = castSurface(_rayOrigin, this._climbNormal, this._groundMeshes, 5);
                if (backHit && backHit.object.userData.climbable) {
                  this._climbNormal.copy(backHit.normal);
                  this._climbDir.copy(backHit.normal).negate();
                  bodyPos.copy(backHit.point).addScaledVector(backHit.normal, 0.15);
                  this._wrappedEdge = true;
                  this._movedDelta.set(0, 0, 0);  // kill movement on wrap frame
                  wrapped = true;
                }
              }

              if (!wrapped) {
                this.climbing = false;
              }
            }
          }
          // When idle: keep current _climbNormal/_climbDir unchanged
        }
      } else if (moving) {
        // ENTER: forward probe for initial climb detection
        const hit = castSurface(bodyPos, this.inputDir, this._groundMeshes, this.climbDetectDist);
        if (hit && hit.object.userData.climbable) {
          this.climbing = true;
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

    if (!this.stepping && moving) {
      const bodyPos = bodyGroup.position;

      if (this._stepCooldown <= 0 && this._checkNeedStep(bodyPos, yaw)) {
        this._triggerStep(bodyPos, yaw);
      } else if (!this._wrappedEdge) {
        this._movedDelta.copy(this.inputDir).multiplyScalar(this.bodySpeed * dt);
      }
    }

    // ── Idle behaviour: correction + fidget (shuffle / tap) ──
    if (!this.stepping && !moving) {
      const bodyPos = bodyGroup.position;

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

  _triggerStep(bodyPos, yaw) {
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
        .addScaledVector(this.inputDir, this.strideLength * 0.5);

      const norm = placeOnSurface(ls.targetPos, this._groundMeshes,
        this._climbDir, this.climbing, bodyPos.y);
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

      const norm = placeOnSurface(ls.targetPos, this._groundMeshes,
        this._climbDir, this.climbing, bodyPos.y);
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
        this._climbDir, this.climbing, bodyPos.y);
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
      const groundY = getGroundY(limb.current.x, limb.current.z, this._groundMeshes, 0);
      if (t < upPhase) {
        const u = t / upPhase;
        limb.current.y = groundY + h * u * u * (3 - 2 * u); // smoothstep rise
      } else {
        const d = (t - upPhase) / (1 - upPhase);
        limb.current.y = groundY + h * (1 - d);              // linear fast drop
      }
    }

    if (t >= 1) {
      limb.current.y = getGroundY(limb.current.x, limb.current.z, this._groundMeshes, 0);
      limb.grounded  = true;
      this._idleAnimating = false;
    }
  }

  _cancelIdleAnimation() {
    const limb = this.limbs[this._idleLegIdx];
    limb.current.y = getGroundY(limb.current.x, limb.current.z, this._groundMeshes, 0);
    limb.grounded  = true;
    this._idleAnimating = false;
    this._idleTimer     = 0;
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

  /** Get the best-fit plane from ALL foot positions (not just grounded).
   *  Using all 6 feet avoids centroid oscillation during tripod stepping. */
  getFootPlane() {
    _planeCenter.set(0, 0, 0);
    for (const limb of this.limbs) _planeCenter.add(limb.current);
    _planeCenter.divideScalar(this.limbs.length);

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
