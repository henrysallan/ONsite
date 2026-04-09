import * as THREE from 'three';

/**
 * Centralized ray-debug logger + 3D visualizer.
 *
 * Every raycast in the climbing / walking system calls `log()` which:
 *   1. Stores the ray + result in a circular buffer for the UI overlay.
 *   2. Updates a pooled GL_LINES object so the ray is visible in the 3D scene.
 *
 * Ray categories (each gets a unique color):
 *   ground_down       – getGroundY / floor probes (green)
 *   surface_cast      – castSurface generic (cyan)
 *   climb_maintain    – maintain probe into wall (orange)
 *   climb_lookahead   – look-ahead for edge (yellow)
 *   climb_corner      – forward corner probe (magenta)
 *   climb_wrap_adj    – edge-wrap adjacent face (red)
 *   climb_wrap_back   – edge-wrap back face (pink)
 *   climb_wrap_ground – edge-wrap ground below (lime)
 *   climb_dismount    – ground-below dismount check (white)
 *   body_floor        – PlayerController floor probe (blue)
 *   edge_climb_back   – _tryEdgeClimb backward (salmon)
 *   edge_climb_fwd    – _tryEdgeClimb forward (teal)
 *   joint_probe       – spine/joint collision probe (purple)
 *   foot_place        – placeOnSurface casts (gray)
 *   foot_place_clamp  – placeOnSurface clamping retries (dark gray)
 *   foot_place_down   – placeOnSurface downward fallback (dark green)
 *   foot_place_up     – placeOnSurface upward fallback (dark cyan)
 *   foot_place_out    – placeOnSurface outward fallback (dark orange)
 *   surface_probe     – probeSurfaceExists (dim yellow)
 *   width_probe       – _probeSurfaceWidth casts (dim blue)
 */

const RAY_COLORS = {
  ground_down:       0x44ff44,
  surface_cast:      0x00cccc,
  climb_maintain:    0xff8800,
  climb_lookahead:   0xffff00,
  climb_corner:      0xff00ff,
  climb_wrap_adj:    0xff3333,
  climb_wrap_back:   0xff88aa,
  climb_wrap_ground: 0x88ff00,
  climb_dismount:    0xffffff,
  body_floor:        0x4488ff,
  edge_climb_back:   0xff7766,
  edge_climb_fwd:    0x00ccaa,
  joint_probe:       0xaa44ff,
  foot_place:        0x999999,
  foot_place_clamp:  0x666666,
  foot_place_down:   0x228822,
  foot_place_up:     0x226688,
  foot_place_out:    0x886622,
  surface_probe:     0xaaaa44,
  width_probe:       0x4466aa,
  aim_ray:           0xff0000,
  bullet_path:       0xffaa00,
};

const RAY_LABELS = {
  ground_down:       'Ground ↓',
  surface_cast:      'Surface Cast',
  climb_maintain:    'Climb Maintain',
  climb_lookahead:   'Climb Lookahead',
  climb_corner:      'Climb Corner',
  climb_wrap_adj:    'Wrap Adjacent',
  climb_wrap_back:   'Wrap Back',
  climb_wrap_ground: 'Wrap Ground ↓',
  climb_dismount:    'Dismount ↓',
  body_floor:        'Body Floor ↓',
  edge_climb_back:   'Edge Climb ←',
  edge_climb_fwd:    'Edge Climb →',
  joint_probe:       'Joint Probe',
  foot_place:        'Foot Place',
  foot_place_clamp:  'Foot Clamp',
  foot_place_down:   'Foot ↓ Fallback',
  foot_place_up:     'Foot ↑ Fallback',
  foot_place_out:    'Foot Out Fallback',
  surface_probe:     'Surface Probe',
  width_probe:       'Width Probe',
  aim_ray:           'Aim Ray',
  bullet_path:       'Bullet Path',
};

// ── Pool management ──
const MAX_LINES = 256;          // max simultaneous visible rays
const MAX_LOG_ENTRIES = 5000;   // circular log buffer size
const RAY_LIFETIME = 0.15;     // seconds a ray stays visible after being logged
const AIM_RAY_LIFETIME = 0.5; // longer lifetime for aim/bullet rays

