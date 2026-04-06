/**
 * CelShadingPass – Full-screen post-processing effect that remaps the scene
 * luminance through a user-defined color ramp (like Blender's Color Ramp node).
 *
 * The ramp is baked into a 1D DataTexture each time stops change.  The shader
 * samples the ramp using the pixel's perceived luminance (rec-709 weights) and
 * lerps between the original colour and the ramp-tinted result so the original
 * hue is preserved while the value is quantised.
 */
import * as THREE from 'three';
import { ShaderPass } from 'postprocessing';

/* ---------- helpers --------------------------------------------------- */

/**
 * Build (or rebuild) a 256-wide RGBA DataTexture from an array of
 * { position: 0-1, color: [r,g,b] 0-1 } stops sorted by position.
 */
export function buildRampTexture(stops, existingTex = null) {
  const width = 256;
  const data = new Uint8Array(width * 4);

  // Sort stops by position
  const sorted = [...stops].sort((a, b) => a.position - b.position);

  for (let i = 0; i < width; i++) {
    const t = i / (width - 1); // 0 → 1

    // Find surrounding stops
    let lo = sorted[0];
    let hi = sorted[sorted.length - 1];

    for (let s = 0; s < sorted.length - 1; s++) {
      if (t >= sorted[s].position && t <= sorted[s + 1].position) {
        lo = sorted[s];
        hi = sorted[s + 1];
        break;
      }
    }

    // Lerp factor between lo and hi
    const range = hi.position - lo.position;
    const f = range > 0 ? (t - lo.position) / range : 0;

    data[i * 4 + 0] = Math.round((lo.color[0] + (hi.color[0] - lo.color[0]) * f) * 255);
    data[i * 4 + 1] = Math.round((lo.color[1] + (hi.color[1] - lo.color[1]) * f) * 255);
    data[i * 4 + 2] = Math.round((lo.color[2] + (hi.color[2] - lo.color[2]) * f) * 255);
    data[i * 4 + 3] = 255;
  }

  if (existingTex) {
    existingTex.image.data.set(data);
    existingTex.needsUpdate = true;
    return existingTex;
  }

  const tex = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/* ---------- default ramp (2-stop black-to-white) ---------------------- */

export function defaultRampStops() {
  return [
    { position: 0.0,  color: [0.05, 0.0, 0.35] },
    { position: 0.126,  color: [0.0, 0.0, 0.7] },
    { position: 0.262,  color: [0.2, 0.2, 0.85] },
    { position: 0.563, color: [1.0, 1.0, 1.0] },
    { position: 1.0,  color: [0.2, 0.22, 1.0] },
  ];
}

/* ---------- shader material ------------------------------------------- */

function makeCelMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      inputBuffer: { value: null }, // automatically set by ShaderPass
      tRamp:       { value: null },
      intensity:   { value: 1.0 },
      levels:      { value: 4.0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D inputBuffer;
      uniform sampler2D tRamp;
      uniform float intensity;
      uniform float levels;

      varying vec2 vUv;

      void main() {
        vec4 texel = texture2D(inputBuffer, vUv);

        // Perceived luminance (rec-709)
        float lum = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722));

        // Optional hard-step quantisation
        float quantised = lum;
        if (levels > 1.0) {
          quantised = floor(lum * levels + 0.5) / levels;
        }

        // Look up ramp colour at quantised luminance
        vec3 rampColor = texture2D(tRamp, vec2(clamp(quantised, 0.0, 1.0), 0.5)).rgb;

        // At full intensity, use the ramp colour directly (vibrant cel look).
        // At lower intensity, blend back toward the original scene colour.
        vec3 final = mix(texel.rgb, rampColor, intensity);

        gl_FragColor = vec4(final, texel.a);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

/* ---------- pass ------------------------------------------------------ */

export class CelShadingPass extends ShaderPass {
  constructor(stops = null) {
    const mat = makeCelMaterial();
    super(mat, 'inputBuffer');

    this.stops = stops || defaultRampStops();
    this.rampTexture = buildRampTexture(this.stops);
    mat.uniforms.tRamp.value = this.rampTexture;
  }

  /** Update ramp from outside (colour-ramp editor calls this) */
  setStops(stops) {
    this.stops = stops;
    buildRampTexture(this.stops, this.rampTexture);
  }

  set intensity(v) { this.fullscreenMaterial.uniforms.intensity.value = v; }
  get intensity()  { return this.fullscreenMaterial.uniforms.intensity.value; }

  set levels(v) { this.fullscreenMaterial.uniforms.levels.value = v; }
  get levels()  { return this.fullscreenMaterial.uniforms.levels.value; }

  dispose() {
    this.rampTexture.dispose();
    super.dispose();
  }
}
