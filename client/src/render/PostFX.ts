// Post-processing: GTAO → bloom → tone mapping (OutputPass) → SMAA/FXAA → grade
// (vignette, grain, chromatic aberration, damage pulse, colour grade, colourblind filter).
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import type { Quality } from '../core/Settings';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    vignette: { value: 0.32 },
    grain: { value: 0.045 },
    aberration: { value: 0.0015 },
    damage: { value: 0 },
    marked: { value: 0 },
    saturation: { value: 0.86 },
    contrast: { value: 1.06 },
    lift: { value: new THREE.Vector3(0.006, 0.008, 0.012) },
    gain: { value: new THREE.Vector3(1.0, 0.985, 0.95) },
    cb: { value: 0 },
    flash: { value: 0 },
    downed: { value: 0 },
    resolution: { value: new THREE.Vector2(1920, 1080) },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float time, vignette, grain, aberration, damage, marked, saturation, contrast, flash, downed; uniform vec3 lift, gain; uniform int cb; uniform vec2 resolution;
    varying vec2 vUv;
    float hash(vec2 p){ p = fract(p*vec2(443.897,441.423)); p += dot(p, p.yx+19.19); return fract((p.x+p.y)*p.x); }
    vec3 daltonize(vec3 c, int t){
      // simulate the deficiency, then shift the lost information into visible channels
      mat3 sim;
      if (t==1) sim = mat3(0.625,0.7,0.0, 0.375,0.3,0.3, 0.0,0.0,0.7);       // deuteranopia
      else if (t==2) sim = mat3(0.567,0.558,0.0, 0.433,0.442,0.242, 0.0,0.0,0.758); // protanopia
      else sim = mat3(0.95,0.0,0.0, 0.05,0.433,0.475, 0.0,0.567,0.525);           // tritanopia
      vec3 s = sim * c; vec3 err = c - s;
      vec3 corr = vec3(0.0, err.r*0.7 + err.g, err.r*0.7 + err.b);
      return clamp(c + corr, 0.0, 1.0);
    }
    void main(){
      vec2 uv = vUv; vec2 d = uv - 0.5; float r2 = dot(d,d);
      float ab = aberration + damage*0.006 + marked*0.003;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + d*ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - d*ab).b;
      // grade
      col = col * gain + lift;
      float l = dot(col, vec3(0.2126,0.7152,0.0722));
      col = mix(vec3(l), col, saturation * (1.0 - downed*0.75));
      col = (col - 0.5) * contrast + 0.5;
      // vignette + damage pulse
      float v = smoothstep(0.85, 0.2, r2 * (1.0 + vignette*1.6));
      col *= mix(1.0, v, 0.85);
      col = mix(col, col*vec3(1.25,0.35,0.3), damage * smoothstep(0.08, 0.55, r2));
      col = mix(col, col*vec3(0.8,0.75,1.2), marked * smoothstep(0.15, 0.6, r2) * (0.6+0.4*sin(time*6.0)));
      col *= 1.0 - downed * smoothstep(0.05, 0.4, r2) * 0.8;
      col += flash;
      // film grain (luma weighted)
      float n = hash(uv*resolution + fract(time*61.0)*vec2(97.0,131.0)) - 0.5;
      col += n * grain * (1.0 - l*0.6);
      if (cb > 0) col = daltonize(clamp(col,0.0,1.0), cb);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

export class PostFX {
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly viewPass: RenderPass;
  gtao: GTAOPass | null = null;
  bloom: UnrealBloomPass | null = null;
  aa: SMAAPass | FXAAPass | null = null;
  readonly output: OutputPass;
  readonly grade: ShaderPass;

  constructor(readonly renderer: THREE.WebGLRenderer, readonly scene: THREE.Scene, readonly camera: THREE.PerspectiveCamera, readonly viewScene: THREE.Scene, readonly viewCamera: THREE.PerspectiveCamera) {
    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);
    this.viewPass = new RenderPass(viewScene, viewCamera);
    this.viewPass.clear = false;
    this.viewPass.clearDepth = true;
    this.output = new OutputPass();
    this.grade = new ShaderPass(GradeShader);
  }

  configure(q: Quality, width: number, height: number) {
    const c = this.composer;
    while (c.passes.length) c.removePass(c.passes[0]);
    this.gtao?.dispose(); this.bloom?.dispose(); (this.aa as unknown as { dispose?: () => void })?.dispose?.();
    this.gtao = null; this.bloom = null; this.aa = null;
    c.addPass(this.renderPass);
    if (q === 'high' || q === 'ultra') {
      const scale = q === 'ultra' ? 1 : 0.5;
      this.gtao = new GTAOPass(this.scene, this.camera, Math.floor(width * scale), Math.floor(height * scale));
      this.gtao.output = GTAOPass.OUTPUT.Default;
      this.gtao.blendIntensity = 0.85;
      this.gtao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: q === 'ultra' ? 16 : 10, distanceFallOff: 1.0 });
      this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: q === 'ultra' ? 16 : 8 });
      c.addPass(this.gtao);
    }
    c.addPass(this.viewPass);
    if (q !== 'low') {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(width / 2, height / 2), q === 'medium' ? 0.42 : 0.5, 0.55, 0.88);
      c.addPass(this.bloom);
    }
    c.addPass(this.output);
    this.aa = q === 'low' || q === 'medium' ? new FXAAPass() : new SMAAPass();
    c.addPass(this.aa);
    this.grade.uniforms.grain.value = q === 'low' ? 0.03 : 0.045;
    c.addPass(this.grade);
    this.setSize(width, height);
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
    this.grade.uniforms.resolution.value.set(w, h);
    if (this.gtao) {
      const s = this.gtao.gtaoRenderTarget.width / Math.max(1, w) < 0.75 ? 0.5 : 1;
      this.gtao.setSize(Math.floor(w * s), Math.floor(h * s));
    }
  }

  render(dt: number) {
    this.grade.uniforms.time.value += dt;
    this.composer.render(dt);
  }
}
