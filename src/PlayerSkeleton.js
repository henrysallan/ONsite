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
const spineMat  = new THREE.MeshStandardMaterial({ color: 0xffffff });
const hipMat    = new THREE.MeshStandardMaterial({ color: 0xffffff });
const legMat    = new THREE.MeshStandardMaterial({ color: 0xffffff });
const jointMat  = new THREE.MeshStandardMaterial({ color: 0xffffff });
const footMat   = new THREE.MeshStandardMaterial({ color: 0xffffff });
const gunMat    = new THREE.MeshStandardMaterial({ color: 0xffffff });

// Reusable temporary for gun limb rest-pose target
const _gunTarget = new THREE.Vector3();

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
    this._refSpineHeight = this.spineHeight; // fixed reference for raycast/climb proxies

    // Per-bone lengths: 4 spines, 6 hips (L0,R0,L1,R1,L2,R2), 6 legs (same order)
    this.spineLengths = [this.spineLength / 2, this.spineLength / 2, this.spineLength / 2, this.spineLength / 2];
    this.hipLengths   = [1.10, 0.80, 1.00, 0.95, 0.90, 1.15];
    this.legLengths   = [1.05, 1.15, 1.20, 1.15, 1.30, 1.40];

    // Gun limb lengths (upper extends up from spine, lower bends forward)
    this.gunUpperLength = opts.gunUpperLength ?? 0.6;
    this.gunLowerLength = opts.gunLowerLength ?? 0.5;
    this.gunUpperAngle  = opts.gunUpperAngle  ?? 30; // degrees from vertical toward forward

    this.group = new THREE.Group();
    this._boneMeshes = [];
    this._jointMeshes = [];
    this._overrideMaterial = null;
    this.bones = {};

    // Stored custom bone-local geometries (survives build() teardown)
    // Map<boneName, { geometry, material, restLength }>
    this._customGeoStore = null;

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
    const S3 = this.spineLengths[2];
    const S4 = this.spineLengths[3];
    const Y = this.spineHeight;

    // ── Node positions (local space, spine along +Z) ──
    // 5 nodes: limbs attach at 0, 2, 4 (1st, 3rd, 5th)
    const node0 = new THREE.Vector3(0, Y, -(S1 + S2));
    const node1 = new THREE.Vector3(0, Y, -S2);
    const node2 = new THREE.Vector3(0, Y,  0);
    const node3 = new THREE.Vector3(0, Y,  S3);
    const node4 = new THREE.Vector3(0, Y,  S3 + S4);
    this.nodes = [node0, node1, node2, node3, node4];

    // ── Spine bones (4 segments) ──
    this._addBone(node0, node1, spineMat, 'spine1');
    this._addBone(node1, node2, spineMat, 'spine2');
    this._addBone(node2, node3, spineMat, 'spine3');
    this._addBone(node3, node4, spineMat, 'spine4');

    // ── Hips + Legs at limb nodes (0, 2, 4) ──
    // limbData ordering: L0, R0, L1, R1, L2, R2
    const limbNodes = [0, 2, 4];
    for (let i = 0; i < 3; i++) {
      const nodeIdx = limbNodes[i];
      const n = this.nodes[nodeIdx];
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
        nodeIndex: nodeIdx, side: 'L',
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
        nodeIndex: nodeIdx, side: 'R',
        hipBone: this.bones[`hip_R${i}`],
        legBone: this.bones[`leg_R${i}`],
        kneeJoint: jR,
        footJoint: fR,
      });
    }

    // ── Gun limb at 2nd node (node1) ──
    const gunUpperEnd = new THREE.Vector3(node1.x, node1.y + this.gunUpperLength, node1.z);
    const gunLowerEnd = new THREE.Vector3(gunUpperEnd.x, gunUpperEnd.y, gunUpperEnd.z + this.gunLowerLength);
    this._addBone(node1, gunUpperEnd, gunMat, 'gun_upper');
    this._addBone(gunUpperEnd, gunLowerEnd, gunMat, 'gun_lower');
    const gunElbow = this._addJoint(gunUpperEnd);
    const gunTip = this._addJoint(gunLowerEnd);

    this.gunData = {
      nodeIndex: 1,
      upperBone: this.bones['gun_upper'],
      lowerBone: this.bones['gun_lower'],
      elbowJoint: gunElbow,
      tipJoint: gunTip,
    };

    // Joint spheres at the 5 spine nodes
    this._spineNodeJoints = [];
    for (const n of this.nodes) {
      this._spineNodeJoints.push(this._addJoint(n));
    }
  }

  /**
   * Re-position spine bone meshes and spine-node joint spheres to match
   * the current `this.nodes` positions.  Must be called after setLiveHeight
   * or any other modification to node Y so the visual bones stay connected
   * to the IK hip roots.
   */
  updateSpine() {
    // Spine bones: spine1 = node0→node1, spine2 = node1→node2, etc.
    for (let i = 0; i < 4; i++) {
      const bone = this.bones[`spine${i + 1}`];
      if (bone) updateBoneMesh(bone.mesh, this.nodes[i], this.nodes[i + 1]);
    }
    // Spine-node joint spheres
    if (this._spineNodeJoints) {
      for (let i = 0; i < this.nodes.length; i++) {
        if (this._spineNodeJoints[i]) {
          this._spineNodeJoints[i].position.copy(this.nodes[i]);
        }
      }
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

  /**
   * Update the gun limb using 2-bone IK. tipPosLocal is in SKELETON-LOCAL space.
   */
  updateGunLimb(tipPosLocal) {
    const gd = this.gunData;
    if (!gd) return;
    const root = this.nodes[gd.nodeIndex];

    // Pole hint: backward (-Z) so the elbow bends upward
    _poleHint.set(0, 0, -1);

    const upperLen = this.gunUpperLength;
    const lowerLen = this.gunLowerLength;
    const maxReach = (upperLen + lowerLen) * 0.98;

    _toFoot.subVectors(tipPosLocal, root);
    const dist = _toFoot.length();
    if (dist > maxReach) {
      _toFoot.multiplyScalar(maxReach / dist);
      tipPosLocal.copy(root).add(_toFoot);
    }

    solve2BoneIK(root, tipPosLocal, upperLen, lowerLen, _poleHint, _knee);

    updateBoneMesh(gd.upperBone.mesh, root, _knee);
    updateBoneMesh(gd.lowerBone.mesh, _knee, tipPosLocal);

    gd.elbowJoint.position.copy(_knee);
    gd.tipJoint.position.copy(tipPosLocal);
  }

  /**
   * Update the gun limb to its default rest pose (extends up, bends forward).
   * Call once per frame after updating walking limbs.
   */
  updateGunRest() {
    if (!this.gunData) return;
    const root = this.nodes[this.gunData.nodeIndex];
    const totalReach = this.gunUpperLength + this.gunLowerLength;
    // Upper limb direction: angle from vertical (+Y) toward forward (+Z)
    const rad = this.gunUpperAngle * Math.PI / 180;
    const upComp = Math.cos(rad) * totalReach * 0.7;
    const fwdComp = Math.sin(rad) * totalReach * 0.7 + totalReach * 0.3;
    _gunTarget.set(root.x, root.y + upComp, root.z + fwdComp);
    this.updateGunLimb(_gunTarget);
  }

  /**
   * Get the gun tip position in world space.
   * Call after updateGunRest / updateGunLimb and after the skeleton group's
   * matrixWorld has been updated.
   * @param {THREE.Vector3} out – result written here
   * @returns {THREE.Vector3}
   */
  getGunTipWorld(out) {
    if (!this.gunData) return out.set(0, 0, 0);
    out.copy(this.gunData.tipJoint.position);
    this.group.localToWorld(out);
    return out;
  }

  _addBone(from, to, mat, name) {
    let mesh;
    const stored = this._customGeoStore && this._customGeoStore.get(name);
    if (stored) {
      // Re-use stored custom geometry (already in bone-local space)
      mesh = new THREE.Mesh(stored.geometry.clone(), this._overrideMaterial || stored.material.clone());
      mesh.castShadow = true;
      mesh.userData.customGeo = true;
      mesh.userData.restLength = stored.restLength;
      // Position at "from", orient +Y toward "to"
      mesh.position.copy(from);
      const dir = new THREE.Vector3().subVectors(to, from);
      if (dir.lengthSq() > 0.0001) {
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      }
    } else {
      mesh = createBoneMesh(from, to, this._overrideMaterial || mat);
    }
    mesh.name = name;
    this.group.add(mesh);
    this._boneMeshes.push(mesh);
    this.bones[name] = { from: from.clone(), to: to.clone(), mesh };
  }

  _addJoint(pos, mat) {
    const geo = new THREE.SphereGeometry(BONE_RADIUS * 2.5, 8, 6);
    const mesh = new THREE.Mesh(geo, this._overrideMaterial || mat || jointMat);
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
   * Replace the material on ALL bone and joint meshes.
   * @param {THREE.Material} mat
   */
  setMaterial(mat) {
    this._overrideMaterial = mat;
    for (const m of this._boneMeshes) m.material = mat;
    for (const m of this._jointMeshes) m.material = mat;
  }

  /**
   * Dynamically adjust the spine height. Updates spineHeight (used for body-height
   * tracking) AND all node Y positions so IK hip roots move accordingly.
   * Does NOT touch _refSpineHeight.
   * @param {number} y
   */
  setLiveHeight(y) {
    this.spineHeight = y;
    if (this.nodes) {
      for (const n of this.nodes) n.y = y;
      this.updateSpine();
    }
  }

  /**
   * Replace default cylinder bone meshes with custom geometry from a loaded GLB.
   *
   * Incoming meshes (from loadCustomGeoGLB) have their geometry in skeleton-space
   * (world transforms already baked in).  This method:
   *   1. Computes each bone's local frame (origin at from, +Y toward to)
   *   2. Applies the inverse to bring geometry into bone-local space
   *   3. Stores the bone-local geometry so it survives build() teardowns
   *
   * @param {Map<string, THREE.Mesh>} meshMap – name → mesh from loadCustomGeoGLB
   */
  applyCustomGeo(meshMap) {
    if (!this._customGeoStore) this._customGeoStore = new Map();

    const _invBone  = new THREE.Matrix4();
    const _boneQuat = new THREE.Quaternion();
    const _up       = new THREE.Vector3(0, 1, 0);
    const _dir      = new THREE.Vector3();
    const _one      = new THREE.Vector3(1, 1, 1);

    // Build a fuzzy lookup: Blender's GLTF export strips dots from
    // .001 suffixes, turning "hip_L0.001" into "hip_L0001".  We match
    // by checking if any meshMap key starts with the bone name and the
    // remaining characters are all digits (the Blender collision suffix).
    // We sort bone names longest-first so "gun_upper" matches before "gun".
    const boneNames = Object.keys(this.bones).sort((a, b) => b.length - a.length);
    const meshLookup = new Map(); // boneName → mesh from meshMap
    const usedKeys = new Set();
    for (const bn of boneNames) {
      // Exact match first
      if (meshMap.has(bn) && !usedKeys.has(bn)) {
        meshLookup.set(bn, meshMap.get(bn));
        usedKeys.add(bn);
        continue;
      }
      // Prefix + digits match
      for (const [key, mesh] of meshMap) {
        if (usedKeys.has(key)) continue;
        if (key.startsWith(bn)) {
          const suffix = key.slice(bn.length);
          if (/^\d{3,}$/.test(suffix)) {
            meshLookup.set(bn, mesh);
            usedKeys.add(key);
            break;
          }
        }
      }
    }

    const matched   = [];
    const unmatched = [];

    for (const [name, bone] of Object.entries(this.bones)) {
      const custom = meshLookup.get(name);
      if (!custom) { unmatched.push(name); continue; }
      matched.push(name);

      // Remove old mesh
      const oldMesh = bone.mesh;
      this.group.remove(oldMesh);
      if (oldMesh.geometry !== _sharedBoneGeo) oldMesh.geometry.dispose();

      // Rest length for this bone
      const restLen = _dir.subVectors(bone.to, bone.from).length();
      _dir.normalize();
      _boneQuat.setFromUnitVectors(_up, _dir);

      // Bone frame: position at from, +Y along direction
      const boneMat = new THREE.Matrix4().compose(bone.from, _boneQuat, _one);
      _invBone.copy(boneMat).invert();

      // Transform geometry from skeleton-space into bone-local space
      const localGeo = custom.geometry.clone();
      localGeo.applyMatrix4(_invBone);

      const material = this._overrideMaterial || custom.material.clone();
      const newMesh = new THREE.Mesh(localGeo, material);
      newMesh.name = name;
      newMesh.castShadow = true;
      newMesh.userData.customGeo = true;
      newMesh.userData.restLength = restLen;

      // Place at current bone position and orient
      newMesh.position.copy(bone.from);
      newMesh.quaternion.copy(_boneQuat);

      this.group.add(newMesh);
      bone.mesh = newMesh;

      // Store bone-local data so build() can re-create this mesh
      this._customGeoStore.set(name, {
        geometry: localGeo.clone(),
        material: custom.material.clone(),
        restLength: restLen,
      });
    }

    console.log(`[Skeleton] Custom geo applied to ${matched.length} bones: ${matched.join(', ')}`);
    if (unmatched.length > 0) {
      console.warn(`[Skeleton] No custom mesh found for bones: ${unmatched.join(', ')}`);
    }
    const extras = [...meshMap.keys()].filter(k => !this.bones[k]);
    if (extras.length > 0) {
      console.warn(`[Skeleton] GLB meshes that didn't match any bone (ignored): ${extras.join(', ')}`);
    }
  }

  /**
   * Remove all stored custom geometry, reverting to default cylinders
   * on the next build() call.
   */
  clearCustomGeo() {
    if (this._customGeoStore) {
      for (const v of this._customGeoStore.values()) v.geometry.dispose();
      this._customGeoStore = null;
    }
    this.build();
  }
}
