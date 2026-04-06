/**
 * OutlinePass – Full-screen post-processing pass for ink-style line art.
 *
 * Combines three edge sources:
 *   1. Depth-based edges   (object silhouettes, geometry creases)
 *   2. Normal-based edges  (surface direction changes)
 *   3. Shadow-boundary edges (luminance gradient at shadow/light transitions)
 *
 * Lines are constant-weight in screen-space regardless of camera distance.
 *
 * Renders a depth+normal pre-pass internally.
 */
import * as THREE from 'three';
import { Pass } from 'postprocessing';

/* ---------- shader ---------------------------------------------------- */

const outlineFragmentShader = /* glsl */ `
uniform sampler2D inputBuffer;    // scene colour (from previous pass)
uniform sampler2D tDepth;         // scene depth
uniform sampler2D tNormal;        // view-space normals
uniform vec2 resolution;          // viewport size in pixels
uniform float thickness;          // line thickness in pixels
uniform float depthThreshold;     // sensitivity for depth edges
uniform float normalThreshold;    // sensitivity for normal edges
uniform float shadowThreshold;    // sensitivity for shadow boundary edges
uniform float intensity;          // overall line opacity 0-1
uniform vec3 lineColor;           // line colour (default black)
uniform float cameraNear;
uniform float cameraFar;

varying vec2 vUv;

/* ---- helpers ---- */

float linearizeDepth(float d) {
  return cameraNear * cameraFar / (cameraFar - d * (cameraFar - cameraNear));
}

float sampleDepth(vec2 uv) {
  return linearizeDepth(texture2D(tDepth, uv).r);
}

vec3 sampleNormal(vec2 uv) {
  return texture2D(tNormal, uv).rgb * 2.0 - 1.0;
}

float sampleLuminance(vec2 uv) {
  vec3 c = texture2D(inputBuffer, uv).rgb;
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

/* Roberts cross operator with variable kernel size */
float edgeDepth(vec2 uv, vec2 texel) {
  vec2 offset = texel * thickness;
  float d00 = sampleDepth(uv + vec2(-offset.x, -offset.y));
  float d11 = sampleDepth(uv + vec2( offset.x,  offset.y));
  float d01 = sampleDepth(uv + vec2(-offset.x,  offset.y));
  float d10 = sampleDepth(uv + vec2( offset.x, -offset.y));

  float diff1 = abs(d00 - d11);
  float diff2 = abs(d01 - d10);

  // Normalise by centre depth so distant edges aren't washed out
  float centre = sampleDepth(uv);
  float norm = max(centre, 0.1);

  return (diff1 + diff2) / norm;
}

float edgeNormal(vec2 uv, vec2 texel) {
  vec2 offset = texel * thickness;
  vec3 n00 = sampleNormal(uv + vec2(-offset.x, -offset.y));
  vec3 n11 = sampleNormal(uv + vec2( offset.x,  offset.y));
  vec3 n01 = sampleNormal(uv + vec2(-offset.x,  offset.y));
  vec3 n10 = sampleNormal(uv + vec2( offset.x, -offset.y));

  float diff1 = length(n00 - n11);
  float diff2 = length(n01 - n10);

  return diff1 + diff2;
}

/* Shadow boundary: luminance gradient indicates light->shadow transition */
float edgeShadow(vec2 uv, vec2 texel) {
  vec2 offset = texel * thickness;
  float l00 = sampleLuminance(uv + vec2(-offset.x, -offset.y));
  float l11 = sampleLuminance(uv + vec2( offset.x,  offset.y));
  float l01 = sampleLuminance(uv + vec2(-offset.x,  offset.y));
  float l10 = sampleLuminance(uv + vec2( offset.x, -offset.y));

  return abs(l00 - l11) + abs(l01 - l10);
}

void main() {
  vec4 sceneColor = texture2D(inputBuffer, vUv);
  vec2 texel = 1.0 / resolution;

  float dEdge = step(depthThreshold, edgeDepth(vUv, texel));
  float nEdge = step(normalThreshold, edgeNormal(vUv, texel));
  float sEdge = step(shadowThreshold, edgeShadow(vUv, texel));

  float edge = clamp(dEdge + nEdge + sEdge, 0.0, 1.0);
  edge *= intensity;

  vec3 final = mix(sceneColor.rgb, lineColor, edge);
  gl_FragColor = vec4(final, sceneColor.a);
}
`;

const outlineVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

/* ---------- pass ------------------------------------------------------ */

export class OutlinePass extends Pass {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(renderer, scene, camera) {
    super('OutlinePass');

    this._scene = scene;
    this._camera = camera;
    this._renderer = renderer;

    // Create depth + normal render target
    const size = renderer.getSize(new THREE.Vector2());
    const pixelRatio = renderer.getPixelRatio();
    const w = size.x * pixelRatio;
    const h = size.y * pixelRatio;

    this.depthNormalRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.FloatType,
    });
    this.depthNormalRT.depthTexture = new THREE.DepthTexture();
    this.depthNormalRT.depthTexture.type = THREE.UnsignedIntType;

    // Normal-rendering override material
    this.normalMaterial = new THREE.MeshNormalMaterial();

    // The outline composite material
    this._outlineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        inputBuffer:      { value: null },
        tDepth:           { value: this.depthNormalRT.depthTexture },
        tNormal:          { value: this.depthNormalRT.texture },
        resolution:       { value: new THREE.Vector2(w, h) },
        thickness:        { value: 1.0 },
        depthThreshold:   { value: 0.05 },
        normalThreshold:  { value: 0.3 },
        shadowThreshold:  { value: 0.15 },
        intensity:        { value: 1.0 },
        lineColor:        { value: new THREE.Color(0x000000) },
        cameraNear:       { value: camera.near },
        cameraFar:        { value: camera.far },
      },
      vertexShader: outlineVertexShader,
      fragmentShader: outlineFragmentShader,
      depthTest: false,
      depthWrite: false,
    });

    // Set this as the fullscreen material so the Pass base class renders it
    this.fullscreenMaterial = this._outlineMaterial;
  }

  setSize(width, height) {
    const pixelRatio = this._renderer.getPixelRatio();
    const w = width * pixelRatio;
    const h = height * pixelRatio;
    this.depthNormalRT.setSize(w, h);
    this._outlineMaterial.uniforms.resolution.value.set(w, h);
  }

  /* convenience setters */
  set thickness(v)        { this._outlineMaterial.uniforms.thickness.value = v; }
  get thickness()         { return this._outlineMaterial.uniforms.thickness.value; }

  set depthThreshold(v)   { this._outlineMaterial.uniforms.depthThreshold.value = v; }
  get depthThreshold()    { return this._outlineMaterial.uniforms.depthThreshold.value; }

  set normalThreshold(v)  { this._outlineMaterial.uniforms.normalThreshold.value = v; }
  get normalThreshold()   { return this._outlineMaterial.uniforms.normalThreshold.value; }

  set shadowThreshold(v)  { this._outlineMaterial.uniforms.shadowThreshold.value = v; }
  get shadowThreshold()   { return this._outlineMaterial.uniforms.shadowThreshold.value; }

  set intensity(v)        { this._outlineMaterial.uniforms.intensity.value = v; }
  get intensity()         { return this._outlineMaterial.uniforms.intensity.value; }

  set lineColor(hex)      { this._outlineMaterial.uniforms.lineColor.value.set(hex); }

  render(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest) {
    // 1) Render scene normals into our RT (depth comes for free via depthTexture)
    const bg = this._scene.background;
    const fog = this._scene.fog;
    const overrideMat = this._scene.overrideMaterial;

    this._scene.background = null;
    this._scene.fog = null;
    this._scene.overrideMaterial = this.normalMaterial;

    renderer.setRenderTarget(this.depthNormalRT);
    renderer.clear();
    renderer.render(this._scene, this._camera);

    // Restore
    this._scene.background = bg;
    this._scene.fog = fog;
    this._scene.overrideMaterial = overrideMat;

    // 2) Composite lines over the scene colour
    this._outlineMaterial.uniforms.inputBuffer.value = inputBuffer.texture;
    this._outlineMaterial.uniforms.cameraNear.value = this._camera.near;
    this._outlineMaterial.uniforms.cameraFar.value = this._camera.far;

    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.depthNormalRT.dispose();
    this.normalMaterial.dispose();
    this._outlineMaterial.dispose();
    super.dispose();
  }
}
