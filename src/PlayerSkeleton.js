import * as THREE from 'three';
import { solve2BoneIK } from './IKSolver.js';

/**
 * Procedural skeleton built from bone segments, each visualized as a thin tube.
 *
 * Structure (viewed from above, spine runs along +Z):
 *
 *        hipL ── legL          hipL ── legL          hipL ── legL
 *          |                     |                     |
 *  [node0] ═══ spine1 ═══ [node1] ═══ spine2 ═══ [node2]
 *          |                     |                     |
 *        hipR ── legR          hipR ── legR          hipR ── legR
 *
 * - Spine bones are horizontal (parallel to ground, along local +Z).
 * - Hip bones extend left/right from each node (along local ±X).
 * - Leg bones hang straight down from each hip end (along -Y).
 */

const BONE_RADIUS = 0.03;
const BONE_SEGMENTS = 6;

// Shared unit-height cylinder geometry for all default bone meshes (scaled at runtime)
const _sharedBoneGeo = new THREE.CylinderGeometry(BONE_RADIUS, BONE_RADIUS, 1, BONE_SEGMENTS);

// Reusable temporaries for per-frame updates
const _boneDir = new THREE.Vector3();
const _boneMid = new THREE.Vector3();
const _boneUp  = new THREE.Vector3(0, 1, 0);
const _poleHint = new THREE.Vector3();
const _toFoot = new THREE.Vector3();
const _knee = new THREE.Vector3();

// Shared materials
const spineMat  = new THREE.MeshStandardMaterial({ color: 0xe2e8f0 });
const hipMat    = new THREE.MeshStandardMaterial({ color: 0x94a3b8 });
const legMat    = new THREE.MeshStandardMaterial({ color: 0x64748b });
const jointMat  = new THREE.MeshStandardMaterial({ color: 0xfbbf24 });
const footMat   = new THREE.MeshStandardMaterial({ color: 0xef4444 });

/** Create a tube (cylinder) mesh between two local-space points. */
function createBoneMesh(from, to, material) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const length = dir.length();
  const mesh = new THREE.Mesh(_sharedBoneGeo, material);

  const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
  mesh.position.copy(mid);
  mesh.scale.set(1, length, 1);

  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize());
  mesh.quaternion.copy(quat);

  mesh.castShadow = true;
  return mesh;
}

/** Reposition an existing bone mesh to span from → to (reuses geometry). */
function updateBoneMesh(mesh, from, to) {
  _boneDir.subVectors(to, from);
  const length = _boneDir.length();

  if (mesh.userData.customGeo) {
    // Custom geometry: origin is at "from", extends along local +Y.
    mesh.position.copy(from);
    _boneUp.set(0, 1, 0);
    const dirSq = _boneDir.lengthSq();
    if (dirSq > 0.0001) {
      _boneDir.multiplyScalar(1 / Math.sqrt(dirSq));
      mesh.quaternion.setFromUnitVectors(_boneUp, _boneDir);
    }
    const restLen = mesh.userData.restLength || length;
    mesh.scale.set(1, length / restLen, 1);
  } else {
    // Default cylinder: shared unit-height geometry, scaled to match length
    _boneMid.addVectors(from, to).multiplyScalar(0.5);
    mesh.position.copy(_boneMid);
    mesh.scale.set(1, length, 1);

    _boneUp.set(0, 1, 0);
    const dirSq = _boneDir.lengthSq();
    if (dirSq > 0.0001) {
      _boneDir.multiplyScalar(1 / Math.sqrt(dirSq));
      mesh.quaternion.setFromUnitVectors(_boneUp, _boneDir);
    }
  }
}

/** Small sphere at a joint position. */
function createJointMesh(position) {
  const geo = new THREE.SphereGeometry(BONE_RADIUS * 2.5, 8, 6);
  const mesh = new THREE.Mesh(geo, jointMat);
  mesh.position.copy(position);
  mesh.castShadow = true;
  return mesh;
}

