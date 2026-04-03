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

// ── Ground raycasting helpers ──
const _rayOrigin = new THREE.Vector3();
const _rayDown   = new THREE.Vector3(0, -1, 0);
const _raycaster = new THREE.Raycaster();

/** Raycast downward from (x, 50, z) against ground meshes. Returns Y or fallback. */
function getGroundY(x, z, groundMeshes, fallback = 0) {
  if (!groundMeshes || groundMeshes.length === 0) return fallback;
  _rayOrigin.set(x, 50, z);
  _raycaster.set(_rayOrigin, _rayDown);
  const hits = _raycaster.intersectObjects(groundMeshes, false);
  return hits.length > 0 ? hits[0].point.y : fallback;
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
      { timer: 0, delay: 0, started: false, done: false, startPos: null, targetPos: null },
      { timer: 0, delay: 0, started: false, done: false, startPos: null, targetPos: null },
      { timer: 0, delay: 0, started: false, done: false, startPos: null, targetPos: null },
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

    // ── Movement input ──
    this.inputDir = new THREE.Vector3();
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
        grounded: true,
      });
      limbs.push({
        nodeIndex: i, side: 'R',
        home: new THREE.Vector3(-hR, 0, nz),
        current: new THREE.Vector3(-hR, 0, nz),
        grounded: true,
      });
    }
    return limbs;
  }

  setInput(dir) {
    this.inputDir.copy(dir);
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
   * @returns {{ movedDelta: THREE.Vector3 }}
   */
  update(dt, bodyGroup, groundMeshes) {
    this._elapsed += dt;
    const moving = this.inputDir.lengthSq() > 0.001;
    const movedDelta = new THREE.Vector3();
    this._groundMeshes = groundMeshes || [];

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
        // Step arc added on top of the interpolated terrain Y
        limb.current.y += arcHeight(t, this.stepHeight);

        if (t >= 1) {
          limb.current.copy(ls.targetPos);
          limb.grounded = true;
          ls.done = true;
        } else {
          allDone = false;
        }
      }

      // Move body while step is in progress
      if (moving) {
        movedDelta.copy(this.inputDir).multiplyScalar(this.bodySpeed * dt);
      }

      if (allDone) {
        this.stepping = false;
      }
    }

    if (!this.stepping && moving) {
      const bodyPos = bodyGroup.position;
      const yaw = bodyGroup.rotation.y;

      if (this._checkNeedStep(bodyPos, yaw)) {
        this._triggerStep(bodyPos, yaw);
      } else {
        movedDelta.copy(this.inputDir).multiplyScalar(this.bodySpeed * dt);
      }
    }

    // ── Idle behaviour: correction + fidget (shuffle / tap) ──
    if (!this.stepping && !moving) {
      const bodyPos = bodyGroup.position;
      const yaw = bodyGroup.rotation.y;

      if (this._idleAnimating) {
        // Advance the single-leg fidget animation
        this._updateIdleAnimation(dt);
      } else {
        // Priority 1 – drift correction after rotation
        const driftA = this._maxGroupDrift(this.groupA, bodyPos, yaw);
        const driftB = this._maxGroupDrift(this.groupB, bodyPos, yaw);

        if (driftA > this.idleCorrectionThreshold || driftB > this.idleCorrectionThreshold) {
          const correctGroup = driftA >= driftB ? 'A' : 'B';
          this._nextGroup = correctGroup;
          this._triggerIdleCorrection(bodyPos, yaw);
        } else {
          // Priority 2 – fidget timer
          this._idleTimer += dt;
          if (this._idleTimer >= this._idleNextAction) {
            this._startIdleAction(bodyPos, yaw);
          }
        }
      }
    } else {
      // Moving or stepping – cancel any fidget and reset timer
      if (this._idleAnimating) this._cancelIdleAnimation();
      this._idleTimer = 0;
    }

    // Keep grounded feet snapped to terrain
    for (const limb of this.limbs) {
      if (limb.grounded && !this.stepping) {
        limb.current.y = getGroundY(limb.current.x, limb.current.z, this._groundMeshes, limb.current.y);
      }
    }

    return { movedDelta };
  }

  _checkNeedStep(bodyPos, yaw) {
    const group = this._nextGroup === 'A' ? this.groupA : this.groupB;
    const threshold = this.strideLength * 0.5;

    for (const idx of group) {
      const limb = this.limbs[idx];
      const worldHome = limb.home.clone()
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
        .add(bodyPos);
      // Compare in XZ only so slope doesn't trigger extra steps
      const dx = limb.current.x - worldHome.x;
      const dz = limb.current.z - worldHome.z;
      if (Math.sqrt(dx * dx + dz * dz) > threshold) return true;
    }
    return false;
  }

  _triggerStep(bodyPos, yaw) {
    const group = this._nextGroup === 'A' ? this.groupA : this.groupB;
    this.activeGroup = group;
    this._nextGroup = this._nextGroup === 'A' ? 'B' : 'A';
    this.stepping = true;

    for (let g = 0; g < 3; g++) {
      const limb = this.limbs[group[g]];
      limb.grounded = false;

      const ls = this.legState[g];
      ls.timer   = 0;
      ls.delay   = this._getPhaseDelay(g, group);
      ls.started = false;
      ls.done    = false;
      ls.startPos = limb.current.clone();

      const worldHome = limb.home.clone()
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
        .add(bodyPos);
      ls.targetPos = worldHome.clone()
        .addScaledVector(this.inputDir, this.strideLength * 0.5);
      // Raycast to find ground Y at the target XZ
      ls.targetPos.y = getGroundY(ls.targetPos.x, ls.targetPos.z, this._groundMeshes, bodyPos.y);
    }
  }

  /** Get the maximum drift of any limb in a group from its home position. */
  _maxGroupDrift(group, bodyPos, yaw) {
    let maxDist = 0;
    for (const idx of group) {
      const limb = this.limbs[idx];
      const worldHome = limb.home.clone()
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
        .add(bodyPos);
      const dx = limb.current.x - worldHome.x;
      const dz = limb.current.z - worldHome.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > maxDist) maxDist = dist;
    }
    return maxDist;
  }

  /** Trigger a corrective step to bring idle feet back to their homes. */
  _triggerIdleCorrection(bodyPos, yaw) {
    const group = this._nextGroup === 'A' ? this.groupA : this.groupB;
    this.activeGroup = group;
    this._nextGroup = this._nextGroup === 'A' ? 'B' : 'A';
    this.stepping = true;

    for (let g = 0; g < 3; g++) {
      const limb = this.limbs[group[g]];
      limb.grounded = false;

      const ls = this.legState[g];
      ls.timer   = 0;
      ls.delay   = this._getPhaseDelay(g, group);
      ls.started = false;
      ls.done    = false;
      ls.startPos = limb.current.clone();

      // Target is exactly the home position (no overshoot)
      const worldHome = limb.home.clone()
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
        .add(bodyPos);
      worldHome.y = getGroundY(worldHome.x, worldHome.z, this._groundMeshes, bodyPos.y);
      ls.targetPos = worldHome;
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
      const worldHome = limb.home.clone()
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
        .add(bodyPos);

      const angle = Math.random() * Math.PI * 2;
      const dist  = 0.05 + Math.random() * 0.15;
      this._idleTargetPos.copy(worldHome);
      this._idleTargetPos.x += Math.cos(angle) * dist;
      this._idleTargetPos.z += Math.sin(angle) * dist;
      this._idleTargetPos.y = getGroundY(this._idleTargetPos.x, this._idleTargetPos.z, this._groundMeshes, bodyPos.y);

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

  getFootLocal(limbIndex, bodyPos, yaw) {
    const world = this.limbs[limbIndex].current;
    const local = world.clone().sub(bodyPos);
    local.applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
    return local;
  }
}