function makePoolLine() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(6); // 2 verts × 3 components
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    transparent: true,
    opacity: 0.7,
  });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  line.renderOrder = 9998;
  line.visible = false;
  return line;
}

// Hit indicator: small sphere at hit point
const HIT_SPHERE_GEO = new THREE.SphereGeometry(0.04, 6, 4);
function makeHitSphere() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    depthTest: false,
    transparent: true,
    opacity: 0.8,
  });
  const mesh = new THREE.Mesh(HIT_SPHERE_GEO, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 9999;
  mesh.visible = false;
  return mesh;
}

export class RayDebugLogger {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.enabled = false;        // master toggle – set from UI
    this.logEnabled = true;      // whether to record to the circular buffer
    this.visEnabled = true;      // whether to render 3D lines

    // Category filters — all on by default
    this.filters = {};
    for (const key of Object.keys(RAY_COLORS)) this.filters[key] = true;

    // Circular log buffer
    this._log = [];              // { frame, time, category, origin, dir, maxDist, hit, hitPoint, hitNormal, hitObject, hitDist }
    this._logHead = 0;
    this._frame = 0;
    this._time = 0;

    // 3D line pool
    this._pool = [];
    this._poolMeta = [];         // { expiry: number, category: string }
    this._hitSpheres = [];
    this._hitSphereMeta = [];
    this._nextPool = 0;

    for (let i = 0; i < MAX_LINES; i++) {
      const line = makePoolLine();
      scene.add(line);
      this._pool.push(line);
      this._poolMeta.push({ expiry: 0, category: '' });

      const sphere = makeHitSphere();
      scene.add(sphere);
      this._hitSpheres.push(sphere);
      this._hitSphereMeta.push({ expiry: 0 });
    }