export class PlayerSkeleton {
  constructor(opts = {}) {
    this.spineLength = opts.spineLength ?? 0.8;
    this.hipLength   = opts.hipLength   ?? 0.6;
    this.legLength   = opts.legLength   ?? 0.8;
    this.spineHeight = opts.spineHeight ?? 0.70;

    // Per-bone lengths: 2 spines, 6 hips (L0,R0,L1,R1,L2,R2), 6 legs (same order)
    this.spineLengths = [this.spineLength, this.spineLength];
    this.hipLengths   = [1.10, 0.80, 1.00, 0.95, 0.90, 1.15];
    this.legLengths   = [1.05, 1.15, 1.20, 1.15, 1.30, 1.40];

    this.group = new THREE.Group();
    this._boneMeshes = [];
    this._jointMeshes = [];
    this.bones = {};

    // Per-limb IK data (filled by build)
    // Index layout: [L0, R0, L1, R1, L2, R2]
    this.limbData = [];

    this.build();
  }

  build() {
    // Tear down — only dispose non-shared geometry
    for (const m of this._boneMeshes) {
      this.group.remove(m);
      if (m.geometry !== _sharedBoneGeo) m.geometry.dispose();
    }
    for (const m of this._jointMeshes) { this.group.remove(m); m.geometry.dispose(); }
    this._boneMeshes = [];
    this._jointMeshes = [];
    this.limbData = [];

    const S1 = this.spineLengths[0];
    const S2 = this.spineLengths[1];
    const Y = this.spineHeight;

    // ── Node positions (local space, spine along +Z) ──
    const node0 = new THREE.Vector3(0, Y, -S1);
    const node1 = new THREE.Vector3(0, Y,  0);
    const node2 = new THREE.Vector3(0, Y,  S2);
    this.nodes = [node0, node1, node2];

    // ── Spine bones ──
    this._addBone(node0, node1, spineMat, 'spine1');
    this._addBone(node1, node2, spineMat, 'spine2');

    // ── Hips + Legs at each node ──
    // limbData ordering: L0, R0, L1, R1, L2, R2  (limbIdx = i*2 for L, i*2+1 for R)
    for (let i = 0; i < 3; i++) {
      const n = this.nodes[i];
      const limbIdxL = i * 2;
      const limbIdxR = i * 2 + 1;

      const hL = this.hipLengths[limbIdxL];
      const lL = this.legLengths[limbIdxL];

      // Left (+X)
      const hipLEnd = new THREE.Vector3(n.x + hL, n.y, n.z);
      const legLEnd = new THREE.Vector3(hipLEnd.x, hipLEnd.y - lL, hipLEnd.z);
      this._addBone(n, hipLEnd, hipMat, `hip_L${i}`);
      this._addBone(hipLEnd, legLEnd, legMat, `leg_L${i}`);
      const jL = this._addJoint(hipLEnd);   // knee joint
      const fL = this._addJoint(legLEnd, footMat); // foot

      this.limbData.push({
        nodeIndex: i, side: 'L',
        hipBone: this.bones[`hip_L${i}`],
        legBone: this.bones[`leg_L${i}`],
        kneeJoint: jL,
        footJoint: fL,
      });

      const hR = this.hipLengths[limbIdxR];
      const lR = this.legLengths[limbIdxR];

      // Right (-X)
      const hipREnd = new THREE.Vector3(n.x - hR, n.y, n.z);
      const legREnd = new THREE.Vector3(hipREnd.x, hipREnd.y - lR, hipREnd.z);
      this._addBone(n, hipREnd, hipMat, `hip_R${i}`);
      this._addBone(hipREnd, legREnd, legMat, `leg_R${i}`);
      const jR = this._addJoint(hipREnd);
      const fR = this._addJoint(legREnd, footMat);

      this.limbData.push({
        nodeIndex: i, side: 'R',
        hipBone: this.bones[`hip_R${i}`],
        legBone: this.bones[`leg_R${i}`],
        kneeJoint: jR,
        footJoint: fR,
      });
    }

    // Joint spheres at the 3 spine nodes
    for (const n of this.nodes) {
      this._addJoint(n);
    }
  }

