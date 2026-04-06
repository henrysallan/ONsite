import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Patch Three.js so every BufferGeometry can build a BVH and every Mesh raycasts through it
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import React, { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { useControls, button } from 'leva';

import { PostProcessing } from './PostProcessing.js';
import { defaultRampStops } from './CelShadingPass.js';
import { ColorRampEditor } from './ColorRampEditor.jsx';
import { PlayerController, setRendererDomElement } from './PlayerController.js';
import { CameraController } from './CameraController.js';
import { ClimbDebugVis } from './ClimbDebugVis.js';
import { RayDebugLogger, setRayDebugLogger } from './RayDebugLogger.js';
import { RayDebugOverlay } from './DebugOverlay.jsx';
import { exportSkeletonGLB, loadCustomGeoGLB } from './SkeletonIO.js';
import { BulletSystem } from './BulletSystem.js';
import { SparkSystem } from './SparkSystem.js';

// ───────────────────────────────────────────────
// Three.js setup (module-level singletons)
// ───────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
THREE.ColorManagement.enabled = false;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.body.appendChild(renderer.domElement);

// Let the player controller know which element has pointer lock
setRendererDomElement(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);
scene.fog = new THREE.Fog(0xffffff, 40, 120);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);

// ── Post-processing pipeline ──
const postFX = new PostProcessing(renderer, scene, camera);

// ── Lighting ──
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(10, 20, 10);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.left = -30;
dirLight.shadow.camera.right = 30;
dirLight.shadow.camera.top = 30;
dirLight.shadow.camera.bottom = -30;
scene.add(dirLight);

// ── Ground plane ──
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(200, 80, 0xcccccc, 0xcccccc);
grid.position.y = 0.01;
grid.material.opacity = 0.3;
grid.material.transparent = true;
scene.add(grid);

// ── Terrain: ramps and hills ──
const terrainMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
ground.geometry.computeBoundsTree();
const groundMeshes = [ground]; // collect all walkable surfaces

// Ramp 1 – gentle slope facing +Z
{
  const geo = new THREE.BoxGeometry(4, 0.15, 8);
  geo.computeBoundsTree();
  const ramp = new THREE.Mesh(geo, terrainMat);
  ramp.position.set(6, 0.8, 5);
  ramp.rotation.x = -0.2; // ~11°
  ramp.castShadow = true;
  ramp.receiveShadow = true;
  scene.add(ramp);
  groundMeshes.push(ramp);
}

// Ramp 2 – steeper slope facing -X
{
  const geo = new THREE.BoxGeometry(10, 0.15, 4);
  geo.computeBoundsTree();
  const ramp = new THREE.Mesh(geo, terrainMat);
  ramp.position.set(-8, 1.0, -3);
  ramp.rotation.z = 0.25; // ~14°
  ramp.castShadow = true;
  ramp.receiveShadow = true;
  scene.add(ramp);
  groundMeshes.push(ramp);
}

// Ramp 3 – wide gentle ramp facing +X
{
  const geo = new THREE.BoxGeometry(12, 0.15, 6);
  geo.computeBoundsTree();
  const ramp = new THREE.Mesh(geo, terrainMat);
  ramp.position.set(0, 0.5, -10);
  ramp.rotation.z = -0.12; // ~7°
  ramp.castShadow = true;
  ramp.receiveShadow = true;
  scene.add(ramp);
  groundMeshes.push(ramp);
}

// Hill – a subdivided plane with sine displacement
{
  const hillSize = 16;
  const hillSegs = 32;
  const geo = new THREE.PlaneGeometry(hillSize, hillSize, hillSegs, hillSegs);
  const posAttr = geo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    // Smooth hill: height based on distance from center
    const d = Math.sqrt(x * x + y * y);
    const h = 2.0 * Math.max(0, 1 - d / (hillSize * 0.4));
    posAttr.setZ(i, h * h); // quadratic falloff for smooth dome
  }
  geo.computeVertexNormals();
  geo.computeBoundsTree();
  const hillMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const hill = new THREE.Mesh(geo, hillMat);
  hill.rotation.x = -Math.PI / 2;
  hill.position.set(12, 0, -12);
  hill.castShadow = true;
  hill.receiveShadow = true;
  scene.add(hill);
  groundMeshes.push(hill);
}

