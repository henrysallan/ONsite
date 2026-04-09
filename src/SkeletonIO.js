import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

/**
 * Export the skeleton's current rest pose as a GLB file.
 *
 * Each bone segment is exported as a mesh with its origin at the "from" joint,
 * extending along local +Y to the "to" joint.  This means in Blender you model
 * geometry around the local Y axis, with the base at the origin.
 *
 * Naming convention in the exported file:
 *   spine1, spine2,
 *   hip_L0, hip_R0, hip_L1, hip_R1, hip_L2, hip_R2,
 *   leg_L0, leg_R0, leg_L1, leg_R1, leg_L2, leg_R2,
 *   joint_node0, joint_node1, joint_node2,
 *   joint_knee_L0 .. joint_knee_R2,
 *   joint_foot_L0 .. joint_foot_R2
 */
export function exportSkeletonGLB(skeleton) {
  const exportGroup = new THREE.Group();
  exportGroup.name = 'skeleton_reference';

  // Export each bone segment with origin at "from", extending along +Y
  for (const [name, bone] of Object.entries(skeleton.bones)) {
    const dir = new THREE.Vector3().subVectors(bone.to, bone.from);
    const length = dir.length();

    // Cylinder along +Y from 0 to length (shift geometry so bottom is at origin)
    const geo = new THREE.CylinderGeometry(0.03, 0.03, length, 8);
    geo.translate(0, length / 2, 0); // move so base is at origin

    const mat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;

    // Position at the "from" point
    mesh.position.copy(bone.from);

    // Orient +Y to point from → to
    const up = new THREE.Vector3(0, 1, 0);
    const dirN = dir.clone().normalize();
    if (dirN.lengthSq() > 0.0001) {
      mesh.quaternion.setFromUnitVectors(up, dirN);
    }

    exportGroup.add(mesh);
  }

  // Export joint markers so they're visible as reference points.
  // Use rest-pose positions from the bone data (not the live IK-driven joint meshes).
  const limbLabels = ['L0', 'R0', 'L1', 'R1', 'L2', 'R2'];
  for (let i = 0; i < limbLabels.length; i++) {
    const label = limbLabels[i];
    const side = label[0]; // 'L' or 'R'
    const nodeIdx = label[1]; // '0', '1', '2'
    const hipBone = skeleton.bones[`hip_${side}${nodeIdx}`];
    const legBone = skeleton.bones[`leg_${side}${nodeIdx}`];

    // Knee = where hip ends / leg begins
    const kneeGeo = new THREE.SphereGeometry(0.06, 8, 6);
    const kneeMesh = new THREE.Mesh(kneeGeo, new THREE.MeshStandardMaterial({ color: 0xfbbf24 }));
    kneeMesh.name = `joint_knee_${label}`;
    kneeMesh.position.copy(hipBone.to);
    exportGroup.add(kneeMesh);

    // Foot = where leg ends
    const footGeo = new THREE.SphereGeometry(0.06, 8, 6);
    const footMesh = new THREE.Mesh(footGeo, new THREE.MeshStandardMaterial({ color: 0xef4444 }));
    footMesh.name = `joint_foot_${label}`;
    footMesh.position.copy(legBone.to);
    exportGroup.add(footMesh);
  }

  // Spine node joints
  for (let i = 0; i < skeleton.nodes.length; i++) {
    const geo = new THREE.SphereGeometry(0.06, 8, 6);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xfbbf24 }));
    mesh.name = `joint_node${i}`;
    mesh.position.copy(skeleton.nodes[i]);
    exportGroup.add(mesh);
  }

  // Gun limb joints
  if (skeleton.gunData) {
    const gunElbowGeo = new THREE.SphereGeometry(0.06, 8, 6);
    const gunElbowMesh = new THREE.Mesh(gunElbowGeo, new THREE.MeshStandardMaterial({ color: 0xfbbf24 }));
    gunElbowMesh.name = 'joint_gun_elbow';
    gunElbowMesh.position.copy(skeleton.bones['gun_upper'].to);
    exportGroup.add(gunElbowMesh);

    const gunTipGeo = new THREE.SphereGeometry(0.06, 8, 6);
    const gunTipMesh = new THREE.Mesh(gunTipGeo, new THREE.MeshStandardMaterial({ color: 0xef4444 }));
    gunTipMesh.name = 'joint_gun_tip';
    gunTipMesh.position.copy(skeleton.bones['gun_lower'].to);
    exportGroup.add(gunTipMesh);
  }

  // Export as binary GLB
  const exporter = new GLTFExporter();
  exporter.parse(
    exportGroup,
    (buffer) => {
      const blob = new Blob([buffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'skeleton_reference.glb';
      a.click();
      URL.revokeObjectURL(url);

      const boneNames = Object.keys(skeleton.bones).join(', ');
      console.log(
        `%c=== Skeleton GLB exported ===%c\n` +
        `Bones: ${boneNames}\n\n` +
        `Blender workflow:\n` +
        `  1. File → Import → glTF (.glb)\n` +
        `  2. Replace/edit mesh geometry for any bone object\n` +
        `     Keep the object NAME exactly as-is (or Blender may add .001)\n` +
        `  3. Each bone's local space: origin at base, geometry along +Y (+Z in Blender)\n` +
        `  4. File → Export → glTF (.glb)\n` +
        `  5. Use "Import Custom GLB" button to load it back\n`,
        'font-weight:bold;color:#4ade80', 'color:inherit'
      );
    },
    (error) => { console.error('GLB export failed:', error); },
    { binary: true }
  );
}

/**
 * Load a GLB with custom geometry and return a map of { meshName → THREE.Mesh }.
 *
 * Handles Blender round-trip issues:
 *   - Bakes the full GLTF world transform into geometry vertices so
 *     Blender's Y↔Z axis conversion doesn't break orientation.
 *   - Walks the ancestor chain for generic-named meshes (Mesh_5, etc.)
 *     to find the real bone name from a parent Group node.
 *   - Merges multi-primitive meshes (same parent) into a single geometry.
 *   - Skips joint marker meshes (joint_*) from the export reference.
 *
 * The returned meshes have geometry in "skeleton space" (the same
 * coordinate space as bone.from / bone.to).  PlayerSkeleton.applyCustomGeo
 * will transform them into bone-local space.
 *
 * @returns {Promise<Map<string, THREE.Mesh>>}
 */
/**
 * Internal: parse a loaded GLTF scene into a bone-name → Mesh map.
 * Shared by both the File-based and URL-based loaders.
 */
function _parseMeshMap(gltf) {
  gltf.scene.updateMatrixWorld(true);

  // ── Step 1: Collect all meshes grouped by their resolved bone name ──
  const nameToGeos = new Map();

  gltf.scene.traverse((child) => {
    if (!child.isMesh) return;

    // Walk up the ancestor chain to find a meaningful name.
    let resolvedName = '';
    let node = child;
    while (node) {
      const n = node.name || '';
      if (n && !/^Mesh_\d+(_\d+)?$/.test(n)) {
        resolvedName = n;
        break;
      }
      node = node.parent;
    }
    if (!resolvedName) return;
    if (resolvedName.startsWith('joint_')) return;
    if (resolvedName === 'skeleton_reference') return;

    const geo = child.geometry.clone();
    geo.applyMatrix4(child.matrixWorld);

    const mat = Array.isArray(child.material)
      ? child.material[0].clone()
      : child.material.clone();

    if (!nameToGeos.has(resolvedName)) nameToGeos.set(resolvedName, []);
    nameToGeos.get(resolvedName).push({ geometry: geo, material: mat });
  });

  // ── Step 2: Merge multi-primitive meshes & build final meshMap ──
  const meshMap = new Map();
  for (const [rawName, parts] of nameToGeos) {
    let mergedGeo;
    if (parts.length === 1) {
      mergedGeo = parts[0].geometry;
    } else {
      mergedGeo = mergeGeometries(parts.map(p => p.geometry), false);
      if (!mergedGeo) {
        console.warn(`[SkeletonIO] Failed to merge geometries for "${rawName}", using first primitive`);
        mergedGeo = parts[0].geometry;
      }
    }

    const smoothGeo = toCreasedNormals(mergedGeo, Math.PI * 30 / 180);

    const mesh = new THREE.Mesh(smoothGeo, parts[0].material);
    mesh.name = rawName;
    mesh.castShadow = true;
    meshMap.set(rawName, mesh);
  }

  console.log('[SkeletonIO] Loaded meshes from GLB:', [...meshMap.keys()].join(', '));
  return meshMap;
}

export function loadCustomGeoGLB(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath('/draco/');
      const loader = new GLTFLoader();
      loader.setDRACOLoader(dracoLoader);
      loader.parse(e.target.result, '', (gltf) => {
        resolve(_parseMeshMap(gltf));
      }, (error) => reject(error));
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Load a GLB from a URL (e.g. a path in /public) and return a mesh map.
 * @param {string} url
 * @returns {Promise<Map<string, THREE.Mesh>>}
 */
export function loadCustomGeoFromURL(url) {
  return new Promise((resolve, reject) => {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('/draco/');
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);
    loader.load(
      url,
      (gltf) => resolve(_parseMeshMap(gltf)),
      undefined,
      (error) => reject(error)
    );
  });
}