  /**
   * Update a limb using IK. footPos is in SKELETON-LOCAL space.
   * limbIndex matches ProceduralWalk limb order: [L0, R0, L1, R1, L2, R2]
   */
  updateLimb(limbIndex, footPosLocal) {
    const ld = this.limbData[limbIndex];
    const root = this.nodes[ld.nodeIndex]; // spine node (local)

    // Pole hint: point outward from spine (+X for left, -X for right)
    _poleHint.set(ld.side === 'L' ? 1 : -1, 1, 0).normalize();

    const hipLen = this.hipLengths[limbIndex];
    const legLen = this.legLengths[limbIndex];
    const maxReach = (hipLen + legLen) * 0.98; // 98% to prevent full extension

    // Clamp foot target so the limb never stretches beyond max reach
    _toFoot.subVectors(footPosLocal, root);
    const dist = _toFoot.length();
    if (dist > maxReach) {
      _toFoot.multiplyScalar(maxReach / dist);
      footPosLocal.copy(root).add(_toFoot);
    }

    solve2BoneIK(root, footPosLocal, hipLen, legLen, _poleHint, _knee);

    // Update bone meshes
    updateBoneMesh(ld.hipBone.mesh, root, _knee);
    updateBoneMesh(ld.legBone.mesh, _knee, footPosLocal);

    // Update joint spheres
    ld.kneeJoint.position.copy(_knee);
    ld.footJoint.position.copy(footPosLocal);
  }

  _addBone(from, to, mat, name) {
    const mesh = createBoneMesh(from, to, mat);
    mesh.name = name;
    this.group.add(mesh);
    this._boneMeshes.push(mesh);
    this.bones[name] = { from: from.clone(), to: to.clone(), mesh };
  }

  _addJoint(pos, mat) {
    const geo = new THREE.SphereGeometry(BONE_RADIUS * 2.5, 8, 6);
    const mesh = new THREE.Mesh(geo, mat || jointMat);
    mesh.position.copy(pos);
    mesh.castShadow = true;
    this.group.add(mesh);
    this._jointMeshes.push(mesh);
    return mesh;
  }

  dispose() {
    for (const m of this._boneMeshes) {
      if (m.geometry !== _sharedBoneGeo) m.geometry.dispose();
    }
    for (const m of this._jointMeshes) { m.geometry.dispose(); }
  }

  /**
   * Replace default cylinder bone meshes with custom geometry from a loaded GLB.
   * @param {Map<string, THREE.Mesh>} meshMap – name → mesh from SkeletonIO.loadCustomGeoGLB
   */
  applyCustomGeo(meshMap) {
    for (const [name, bone] of Object.entries(this.bones)) {
      const custom = meshMap.get(name);
      if (!custom) continue;

      // Remove old mesh
      const oldMesh = bone.mesh;
      this.group.remove(oldMesh);
      if (oldMesh.geometry !== _sharedBoneGeo) oldMesh.geometry.dispose();

      // Compute rest length from the current bone endpoints
      const restLen = new THREE.Vector3().subVectors(bone.to, bone.from).length();
      custom.userData.customGeo = true;
      custom.userData.restLength = restLen;

      // Place it at the "from" point, oriented along from→to
      custom.position.copy(bone.from);
      const dir = new THREE.Vector3().subVectors(bone.to, bone.from).normalize();
      if (dir.lengthSq() > 0.0001) {
        custom.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      }

      this.group.add(custom);
      bone.mesh = custom;

      // Also update limbData references
      for (const ld of this.limbData) {
        if (ld.hipBone === bone) ld.hipBone = bone;
        if (ld.legBone === bone) ld.legBone = bone;
      }
    }
  }
}
