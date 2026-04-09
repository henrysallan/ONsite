/**
 * CelMaterial – Per-object 3-tone cel-shading material with shadow support.
 *
 * Uses Three.js's Phong shader source as a base (lights, shadows, normals all
 * work) but replaces the final output with a 3-band quantised colour lookup.
 *
 * Built as a ShaderMaterial so we fully own the uniforms object — mutations
 * propagate reliably every frame with no caching issues.
 */
import * as THREE from 'three';

// Grab the stock Phong shader source & uniforms
const _phong = THREE.ShaderLib.phong;

// Patch fragment shader: inject cel uniforms + replace output
const _celFragShader = _phong.fragmentShader
  .replace(
    'void main() {',
    /* glsl */`
      uniform vec3 uCelShadow;
      uniform vec3 uCelMid;
      uniform vec3 uCelHighlight;
      uniform float uCelT1;
      uniform float uCelT2;
      void main() {
    `
  )
  .replace(
    '#include <opaque_fragment>',
    /* glsl */`
      // Use the direct diffuse contribution as cel factor:
      // 0 in full shadow / facing away, max where fully lit.
      // Normalize by dividing by (directDiffuse + indirectDiffuse) so the
      // range is always 0‒1 regardless of light intensity / PI divisor.
      float celDirect  = dot(reflectedLight.directDiffuse, vec3(0.2126, 0.7152, 0.0722));
      float celTotal   = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
      float celFactor  = celTotal > 0.001 ? celDirect / (celDirect + dot(reflectedLight.indirectDiffuse, vec3(0.2126, 0.7152, 0.0722))) : 0.0;

      vec3 celColor;
      if (celFactor < uCelT1) celColor = uCelShadow;
      else if (celFactor < uCelT2) celColor = uCelMid;
      else celColor = uCelHighlight;
      gl_FragColor = vec4(celColor, diffuseColor.a);
    `
  );

export class CelMaterial extends THREE.ShaderMaterial {
  constructor({
    shadow     = '#2a2a4a',
    mid        = '#6a6a9a',
    highlight  = '#ffffff',
    threshold1 = 0.3,
    threshold2 = 0.6,
  } = {}) {
    // Clone the Phong uniforms so each instance gets its own set,
    // then bolt on our cel uniforms (kept as direct references).
    const uniforms = THREE.UniformsUtils.clone(_phong.uniforms);
    uniforms.diffuse.value.set(0xffffff);
    uniforms.specular.value.set(0x000000);
    uniforms.shininess.value = 0;

    // Our custom uniforms — we keep these objects, so mutations stick.
    uniforms.uCelShadow    = { value: new THREE.Color(shadow) };
    uniforms.uCelMid       = { value: new THREE.Color(mid) };
    uniforms.uCelHighlight = { value: new THREE.Color(highlight) };
    uniforms.uCelT1        = { value: threshold1 };
    uniforms.uCelT2        = { value: threshold2 };

    super({
      uniforms,
      vertexShader:   _phong.vertexShader,
      fragmentShader: _celFragShader,
      lights: true,
      fog:    true,
    });
  }

  /* ── convenience setters (mutate in‑place + flag for re‑upload) ── */

  get celShadow()     { return this.uniforms.uCelShadow.value; }
  set celShadow(c)    { this.uniforms.uCelShadow.value.set(c); this.uniformsNeedUpdate = true; }

  get celMid()        { return this.uniforms.uCelMid.value; }
  set celMid(c)       { this.uniforms.uCelMid.value.set(c); this.uniformsNeedUpdate = true; }

  get celHighlight()  { return this.uniforms.uCelHighlight.value; }
  set celHighlight(c) { this.uniforms.uCelHighlight.value.set(c); this.uniformsNeedUpdate = true; }

  get threshold1()    { return this.uniforms.uCelT1.value; }
  set threshold1(v)   { this.uniforms.uCelT1.value = v; this.uniformsNeedUpdate = true; }

  get threshold2()    { return this.uniforms.uCelT2.value; }
  set threshold2(v)   { this.uniforms.uCelT2.value = v; this.uniformsNeedUpdate = true; }
}
