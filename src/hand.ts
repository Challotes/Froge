// The frog's left hand + thumb, animated by puppet-warping the 2D render.
//
// frog-weights.png says how strongly each pixel follows a joint
// (R = whole left hand around the wrist, G = thumb around its base knuckle,
// B = right hand). The vertex shader bends the image mesh by those weights,
// so the hand moves without tearing holes in the picture.

import * as THREE from 'three'

// joints, in source-image pixels
export const THUMB_PIVOT = new THREE.Vector2(275, 520)
export const WRIST_PIVOT = new THREE.Vector2(170, 600)
export const CARD_GRIP = new THREE.Vector2(230, 855) // where the fist holds the card's left edge

/** Uniforms shared by every warped layer so they always move together. */
export function createWarpUniforms(weights: THREE.Texture, imgW: number, imgH: number) {
  return {
    uWeights: { value: weights },
    uImg: { value: new THREE.Vector2(imgW, imgH) },
    uThumbPivot: { value: THUMB_PIVOT },
    uWristPivot: { value: WRIST_PIVOT },
    uThumbA: { value: 0 },
    uWristA: { value: 0 },
    uHandOff: { value: new THREE.Vector2() },
    uRightOff: { value: new THREE.Vector2() },
  }
}
export type WarpUniforms = ReturnType<typeof createWarpUniforms>

const WARP_VERT = /* glsl */ `
  uniform sampler2D uWeights;
  uniform vec2 uImg;
  uniform vec4 uRect;     // x0, y0, x1, y1 of this layer in image px
  uniform float uScale;   // world units per image px at this layer's depth
  uniform vec2 uThumbPivot;
  uniform vec2 uWristPivot;
  uniform float uThumbA;
  uniform float uWristA;
  uniform vec2 uHandOff;
  uniform vec2 uRightOff;
  varying vec2 vUv;

  // image space is y-down, so a positive angle turns clockwise on screen
  vec2 rot(vec2 v, float a) {
    float c = cos(a), s = sin(a);
    return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
  }

  void main() {
    vUv = uv;
    vec2 px = vec2(mix(uRect.x, uRect.z, uv.x), mix(uRect.y, uRect.w, 1.0 - uv.y));
    vec3 w = texture2D(uWeights, vec2(px.x / uImg.x, 1.0 - px.y / uImg.y)).rgb;
    vec2 p = px;
    p = uThumbPivot + rot(p - uThumbPivot, uThumbA * w.g);
    p = uWristPivot + rot(p - uWristPivot, uWristA * w.r) + uHandOff * w.r;
    p += uRightOff * w.b;
    vec2 c = 0.5 * (uRect.xy + uRect.zw);
    gl_Position = projectionMatrix * modelViewMatrix * vec4((p.x - c.x) * uScale, -(p.y - c.y) * uScale, 0.0, 1.0);
  }
`

const WARP_FRAG = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(map, vUv);
    #include <colorspace_fragment>
  }
`

export function warpMaterial(
  map: THREE.Texture,
  rect: { x0: number; y0: number; x1: number; y1: number },
  scale: number,
  shared: WarpUniforms,
) {
  return new THREE.ShaderMaterial({
    vertexShader: WARP_VERT,
    fragmentShader: WARP_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      ...shared,
      map: { value: map },
      uRect: { value: new THREE.Vector4(rect.x0, rect.y0, rect.x1, rect.y1) },
      uScale: { value: scale },
    },
  })
}

/** Damped spring; underdamped values give the natural overshoot of a catch. */
export class Spring {
  v = 0
  target = 0
  constructor(
    public x: number,
    public k: number,
    public zeta: number,
  ) {}

  step(dt: number) {
    const n = Math.ceil(dt / (1 / 240))
    const h = dt / n
    const c = 2 * this.zeta * Math.sqrt(this.k)
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * (this.x - this.target) - c * this.v) * h
      this.x += this.v * h
    }
  }
}

/** `power` scales the gesture: 1 = a quick turn, >1 = a showy reveal flick. */
export type HandCue =
  | { mode: 'rest' }
  | { mode: 'windup'; u: number; power: number }
  | { mode: 'spin'; u: number; power: number }

/**
 * Magician-style flick: the thumb presses down while the wrist cocks, snaps up
 * to release the card, then drops back to pin it as it lands. The card's
 * weight makes the whole hand dip on the catch.
 */
export class HandRig {
  readonly thumb = new Spring(0, 1600, 0.45) // radians, negative = lifted
  readonly wrist = new Spring(0, 520, 0.4) // radians, negative = flicked up
  readonly dip = new Spring(0, 300, 0.34) // image px, positive = down
  readonly right = new Spring(0, 180, 0.45) // image px, sympathetic bob
  override: { thumb: number; wrist: number } | null = null

  update(dt: number, cue: HandCue) {
    let thumb = 0
    let wrist = 0
    let right = 0
    if (cue.mode === 'windup') {
      // load the spring: press into the card and cock the wrist down
      const e = Math.min(cue.u * 1.6, 1)
      thumb = 0.1 * cue.power * e
      wrist = 0.06 * cue.power * e
      right = 4 * cue.power
    } else if (cue.mode === 'spin') {
      const p = cue.power
      thumb = cue.u < 0.72 ? -0.27 : 0.03 // snap up, then come down to pin it
      wrist = cue.u < 0.22 ? -0.1 * p : cue.u < 0.7 ? -0.03 * p : 0.015
      right = cue.u < 0.4 ? -7 * p : 0
    }
    if (this.override) {
      thumb = this.override.thumb
      wrist = this.override.wrist
    }
    this.thumb.target = thumb
    this.wrist.target = wrist
    this.right.target = right
    for (const s of [this.thumb, this.wrist, this.dip, this.right]) s.step(dt)
  }

  /** The card lands in the hand; a harder throw lands harder. */
  catch(power = 1) {
    this.thumb.v += 4 * power
    this.wrist.v += 0.5 * power
    this.dip.v += 110 * power
  }

  apply(u: WarpUniforms) {
    u.uThumbA.value = this.thumb.x
    u.uWristA.value = this.wrist.x
    u.uHandOff.value.set(0, this.dip.x)
    u.uRightOff.value.set(0, this.right.x)
  }

  /** Where the gripped card edge ends up, as an image-px offset + rotation. */
  gripTransform(out: THREE.Vector2) {
    const a = this.wrist.x
    const d = CARD_GRIP.clone().sub(WRIST_PIVOT)
    const c = Math.cos(a)
    const s = Math.sin(a)
    out.set(WRIST_PIVOT.x + c * d.x - s * d.y, WRIST_PIVOT.y + s * d.x + c * d.y + this.dip.x).sub(CARD_GRIP)
    return a
  }
}
