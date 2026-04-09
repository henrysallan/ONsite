/**
 * TargetSystem – Lightweight voronoi-fractured green disc targets.
 *
 * Each target is a flat disc sliced into voronoi cells. On bullet hits the
 * cells progressively shift apart over 4 stages (10 hits total), then the
 * pieces explode outward with cheap fake-physics.
 *
 * All geometry is pre-built on spawn (simple 2D voronoi → extruded slab),
 * kept in a THREE.Group per target. The explosion is just per-piece velocity
 * + gravity + fade — no real physics.
 */
import * as THREE from 'three';

// ── Config ──
const DISC_RADIUS       = 1.0;
const DISC_THICKNESS    = 0.08;
const CELLS_PER_DISC    = 10;
const HITS_TO_EXPLODE   = 10;
const SHIFT_STAGES      = [3, 5, 7, 10]; // hit counts where pieces shift further
const SHIFT_AMOUNTS     = [0.02, 0.06, 0.13, 0.22]; // cumulative gap per stage
const EXPLODE_SPEED     = 8;
const EXPLODE_UP        = 5;
const EXPLODE_GRAVITY   = -15;
const EXPLODE_SPIN      = 6;
const EXPLODE_LIFETIME  = 1.4;

// Tmp vectors
const _v2a = new THREE.Vector2();
const _v2b = new THREE.Vector2();
const _v3  = new THREE.Vector3();

/* ──────────────────────────────────────────────
   2-D Voronoi helpers (disc-clipped)
   ────────────────────────────────────────────── */

/**
 * Generate N random seed points inside a unit circle.
 */
function _randomSeeds(n, radius) {
  const seeds = [];
  for (let i = 0; i < n; i++) {
    // Uniform disc sampling
    const a = Math.random() * Math.PI * 2;
    const r = radius * Math.sqrt(Math.random()) * 0.85; // keep seeds away from rim
    seeds.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return seeds;
}

/**
 * Clip a convex polygon (array of Vector2) by a half-plane.
 * Half-plane: all points p where dot(p - point, normal) <= 0
 * (Sutherland-Hodgman single edge clip)
 */
function _clipPolygonByHalfPlane(poly, point, normal) {
  if (poly.length === 0) return poly;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dA = (a.x - point.x) * normal.x + (a.y - point.y) * normal.y;
    const dB = (b.x - point.x) * normal.x + (b.y - point.y) * normal.y;
    if (dA <= 0) out.push(a);
    if ((dA <= 0) !== (dB <= 0)) {
      // Edge crosses the boundary — compute intersection
      const t = dA / (dA - dB);
      out.push(new THREE.Vector2(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)));
    }
  }
  return out;
}

/**
 * Clip a polygon to a circle of given radius (approximate with 32-gon).
 */
function _clipToDisc(poly, radius) {
  const N = 32;
  let clipped = poly;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    // Outward normal at this edge point
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    const px = nx * radius;
    const py = ny * radius;
    // Keep interior: dot(p - edge, outward) <= 0
    clipped = _clipPolygonByHalfPlane(clipped, { x: px, y: py }, { x: nx, y: ny });
    if (clipped.length === 0) break;
  }
  return clipped;
}

/**
 * Compute the voronoi cell polygon for seed[index] clipped to the disc.
 */
function _voronoiCell(seeds, index, radius) {
  const si = seeds[index];
  // Start with a large bounding box
  const R = radius * 2;
  let poly = [
    new THREE.Vector2(-R, -R),
    new THREE.Vector2( R, -R),
    new THREE.Vector2( R,  R),
    new THREE.Vector2(-R,  R),
  ];

  // Clip by perpendicular bisector with every other seed
  for (let j = 0; j < seeds.length; j++) {
    if (j === index) continue;
    const sj = seeds[j];
    // Midpoint
    const mx = (si.x + sj.x) * 0.5;
    const my = (si.y + sj.y) * 0.5;
    // Normal pointing away from si (toward sj) so the <= 0 half-plane keeps si's side
    const nx = sj.x - si.x;
    const ny = sj.y - si.y;
    const len = Math.sqrt(nx * nx + ny * ny);
    poly = _clipPolygonByHalfPlane(poly, { x: mx, y: my }, { x: nx / len, y: ny / len });
    if (poly.length < 3) return [];
  }

  // Clip to disc
  poly = _clipToDisc(poly, radius);
  return poly;
}

/**
 * Build a flat slab BufferGeometry from a 2D polygon (in XZ plane).
 * Returns the geometry with computed centroid offset, or null if degenerate.
 */
