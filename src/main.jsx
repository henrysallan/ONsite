import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Patch Three.js so every BufferGeometry can build a BVH and every Mesh raycasts through it
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useControls, button } from 'leva';

import { PlayerController, setRendererDomElement } from './PlayerController.js';
import { CameraController } from './CameraController.js';
import { ClimbDebugVis } from './ClimbDebugVis.js';
import { RayDebugLogger, setRayDebugLogger } from './RayDebugLogger.js';
import { RayDebugOverlay } from './DebugOverlay.jsx';
import { exportSkeletonGLB, loadCustomGeoGLB } from './SkeletonIO.js';

// ───────────────────────────────────────────────
// Three.js setup (module-level singletons)
// ───────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Let the player controller know which element has pointer lock
setRendererDomElement(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 40, 120);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);

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
  new THREE.MeshStandardMaterial({ color: 0x4ade80, roughness: 0.9 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(200, 80, 0x228833, 0x228833);
grid.position.y = 0.01;
grid.material.opacity = 0.3;
grid.material.transparent = true;
scene.add(grid);

// ── Terrain: ramps and hills ──
const terrainMat = new THREE.MeshStandardMaterial({ color: 0x8b7355, roughness: 0.85 });
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
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x6b8e23, roughness: 0.9 });
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
const wallMat = new THREE.MeshStandardMaterial({ color: 0x7c6f64, roughness: 0.75 });

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
        // Ensure raycasts hit from both sides — even thick manifold meshes
        // can have grazing-angle misses with FrontSide-only raycasting
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => { m.side = THREE.DoubleSide; });
          } else {
            child.material.side = THREE.DoubleSide;
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
const climbDebug = new ClimbDebugVis(scene);
const rayLogger = new RayDebugLogger(scene);
setRayDebugLogger(rayLogger);

// ── Pointer lock on canvas click ──
renderer.domElement.addEventListener('click', () => {
  renderer.domElement.requestPointerLock();
});

// ── Resize ──
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Game loop ──
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  rayLogger.beginFrame(dt);
  player.update(dt);
  climbDebug.update(player.walk, player.mesh.position);
  camCtrl.update();
  renderer.render(scene, camera);
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
    Y: { value: 3, min: 0, max: 30, step: 0.1 },
    Z: { value: -6, min: -30, max: 0, step: 0.1 },
  });

  const cameraSettings = useControls('Camera', {
    Pan:  { value: 0, min: -90, max: 90, step: 0.5 },
    Tilt: { value: 0, min: -45, max: 90, step: 0.5 },
    FOV:  { value: 60, min: 20, max: 120, step: 1 },
  });

  useEffect(() => {
    camCtrl.offsetX = cameraOffset.X;
    camCtrl.offsetY = cameraOffset.Y;
    camCtrl.offsetZ = cameraOffset.Z;
  }, [cameraOffset.X, cameraOffset.Y, cameraOffset.Z]);

  useEffect(() => {
    camCtrl.pan = cameraSettings.Pan;
    camCtrl.tilt = cameraSettings.Tilt;
  }, [cameraSettings.Pan, cameraSettings.Tilt]);

  useEffect(() => {
    camera.fov = cameraSettings.FOV;
    camera.updateProjectionMatrix();
  }, [cameraSettings.FOV]);

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
    'Spine 1 (rear)':  { value: 0.8, min: 0.1, max: 3.0, step: 0.05 },
    'Spine 2 (front)': { value: 0.8, min: 0.1, max: 3.0, step: 0.05 },
  });

  useEffect(() => {
    skel.spineLengths[0] = spines['Spine 1 (rear)'];
    skel.spineLengths[1] = spines['Spine 2 (front)'];
    skel.build();
  }, [spines['Spine 1 (rear)'], spines['Spine 2 (front)']]);

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

  // ── Jump ──
  const jumpCtrl = useControls('Jump', {
    'Strength':     { value: 28.0,  min: 0.5, max: 100.0, step: 0.5 },
    'Gravity':      { value: 52.8,  min: 1.0, max: 100.0, step: 0.5 },
    'Terminal Vel': { value: 20.0,  min: 5.0, max: 60.0,  step: 1.0 },
    'Air Steer':    { value: 35.0,  min: 0.0, max: 100.0, step: 0.5 },
    'Latch Radius': { value: 2.0,  min: 0.5, max: 6.0,  step: 0.25 },
  });

  useEffect(() => {
    player.jumpStrength    = jumpCtrl['Strength'];
    player.jumpGravity     = jumpCtrl['Gravity'];
    player.jumpTerminalVel = jumpCtrl['Terminal Vel'];
    player.jumpAirSteer    = jumpCtrl['Air Steer'];
    player.jumpLatchRadius = jumpCtrl['Latch Radius'];
  }, [jumpCtrl['Strength'], jumpCtrl['Gravity'], jumpCtrl['Terminal Vel'], jumpCtrl['Air Steer'], jumpCtrl['Latch Radius']]);

  return <RayDebugOverlay logger={rayLogger} />;
}

const guiRoot = document.createElement('div');
guiRoot.id = 'leva-root';
document.body.appendChild(guiRoot);
createRoot(guiRoot).render(<LevaPanel />);
