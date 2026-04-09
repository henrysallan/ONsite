import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

// Patch Three.js so every BufferGeometry can build a BVH and every Mesh raycasts through it
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Leva, useControls, button } from 'leva';

import { PostProcessing } from './PostProcessing.js';
import { CelMaterial } from './CelMaterial.js';
import { PlayerController, setRendererDomElement } from './PlayerController.js';
import { CameraController } from './CameraController.js';
import { ClimbDebugVis } from './ClimbDebugVis.js';
import { RayDebugLogger, setRayDebugLogger } from './RayDebugLogger.js';
import { RayDebugOverlay } from './DebugOverlay.jsx';
import { exportSkeletonGLB, loadCustomGeoGLB, loadCustomGeoFromURL } from './SkeletonIO.js';
import { BulletSystem } from './BulletSystem.js';
import { SparkSystem } from './SparkSystem.js';
import { MuzzleFlash } from './MuzzleFlash.js';
import { DecalSystem } from './DecalSystem.js';
import { TargetSystem } from './TargetSystem.js';

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
scene.background = new THREE.Color('#0019ff');
scene.fog = new THREE.Fog('#0019ff', 40, 120);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);

// Allow camera to see layer 1 (muzzle flash cards)
camera.layers.enable(1);

// ── Post-processing pipeline ──
const postFX = new PostProcessing(renderer, scene, camera);

// ── Per-category Cel Materials ──
const celMats = {
  ground:      new CelMaterial({ shadow: '#000048', mid: '#0000ff', highlight: '#0000ff', threshold1: 0.07, threshold2: 0.60 }),
  environment: new CelMaterial({ shadow: '#000045', mid: '#0000ff', highlight: '#3d99ff', threshold1: 0.00, threshold2: 0.29 }),
  character:   new CelMaterial({ shadow: '#0000ff', mid: '#ffffff', highlight: '#ffffff', threshold1: 0.30, threshold2: 0.60 }),
};

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
  celMats.ground
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
const terrainMat = celMats.environment;
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
  const hill = new THREE.Mesh(geo, celMats.environment);
  hill.rotation.x = -Math.PI / 2;
  hill.position.set(12, 0, -12);
  hill.castShadow = true;
  hill.receiveShadow = true;
  scene.add(hill);
  groundMeshes.push(hill);
}

// Stepped platform – two flat boxes
{
  const step1 = new THREE.Mesh(new THREE.BoxGeometry(4, 0.5, 4), terrainMat);
  step1.geometry.computeBoundsTree();
  step1.position.set(-6, 0.25, 8);
  step1.castShadow = true;
  step1.receiveShadow = true;
  scene.add(step1);
  groundMeshes.push(step1);

  const step2 = new THREE.Mesh(new THREE.BoxGeometry(3, 1.0, 3), terrainMat);
  step2.geometry.computeBoundsTree();
  step2.position.set(-6, 0.5, 8);
  step2.castShadow = true;
  step2.receiveShadow = true;
  scene.add(step2);
  groundMeshes.push(step2);
}

// ── Climbable walls ──
const wallMat = celMats.environment;

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
  const w1 = new THREE.Mesh(new THREE.BoxGeometry(2, 6, 8), wallMat);
  w1.geometry.computeBoundsTree();
  w1.position.set(-14, 3, 4);
  w1.castShadow = true;
  w1.receiveShadow = true;
  w1.userData.climbable = true;
  scene.add(w1);
  groundMeshes.push(w1);

  const w2 = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 2), wallMat);
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
  const wall = new THREE.Mesh(geo, wallMat);
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
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('/draco/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  loader.load('/meshes/testblock.glb', (gltf) => {
    const model = gltf.scene;
    model.position.set(0, 0, 5);
    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.userData.climbable = true;
        // Use environment cel material
        child.material = celMats.environment;
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
player.skeleton.setMaterial(celMats.character);
const camCtrl = new CameraController(camera, player);
camCtrl.setGroundMeshes([ground]);
const climbDebug = new ClimbDebugVis(scene);
const rayLogger = new RayDebugLogger(scene);
setRayDebugLogger(rayLogger);

// ── Bullet system ──
const sparks = new SparkSystem(scene);
const bullets = new BulletSystem(scene, groundMeshes);
bullets.sparks = sparks;
const decals = new DecalSystem(scene);
bullets.decals = decals;
const muzzleFlash = new MuzzleFlash(scene);

// ── Target system ──
const targetMat = new CelMaterial({
  shadow: '#003300', mid: '#00cc44', highlight: '#44ff88',
  threshold1: 0.20, threshold2: 0.55,
});
const targets = new TargetSystem(scene, targetMat);
bullets.targetSystem = targets;

// Scatter targets around the map
{
  const targetPositions = [];
  const count = 12;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const dist = 12 + Math.random() * 30;
    targetPositions.push(new THREE.Vector3(
      Math.cos(angle) * dist,
      1.0 + Math.random() * 2.0, // floating height
      Math.sin(angle) * dist,
    ));
  }
  targets.spawn(targetPositions);
}
const _aimRaycaster = new THREE.Raycaster();
const _aimDir = new THREE.Vector3();
const _gunTipW = new THREE.Vector3();
const _aimPoint = new THREE.Vector3();
const _screenCenter = new THREE.Vector2(0, 0); // NDC center

// ── Continuous fire state ──
let _firing = false;
let _fireCooldown = 0;

// ── Gun heat system ──
let _gunHeat = 1.0;          // 1 = full charge, 0 = empty

// ── HUD parallax ──
let _hudOffsetX = 0;
let _hudOffsetY = 0;
let _hudParallaxAmount = 12; // px per unit/s of camera velocity
let _hudParallaxSmooth = 6;  // lerp speed (higher = snappier return)
let _hudMaxPx = 8;           // max pixel displacement
const _prevCamPos = new THREE.Vector3();
let _hudParallaxInited = false;

// ── Airborne camera wobble ──
let _wobbleTime = 0;
let _wobbleMagXY = 0.03;    // translation magnitude (world units)
let _wobbleMagRot = 0.15;   // rotation magnitude (degrees)
let _wobbleSpeed = 2.5;     // base frequency
let _wobbleActive = 0;      // smooth blend 0→1

// ── Walk camera wobble ──
let _walkWobbleTime = 0;
let _walkWobbleMagXY = 0.045;   // translation magnitude (world units)
let _walkWobbleMagRot = 0.08;   // rotation magnitude (degrees)
let _walkWobbleSpeed = 9.75;     // base frequency
let _walkWobbleActive = 0;      // smooth blend 0→1

// ── Shoot camera wobble ──
let _shootWobbleTime = 0;
let _shootWobbleMagXY = 0.02;   // translation magnitude (world units)
let _shootWobbleMagRot = 0.27;  // rotation magnitude (degrees)
let _shootWobbleSpeed = 14.5;    // base frequency (faster, jittery)
let _shootWobbleActive = 0;     // smooth blend 0→1

// ── Shoot camera lerp (offset Z + FOV) ──
let _shootOffsetZ = -4.6;       // target offset Z while shooting
let _shootFOV = 67;             // target FOV while shooting
let _shootLerpSpeed = 6.0;      // lerp speed for shoot camera transition
let _currentShootBlend = 0;     // 0 = idle, 1 = fully in shoot mode