function _buildCellGeometry(polygon, thickness) {
  if (polygon.length < 3) return null;

  // Compute centroid
  let cx = 0, cz = 0;
  for (const p of polygon) { cx += p.x; cz += p.y; }
  cx /= polygon.length;
  cz /= polygon.length;

  // Triangulate the top face (fan from first vertex) + bottom face + sides
  const verts = [];
  const normals = [];
  const hy = thickness * 0.5;
  const n = polygon.length;

  // Top face (Y+)
  for (let i = 1; i < n - 1; i++) {
    verts.push(polygon[0].x, hy, polygon[0].y);
    verts.push(polygon[i].x, hy, polygon[i].y);
    verts.push(polygon[i + 1].x, hy, polygon[i + 1].y);
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
  }
  // Bottom face (Y-)
  for (let i = 1; i < n - 1; i++) {
    verts.push(polygon[0].x, -hy, polygon[0].y);
    verts.push(polygon[i + 1].x, -hy, polygon[i + 1].y);
    verts.push(polygon[i].x, -hy, polygon[i].y);
    normals.push(0, -1, 0, 0, -1, 0, 0, -1, 0);
  }
  // Side faces
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const len = Math.sqrt(dx * dx + dz * dz);
    const nx = dz / len;  // outward normal in XZ
    const nz = -dx / len;

    verts.push(a.x,  hy, a.y);
    verts.push(b.x,  hy, b.y);
    verts.push(b.x, -hy, b.y);

    verts.push(a.x,  hy, a.y);
    verts.push(b.x, -hy, b.y);
    verts.push(a.x, -hy, a.y);

    for (let k = 0; k < 6; k++) normals.push(nx, 0, nz);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));

  return { geometry: geo, centroid: new THREE.Vector2(cx, cz) };
}

/* ──────────────────────────────────────────────
   Target class (single disc)
   ────────────────────────────────────────────── */

class Target {
  constructor(position, material, radius) {
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.radius = radius;
    this.hits = 0;
    this.stage = 0;        // current shift stage (0-3)
    this.exploding = false;
    this.explodeAge = 0;
    this.dead = false;

    // Generate voronoi cells
    const seeds = _randomSeeds(CELLS_PER_DISC, radius);
    this.pieces = [];

    for (let i = 0; i < seeds.length; i++) {
      const poly = _voronoiCell(seeds, i, radius);
      const result = _buildCellGeometry(poly, DISC_THICKNESS);
      if (!result) continue;

      const mesh = new THREE.Mesh(result.geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // BVH needed since global raycast is patched to use acceleratedRaycast
      if (result.geometry.computeBoundsTree) result.geometry.computeBoundsTree();

      // Direction from disc centre toward piece centroid (for shifting/exploding)
      const dir = new THREE.Vector3(result.centroid.x, 0, result.centroid.y);
      const dist = dir.length();
      if (dist > 0.001) dir.divideScalar(dist);
      else dir.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();

      this.pieces.push({
        mesh,
        centroid: result.centroid.clone(),
        dir,                              // outward direction (normalized)
        basePos: new THREE.Vector3(0, 0, 0),
        shiftOffset: new THREE.Vector3(), // current shift
        // Explosion state
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        rotQuat: new THREE.Quaternion(),
      });

      this.group.add(mesh);
    }

    // Stand the disc upright facing a random direction
    this.group.rotation.x = 0; // disc lies in XZ, we'll tilt to face player
  }

  /**
   * Register a hit. Returns true if the target just exploded.
   */
  hit() {
    if (this.exploding || this.dead) return false;
    this.hits++;

    // Check if we enter a new shift stage
    for (let s = this.stage; s < SHIFT_STAGES.length; s++) {
      if (this.hits >= SHIFT_STAGES[s]) {
        this.stage = s + 1;
        this._applyShift(SHIFT_AMOUNTS[s]);
      }
    }

    if (this.hits >= HITS_TO_EXPLODE) {
      this._startExplosion();
      return true;
    }
    return false;
  }

  _applyShift(amount) {
    for (const p of this.pieces) {
      p.shiftOffset.copy(p.dir).multiplyScalar(amount);
      p.mesh.position.copy(p.basePos).add(p.shiftOffset);
    }
  }

  _startExplosion() {
    this.exploding = true;
    this.explodeAge = 0;

    for (const p of this.pieces) {
      // Outward velocity + random upward kick
      p.vel.copy(p.dir).multiplyScalar(EXPLODE_SPEED * (0.5 + Math.random()));
      p.vel.y = EXPLODE_UP * (0.4 + Math.random() * 0.6);

      // Random spin axis
      p.spin.set(
        (Math.random() - 0.5) * EXPLODE_SPIN,
        (Math.random() - 0.5) * EXPLODE_SPIN,
        (Math.random() - 0.5) * EXPLODE_SPIN,
      );
      p.rotQuat.identity();
    }
  }

  /**
   * Tick the explosion sim. Returns true when fully dead.
   */
  updateExplosion(dt) {
    if (!this.exploding) return false;
    this.explodeAge += dt;
    if (this.explodeAge >= EXPLODE_LIFETIME) {
      this.dead = true;
      return true;
    }

    const t = this.explodeAge / EXPLODE_LIFETIME;

    for (const p of this.pieces) {
      // Euler integration
      p.vel.y += EXPLODE_GRAVITY * dt;
      p.mesh.position.addScaledVector(p.vel, dt);

      // Spin
      const angle = p.spin.length() * dt;
      if (angle > 0.0001) {
        const axis = _v3.copy(p.spin).normalize();
        const dq = new THREE.Quaternion().setFromAxisAngle(axis, angle);
        p.rotQuat.premultiply(dq);
        p.mesh.quaternion.copy(p.rotQuat);
      }

      // Fade out (scale down near end)
      const fade = 1.0 - smoothstep(0.6, 1.0, t);
      p.mesh.scale.setScalar(fade);
    }
    return false;
  }

  dispose() {
    for (const p of this.pieces) {
      p.mesh.geometry.dispose();
    }
  }
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/* ──────────────────────────────────────────────
   TargetSystem (manages all targets)
   ────────────────────────────────────────────── */

export class TargetSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Material} material - cel material for target pieces
   */
  constructor(scene, material) {
    this.scene = scene;
    this.material = material;
    /** @type {Target[]} */
    this.targets = [];
    this._collisionRay = new THREE.Raycaster();
    this._collisionRay.firstHitOnly = true;

    // Collect all target meshes for fast raycasting
    /** @type {THREE.Mesh[]} */
    this._hitMeshes = [];
    /** @type {Map<THREE.Mesh, Target>} */
    this._meshToTarget = new Map();
  }

