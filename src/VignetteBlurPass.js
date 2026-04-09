/**
 * VignetteBlurPass – Full-screen post-processing pass that applies a
 * directional (radial) blur only at the edges of the screen, fading to
 * zero at the center.  Intensity is driven externally (e.g. by a shoot
 * blend value) so it can smoothly lerp in/out.
 */
import * as THREE from 'three';
import { Pass } from 'postprocessing';

const vertexShader = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */`
uniform sampler2D inputBuffer;
uniform vec2 resolution;
uniform float intensity;   // 0 = off, 1 = full blur
uniform float radius;      // how far from center blur starts (0-1, 0 = entire screen)
uniform float softness;    // width of the falloff band
uniform int samples;       // blur quality (tap count)
uniform float strength;    // max blur offset in UV space

varying vec2 vUv;

void main() {
  vec2 center = vec2(0.5);
  vec2 toCenter = vUv - center;
  float dist = length(toCenter);

  // Vignette mask: 0 at center, 1 at edges
  float mask = smoothstep(radius, radius + softness, dist) * intensity;

  if (mask < 0.001) {
    gl_FragColor = texture2D(inputBuffer, vUv);
    return;
  }

  // Radial blur: sample along the vector toward the center
  vec2 dir = normalize(toCenter) * strength * mask;
  vec4 color = vec4(0.0);
  float total = 0.0;

  for (int i = 0; i < 16; i++) {
    if (i >= samples) break;
    float t = (float(i) / float(samples - 1)) - 0.5; // -0.5 to 0.5
    vec2 offset = dir * t;
    color += texture2D(inputBuffer, vUv + offset);
    total += 1.0;
  }
  color /= total;

  gl_FragColor = color;
}
`;

export class VignetteBlurPass extends Pass {
  constructor() {
    super('VignetteBlurPass');

    this._material = new THREE.ShaderMaterial({
      uniforms: {
        inputBuffer: { value: null },
        resolution:  { value: new THREE.Vector2(1, 1) },
        intensity:   { value: 0.0 },
        radius:      { value: 0.2 },
        softness:    { value: 0.4 },
        samples:     { value: 12 },
        strength:    { value: 0.04 },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });

    this.fullscreenMaterial = this._material;
  }

  /** Blur intensity 0–1 (drive this from the game loop) */
  get intensity()  { return this._material.uniforms.intensity.value; }
  set intensity(v) { this._material.uniforms.intensity.value = v; }

  /** Distance from center where blur begins (0 = full screen, 0.5 = corners only) */
  get radius()  { return this._material.uniforms.radius.value; }
  set radius(v) { this._material.uniforms.radius.value = v; }

  /** Falloff width of the vignette edge */
  get softness()  { return this._material.uniforms.softness.value; }
  set softness(v) { this._material.uniforms.softness.value = v; }

  /** Number of blur taps (quality) */
  get samples()  { return this._material.uniforms.samples.value; }
  set samples(v) { this._material.uniforms.samples.value = v; }

  /** Maximum UV offset of the blur */
  get strength()  { return this._material.uniforms.strength.value; }
  set strength(v) { this._material.uniforms.strength.value = v; }

  setSize(width, height) {
    this._material.uniforms.resolution.value.set(width, height);
  }

  render(renderer, inputBuffer, outputBuffer) {
    this._material.uniforms.inputBuffer.value = inputBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this._material.dispose();
    super.dispose();
  }
}
