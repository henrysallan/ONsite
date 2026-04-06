import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

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
    },
    (error) => { console.error('GLB export failed:', error); },
    { binary: true }
  );
}

/**
 * Load a GLB with custom geometry and return a map of { meshName → THREE.Mesh }.
 *
 * Convention: each mesh in the GLB must be named to match a bone segment
 * (e.g. hip_L0, leg_R2, spine1).  The mesh's local space should have:
 *   - Origin at the "from" joint (base of the bone)
 *   - Geometry extending along local +Y for the bone's length
 *
 * At runtime, each custom mesh will be oriented from→to using the same
 * setFromUnitVectors(+Y, direction) as the default cylinders.
 *
 * @returns {Promise<Map<string, THREE.Mesh>>}
 */
export function loadCustomGeoGLB(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const loader = new GLTFLoader();
      loader.parse(e.target.result, '', (gltf) => {
        const meshMap = new Map();
        gltf.scene.traverse((child) => {
          if (child.isMesh && child.name) {
            // Clone the mesh so we own it
            const cloned = child.clone();
            cloned.geometry = child.geometry.clone();
            cloned.material = child.material.clone();
            cloned.castShadow = true;
            meshMap.set(child.name, cloned);
          }
        });
        resolve(meshMap);
      }, (error) => reject(error));
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