// Stepped platform – two flat boxes
{
  const step1 = new THREE.Mesh(new THREE.BoxGeometry(4, 0.5, 4), terrainMat.clone());
  step1.geometry.computeBoundsTree();
  step1.position.set(-6, 0.25, 8);
  step1.castShadow = true;
  step1.receiveShadow = true;
  scene.add(step1);
  groundMeshes.push(step1);

  const step2 = new THREE.Mesh(new THREE.BoxGeometry(3, 1.0, 3), terrainMat.clone());
  step2.geometry.computeBoundsTree();
  step2.position.set(-6, 0.5, 8);
  step2.castShadow = true;
  step2.receiveShadow = true;
  scene.add(step2);
  groundMeshes.push(step2);
}

// ── Climbable walls ──
const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 });

// Wall 1 – tall vertical wall facing +X
{
  const geo = new THREE.BoxGeometry(2, 8, 6);
  geo.computeBoundsTree();
  const wall = new THREE.Mesh(geo, wallMat);
  wall.position.set(14, 4, 0);
  wall.castShadow = true;
  wall.receiveShadow = true;
  wall.userData.climbable = true;
  scene.add(wall);
  groundMeshes.push(wall);
}

// Wall 2 – L-shaped wall section (two boxes)
{
  const w1 = new THREE.Mesh(new THREE.BoxGeometry(2, 6, 8), wallMat.clone());
  w1.geometry.computeBoundsTree();
  w1.position.set(-14, 3, 4);
  w1.castShadow = true;
  w1.receiveShadow = true;
  w1.userData.climbable = true;
  scene.add(w1);
  groundMeshes.push(w1);

  const w2 = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 2), wallMat.clone());
  w2.geometry.computeBoundsTree();
  w2.position.set(-11, 3, 8);
  w2.castShadow = true;
  w2.receiveShadow = true;
  w2.userData.climbable = true;
  scene.add(w2);
  groundMeshes.push(w2);
}

// Wall 3 – angled wall (tilted ~30° from vertical)
{
  const geo = new THREE.BoxGeometry(2, 8, 6);
  geo.computeBoundsTree();
  const wall = new THREE.Mesh(geo, wallMat.clone());
  wall.position.set(8, 3, -8);
  wall.rotation.z = 0.5; // ~30° tilt
  wall.castShadow = true;
  wall.receiveShadow = true;
  wall.userData.climbable = true;
  scene.add(wall);
  groundMeshes.push(wall);
}

// ── Test block (loaded from GLB) ──
{
  const loader = new GLTFLoader();
  loader.load('/testblock.glb', (gltf) => {
    const model = gltf.scene;
    model.position.set(0, 0, 5);
    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.userData.climbable = true;
        // FrontSide is sufficient with BVH (three-mesh-bvh) for precise
        // ray-triangle tests. DoubleSide caused raycasts to hit interior
        // surfaces, letting the player walk inside manifold meshes.
        if (child.material) {
          const normMat = (m) => {
            m.color.set(0xffffff);
            m.side = THREE.FrontSide;
            m.roughness = 0.9;
            m.metalness = 0;
            m.emissive?.set(0x000000);
            if (m.emissiveMap) { m.emissiveMap = null; }
            if (m.metalnessMap) { m.metalnessMap = null; }
            if (m.roughnessMap) { m.roughnessMap = null; }
            if (m.map) { m.map = null; }
            m.needsUpdate = true;
          };
          if (Array.isArray(child.material)) {
            child.material.forEach(normMat);
          } else {
            normMat(child.material);
          }
        }
        // Build BVH for fast trimesh raycasting on complex geometry
        child.geometry.computeBoundsTree();
        groundMeshes.push(child);
      }
    });
    scene.add(model);
    // Update player ground meshes now that the block is loaded
    player.setGroundMeshes(groundMeshes);
  }, undefined, (err) => {
    console.error('Failed to load testblock.glb:', err);
  });
}

// ── Player + Camera controllers ──
const player = new PlayerController(scene);
player.setGroundMeshes(groundMeshes);
const camCtrl = new CameraController(camera, player);
camCtrl.setGroundMeshes([ground]);
const climbDebug = new ClimbDebugVis(scene);
const rayLogger = new RayDebugLogger(scene);
setRayDebugLogger(rayLogger);

// ── Bullet system ──
const sparks = new SparkSystem(scene);
const bullets = new BulletSystem(scene, groundMeshes);
bullets.sparks = sparks;
const _aimRaycaster = new THREE.Raycaster();
const _aimDir = new THREE.Vector3();
const _gunTipW = new THREE.Vector3();
const _aimPoint = new THREE.Vector3();
const _screenCenter = new THREE.Vector2(0, 0); // NDC center

