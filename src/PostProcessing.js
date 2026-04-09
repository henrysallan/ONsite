/**
 * PostProcessing – sets up the EffectComposer pipeline and exposes the
 * CelShadingPass and OutlinePass for external control.
 *
 * Pipeline order:
 *   RenderPass → CelShadingPass → OutlinePass → (screen)
 *
 * Future passes (bloom, sharpen, etc.) can be inserted before the final pass.
 */
import { EffectComposer, RenderPass, EffectPass, BloomEffect, KernelSize } from 'postprocessing';
import { OutlinePass } from './OutlinePass.js';
import { VignetteBlurPass } from './VignetteBlurPass.js';

export class PostProcessing {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    // Composer
    this.composer = new EffectComposer(renderer);

    // 1) Render the scene into the pipeline
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // 2) Line art outlines
    this.outlinePass = new OutlinePass(renderer, scene, camera);
    this.composer.addPass(this.outlinePass);

    // 3) Bloom (picks up emissive HDR fragments from bullets, muzzle flash, etc.)
    this.bloomEffect = new BloomEffect({
      intensity: 1.0,
      luminanceThreshold: 0.9,
      luminanceSmoothing: 0.3,
      mipmapBlur: true,
      kernelSize: KernelSize.MEDIUM,
    });
    this.bloomPass = new EffectPass(camera, this.bloomEffect);
    this.composer.addPass(this.bloomPass);

    // 4) Vignette blur (driven by shoot state)
    this.vignetteBlurPass = new VignetteBlurPass();
    this.composer.addPass(this.vignetteBlurPass);
  }

  /** Call from the window resize handler */
  setSize(width, height) {
    this.composer.setSize(width, height);
    this.outlinePass.setSize(width, height);
    this.vignetteBlurPass.setSize(width, height);
  }

  /** Call instead of renderer.render(scene, camera) */
  render(dt) {
    this.composer.render(dt);
  }
}