  /**
   * Spawn targets at given world positions.
   * Each position is the centre of the disc, placed upright (rotated to face random yaw).
   * @param {THREE.Vector3[]} positions
   */
  spawn(positions) {
    for (const pos of positions) {
      const target = new Target(pos, this.material, DISC_RADIUS);

      // Tilt disc upright (rotate 90° around X so the XZ disc faces the player)
      target.group.rotation.x = Math.PI * 0.5;
      // Random facing
      target.group.rotation.z = Math.random() * Math.PI * 2;

      this.scene.add(target.group);
      this.targets.push(target);

      // Register meshes for raycasting
      for (const p of target.pieces) {
        this._hitMeshes.push(p.mesh);
        this._meshToTarget.set(p.mesh, target);
      }
    }
  }

  /**
   * Test a ray (from BulletSystem) against all targets.
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} direction (normalized)
   * @param {number} maxDist
   * @returns {{ hit: boolean, point: THREE.Vector3|null, normal: THREE.Vector3|null }}
   */
  testBulletRay(origin, direction, maxDist) {
    this._collisionRay.set(origin, direction);
    this._collisionRay.far = maxDist;
    const hits = this._collisionRay.intersectObjects(this._hitMeshes, false);
    if (hits.length === 0) return { hit: false, point: null, normal: null };

    const hitMesh = hits[0].object;
    const target = this._meshToTarget.get(hitMesh);
    if (target && !target.exploding && !target.dead) {
      target.hit();
      const normal = hits[0].face
        ? hits[0].face.normal.clone().transformDirection(hitMesh.matrixWorld).normalize()
        : direction.clone().negate();
      return { hit: true, point: hits[0].point.clone(), normal };
    }
    return { hit: false, point: null, normal: null };
  }

  /**
   * Update all targets (explosions, cleanup).
   * @param {number} dt
   */
  update(dt) {
    // Ensure world matrices are current for raycasting this frame
    for (const t of this.targets) {
      if (!t.dead) t.group.updateMatrixWorld(true);
    }

    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i];
      if (t.exploding) {
        const done = t.updateExplosion(dt);
        if (done) {
          // Clean up
          this.scene.remove(t.group);
          for (const p of t.pieces) {
            this._hitMeshes.splice(this._hitMeshes.indexOf(p.mesh), 1);
            this._meshToTarget.delete(p.mesh);
          }
          t.dispose();
          this.targets.splice(i, 1);
        }
      }
    }
  }

  dispose() {
    for (const t of this.targets) {
      this.scene.remove(t.group);
      t.dispose();
    }
    this.targets.length = 0;
    this._hitMeshes.length = 0;
    this._meshToTarget.clear();
  }
}