// ── Continuous fire state ──
let _firing = false;
let _fireCooldown = 0;

function fireBullet() {
  // 1. Raycast from camera through screen center to find aim point
  _aimRaycaster.setFromCamera(_screenCenter, camera);
  _aimRaycaster.far = 500;
  const hits = _aimRaycaster.intersectObjects(groundMeshes, false);
  if (hits.length > 0) {
    _aimPoint.copy(hits[0].point);
  } else {
    _aimPoint.copy(_aimRaycaster.ray.direction).multiplyScalar(200).add(_aimRaycaster.ray.origin);
  }

  // 2. Get gun tip in world space
  player.skeleton.group.updateMatrixWorld(true);
  player.skeleton.getGunTipWorld(_gunTipW);

  // 3. Direction from gun tip toward aim point
  _aimDir.subVectors(_aimPoint, _gunTipW).normalize();

  // 4. Fire!
  bullets.fire(_gunTipW, _aimDir);
}

renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (document.pointerLockElement !== renderer.domElement) return;
  _firing = true;
  _fireCooldown = 0; // fire immediately on first click
});
renderer.domElement.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  _firing = false;
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== renderer.domElement) _firing = false;
});

// ── Pointer lock on canvas click ──
renderer.domElement.addEventListener('click', () => {
  renderer.domElement.requestPointerLock();
});

// ── Resize ──
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  postFX.setSize(window.innerWidth, window.innerHeight);
});

// ── Game loop ──
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  rayLogger.beginFrame(dt);
  player.update(dt);

  // Continuous fire
  if (_firing) {
    _fireCooldown -= dt;
    if (_fireCooldown <= 0) {
      fireBullet();
      _fireCooldown = 1 / bullets.fireRate;
    }
  }

  bullets.update(dt);
  sparks.update(dt);
  climbDebug.update(player.walk, player.mesh.position);
  camCtrl.update();
  postFX.render(dt);
}

animate();

// ───────────────────────────────────────────────
// Leva GUI (React component mounted in its own root)
// ───────────────────────────────────────────────
const skel = player.skeleton;
const walk = player.walk;

// Bone label helpers
const LIMB_LABELS = ['Rear L', 'Rear R', 'Mid L', 'Mid R', 'Front L', 'Front R'];

