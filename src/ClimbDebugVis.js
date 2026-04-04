import * as THREE from 'three';

/**
 * Lightweight debug visualization for climb probes and vectors.
 * Uses a fixed pool of GL_LINES — zero allocations per frame.
 *
 * Lines drawn:
 *   cyan    — maintain probe (body → climbDir)
 *   yellow  — corner/ahead probe (body → inputDir)
 *   magenta — edge-wrap probe origin + direction
 *   green   — climbNormal (from body, outward)
 *   red     — inputDir (from body)
 *   white   — bodyUp (from body)
 */

const MAX_LINES = 8;

function makeLine(color) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(6); // 2 vertices × 3 components
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  line.renderOrder = 9999;
  line.visible = false;
  return line;
}

export class ClimbDebugVis {
  constructor(scene) {
    this.enabled = true;
    this.scene = scene;

    // Fixed line pool
    this.lines = {
      maintain:   makeLine(0x00ffff), // cyan
      corner:     makeLine(0xffff00), // yellow
      wrap:       makeLine(0xff00ff), // magenta
      wrapDir:    makeLine(0xff44ff), // lighter magenta (cast direction)
      normal:     makeLine(0x00ff00), // green
      input:      makeLine(0xff3333), // red
      bodyUp:     makeLine(0xffffff), // white
      climbDir:   makeLine(0xff8800), // orange
    };

    for (const l of Object.values(this.lines)) scene.add(l);
  }

  /** Call once per frame after walk.update(). */
  update(walk, bodyPos) {
    const vis = this.enabled && walk.climbing;

    // Hide all if not climbing or disabled
    for (const l of Object.values(this.lines)) l.visible = false;
    if (!vis) return;

    const scale = 2.0; // vector display length

    // Helper: set a line from origin along direction * length
    const setRay = (line, ox, oy, oz, dx, dy, dz, len) => {
      const arr = line.geometry.attributes.position.array;
      arr[0] = ox;            arr[1] = oy;            arr[2] = oz;
      arr[3] = ox + dx * len; arr[4] = oy + dy * len; arr[5] = oz + dz * len;
      line.geometry.attributes.position.needsUpdate = true;
      line.visible = true;
    };

    const bp = bodyPos;
    const w = walk;

    // climbNormal (green)
    setRay(this.lines.normal,
      bp.x, bp.y, bp.z,
      w._climbNormal.x, w._climbNormal.y, w._climbNormal.z, scale);

    // climbDir (orange) — into the wall
    setRay(this.lines.climbDir,
      bp.x, bp.y, bp.z,
      w._climbDir.x, w._climbDir.y, w._climbDir.z, w.climbMaintainDist);

    // inputDir (red)
    if (w.inputDir.lengthSq() > 0.001) {
      setRay(this.lines.input,
        bp.x, bp.y, bp.z,
        w.inputDir.x, w.inputDir.y, w.inputDir.z, scale);
    }

    // bodyUp (white)
    setRay(this.lines.bodyUp,
      bp.x, bp.y, bp.z,
      w._bodyUp.x, w._bodyUp.y, w._bodyUp.z, scale * 0.6);

    // The probe-specific lines get set via the walk system's debug hooks
    // (we'll read the last-frame debug data stored on walk)
    if (w._dbg) {
      const d = w._dbg;
      if (d.maintain) {
        setRay(this.lines.maintain,
          d.maintain.ox, d.maintain.oy, d.maintain.oz,
          d.maintain.dx, d.maintain.dy, d.maintain.dz, d.maintain.len);
      }
      if (d.corner) {
        setRay(this.lines.corner,
          d.corner.ox, d.corner.oy, d.corner.oz,
          d.corner.dx, d.corner.dy, d.corner.dz, d.corner.len);
      }
      if (d.wrap) {
        setRay(this.lines.wrap,
          d.wrap.ox, d.wrap.oy, d.wrap.oz,
          d.wrap.dx, d.wrap.dy, d.wrap.dz, d.wrap.len);
      }
    }
  }

  dispose() {
    for (const l of Object.values(this.lines)) {
      l.geometry.dispose();
      l.material.dispose();
      this.scene.remove(l);
    }
  }
}