// ── FOV lerp (stationary / walking / jumping) ──
let _fovStationary = 80;        // FOV when idle
let _fovWalking = 94;           // FOV when walking
let _fovJumping = 105;          // FOV when airborne
let _fovLerpSpeed = 4.0;        // lerp speed for FOV transitions
let _currentFovBlend = 0;       // 0 = stationary, 1 = walking
let _currentJumpFovBlend = 0;   // 0 = grounded, 1 = airborne

// ── Shoot vignette blur ──
let _vignetteBlurBlend = 0;     // smooth 0→1 for edge blur
let _vignetteBlurLerpSpeed = 4.0;
let _vignetteBlurMaxIntensity = 1.0;

// ── Aim mode (right-click) ──
let _aiming = false;
let _aimFOV = 47;               // FOV when aiming
let _aimLerpSpeed = 10.0;       // lerp speed into/out of aim
let _currentAimBlend = 0;       // 0 = hip, 1 = fully aimed
let _aimCrosshairScale = 0.4;   // crosshair scale while aiming

// ── Sprint camera effects ──
let _sprintFOV = 115;            // target FOV when sprinting
let _sprintWobbleTime = 0;
let _sprintWobbleMagXY = 0.08;   // heavy translation shake
let _sprintWobbleMagRot = 0.35;  // heavy rotation shake
let _sprintWobbleSpeed = 13.0;   // frequency

// Reusable temporaries for per-frame camera work (avoid GC pressure)
const _tmpRight = new THREE.Vector3();
const _tmpUp = new THREE.Vector3();

let _gunOverheated = false;
let _gunDrainRate = 0.6;     // fraction of bar drained per second while firing
let _gunRechargeTime = 2.0;  // seconds to recharge from 0 → 1
let _gunRechargeDelay = 0.4; // seconds after releasing fire before recharge starts
let _gunRechargeWait = 0;    // current wait timer

// ── Background music ──
const _bgMusic = new Audio('/sound/darkruins.mp3');
_bgMusic.loop = true;
_bgMusic.volume = 0.3;
let _bgMusicStarted = false;

// ── Gun sound ──
const _gunAudio = new Audio('/sound/gun.mp3');
_gunAudio.loop = true;
_gunAudio.volume = 0.5;
let _gunSoundPlaying = false;

function _startGunSound() {
  if (_gunSoundPlaying) return;
  _gunAudio.currentTime = 0;
  _gunAudio.play().catch(() => {}); // catch autoplay rejection
  _gunSoundPlaying = true;
}
function _stopGunSound() {
  if (!_gunSoundPlaying) return;
  _gunAudio.pause();
  _gunSoundPlaying = false;
}

function fireBullet() {
  // 1. Raycast from the FINAL camera (with post-offset) through screen centre.
  //    This matches what the crosshair is pointing at.
  //    Force matrix recompose so position/quaternion changes from camCtrl.update()
  //    are baked into matrixWorld before setFromCamera reads it.
  camera.updateMatrix();
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  _aimRaycaster.setFromCamera(_screenCenter, camera);
  _aimRaycaster.far = 500;

  // Test against BOTH environment meshes and target meshes so the aim point
  // lands on whatever the crosshair is actually pointing at.
  const aimObjects = [...groundMeshes, ...targets._hitMeshes];
  const hits = _aimRaycaster.intersectObjects(aimObjects, false);
  if (hits.length > 0) {
    _aimPoint.copy(hits[0].point);
  } else {
    _aimPoint.copy(_aimRaycaster.ray.direction).multiplyScalar(200).add(_aimRaycaster.ray.origin);
  }

  // Debug: log aim ray (camera → aim point)
  const aimOrigin = _aimRaycaster.ray.origin.clone();
  const aimDirection = _aimRaycaster.ray.direction.clone();
  const aimHit = hits.length > 0;
  const aimHitDist = aimHit ? hits[0].distance : null;
  rayLogger.log('aim_ray', aimOrigin, aimDirection, 500, aimHit,
    aimHit ? hits[0].point : null, null, aimHit ? hits[0].object.name : null, aimHitDist);

  // 2. Get gun tip in world space
  player.skeleton.group.updateMatrixWorld(true);
  player.skeleton.getGunTipWorld(_gunTipW);

  // 3. Direction from gun tip toward aim point
  _aimDir.subVectors(_aimPoint, _gunTipW).normalize();

  // Debug: log bullet path (gun tip → aim point)
  const bulletDist = _gunTipW.distanceTo(_aimPoint);
  rayLogger.log('bullet_path', _gunTipW.clone(), _aimDir.clone(), bulletDist, aimHit,
    _aimPoint.clone(), null, null, bulletDist);

  // 4. Fire!
  bullets.fire(_gunTipW, _aimDir);
  muzzleFlash.fire();
}

renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (document.pointerLockElement !== renderer.domElement) return;
  _firing = true;
  _fireCooldown = 0; // fire immediately on first click
  if (!_gunOverheated) _startGunSound();
});
renderer.domElement.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  _firing = false;
  _stopGunSound();
});

// ── Aim (right-click hold) ──
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button !== 2) return;
  if (document.pointerLockElement !== renderer.domElement) return;
  _aiming = true;
});
renderer.domElement.addEventListener('mouseup', (e) => {
  if (e.button !== 2) return;
  _aiming = false;
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== renderer.domElement) {
    _firing = false;
    _aiming = false;
    _stopGunSound();
    _showPauseModal();
  } else {
    _hidePauseModal();
  }
});

// ── Pointer lock on canvas click ──
renderer.domElement.addEventListener('click', () => {
  renderer.domElement.requestPointerLock();
  if (!_bgMusicStarted) {
    _bgMusic.play().catch(() => {});
    _bgMusicStarted = true;
  }
});

// ── Resize ──
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  postFX.setSize(window.innerWidth, window.innerHeight);
});

// ── Pause modal ──
const _pauseOverlay = document.createElement('div');
Object.assign(_pauseOverlay.style, {
  position: 'fixed', inset: '0',
  display: 'none', alignItems: 'center', justifyContent: 'center',
  zIndex: '999', background: 'rgba(0,0,0,0.35)',
  fontFamily: "'RestartSoft', sans-serif",
});
document.body.appendChild(_pauseOverlay);

// wrapper to hold both circles in the same stacking spot
const _pauseWrapper = document.createElement('div');
Object.assign(_pauseWrapper.style, {
  position: 'relative', width: '260px', height: '260px',
});
_pauseOverlay.appendChild(_pauseWrapper);

// shadow circle (behind, offset down-left)
const _pauseShadow = document.createElement('div');
Object.assign(_pauseShadow.style, {
  position: 'absolute', top: '8px', left: '-8px',
  width: '260px', height: '260px', borderRadius: '50%',
  background: '#fff', border: '1px solid #000',
  pointerEvents: 'none',
});
_pauseWrapper.appendChild(_pauseShadow);

const _pauseCircle = document.createElement('div');
Object.assign(_pauseCircle.style, {
  position: 'absolute', top: '0', left: '0',
  width: '260px', height: '260px', borderRadius: '50%',
  background: '#fff', border: '1px solid #000',
  display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', gap: '18px',
});
_pauseWrapper.appendChild(_pauseCircle);

const _pauseText = document.createElement('span');
_pauseText.textContent = 'Game Paused';
Object.assign(_pauseText.style, {
  fontSize: '25px', color: '#000', letterSpacing: '1px',
  textTransform: 'none', userSelect: 'none',
});
_pauseCircle.appendChild(_pauseText);