function LevaPanel() {
  // ── Climb Debug Vis ──
  const debug = useControls('Debug', {
    'Climb Rays': { value: true },
    'Ray Logger': { value: false },
  });

  useEffect(() => {
    climbDebug.enabled = debug['Climb Rays'];
  }, [debug['Climb Rays']]);

  useEffect(() => {
    rayLogger.enabled = debug['Ray Logger'];
    if (!debug['Ray Logger']) rayLogger.hideAll();
  }, [debug['Ray Logger']]);

  // ── Camera ──
  const cameraOffset = useControls('Camera Offset', {
    X: { value: 0, min: -20, max: 20, step: 0.1 },
    Y: { value: 0.7, min: 0, max: 30, step: 0.1 },
    Z: { value: -4.1, min: -30, max: 0, step: 0.1 },
  });

  const cameraSettings = useControls('Camera', {
    Pan:  { value: 0, min: -90, max: 90, step: 0.5 },
    Tilt: { value: 0, min: -45, max: 90, step: 0.5 },
    FOV:  { value: 95, min: 20, max: 120, step: 1 },
    'Orbit Sensitivity': { value: 0.002, min: 0.0005, max: 0.01, step: 0.0005 },
  });

  useEffect(() => {
    camCtrl.offsetX = cameraOffset.X;
    camCtrl.offsetY = cameraOffset.Y;
    camCtrl.offsetZ = cameraOffset.Z;
  }, [cameraOffset.X, cameraOffset.Y, cameraOffset.Z]);

  useEffect(() => {
    camCtrl.pan = cameraSettings.Pan;
    camCtrl.tilt = cameraSettings.Tilt;
    player.mouseSensitivity = cameraSettings['Orbit Sensitivity'];
  }, [cameraSettings.Pan, cameraSettings.Tilt, cameraSettings['Orbit Sensitivity']]);

  useEffect(() => {
    camera.fov = cameraSettings.FOV;
    camera.updateProjectionMatrix();
  }, [cameraSettings.FOV]);

  const postPos = useControls('Camera Post-Offset (Position)', {
    X: { value: 2.6, min: -10, max: 10, step: 0.05 },
    Y: { value: -0.9, min: -10, max: 10, step: 0.05 },
    Z: { value: -0.1, min: -10, max: 10, step: 0.05 },
  });

  const postRot = useControls('Camera Post-Offset (Rotation)', {
    Pitch: { value: 0, min: -90, max: 90, step: 0.5 },
    Yaw:   { value: 0, min: -90, max: 90, step: 0.5 },
    Roll:  { value: 0, min: -45, max: 45, step: 0.5 },
  });

  useEffect(() => {
    camCtrl.postOffsetX = postPos.X;
    camCtrl.postOffsetY = postPos.Y;
    camCtrl.postOffsetZ = postPos.Z;
  }, [postPos.X, postPos.Y, postPos.Z]);

  useEffect(() => {
    camCtrl.postRotX = postRot.Pitch;
    camCtrl.postRotY = postRot.Yaw;
    camCtrl.postRotZ = postRot.Roll;
  }, [postRot.Pitch, postRot.Yaw, postRot.Roll]);

  // ── Gait ──
  const gait = useControls('Gait', {
    'Stride Length':    { value: 0.40, min: 0.1, max: 3.0, step: 0.05 },
    'Step Height':      { value: 0.30, min: 0.05, max: 1.5, step: 0.05 },
    'Step Duration':    { value: 0.05, min: 0.01, max: 1.0, step: 0.01 },
    'Phase Spread':     { value: 0.0, min: 0, max: 1, step: 0.01 },
    'Phase Randomness': { value: 0.1, min: 0, max: 1, step: 0.01 },
    'Idle Correction':  { value: 0.3,  min: 0.05, max: 2.0, step: 0.05 },
  });

  useEffect(() => {
    walk.strideLength            = gait['Stride Length'];
    walk.stepHeight              = gait['Step Height'];
    walk.stepDuration            = gait['Step Duration'];
    walk.bodySpeed               = walk.strideLength / walk.stepDuration;
    walk.phaseSpread             = gait['Phase Spread'];
    walk.phaseRandomness         = gait['Phase Randomness'];
    walk.idleCorrectionThreshold = gait['Idle Correction'];
  }, [gait['Stride Length'], gait['Step Height'], gait['Step Duration'], gait['Phase Spread'], gait['Phase Randomness'], gait['Idle Correction']]);

  // ── Spine bones ──
  const spines = useControls('Spine Bones', {
    'Spine 1': { value: 0.4, min: 0.1, max: 3.0, step: 0.05 },
    'Spine 2': { value: 0.4, min: 0.1, max: 3.0, step: 0.05 },
    'Spine 3': { value: 0.4, min: 0.1, max: 3.0, step: 0.05 },
    'Spine 4': { value: 0.4, min: 0.1, max: 3.0, step: 0.05 },
  });

  useEffect(() => {
    skel.spineLengths[0] = spines['Spine 1'];
    skel.spineLengths[1] = spines['Spine 2'];
    skel.spineLengths[2] = spines['Spine 3'];
    skel.spineLengths[3] = spines['Spine 4'];
    skel.build();
  }, [spines['Spine 1'], spines['Spine 2'], spines['Spine 3'], spines['Spine 4']]);

  // ── Gun limb ──
  const gunCtrl = useControls('Gun Limb', {
    'Upper Length': { value: 0.6, min: 0.1, max: 3.0, step: 0.05 },
    'Lower Length': { value: 0.5, min: 0.1, max: 3.0, step: 0.05 },
    'Upper Angle':  { value: 30, min: -90, max: 90, step: 1 },
  });

  useEffect(() => {
    skel.gunUpperLength = gunCtrl['Upper Length'];
    skel.gunLowerLength = gunCtrl['Lower Length'];
    skel.build();
  }, [gunCtrl['Upper Length'], gunCtrl['Lower Length']]);

  useEffect(() => {
    skel.gunUpperAngle = gunCtrl['Upper Angle'];
  }, [gunCtrl['Upper Angle']]);

  // ── Hip bones ──
  const hips = useControls('Hip Bones', {
    'Rear L Hip':  { value: 1.00, min: 0.1, max: 3.0, step: 0.05 },
    'Rear R Hip':  { value: 1.00, min: 0.1, max: 3.0, step: 0.05 },
    'Mid L Hip':   { value: 1.00, min: 0.1, max: 3.0, step: 0.05 },
    'Mid R Hip':   { value: 1.00, min: 0.1, max: 3.0, step: 0.05 },
    'Front L Hip': { value: 1.00, min: 0.1, max: 3.0, step: 0.05 },
    'Front R Hip': { value: 1.00, min: 0.1, max: 3.0, step: 0.05 },
  });

  useEffect(() => {
    skel.hipLengths[0] = hips['Rear L Hip'];
    skel.hipLengths[1] = hips['Rear R Hip'];
    skel.hipLengths[2] = hips['Mid L Hip'];
    skel.hipLengths[3] = hips['Mid R Hip'];
    skel.hipLengths[4] = hips['Front L Hip'];
    skel.hipLengths[5] = hips['Front R Hip'];
    skel.build();
  }, [hips['Rear L Hip'], hips['Rear R Hip'], hips['Mid L Hip'], hips['Mid R Hip'], hips['Front L Hip'], hips['Front R Hip']]);

  // ── Leg bones ──
  const legs = useControls('Leg Bones', {
    'Rear L Leg':  { value: 1.15, min: 0.1, max: 3.0, step: 0.05 },
    'Rear R Leg':  { value: 1.15, min: 0.1, max: 3.0, step: 0.05 },
    'Mid L Leg':   { value: 1.15, min: 0.1, max: 3.0, step: 0.05 },
    'Mid R Leg':   { value: 1.15, min: 0.1, max: 3.0, step: 0.05 },
    'Front L Leg': { value: 1.15, min: 0.1, max: 3.0, step: 0.05 },
    'Front R Leg': { value: 1.15, min: 0.1, max: 3.0, step: 0.05 },
  });

  useEffect(() => {
    skel.legLengths[0] = legs['Rear L Leg'];
    skel.legLengths[1] = legs['Rear R Leg'];
    skel.legLengths[2] = legs['Mid L Leg'];
    skel.legLengths[3] = legs['Mid R Leg'];
    skel.legLengths[4] = legs['Front L Leg'];
    skel.legLengths[5] = legs['Front R Leg'];
    skel.build();
  }, [legs['Rear L Leg'], legs['Rear R Leg'], legs['Mid L Leg'], legs['Mid R Leg'], legs['Front L Leg'], legs['Front R Leg']]);

  // ── Spine Height ──
  const body = useControls('Body', {
    'Spine Height': { value: 0.1, min: 0.01, max: 5.0, step: 0.05 },
  });

  useEffect(() => {
    skel.spineHeight = body['Spine Height'];
    skel.build();
  }, [body['Spine Height']]);

  // ── Skeleton GLB Export / Import ──
  useControls('Skeleton IO', {
    'Export GLB': button(() => {
      exportSkeletonGLB(skel);
    }),
    'Import Custom GLB': button(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.glb';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const meshMap = await loadCustomGeoGLB(file);
          skel.applyCustomGeo(meshMap);
          console.log('Custom geo loaded:', [...meshMap.keys()].join(', '));
        } catch (err) {
          console.error('Failed to load custom GLB:', err);
        }
      };
      input.click();
    }),
  });

  // ── Body Noise – Position ──
  const noisePos = useControls('Body Noise Position', {
    'Speed':  { value: 0.2,   min: 0,    max: 10,  step: 0.1 },
    'Min X':  { value:  0.02, min: -1.0, max: 1.0, step: 0.005 },
    'Max X':  { value:  0.61, min: -1.0, max: 1.0, step: 0.005 },
    'Min Y':  { value:  0.01, min: -1.0, max: 1.0, step: 0.005 },
    'Max Y':  { value:  0.57, min: -1.0, max: 1.0, step: 0.005 },
    'Min Z':  { value:  0.00, min: -1.0, max: 1.0, step: 0.005 },
    'Max Z':  { value:  0.04, min: -1.0, max: 1.0, step: 0.005 },
  });

  useEffect(() => {
    const bn = player.bodyNoise;
    bn.posSpeed = noisePos['Speed'];
    bn.posMinX  = noisePos['Min X'];
    bn.posMaxX  = noisePos['Max X'];
    bn.posMinY  = noisePos['Min Y'];
    bn.posMaxY  = noisePos['Max Y'];
    bn.posMinZ  = noisePos['Min Z'];
    bn.posMaxZ  = noisePos['Max Z'];
  }, [noisePos['Speed'], noisePos['Min X'], noisePos['Max X'], noisePos['Min Y'], noisePos['Max Y'], noisePos['Min Z'], noisePos['Max Z']]);

  // ── Body Noise – Rotation ──
  const noiseRot = useControls('Body Noise Rotation', {
    'Speed':  { value: 0.2,   min: 0,    max: 10,  step: 0.1 },
    'Min X':  { value:  0.00, min: -1.0, max: 1.0, step: 0.005 },
    'Max X':  { value:  0.38, min: -1.0, max: 1.0, step: 0.005 },
    'Min Y':  { value:  0.02, min: -1.0, max: 1.0, step: 0.005 },
    'Max Y':  { value:  0.41, min: -1.0, max: 1.0, step: 0.005 },
    'Min Z':  { value:  0.03, min: -1.0, max: 1.0, step: 0.005 },
    'Max Z':  { value:  0.38, min: -1.0, max: 1.0, step: 0.005 },
  });

  useEffect(() => {
    const bn = player.bodyNoise;
    bn.rotSpeed = noiseRot['Speed'];
    bn.rotMinX  = noiseRot['Min X'];
    bn.rotMaxX  = noiseRot['Max X'];
    bn.rotMinY  = noiseRot['Min Y'];
    bn.rotMaxY  = noiseRot['Max Y'];
    bn.rotMinZ  = noiseRot['Min Z'];
    bn.rotMaxZ  = noiseRot['Max Z'];
  }, [noiseRot['Speed'], noiseRot['Min X'], noiseRot['Max X'], noiseRot['Min Y'], noiseRot['Max Y'], noiseRot['Min Z'], noiseRot['Max Z']]);

  // ── Body Noise – Movement Bias ──
  const noiseBias = useControls('Body Noise Movement', {
    'Fwd Tilt':        { value:  0.14, min: 0,    max: 1.0, step: 0.01 },
    'Bwd Tilt':        { value:  0.08, min: -1.0, max: 1.0, step: 0.01 },
    'Move Damping':    { value:  1.0,  min: 0,    max: 1.0, step: 0.05 },
    'Lateral Damping': { value:  1.0,  min: 0,    max: 1.0, step: 0.05 },
  });

  useEffect(() => {
    const bn = player.bodyNoise;
    bn.fwdTilt        = noiseBias['Fwd Tilt'];
    bn.bwdTilt        = noiseBias['Bwd Tilt'];
    bn.moveDamping    = noiseBias['Move Damping'];
    bn.lateralDamping = noiseBias['Lateral Damping'];
  }, [noiseBias['Fwd Tilt'], noiseBias['Bwd Tilt'], noiseBias['Move Damping'], noiseBias['Lateral Damping']]);

  // ── Sun ──
  const sunCtrl = useControls('Sun', {
    Height: { value: 60, min: 5, max: 90, step: 1 },
    Angle:  { value: 45, min: 0, max: 360, step: 1 },
    Intensity: { value: 1.0, min: 0, max: 3, step: 0.05 },
  });

  useEffect(() => {
    const dist = 25;
    const heightRad = (sunCtrl.Height * Math.PI) / 180;
    const angleRad = (sunCtrl.Angle * Math.PI) / 180;
    const y = Math.sin(heightRad) * dist;
    const horiz = Math.cos(heightRad) * dist;
    const x = Math.cos(angleRad) * horiz;
    const z = Math.sin(angleRad) * horiz;
    dirLight.position.set(x, y, z);
    dirLight.intensity = sunCtrl.Intensity;
  }, [sunCtrl.Height, sunCtrl.Angle, sunCtrl.Intensity]);

  // ── Cel Shading ──
  const [rampStops, setRampStops] = useState(defaultRampStops());

  const celCtrl = useControls('Cel Shading', {
    Enabled:   { value: true },
    Intensity: { value: 1.0, min: 0, max: 1, step: 0.05 },
    Levels:    { value: 4, min: 0, max: 20, step: 1 },
    'Add Level': button(() => {
      // Increase the levels count by 1
      const cur = postFX.celPass.levels;
      postFX.celPass.levels = cur + 1;
    }),
  });

  useEffect(() => {
    postFX.celPass.enabled = celCtrl.Enabled;
    postFX.celPass.intensity = celCtrl.Intensity;
    postFX.celPass.levels = celCtrl.Levels;
  }, [celCtrl.Enabled, celCtrl.Intensity, celCtrl.Levels]);

  const onRampChange = useCallback((newStops) => {
    setRampStops(newStops);
    postFX.celPass.setStops(newStops);
  }, []);

  // ── Line Art ──
  const lineCtrl = useControls('Line Art', {
    Enabled:          { value: true },
    Intensity:        { value: 1.0,  min: 0, max: 1, step: 0.05 },
    Thickness:        { value: 1.0,  min: 0.5, max: 5, step: 0.25 },
    'Depth Threshold':  { value: 0.05, min: 0.001, max: 0.5, step: 0.005 },
    'Normal Threshold': { value: 1.0,  min: 0.05, max: 2.0, step: 0.05 },
    'Shadow Threshold': { value: 0.15, min: 0.01, max: 1.0, step: 0.01 },
    'Line Color':       { value: '#000000' },
  });

  useEffect(() => {
    postFX.outlinePass.enabled = lineCtrl.Enabled;
    postFX.outlinePass.intensity = lineCtrl.Intensity;
    postFX.outlinePass.thickness = lineCtrl.Thickness;
    postFX.outlinePass.depthThreshold = lineCtrl['Depth Threshold'];
    postFX.outlinePass.normalThreshold = lineCtrl['Normal Threshold'];
    postFX.outlinePass.shadowThreshold = lineCtrl['Shadow Threshold'];
    postFX.outlinePass.lineColor = lineCtrl['Line Color'];
  }, [lineCtrl.Enabled, lineCtrl.Intensity, lineCtrl.Thickness, lineCtrl['Depth Threshold'], lineCtrl['Normal Threshold'], lineCtrl['Shadow Threshold'], lineCtrl['Line Color']]);

  // ── Jump ──
  const jumpCtrl = useControls('Jump', {
    'Strength':      { value: 39.0,  min: 0.5, max: 100.0, step: 0.5 },
    'Min Strength':  { value: 13.0,   min: 0.5, max: 50.0,  step: 0.5 },
    'Charge Rate':   { value: 117.0,  min: 5.0, max: 200.0, step: 1.0 },
    'Gravity':       { value: 52.8,  min: 1.0, max: 100.0, step: 0.5 },
    'Terminal Vel':  { value: 20.0,  min: 5.0, max: 60.0,  step: 1.0 },
    'Air Steer':     { value: 35.0,  min: 0.0, max: 100.0, step: 0.5 },
    'Latch Radius':  { value: 2.0,   min: 0.5, max: 6.0,   step: 0.25 },
  });

  useEffect(() => {
    player.jumpStrength    = jumpCtrl['Strength'];
    player.jumpMinStrength = Math.min(jumpCtrl['Min Strength'], jumpCtrl['Strength']);
    player.jumpChargeRate  = jumpCtrl['Charge Rate'];
    player.jumpGravity     = jumpCtrl['Gravity'];
    player.jumpTerminalVel = jumpCtrl['Terminal Vel'];
    player.jumpAirSteer    = jumpCtrl['Air Steer'];
    player.jumpLatchRadius = jumpCtrl['Latch Radius'];
  }, [jumpCtrl['Strength'], jumpCtrl['Min Strength'], jumpCtrl['Charge Rate'], jumpCtrl['Gravity'], jumpCtrl['Terminal Vel'], jumpCtrl['Air Steer'], jumpCtrl['Latch Radius']]);

  // ── Bullets ──
  const bulletCtrl = useControls('Bullets', {
    'Fire Rate':    { value: 18,   min: 1,     max: 30,  step: 1 },
    'Spawn Offset': { value: 1.0,  min: 0,     max: 5.0, step: 0.1 },
    Speed:          { value: 60,   min: 10,    max: 200, step: 5 },
    Lifetime:       { value: 0.60, min: 0.1,   max: 3.0, step: 0.05 },
    Width:          { value: 0.04, min: 0.005, max: 0.3, step: 0.005 },
    Length:         { value: 0.1,  min: 0.1,   max: 5.0, step: 0.1 },
    Color:          { value: '#747474' },
  });

  useEffect(() => {
    bullets.fireRate    = bulletCtrl['Fire Rate'];
    bullets.spawnOffset = bulletCtrl['Spawn Offset'];
    bullets.speed       = bulletCtrl.Speed;
    bullets.lifetime    = bulletCtrl.Lifetime;
    bullets.width       = bulletCtrl.Width;
    bullets.length      = bulletCtrl.Length;
    bullets.color.set(bulletCtrl.Color);
  }, [bulletCtrl['Fire Rate'], bulletCtrl['Spawn Offset'], bulletCtrl.Speed, bulletCtrl.Lifetime, bulletCtrl.Width, bulletCtrl.Length, bulletCtrl.Color]);

  // ── Sparks ──
  const sparkCtrl = useControls('Sparks', {
    Count:    { value: 25,   min: 1,   max: 40,   step: 1 },
    Speed:    { value: 19.0, min: 1,   max: 30,   step: 0.5 },
    Gravity:  { value: 29,   min: 0,   max: 60,   step: 1 },
    Lifetime: { value: 1.35, min: 0.05, max: 2.0, step: 0.05 },
    Size:     { value: 0.18, min: 0.01, max: 0.3, step: 0.01 },
    Color:    { value: '#7b7b7b' },
  });

  useEffect(() => {
    sparks.sparksPerHit = sparkCtrl.Count;
    sparks.speed        = sparkCtrl.Speed;
    sparks.gravity      = sparkCtrl.Gravity;
    sparks.lifetime     = sparkCtrl.Lifetime;
    sparks.size         = sparkCtrl.Size;
    sparks.color.set(sparkCtrl.Color);
  }, [sparkCtrl.Count, sparkCtrl.Speed, sparkCtrl.Gravity, sparkCtrl.Lifetime, sparkCtrl.Size, sparkCtrl.Color]);

  // ── Crosshair ──
  const crosshair = useControls('Crosshair', {
    Show:       { value: true },
    Width:      { value: 80, min: 4, max: 80, step: 1 },
    Height:     { value: 57, min: 4, max: 80, step: 1 },
    Stroke:     { value: 0.5, min: 0.5, max: 5, step: 0.25 },
    Color:      { value: '#ffffff' },
    Opacity:    { value: 0.50, min: 0, max: 1, step: 0.05 },
    'Tick Radius':  { value: 6, min: 0, max: 60, step: 1 },
    'Tick Length':  { value: 6, min: 1, max: 30, step: 1 },
    'Tick Offset':  { value: 11, min: -30, max: 30, step: 1 },
    'Tick Stroke':  { value: 0.5, min: 0.5, max: 5, step: 0.25 },
  });

  const chShow   = crosshair.Show;
  const chW      = crosshair.Width;
  const chH      = crosshair.Height;
  const chStroke = crosshair.Stroke;
  const chColor  = crosshair.Color;
  const chAlpha  = crosshair.Opacity;
  const tickRad  = crosshair['Tick Radius'];
  const tickLen  = crosshair['Tick Length'];
  const tickOff  = crosshair['Tick Offset'];
  const tickStk  = crosshair['Tick Stroke'];

  return (
    <>
      <RayDebugOverlay logger={rayLogger} />
      {celCtrl.Enabled && (
        <div style={{
          position: 'fixed',
          top: 10,
          right: 310,
          width: 250,
          zIndex: 1000,
        }}>
          <ColorRampEditor stops={rampStops} onChange={onRampChange} />
        </div>
      )}
      {chShow && (() => {
        // SVG centered on the rect's center.
        // Box uses chW/chH. Ticks use tickRad for their distance from center.
        // tickOff shifts tick start inward (+) or outward (-).
        const hw = chW / 2;
        const hh = chH / 2;
        const maxExtent = Math.max(hw, hh, tickRad - tickOff + tickLen);
        const pad = maxExtent + tickStk;
        const svgW = pad * 2;
        const svgH = pad * 2;
        const cx = pad;
        const cy = pad;
        return (
          <svg
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              zIndex: 999,
              opacity: chAlpha,
            }}
            width={svgW}
            height={svgH}
            viewBox={`0 0 ${svgW} ${svgH}`}
          >
            {/* Rectangle */}
            <rect
              x={cx - hw}
              y={cy - hh}
              width={chW}
              height={chH}
              fill="none"
              stroke={chColor}
              strokeWidth={chStroke}
            />
            {/* Top tick */}
            <line
              x1={cx} y1={cy - tickRad + tickOff}
              x2={cx} y2={cy - tickRad + tickOff + tickLen}
              stroke={chColor} strokeWidth={tickStk}
            />
            {/* Bottom tick */}
            <line
              x1={cx} y1={cy + tickRad - tickOff}
              x2={cx} y2={cy + tickRad - tickOff - tickLen}
              stroke={chColor} strokeWidth={tickStk}
            />
            {/* Left tick */}
            <line
              x1={cx - tickRad + tickOff} y1={cy}
              x2={cx - tickRad + tickOff + tickLen} y2={cy}
              stroke={chColor} strokeWidth={tickStk}
            />
            {/* Right tick */}
            <line
              x1={cx + tickRad - tickOff} y1={cy}
              x2={cx + tickRad - tickOff - tickLen} y2={cy}
              stroke={chColor} strokeWidth={tickStk}
            />
          </svg>
        );
      })()}
    </>
  );
}

const guiRoot = document.createElement('div');
guiRoot.id = 'leva-root';
document.body.appendChild(guiRoot);
createRoot(guiRoot).render(<LevaPanel />);