    // Listeners for the overlay UI
    this._onLogCallbacks = [];
  }

  /** Subscribe to new log entries (for the overlay). Callback receives the entry. */
  onLog(cb) { this._onLogCallbacks.push(cb); }

  /** Call once per frame before any raycasts happen. */
  beginFrame(dt) {
    this._frame++;
    this._time += dt;

    // Expire old lines
    if (this.visEnabled && this.enabled) {
      for (let i = 0; i < MAX_LINES; i++) {
        if (this._pool[i].visible && this._time > this._poolMeta[i].expiry) {
          this._pool[i].visible = false;
          this._hitSpheres[i].visible = false;
        }
      }
    }
  }

  /**
   * Log a raycast.
   *
   * @param {string} category — one of the keys from RAY_COLORS
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir — unit direction
   * @param {number} maxDist — raycaster.far
   * @param {boolean} hit — did it hit something?
   * @param {THREE.Vector3|null} hitPoint
   * @param {THREE.Vector3|null} hitNormal
   * @param {string|null} hitObjectName — mesh name or id
   * @param {number|null} hitDist
   */
  log(category, origin, dir, maxDist, hit, hitPoint = null, hitNormal = null, hitObjectName = null, hitDist = null) {
    if (!this.enabled) return;
    if (!this.filters[category]) return;

    // ── Record to circular buffer ──
    if (this.logEnabled) {
      const entry = {
        frame: this._frame,
        time: this._time.toFixed(3),
        category,
        label: RAY_LABELS[category] || category,
        originX: origin.x.toFixed(2),
        originY: origin.y.toFixed(2),
        originZ: origin.z.toFixed(2),
        dirX: dir.x.toFixed(2),
        dirY: dir.y.toFixed(2),
        dirZ: dir.z.toFixed(2),
        maxDist: maxDist.toFixed(2),
        hit,
        hitX: hit && hitPoint ? hitPoint.x.toFixed(2) : null,
        hitY: hit && hitPoint ? hitPoint.y.toFixed(2) : null,
        hitZ: hit && hitPoint ? hitPoint.z.toFixed(2) : null,
        hitNormX: hit && hitNormal ? hitNormal.x.toFixed(2) : null,
        hitNormY: hit && hitNormal ? hitNormal.y.toFixed(2) : null,
        hitNormZ: hit && hitNormal ? hitNormal.z.toFixed(2) : null,
        hitObject: hitObjectName,
        hitDist: hitDist !== null ? hitDist.toFixed(3) : null,
      };

      if (this._log.length < MAX_LOG_ENTRIES) {
        this._log.push(entry);
      } else {
        this._log[this._logHead] = entry;
      }
      this._logHead = (this._logHead + 1) % MAX_LOG_ENTRIES;

      for (const cb of this._onLogCallbacks) cb(entry);
    }

    // ── 3D visualization ──
    if (this.visEnabled) {
      const idx = this._nextPool;
      this._nextPool = (this._nextPool + 1) % MAX_LINES;

      const line = this._pool[idx];
      const sphere = this._hitSpheres[idx];
      const color = RAY_COLORS[category] || 0xffffff;

      // Set line endpoints: origin → origin + dir * actualDist
      const arr = line.geometry.attributes.position.array;
      const endDist = hit && hitDist !== null ? parseFloat(hitDist) : maxDist;
      arr[0] = origin.x;               arr[1] = origin.y;               arr[2] = origin.z;
      arr[3] = origin.x + dir.x * endDist;
      arr[4] = origin.y + dir.y * endDist;
      arr[5] = origin.z + dir.z * endDist;
      line.geometry.attributes.position.needsUpdate = true;

      line.material.color.setHex(color);
      line.material.opacity = hit ? 0.85 : 0.35;
      line.visible = true;
      const lifetime = (category === 'aim_ray' || category === 'bullet_path')
        ? AIM_RAY_LIFETIME : RAY_LIFETIME;
      this._poolMeta[idx] = { expiry: this._time + lifetime, category };

      // Hit sphere
      if (hit && hitPoint) {
        sphere.position.set(hitPoint.x, hitPoint.y, hitPoint.z);
        sphere.material.color.setHex(color);
        sphere.visible = true;
        this._hitSphereMeta[idx] = { expiry: this._time + RAY_LIFETIME };
      } else {
        sphere.visible = false;
      }
    }
  }

  /** Get a copy of the log buffer ordered oldest → newest. */
  getLog() {
    if (this._log.length < MAX_LOG_ENTRIES) return [...this._log];
    // Circular buffer — reorder
    return [
      ...this._log.slice(this._logHead),
      ...this._log.slice(0, this._logHead),
    ];
  }

  /** Clear the log buffer. */
  clearLog() {
    this._log.length = 0;
    this._logHead = 0;
  }

  /** Hide all 3D lines immediately. */
  hideAll() {
    for (let i = 0; i < MAX_LINES; i++) {
      this._pool[i].visible = false;
      this._hitSpheres[i].visible = false;
    }
  }

  /** Get category info for UI rendering. */
  static get CATEGORIES() { return RAY_COLORS; }
  static get LABELS() { return RAY_LABELS; }

  dispose() {
    for (let i = 0; i < MAX_LINES; i++) {
      this._pool[i].geometry.dispose();
      this._pool[i].material.dispose();
      this.scene.remove(this._pool[i]);
      this._hitSpheres[i].geometry.dispose();
      this._hitSpheres[i].material.dispose();
      this.scene.remove(this._hitSpheres[i]);
    }
  }
}

/**
 * Thin proxy so consuming modules can `import { rayDebug }` and always get a
 * stable reference.  `export let` live-bindings break in bundled builds —
 * this const-object pattern avoids that entirely.
 */
class _RayDebugProxy {
  constructor() { this._target = null; }
  get enabled() { return this._target ? this._target.enabled : false; }
  set enabled(v) { if (this._target) this._target.enabled = v; }
  log(...args) { if (this._target && this._target.enabled) this._target.log(...args); }
}

export const rayDebug = new _RayDebugProxy();
export function setRayDebugLogger(logger) { rayDebug._target = logger; }