const _unpauseBtn = document.createElement('button');
_unpauseBtn.textContent = 'Unpause';
Object.assign(_unpauseBtn.style, {
  padding: '6px 20px', fontSize: '20px',
  fontFamily: "'RestartSoft', sans-serif", background: '#fff',
  border: '1px solid #000', borderRadius: '0',
  cursor: 'pointer', letterSpacing: '1px',
  textTransform: 'none',
});
_unpauseBtn.addEventListener('mouseenter', () => {
  _unpauseBtn.style.background = '#000';
  _unpauseBtn.style.color = '#fff';
});
_unpauseBtn.addEventListener('mouseleave', () => {
  _unpauseBtn.style.background = '#fff';
  _unpauseBtn.style.color = '#000';
});
_unpauseBtn.addEventListener('click', () => {
  _pauseOverlay.style.display = 'none';
  renderer.domElement.requestPointerLock();
});
_pauseCircle.appendChild(_unpauseBtn);

function _showPauseModal()  { _pauseOverlay.style.display = 'flex'; }
function _hidePauseModal()  { _pauseOverlay.style.display = 'none'; }

// ── Game loop ──
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  rayLogger.beginFrame(dt);

  // ── Gun aim tracking: feed aim direction to skeleton before update ──
  // We intentionally do NOT call updateMatrixWorld here — that would bake
  // stale skeleton group transforms and prevent player.update() from
  // resetting rotation during jumps. The gun tip from last frame is close
  // enough for a smooth aim direction.
  {
    const isShooting = _firing && !_gunOverheated;
    if (isShooting) {
      _aimRaycaster.setFromCamera(_screenCenter, camera);
      const hits = _aimRaycaster.intersectObjects(groundMeshes, false);
      if (hits.length > 0) {
        _aimPoint.copy(hits[0].point);
      } else {
        _aimPoint.copy(_aimRaycaster.ray.direction).multiplyScalar(200).add(_aimRaycaster.ray.origin);
      }
      // Use last-frame gun tip (already computed after previous player.update)
      _aimDir.subVectors(_aimPoint, _gunTipW).normalize();
      player.skeleton.setGunAim(_aimDir, dt);
    } else {
      player.skeleton.setGunAim(null, dt);
    }
  }

  player.update(dt);

  // Sync light direction to bullet shader
  bullets._material.uniforms.uLightDir.value.copy(dirLight.position).normalize();

  // Muzzle flash: update position to gun tip every frame
  player.skeleton.group.updateMatrixWorld(true);
  player.skeleton.getGunTipWorld(_gunTipW);
  // Barrel direction: from gun elbow joint toward tip (in world space)
  const _elbowW = player.skeleton.gunData.elbowJoint.position.clone();
  player.skeleton.group.localToWorld(_elbowW);
  _aimDir.subVectors(_gunTipW, _elbowW).normalize();
  muzzleFlash.update(dt, _gunTipW, _aimDir);

  climbDebug.update(player.walk, player.mesh.position);

  // FOV lerp: stationary ↔ walking ↔ jumping ↔ sprinting (must run before camCtrl.update + fireBullet)
  let baseFOV;
  {
    const isWalking = (player._jump == null && !player._landing &&
      player.walk.inputDir.lengthSq() > 0.001) ? 1 : 0;
    _currentFovBlend += (isWalking - _currentFovBlend) * (1 - Math.exp(-_fovLerpSpeed * dt));
    if (!isWalking && _currentFovBlend < 0.001) _currentFovBlend = 0;
    if (isWalking && _currentFovBlend > 0.999) _currentFovBlend = 1;

    const isAirborne = player._jump != null ? 1 : 0;
    const jumpBlendSpeed = isAirborne ? 3.0 : 6.0;
    _currentJumpFovBlend += (isAirborne - _currentJumpFovBlend) * (1 - Math.exp(-jumpBlendSpeed * dt));
    if (!isAirborne && _currentJumpFovBlend < 0.001) _currentJumpFovBlend = 0;

    // Sprint blend (read from player controller's smoothed value)
    const sprintBlend = player._currentSprintBlend;
    const walkFov = _fovWalking + (_sprintFOV - _fovWalking) * sprintBlend;
    baseFOV = _fovStationary + (walkFov - _fovStationary) * _currentFovBlend;
    baseFOV = baseFOV + (_fovJumping - baseFOV) * _currentJumpFovBlend;
  }

  // Shoot camera lerp: offset Z + FOV (must run before camCtrl.update + fireBullet)
  {
    const isShooting = (_firing && !_gunOverheated) ? 1 : 0;
    _currentShootBlend += (isShooting - _currentShootBlend) * (1 - Math.exp(-_shootLerpSpeed * dt));
    if (!isShooting && _currentShootBlend < 0.001) _currentShootBlend = 0;

    if (_currentShootBlend > 0.001) {
      camCtrl.offsetZ = camCtrl._baseOffsetZ + (_shootOffsetZ - camCtrl._baseOffsetZ) * _currentShootBlend;
      camera.fov = baseFOV + (_shootFOV - baseFOV) * _currentShootBlend;
    } else {
      camCtrl.offsetZ = camCtrl._baseOffsetZ;
      camera.fov = baseFOV;
    }
    camera.updateProjectionMatrix();
  }

  // Aim mode: override FOV → 47 and ramp shake to 0
  {
    const wantAim = _aiming ? 1 : 0;
    _currentAimBlend += (wantAim - _currentAimBlend) * (1 - Math.exp(-_aimLerpSpeed * dt));
    if (!wantAim && _currentAimBlend < 0.001) _currentAimBlend = 0;
    if (wantAim && _currentAimBlend > 0.999) _currentAimBlend = 1;

    if (_currentAimBlend > 0.001) {
      camera.fov = camera.fov + (_aimFOV - camera.fov) * _currentAimBlend;
      camera.updateProjectionMatrix();
    }
  }

  camCtrl.update();

  // Gun heat: recharge when not firing (after delay)
  if (_firing && !_gunOverheated) {
    _gunRechargeWait = _gunRechargeDelay;
    _fireCooldown -= dt;
    if (_fireCooldown <= 0) {
      _gunHeat -= (1 / bullets.fireRate) * _gunDrainRate;
      if (_gunHeat <= 0) {
        _gunHeat = 0;
        _gunOverheated = true;
        _stopGunSound();
      } else {
        fireBullet();
      }
      _fireCooldown = 1 / bullets.fireRate;
    }
  } else {
    _gunRechargeWait -= dt;
    if (_gunRechargeWait <= 0) {
      _gunHeat = Math.min(1, _gunHeat + dt / _gunRechargeTime);
      if (_gunHeat >= 1) {
        _gunHeat = 1;
        _gunOverheated = false;
      }
    }
  }

  bullets.update(dt);
  sparks.update(dt);
  targets.update(dt);

  // Airborne camera wobble
  {
    const isAir = player._jump != null ? 1 : 0;
    const blendSpeed = isAir ? 3.0 : 6.0; // fade in slower, fade out faster
    _wobbleActive += (isAir - _wobbleActive) * (1 - Math.exp(-blendSpeed * dt));
    if (_wobbleActive > 0.001) {
      _wobbleTime += dt * _wobbleSpeed;
      const t = _wobbleTime;
      // Use incommensurate frequencies so it doesn't loop obviously
      const ox = Math.sin(t * 1.0) * 0.6 + Math.sin(t * 2.3) * 0.4;
      const oy = Math.sin(t * 1.4) * 0.5 + Math.sin(t * 2.7) * 0.5;
      const rx = Math.sin(t * 1.1) * 0.5 + Math.sin(t * 2.9) * 0.5;
      const ry = Math.sin(t * 0.9) * 0.4 + Math.sin(t * 2.1) * 0.6;
      const rz = Math.sin(t * 1.3) * 0.6 + Math.sin(t * 2.5) * 0.4;
      const a = _wobbleActive * (1 - _currentAimBlend);
      // Apply translation in camera-local space
      _tmpRight.setFromMatrixColumn(camera.matrixWorld, 0);
      _tmpUp.setFromMatrixColumn(camera.matrixWorld, 1);
      camera.position.addScaledVector(_tmpRight, ox * _wobbleMagXY * a);
      camera.position.addScaledVector(_tmpUp,    oy * _wobbleMagXY * a);
      // Apply rotation
      const deg = Math.PI / 180;
      camera.rotation.x += rx * _wobbleMagRot * deg * a;
      camera.rotation.y += ry * _wobbleMagRot * deg * a;
      camera.rotation.z += rz * _wobbleMagRot * deg * a;
    } else {
      _wobbleTime = 0;
    }
  }

  // Walk camera wobble
  {
    const isWalking = (player._jump == null && !player._landing &&
      player.walk.inputDir.lengthSq() > 0.001) ? 1 : 0;
    const blendSpeed = isWalking ? 4.0 : 8.0;
    _walkWobbleActive += (isWalking - _walkWobbleActive) * (1 - Math.exp(-blendSpeed * dt));
    if (_walkWobbleActive > 0.001) {
      _walkWobbleTime += dt * _walkWobbleSpeed;
      const t = _walkWobbleTime;
      const ox = Math.sin(t * 1.0) * 0.5 + Math.sin(t * 2.1) * 0.3 + Math.cos(t * 0.7) * 0.2;
      const oy = Math.sin(t * 1.6) * 0.6 + Math.sin(t * 2.8) * 0.4;
      const rx = Math.sin(t * 1.2) * 0.4 + Math.sin(t * 2.5) * 0.6;
      const ry = Math.sin(t * 0.8) * 0.3 + Math.sin(t * 2.3) * 0.7;
      const rz = Math.sin(t * 1.5) * 0.5 + Math.sin(t * 2.6) * 0.5;
      const a = _walkWobbleActive * (1 - _currentAimBlend);
      _tmpRight.setFromMatrixColumn(camera.matrixWorld, 0);
      _tmpUp.setFromMatrixColumn(camera.matrixWorld, 1);
      camera.position.addScaledVector(_tmpRight, ox * _walkWobbleMagXY * a);
      camera.position.addScaledVector(_tmpUp,    oy * _walkWobbleMagXY * a);
      const deg2 = Math.PI / 180;
      camera.rotation.x += rx * _walkWobbleMagRot * deg2 * a;
      camera.rotation.y += ry * _walkWobbleMagRot * deg2 * a;
      camera.rotation.z += rz * _walkWobbleMagRot * deg2 * a;
    } else {
      _walkWobbleTime = 0;
    }
  }

  // Shoot camera wobble
  {
    const isShooting = (_firing && !_gunOverheated) ? 1 : 0;
    const blendSpeed = isShooting ? 6.0 : 10.0;
    _shootWobbleActive += (isShooting - _shootWobbleActive) * (1 - Math.exp(-blendSpeed * dt));
    if (_shootWobbleActive > 0.001) {
      _shootWobbleTime += dt * _shootWobbleSpeed;
      const t = _shootWobbleTime;
      const ox = Math.sin(t * 1.3) * 0.4 + Math.sin(t * 3.1) * 0.4 + Math.cos(t * 2.0) * 0.2;
      const oy = Math.sin(t * 1.7) * 0.5 + Math.sin(t * 3.4) * 0.5;
      const rx = Math.sin(t * 1.5) * 0.5 + Math.sin(t * 3.7) * 0.5;
      const ry = Math.sin(t * 1.1) * 0.3 + Math.sin(t * 2.9) * 0.7;
      const rz = Math.sin(t * 1.8) * 0.6 + Math.sin(t * 3.2) * 0.4;
      const a = _shootWobbleActive * (1 - _currentAimBlend);
      _tmpRight.setFromMatrixColumn(camera.matrixWorld, 0);
      _tmpUp.setFromMatrixColumn(camera.matrixWorld, 1);
      camera.position.addScaledVector(_tmpRight, ox * _shootWobbleMagXY * a);
      camera.position.addScaledVector(_tmpUp,    oy * _shootWobbleMagXY * a);
      const deg2 = Math.PI / 180;
      camera.rotation.x += rx * _shootWobbleMagRot * deg2 * a;
      camera.rotation.y += ry * _shootWobbleMagRot * deg2 * a;
      camera.rotation.z += rz * _shootWobbleMagRot * deg2 * a;
    } else {
      _shootWobbleTime = 0;
    }
  }

  // Sprint camera wobble
  {
    const sprintBlend = player._currentSprintBlend;
    if (sprintBlend > 0.001) {
      _sprintWobbleTime += dt * _sprintWobbleSpeed;
      const t = _sprintWobbleTime;
      const ox = Math.sin(t * 0.9) * 0.5 + Math.sin(t * 2.0) * 0.3 + Math.cos(t * 1.3) * 0.2;
      const oy = Math.sin(t * 1.5) * 0.6 + Math.sin(t * 2.6) * 0.4;
      const rx = Math.sin(t * 1.1) * 0.5 + Math.sin(t * 2.7) * 0.5;
      const ry = Math.sin(t * 0.7) * 0.4 + Math.sin(t * 2.2) * 0.6;
      const rz = Math.sin(t * 1.4) * 0.5 + Math.sin(t * 2.4) * 0.5;
      const a = sprintBlend * (1 - _currentAimBlend);
      _tmpRight.setFromMatrixColumn(camera.matrixWorld, 0);
      _tmpUp.setFromMatrixColumn(camera.matrixWorld, 1);
      camera.position.addScaledVector(_tmpRight, ox * _sprintWobbleMagXY * a);
      camera.position.addScaledVector(_tmpUp,    oy * _sprintWobbleMagXY * a);
      const deg2 = Math.PI / 180;
      camera.rotation.x += rx * _sprintWobbleMagRot * deg2 * a;
      camera.rotation.y += ry * _sprintWobbleMagRot * deg2 * a;
      camera.rotation.z += rz * _sprintWobbleMagRot * deg2 * a;
    } else {
      _sprintWobbleTime = 0;
    }
  }

  // FOV lerp and shoot camera lerp are now computed before camCtrl.update()

  // HUD parallax: offset based on camera world-space velocity
  if (_hudParallaxInited && dt > 0) {
    // Camera velocity in world space
    const vx = (camera.position.x - _prevCamPos.x) / dt;
    const vy = (camera.position.y - _prevCamPos.y) / dt;
    const vz = (camera.position.z - _prevCamPos.z) / dt;
    // Project velocity into screen space (right = +X, up = +Y)
    _tmpRight.setFromMatrixColumn(camera.matrixWorld, 0);
    _tmpUp.setFromMatrixColumn(camera.matrixWorld, 1);
    const screenVx = vx * _tmpRight.x + vy * _tmpRight.y + vz * _tmpRight.z;
    const screenVy = vx * _tmpUp.x    + vy * _tmpUp.y    + vz * _tmpUp.z;
    // Target offset: opposite of velocity
    const targetX = -screenVx * _hudParallaxAmount * 0.05;
    const targetY = screenVy * _hudParallaxAmount * 0.05;
    // Smooth toward target
    const t = 1 - Math.exp(-_hudParallaxSmooth * dt);
    _hudOffsetX += (targetX - _hudOffsetX) * t;
    _hudOffsetY += (targetY - _hudOffsetY) * t;
    // Clamp
    _hudOffsetX = Math.max(-_hudMaxPx, Math.min(_hudMaxPx, _hudOffsetX));
    _hudOffsetY = Math.max(-_hudMaxPx, Math.min(_hudMaxPx, _hudOffsetY));
  }
  _hudParallaxInited = true;
  _prevCamPos.copy(camera.position);

  // Vignette blur: lerp intensity (active when shooting, jumping, or walking)
  {
    const isWalking = (player._jump == null && !player._landing &&
      player.walk.inputDir.lengthSq() > 0.001) ? 1 : 0;
    const wantBlur = ((_firing && !_gunOverheated) || player._jump != null || isWalking) ? 1 : 0;
    _vignetteBlurBlend += (wantBlur - _vignetteBlurBlend) * (1 - Math.exp(-_vignetteBlurLerpSpeed * dt));
    if (!wantBlur && _vignetteBlurBlend < 0.001) _vignetteBlurBlend = 0;
    postFX.vignetteBlurPass.intensity = _vignetteBlurBlend * _vignetteBlurMaxIntensity;
  }

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

