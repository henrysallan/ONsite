/**
 * PostProcessing – sets up the EffectComposer pipeline and exposes the
 * CelShadingPass and OutlinePass for external control.
 *
 * Pipeline order:
 *   RenderPass → CelShadingPass → OutlinePass → (screen)
 *
 * Future passes (bloom, sharpen, etc.) can be inserted before the final pass.
 */
import { EffectComposer, RenderPass } from 'postprocessing';
import { CelShadingPass, defaultRampStops } from './CelShadingPass.js';
import { OutlinePass } from './OutlinePass.js';

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

    // 2) Cel shading
    this.celPass = new CelShadingPass(defaultRampStops());
    this.composer.addPass(this.celPass);

    // 3) Line art outlines
    this.outlinePass = new OutlinePass(renderer, scene, camera);
    this.composer.addPass(this.outlinePass);
  }

  /** Call from the window resize handler */
  setSize(width, height) {
    this.composer.setSize(width, height);
    this.outlinePass.setSize(width, height);
  }

  /** Call instead of renderer.render(scene, camera) */
  render(dt) {
    this.composer.render(dt);
  }
}
