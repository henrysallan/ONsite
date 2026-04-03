import * as THREE from 'three';

const _v = new THREE.Vector3();
const _proj = new THREE.Vector3();

/**
 * 2-bone IK solver.
 *
 * Given a root position, a target (end-effector) position, two bone lengths,
 * and a pole vector hint, returns the joint (knee/elbow) position.
 *
 * @param {THREE.Vector3} root      – shoulder / spine-node position
 * @param {THREE.Vector3} target    – desired foot position
 * @param {number}         lenA     – length of first bone (hip)
 * @param {number}         lenB     – length of second bone (leg)
 * @param {THREE.Vector3} poleHint  – direction hint for the bend plane (e.g. UP)
 * @param {THREE.Vector3} outJoint  – result written here
 * @returns {boolean} true if reachable, false if stretched to limit
 */
export function solve2BoneIK(root, target, lenA, lenB, poleHint, outJoint) {
  const chain = _v.subVectors(target, root);
  let dist = chain.length();

  const maxReach = lenA + lenB;
  const minReach = Math.abs(lenA - lenB);

  // Clamp if out of reach
  let reachable = true;
  if (dist >= maxReach) {
    dist = maxReach - 0.001;
    reachable = false;
  } else if (dist <= minReach) {
    dist = minReach + 0.001;
  }

  // Law of cosines: angle at root
  // cos(angleA) = (lenA² + dist² - lenB²) / (2 * lenA * dist)
  const cosA = (lenA * lenA + dist * dist - lenB * lenB) / (2 * lenA * dist);
  const angleA = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));

  // Direction from root → target (unit)
  const chainDir = chain.clone().normalize();

  // Build a bend-plane normal: cross of chain direction with pole hint
  const bendNormal = new THREE.Vector3().crossVectors(chainDir, poleHint);
  if (bendNormal.lengthSq() < 0.0001) {
    // Pole hint is parallel to chain – pick an arbitrary perpendicular
    bendNormal.crossVectors(chainDir, new THREE.Vector3(0, 0, 1));
    if (bendNormal.lengthSq() < 0.0001) {
      bendNormal.crossVectors(chainDir, new THREE.Vector3(1, 0, 0));
    }
  }
  bendNormal.normalize();

  // The bend direction (perpendicular to chain, in the bend plane)
  const bendDir = new THREE.Vector3().crossVectors(bendNormal, chainDir).normalize();

  // Joint position = root + lenA * ( cos(angleA) * chainDir + sin(angleA) * bendDir )
  const sinA = Math.sin(angleA);
  outJoint.copy(root)
    .addScaledVector(chainDir, lenA * cosA)
    .addScaledVector(bendDir, lenA * sinA);

  return reachable;
}