function GunHeatBar() {
  const [heat, setHeat] = useState(1);
  const [overheated, setOverheated] = useState(false);
  const rafRef = useRef();

  const bar = useControls('Gun Bar', {
    Width:    { value: 200, min: 40, max: 300, step: 1 },
    Height:   { value: 10, min: 4, max: 40, step: 1 },
    Bottom:   { value: 48, min: 10, max: 200, step: 1 },
    Left:     { value: 48, min: 10, max: 200, step: 1 },
    Stroke:   { value: 0.5, min: 0.25, max: 3, step: 0.25 },
    Color:    { value: '#ffffff' },
    Opacity:  { value: 1.0, min: 0, max: 1, step: 0.05 },
    'Drain Rate':     { value: 0.6, min: 0.1, max: 3.0, step: 0.05 },
    'Recharge Time':  { value: 2.0, min: 0.2, max: 5.0, step: 0.1 },
    'Recharge Delay': { value: 0.4, min: 0.0, max: 2.0, step: 0.05 },
  });

  useEffect(() => {
    _gunDrainRate = bar['Drain Rate'];
    _gunRechargeTime = bar['Recharge Time'];
    _gunRechargeDelay = bar['Recharge Delay'];
  }, [bar['Drain Rate'], bar['Recharge Time'], bar['Recharge Delay']]);

  useEffect(() => {
    function tick() {
      setHeat(_gunHeat);
      setOverheated(_gunOverheated);
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const fillW = Math.max(0, Math.min(1, heat));

  const labelSize = 10;
  const labelGap = 4;
  const totalH = labelSize + labelGap + bar.Height;

  return (
    <svg
      style={{
        position: 'fixed',
        bottom: bar.Bottom,
        left: bar.Left,
        pointerEvents: 'none',
        zIndex: 999,
        opacity: bar.Opacity,
        overflow: 'visible',
        mixBlendMode: 'difference',
      }}
      width={bar.Width}
      height={totalH}
    >
      {/* Label */}
      <text
        x={0}
        y={labelSize}
        fill={overheated ? '#ff4444' : bar.Color}
        fontFamily="RestartSoft, sans-serif"
        fontSize={labelSize}
        letterSpacing="0.08em"
      >
        GUN
      </text>
      {/* Outer frame */}
      <rect
        x={0} y={labelSize + labelGap}
        width={bar.Width} height={bar.Height}
        fill="none"
        stroke={overheated ? '#ff4444' : bar.Color}
        strokeWidth={bar.Stroke}
      />
      {/* Inner fill */}
      <rect
        x={0} y={labelSize + labelGap}
        width={bar.Width * fillW} height={bar.Height}
        fill={overheated ? '#ff4444' : bar.Color}
        opacity={0.5}
      />
    </svg>
  );
}

function LevaPanel() {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'KeyL' && !e.repeat) setHidden((h) => !h);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  // ── Music ──
  const music = useControls('Music', {
    Volume: { value: 0.3, min: 0, max: 1, step: 0.01 },
  });

  useEffect(() => {
    _bgMusic.volume = music.Volume;
  }, [music.Volume]);

  // ── Camera ──
  const cameraOffset = useControls('Camera Offset', {
    X: { value: 0, min: -20, max: 20, step: 0.1 },
    Y: { value: 0.7, min: 0, max: 30, step: 0.1 },
    Z: { value: -4.1, min: -30, max: 0, step: 0.1 },
  });

  const cameraSettings = useControls('Camera', {
    Pan:  { value: 0, min: -90, max: 90, step: 0.5 },
    Tilt: { value: 0, min: -45, max: 90, step: 0.5 },
    'FOV Stationary': { value: 80, min: 20, max: 120, step: 1 },
    'FOV Walking':    { value: 94, min: 20, max: 120, step: 1 },
    'FOV Jumping':    { value: 105, min: 20, max: 140, step: 1 },
    'FOV Lerp Speed': { value: 4.0, min: 0.5, max: 20, step: 0.5 },
    'Orbit Sensitivity': { value: 0.002, min: 0.0005, max: 0.01, step: 0.0005 },
  });

  useEffect(() => {
    camCtrl.offsetX = cameraOffset.X;
    camCtrl.offsetY = cameraOffset.Y;
    camCtrl.offsetZ = cameraOffset.Z;
    camCtrl._baseOffsetZ = cameraOffset.Z;
  }, [cameraOffset.X, cameraOffset.Y, cameraOffset.Z]);

  useEffect(() => {
    camCtrl.pan = cameraSettings.Pan;
    camCtrl.tilt = cameraSettings.Tilt;
    player.mouseSensitivity = cameraSettings['Orbit Sensitivity'];
  }, [cameraSettings.Pan, cameraSettings.Tilt, cameraSettings['Orbit Sensitivity']]);

  useEffect(() => {
    _fovStationary = cameraSettings['FOV Stationary'];
    _fovWalking    = cameraSettings['FOV Walking'];
    _fovJumping    = cameraSettings['FOV Jumping'];
    _fovLerpSpeed  = cameraSettings['FOV Lerp Speed'];
    camera.fov = _fovStationary;
    camera.updateProjectionMatrix();
  }, [cameraSettings['FOV Stationary'], cameraSettings['FOV Walking'], cameraSettings['FOV Jumping'], cameraSettings['FOV Lerp Speed']]);

  const postPos = useControls('Camera Post-Offset (Position)', {
    X: { value: 2.6, min: -10, max: 10, step: 0.05 },
    Y: { value: 0.0, min: -10, max: 10, step: 0.05 },
    Z: { value: 0.0, min: -10, max: 10, step: 0.05 },
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

  // ── Airborne Wobble ──
  const wobbleCtrl = useControls('Airborne Wobble', {
    'Translate Mag': { value: 0.9, min: 0, max: 0.2, step: 0.005 },
    'Rotate Mag':    { value: 0.9, min: 0, max: 2.0, step: 0.05 },
    Speed:           { value: 5,  min: 0.5, max: 10, step: 0.25 },
  });

  useEffect(() => {
    _wobbleMagXY  = wobbleCtrl['Translate Mag'];
    _wobbleMagRot = wobbleCtrl['Rotate Mag'];
    _wobbleSpeed  = wobbleCtrl.Speed;
  }, [wobbleCtrl['Translate Mag'], wobbleCtrl['Rotate Mag'], wobbleCtrl.Speed]);

  // ── Walk Wobble ──
  const walkWobbleCtrl = useControls('Walk Wobble', {
    'Translate Mag': { value: 0.015, min: 0, max: 0.2, step: 0.005 },
    'Rotate Mag':    { value: 0.08,  min: 0, max: 2.0, step: 0.05 },
    Speed:           { value: 4.0,   min: 0.5, max: 15, step: 0.25 },
  });

  useEffect(() => {
    _walkWobbleMagXY  = walkWobbleCtrl['Translate Mag'];
    _walkWobbleMagRot = walkWobbleCtrl['Rotate Mag'];
    _walkWobbleSpeed  = walkWobbleCtrl.Speed;
  }, [walkWobbleCtrl['Translate Mag'], walkWobbleCtrl['Rotate Mag'], walkWobbleCtrl.Speed]);

  // ── Shoot Wobble ──
  const shootWobbleCtrl = useControls('Shoot Wobble', {
    'Translate Mag': { value: 0.02, min: 0, max: 0.2, step: 0.005 },
    'Rotate Mag':    { value: 0.12, min: 0, max: 2.0, step: 0.05 },
    Speed:           { value: 8.0,  min: 0.5, max: 20, step: 0.25 },
  });

  useEffect(() => {
    _shootWobbleMagXY  = shootWobbleCtrl['Translate Mag'];
    _shootWobbleMagRot = shootWobbleCtrl['Rotate Mag'];
    _shootWobbleSpeed  = shootWobbleCtrl.Speed;
  }, [shootWobbleCtrl['Translate Mag'], shootWobbleCtrl['Rotate Mag'], shootWobbleCtrl.Speed]);

  // ── Shoot Camera ──
  const shootCamCtrl = useControls('Shoot Camera', {
    'Offset Z':   { value: -4.6, min: -15, max: 0, step: 0.1 },
    FOV:          { value: 67,   min: 20, max: 120, step: 1 },
    'Lerp Speed': { value: 6.0,  min: 1, max: 20, step: 0.5 },
  });

  useEffect(() => {
    _shootOffsetZ    = shootCamCtrl['Offset Z'];
    _shootFOV        = shootCamCtrl.FOV;
    _shootLerpSpeed  = shootCamCtrl['Lerp Speed'];
  }, [shootCamCtrl['Offset Z'], shootCamCtrl.FOV, shootCamCtrl['Lerp Speed']]);

  // ── Shoot Blur ──
  const shootBlurCtrl = useControls('Shoot Blur', {
    Intensity:    { value: 1.0,  min: 0, max: 2.0, step: 0.05 },
    'Lerp Speed': { value: 4.0,  min: 0.5, max: 20, step: 0.5 },
    Radius:       { value: 0.2,  min: 0, max: 0.6, step: 0.01 },
    Softness:     { value: 0.4,  min: 0.05, max: 1.0, step: 0.05 },
    Strength:     { value: 0.04, min: 0.005, max: 0.15, step: 0.005 },
    Samples:      { value: 12,   min: 4, max: 16, step: 1 },
  });

  useEffect(() => {
    _vignetteBlurMaxIntensity = shootBlurCtrl.Intensity;
    _vignetteBlurLerpSpeed   = shootBlurCtrl['Lerp Speed'];
    postFX.vignetteBlurPass.radius   = shootBlurCtrl.Radius;
    postFX.vignetteBlurPass.softness = shootBlurCtrl.Softness;
    postFX.vignetteBlurPass.strength = shootBlurCtrl.Strength;
    postFX.vignetteBlurPass.samples  = shootBlurCtrl.Samples;
  }, [shootBlurCtrl.Intensity, shootBlurCtrl['Lerp Speed'], shootBlurCtrl.Radius, shootBlurCtrl.Softness, shootBlurCtrl.Strength, shootBlurCtrl.Samples]);

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
    // Sync base snapshots so sprint multiplier scales from Leva values
    walk._baseStrideLength       = gait['Stride Length'];
    walk._baseStepHeight         = gait['Step Height'];
    walk._baseStepDuration       = gait['Step Duration'];
    walk._baseBodySpeed          = walk._baseStrideLength / walk._baseStepDuration;
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
  });

  const gunUpperRot = useControls('Gun Upper Rotation', {
    'X': { value: 0, min: -180, max: 180, step: 1 },
    'Y': { value: 0, min: -180, max: 180, step: 1 },
    'Z': { value: 0, min: -180, max: 180, step: 1 },
  });

  const gunLowerRot = useControls('Gun Lower Rotation', {
    'X': { value: 92, min: -180, max: 180, step: 1 },
    'Y': { value: 0, min: -180, max: 180, step: 1 },
    'Z': { value: 0, min: -180, max: 180, step: 1 },
  });

  useEffect(() => {
    skel.gunUpperLength = gunCtrl['Upper Length'];
    skel.gunLowerLength = gunCtrl['Lower Length'];
    skel.build();
  }, [gunCtrl['Upper Length'], gunCtrl['Lower Length']]);

  useEffect(() => {
    skel.gunUpperRot.x = gunUpperRot['X'];
    skel.gunUpperRot.y = gunUpperRot['Y'];
    skel.gunUpperRot.z = gunUpperRot['Z'];
  }, [gunUpperRot['X'], gunUpperRot['Y'], gunUpperRot['Z']]);

  useEffect(() => {
    skel.gunLowerRot.x = gunLowerRot['X'];
    skel.gunLowerRot.y = gunLowerRot['Y'];
    skel.gunLowerRot.z = gunLowerRot['Z'];
  }, [gunLowerRot['X'], gunLowerRot['Y'], gunLowerRot['Z']]);

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

  // ── Load default character mesh on mount ──
  useEffect(() => {
    loadCustomGeoFromURL('/meshes/player1.glb')
      .then((meshMap) => {
        skel.applyCustomGeo(meshMap);
        console.log('[Skeleton] Default character mesh (player1.glb) loaded.');
      })
      .catch((err) => {
        console.warn('[Skeleton] Could not load default player1.glb:', err);
      });
  }, []);

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
        } catch (err) {
          console.error('Failed to load custom GLB:', err);
        }
      };
      input.click();
    }),
    'Clear Custom GLB': button(() => {
      skel.clearCustomGeo();
      console.log('[Skeleton] Custom geometry cleared, reverted to default cylinders.');
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
    Angle:  { value: 220, min: 0, max: 360, step: 1 },
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

  // ── Cel Shading: Ground ──
  const celGround = useControls('Cel: Ground', {
    Shadow:    { value: '#000048' },
    Mid:       { value: '#000083' },
    Highlight: { value: '#0000ff' },
    'Threshold 1': { value: 0.07, min: 0, max: 1, step: 0.01 },
    'Threshold 2': { value: 0.60, min: 0, max: 1, step: 0.01 },
  });

  useEffect(() => {
    celMats.ground.celShadow = celGround.Shadow;
    celMats.ground.celMid = celGround.Mid;
    celMats.ground.celHighlight = celGround.Highlight;
    celMats.ground.threshold1 = celGround['Threshold 1'];
    celMats.ground.threshold2 = celGround['Threshold 2'];
  }, [celGround.Shadow, celGround.Mid, celGround.Highlight, celGround['Threshold 1'], celGround['Threshold 2']]);

  // ── Cel Shading: Environment ──
  const celEnv = useControls('Cel: Environment', {
    Shadow:    { value: '#000045' },
    Mid:       { value: '#0000ff' },
    Highlight: { value: '#3d99ff' },
    'Threshold 1': { value: 0.00, min: 0, max: 1, step: 0.01 },
    'Threshold 2': { value: 0.29, min: 0, max: 1, step: 0.01 },
  });

  useEffect(() => {
    celMats.environment.celShadow = celEnv.Shadow;
    celMats.environment.celMid = celEnv.Mid;
    celMats.environment.celHighlight = celEnv.Highlight;
    celMats.environment.threshold1 = celEnv['Threshold 1'];
    celMats.environment.threshold2 = celEnv['Threshold 2'];
  }, [celEnv.Shadow, celEnv.Mid, celEnv.Highlight, celEnv['Threshold 1'], celEnv['Threshold 2']]);

  // ── Cel Shading: Character ──
  const celChar = useControls('Cel: Character', {
    Shadow:    { value: '#0000ff' },
    Mid:       { value: '#ffffff' },
    Highlight: { value: '#ffffff' },
    'Threshold 1': { value: 0.30, min: 0, max: 1, step: 0.01 },
    'Threshold 2': { value: 0.60, min: 0, max: 1, step: 0.01 },
  });

  useEffect(() => {
    celMats.character.celShadow = celChar.Shadow;
    celMats.character.celMid = celChar.Mid;
    celMats.character.celHighlight = celChar.Highlight;
    celMats.character.threshold1 = celChar['Threshold 1'];
    celMats.character.threshold2 = celChar['Threshold 2'];
  }, [celChar.Shadow, celChar.Mid, celChar.Highlight, celChar['Threshold 1'], celChar['Threshold 2']]);

  // ── Cel Shading: Sky ──
  const celSky = useControls('Cel: Sky', {
    Color: { value: '#0019ff' },
  });

  useEffect(() => {
    scene.background = new THREE.Color(celSky.Color);
    if (scene.fog) scene.fog.color.set(celSky.Color);
  }, [celSky.Color]);

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
    'Fire Rate':    { value: 27,   min: 1,     max: 30,  step: 1 },
    'Spawn Offset': { value: 1.0,  min: 0,     max: 5.0, step: 0.1 },
    Speed:          { value: 115,   min: 10,    max: 200, step: 5 },
    Lifetime:       { value: 0.60, min: 0.1,   max: 3.0, step: 0.05 },
    Width:          { value: 0.2, min: 0.005, max: 0.3, step: 0.005 },
    Length:         { value: 0.7,  min: 0.1,   max: 5.0, step: 0.1 },
    Shadow:         { value: '#444444' },
    Mid:            { value: '#888888' },
    Highlight:      { value: '#e9ff00' },
    Emissive:       { value: 50.0, min: 0, max: 50, step: 0.1 },
    'Edge Softness': { value: 1.0, min: 0, max: 1, step: 0.05 },
  });

  useEffect(() => {
    bullets.fireRate    = bulletCtrl['Fire Rate'];
    bullets.spawnOffset = bulletCtrl['Spawn Offset'];
    bullets.speed       = bulletCtrl.Speed;
    bullets.lifetime    = bulletCtrl.Lifetime;
    bullets.width       = bulletCtrl.Width;
    bullets.length      = bulletCtrl.Length;
    bullets.shadow.set(bulletCtrl.Shadow);
    bullets.mid.set(bulletCtrl.Mid);
    bullets.highlight.set(bulletCtrl.Highlight);
    bullets.emissive    = bulletCtrl.Emissive;
    bullets.edgeSoftness = bulletCtrl['Edge Softness'];
  }, [bulletCtrl['Fire Rate'], bulletCtrl['Spawn Offset'], bulletCtrl.Speed, bulletCtrl.Lifetime, bulletCtrl.Width, bulletCtrl.Length, bulletCtrl.Shadow, bulletCtrl.Mid, bulletCtrl.Highlight, bulletCtrl.Emissive, bulletCtrl['Edge Softness']]);

  // ── Muzzle Flash ──
  const muzzleCtrl = useControls('Muzzle Flash', {
    Size:     { value: 3.3,  min: 0.1, max: 5.0, step: 0.1 },
    Duration: { value: 0.03, min: 0.01, max: 0.2, step: 0.005 },
    Opacity:  { value: 1.0,  min: 0, max: 2.0, step: 0.05 },
  });

  useEffect(() => {
    muzzleFlash.size     = muzzleCtrl.Size;
    muzzleFlash.duration = muzzleCtrl.Duration;
    muzzleFlash.opacity  = muzzleCtrl.Opacity;
  }, [muzzleCtrl.Size, muzzleCtrl.Duration, muzzleCtrl.Opacity]);

  // ── Bloom ──
  const bloomCtrl = useControls('Bloom', {
    Intensity:   { value: 1.0,  min: 0,   max: 5,   step: 0.05 },
    Threshold:   { value: 0.4,  min: 0,   max: 2,   step: 0.05 },
    Smoothing:   { value: 0.35,  min: 0,   max: 1,   step: 0.05 },
  });

  useEffect(() => {
    postFX.bloomEffect.intensity           = bloomCtrl.Intensity;
    postFX.bloomEffect.luminanceMaterial.threshold = bloomCtrl.Threshold;
    postFX.bloomEffect.luminanceMaterial.smoothing = bloomCtrl.Smoothing;
  }, [bloomCtrl.Intensity, bloomCtrl.Threshold, bloomCtrl.Smoothing]);

  // ── Sparks ──
  const sparkCtrl = useControls('Sparks', {
    Count:    { value: 25,   min: 1,   max: 40,   step: 1 },
    Speed:    { value: 19.0, min: 1,   max: 30,   step: 0.5 },
    Gravity:  { value: 29,   min: 0,   max: 60,   step: 1 },
    Lifetime: { value: 1.35, min: 0.05, max: 2.0, step: 0.05 },
    Size:     { value: 0.18, min: 0.01, max: 0.3, step: 0.01 },
    Shadow:   { value: '#444444' },
    Mid:      { value: '#888888' },
    Highlight:{ value: '#ffffff' },
  });

  useEffect(() => {
    sparks.sparksPerHit = sparkCtrl.Count;
    sparks.speed        = sparkCtrl.Speed;
    sparks.gravity      = sparkCtrl.Gravity;
    sparks.lifetime     = sparkCtrl.Lifetime;
    sparks.size         = sparkCtrl.Size;
    sparks.shadow.set(sparkCtrl.Shadow);
    sparks.mid.set(sparkCtrl.Mid);
    sparks.highlight.set(sparkCtrl.Highlight);
  }, [sparkCtrl.Count, sparkCtrl.Speed, sparkCtrl.Gravity, sparkCtrl.Lifetime, sparkCtrl.Size, sparkCtrl.Shadow, sparkCtrl.Mid, sparkCtrl.Highlight]);

  // ── Crosshair ──
  const crosshair = useControls('Crosshair', {
    Show:       { value: true },
    Width:      { value: 80, min: 4, max: 80, step: 1 },
    Height:     { value: 57, min: 4, max: 80, step: 1 },
    Stroke:     { value: 0.5, min: 0.5, max: 5, step: 0.25 },
    Color:      { value: '#ffffff' },
    Opacity:    { value: 1.0, min: 0, max: 1, step: 0.05 },
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

  // ── HUD Frame ──
  const hud = useControls('HUD Frame', {
    Show:       { value: true },
    Margin:     { value: 24, min: 0, max: 100, step: 1 },
    Padding:    { value: 12, min: 0, max: 100, step: 1 },
    Stroke:     { value: 0.5, min: 0.25, max: 3, step: 0.25 },
    Color:      { value: '#ffffff' },
    Opacity:    { value: 1.0, min: 0, max: 1, step: 0.05 },
    'Tick Length':  { value: 10, min: 2, max: 40, step: 1 },
    'Tick Inset':   { value: 0, min: -20, max: 20, step: 1 },
    'Tick Stroke':  { value: 0.5, min: 0.25, max: 3, step: 0.25 },
    'Parallax':     { value: 12, min: 0, max: 40, step: 1 },
    'Parallax Max':  { value: 8, min: 1, max: 30, step: 1 },
    'Parallax Snap': { value: 6, min: 1, max: 20, step: 0.5 },
  });

  useEffect(() => {
    _hudParallaxAmount = hud['Parallax'];
    _hudMaxPx = hud['Parallax Max'];
    _hudParallaxSmooth = hud['Parallax Snap'];
  }, [hud['Parallax'], hud['Parallax Max'], hud['Parallax Snap']]);

  // Poll parallax offset and telemetry for rendering
  const [hudOffX, setHudOffX] = useState(0);
  const [hudOffY, setHudOffY] = useState(0);
  const [elevation, setElevation] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [aimBlend, setAimBlend] = useState(0);
  const _prevPos = useRef(new THREE.Vector3());
  const hudRaf = useRef();
  useEffect(() => {
    function tick() {
      setHudOffX(_hudOffsetX);
      setHudOffY(_hudOffsetY);
      setAimBlend(_currentAimBlend);

      // Elevation
      const pos = player.mesh.position;
      setElevation(pos.y);

      // Speed (distance per second, smoothed over frame)
      const dx = pos.x - _prevPos.current.x;
      const dy = pos.y - _prevPos.current.y;
      const dz = pos.z - _prevPos.current.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Approximate dt from 60fps; real dt isn't available here but
      // requestAnimationFrame runs at display rate so this is close enough
      setSpeed((s) => s + (dist * 60 - s) * 0.15);
      _prevPos.current.copy(pos);

      hudRaf.current = requestAnimationFrame(tick);
    }
    _prevPos.current.copy(player.mesh.position);
    hudRaf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(hudRaf.current);
  }, []);

  return (
    <>
      <Leva hidden={hidden} />
      {/* Gun heat bar – bottom left */}
      <GunHeatBar />
      {/* Elevation / Speed readout – upper left */}
      <div
        style={{
          position: 'fixed',
          top: 28,
          left: 28,
          pointerEvents: 'none',
          zIndex: 999,
          fontFamily: 'monospace',
          fontSize: 11,
          lineHeight: 1.5,
          color: '#ffffff',
          mixBlendMode: 'difference',
          opacity: 0.8,
          letterSpacing: '0.04em',
          transform: `translate(${hudOffX}px, ${hudOffY}px)`,
          willChange: 'transform',
        }}
      >
        <div>ELV {elevation >= 0 ? '+' : '-'}{Math.abs(elevation).toFixed(5).padStart(10, '0')}</div>
        <div>SPD {speed.toFixed(5).padStart(10, '0')}</div>
      </div>
      {/* HUD Frame overlay */}
      {hud.Show && (
        <div
          style={{
            position: 'fixed',
            inset: hud.Margin,
            pointerEvents: 'none',
            zIndex: 998,
            opacity: hud.Opacity,
            transform: `translate(${hudOffX}px, ${hudOffY}px)`,
            willChange: 'transform',
            mixBlendMode: 'difference',
          }}
        >
          <svg
            style={{ width: '100%', height: '100%', display: 'block' }}
            preserveAspectRatio="none"
          >
            {/* Main rectangle */}
            <rect
              x={hud.Padding}
              y={hud.Padding}
              width={`calc(100% - ${hud.Padding * 2}px)`}
              height={`calc(100% - ${hud.Padding * 2}px)`}
              fill="none"
              stroke={hud.Color}
              strokeWidth={hud.Stroke}
              vectorEffect="non-scaling-stroke"
            />
            {/* Top ticks – 2 evenly spaced */}
            {[1/3, 2/3].map((f, i) => (
              <line key={`t${i}`}
                x1={`${f * 100}%`} y1={hud.Padding + hud['Tick Inset']}
                x2={`${f * 100}%`} y2={hud.Padding + hud['Tick Inset'] + hud['Tick Length']}
                stroke={hud.Color} strokeWidth={hud['Tick Stroke']}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {/* Bottom ticks – 2 evenly spaced */}
            {[1/3, 2/3].map((f, i) => (
              <line key={`b${i}`}
                x1={`${f * 100}%`} y1={`calc(100% - ${hud.Padding + hud['Tick Inset']}px)`}
                x2={`${f * 100}%`} y2={`calc(100% - ${hud.Padding + hud['Tick Inset'] + hud['Tick Length']}px)`}
                stroke={hud.Color} strokeWidth={hud['Tick Stroke']}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {/* Left ticks – 2 evenly spaced */}
            {[1/3, 2/3].map((f, i) => (
              <line key={`l${i}`}
                x1={hud.Padding + hud['Tick Inset']}
                y1={`${f * 100}%`}
                x2={hud.Padding + hud['Tick Inset'] + hud['Tick Length']}
                y2={`${f * 100}%`}
                stroke={hud.Color} strokeWidth={hud['Tick Stroke']}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {/* Right ticks – 2 evenly spaced */}
            {[1/3, 2/3].map((f, i) => (
              <line key={`r${i}`}
                x1={`calc(100% - ${hud.Padding + hud['Tick Inset']}px)`}
                y1={`${f * 100}%`}
                x2={`calc(100% - ${hud.Padding + hud['Tick Inset'] + hud['Tick Length']}px)`}
                y2={`${f * 100}%`}
                stroke={hud.Color} strokeWidth={hud['Tick Stroke']}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
        </div>
      )}
      <RayDebugOverlay logger={rayLogger} />
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
              transform: `translate(-50%, -50%) scale(${1 - aimBlend * (1 - _aimCrosshairScale)})`,
              pointerEvents: 'none',
              zIndex: 999,
              opacity: chAlpha,
              mixBlendMode: 'difference',
              transition: 'none',
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
Object.assign(guiRoot.style, { position: 'relative', zIndex: '10000' });
document.body.appendChild(guiRoot);
createRoot(guiRoot).render(<LevaPanel />);
