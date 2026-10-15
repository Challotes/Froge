// The frog + card scene.
//
// The frog is the original 2D render split into two layers (body behind,
// left thumb in front). The card is a real 3D object posed so it lands exactly
// where the card sits in the render. All measurements are in source-image
// pixels; the pose was solved offline from the card's four corners.

import * as THREE from 'three'
import { CARD_ASPECT, CORNER, loadBack, paintBack, paintFront, type Face } from './cardArt'
import { twetchTraits, type CardItem } from './feed'
import { CARD_GRIP, createWarpUniforms, HandRig, Spring, warpMaterial, type HandCue, type WarpUniforms } from './hand'

// --- solved camera + card pose ----------------------------------------------
const IMG_W = 1217
const IMG_H = 1293
const FOCAL = 1727.687 // px
const PX = IMG_W / 2 // principal point
const PY = IMG_H / 2
const CARD_POS = new THREE.Vector3(0.0277, -0.3351, -2.1861)
const CARD_ROT = new THREE.Euler(-0.5458, 0.119, -0.2319, 'ZYX')
const FIT_W = 1 // the card the pose was solved for: landscape, held by its left edge
const FIT_H = FIT_W / 1.2421
const CARD_W = 0.62 // our portrait card keeps the same top-left corner under the thumb
const CARD_H = CARD_W / CARD_ASPECT
const CARD_T = 0.011 // thickness

// framing: image px we want visible (room below/aside for the card's swing)
const VIEW = { l: -150, r: IMG_W + 150, t: -40, b: 1420 }
export const VIEW_ASPECT = (VIEW.r - VIEW.l) / (VIEW.b - VIEW.t)

const BG_DEPTH = 3.2
const THUMB_BOX = { x0: 360, y0: 480, x1: 590, y1: 630 } // the cut-out thumb layer, in image px

// --- timing (seconds) ---------------------------------------------------------
export const TIMING = { frontHold: 1.7, windup: 0.17, backHold: 0.22 }
// turning away is a quick flick; the reveal is the showy one, with an extra full turn
const FLIPS = {
  flipOut: { turn: Math.PI, spin: 0.34, power: 1 },
  flipIn: { turn: Math.PI * 3, spin: 0.62, power: 1.5 },
} as const

type Phase = 'front' | 'flipOut' | 'back' | 'flipIn'

/** Map an image-pixel rect onto a camera-facing plane at a given depth. */
function planeForRect(x0: number, y0: number, x1: number, y1: number, depth: number, cell = 12) {
  const s = depth / FOCAL
  const geo = new THREE.PlaneGeometry(
    (x1 - x0) * s,
    (y1 - y0) * s,
    Math.ceil((x1 - x0) / cell),
    Math.ceil((y1 - y0) / cell),
  )
  const pos = new THREE.Vector3(((x0 + x1) / 2 - PX) * s, -((y0 + y1) / 2 - PY) * s, -depth)
  return { geo, pos, scale: s }
}

/** Image-px point → 3D point at a given depth. */
function unproject(px: THREE.Vector2, depth: number) {
  const s = depth / FOCAL
  return new THREE.Vector3((px.x - PX) * s, -(px.y - PY) * s, -depth)
}

function cardShape() {
  const w = CARD_W / 2
  const h = CARD_H / 2
  const r = CORNER * CARD_W
  const s = new THREE.Shape()
  s.moveTo(-w + r, -h)
  s.lineTo(w - r, -h)
  s.absarc(w - r, -h + r, r, -Math.PI / 2, 0, false)
  s.lineTo(w, h - r)
  s.absarc(w - r, h - r, r, 0, Math.PI / 2, false)
  s.lineTo(-w + r, h)
  s.absarc(-w + r, h - r, r, Math.PI / 2, Math.PI, false)
  s.lineTo(-w, -h + r)
  s.absarc(-w + r, -h + r, r, Math.PI, Math.PI * 1.5, false)
  return s
}

function faceGeometry() {
  const g = new THREE.ShapeGeometry(cardShape(), 8)
  const p = g.attributes.position
  const uv = g.attributes.uv
  for (let i = 0; i < p.count; i++) {
    uv.setXY(i, p.getX(i) / CARD_W + 0.5, p.getY(i) / CARD_H + 0.5)
  }
  return g
}

const HOLO_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`

const HOLO_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform sampler2D foilMap;
  uniform float uTime;
  uniform vec2 uPointer;
  uniform float uFlash;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;

  vec3 spectrum(float t) { return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }

  void main() {
    vec3 base = texture2D(map, vUv).rgb;
    float foil = texture2D(foilMap, vUv).r;
    vec3 n = normalize(vN);
    vec3 v = normalize(vV);
    float ndv = clamp(dot(n, v), 0.0, 1.0);

    // colour shifts as the card turns relative to the viewer
    float t = vUv.x * 0.7 + vUv.y * 0.45 + n.x * 1.3 - n.y * 1.6 + uPointer.x * 0.3 + uTime * 0.03;
    vec3 irid = spectrum(t);

    // a glare band that sweeps across the face as it tilts
    float g = vUv.x * 0.85 + (1.0 - vUv.y) * 0.6 - (0.25 + n.y * 1.9 + n.x * 1.4 + uPointer.x * 0.45 - uPointer.y * 0.3);
    float band = exp(-g * g * 30.0);
    float wide = exp(-g * g * 3.0);

    vec3 L = normalize(vec3(-0.35, 0.75, 1.0));
    float diff = 0.5 + 0.5 * max(dot(n, L), 0.0);

    vec3 col = base * diff;
    // foil: tint toward the spectrum (multiplicative keeps the neon saturated)
    vec3 foilCol = base * mix(vec3(1.0), irid * 1.6, 0.45 + 0.35 * (1.0 - ndv));
    col = mix(col, foilCol * diff, foil);
    col += foil * (band * 0.55 + wide * 0.05) * mix(vec3(1.0), irid, 0.4);
    col += (1.0 - foil) * band * 0.05;
    col += uFlash * (foil * irid * 0.35 + 0.05);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

const EDGE_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  vec3 spectrum(float t) { return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
  void main() {
    vec3 n = normalize(vN);
    float t = n.x * 0.8 + n.y * 0.8 + vUv.x * 3.0 + uTime * 0.05;
    float fres = 1.0 - abs(dot(n, normalize(vV)));
    vec3 col = mix(vec3(0.16, 0.12, 0.26), spectrum(t) * vec3(1.0, 0.55, 1.0), 0.45 + 0.4 * fres);
    col += pow(max(n.y, 0.0), 6.0) * 0.6;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

/** Neon glow around the card's outline, `pad` card units beyond each edge. */
function glowTexture(pad: number) {
  const k = 1024 / (CARD_W + pad * 2) // px per card unit
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = Math.round((CARD_H + pad * 2) * k)
  const ctx = c.getContext('2d')!
  const path = () => {
    ctx.beginPath()
    ctx.roundRect(pad * k, pad * k, CARD_W * k, CARD_H * k, CORNER * CARD_W * k)
  }
  for (const [color, blur, width] of [
    ['rgba(255,40,214,0.9)', 60, 26],
    ['rgba(40,200,255,0.8)', 34, 14],
    ['rgba(255,140,240,0.7)', 14, 6],
  ] as const) {
    ctx.shadowColor = color
    ctx.shadowBlur = blur
    ctx.strokeStyle = color
    ctx.lineWidth = width
    path()
    ctx.stroke()
  }
  const tex = canvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** A texture that empties its canvas once it's on the GPU, so the pixels aren't held twice. */
function canvasTexture(c: HTMLCanvasElement) {
  const tex = new THREE.CanvasTexture(c)
  tex.onUpdate = () => {
    c.width = c.height = 1
    tex.onUpdate = null
  }
  return tex
}

function faceTextures(face: Face) {
  const map = canvasTexture(face.art)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 8
  const foil = canvasTexture(face.foil)
  return { map, foil }
}
type FaceTex = ReturnType<typeof faceTextures>

/** Both faces of a card; each card has its own back. */
async function cardTextures(item: CardItem, img: HTMLImageElement | null) {
  // Twetch's trait list, if it answers quickly; otherwise the chain's
  await Promise.race([twetchTraits(item), new Promise((r) => setTimeout(r, 2500))])
  const back = paintBack(item, await loadBack(item))
  return { front: faceTextures(paintFront(item, img)), back: faceTextures(back) }
}
type CardTex = Awaited<ReturnType<typeof cardTextures>>

function disposeFace(t: FaceTex | null) {
  t?.map.dispose()
  t?.foil.dispose()
}

const SPARK_VERT = /* glsl */ `
  attribute vec3 aVel;
  attribute float aSeed;
  uniform float uAge;
  uniform float uSize;
  varying float vFade;
  varying float vSeed;
  void main() {
    float t = uAge;
    vec3 p = position + aVel * (1.0 - exp(-t * 3.2)) / 3.2;
    p.y -= 0.25 * t * t; // a little gravity
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vFade = clamp(1.0 - t / (0.55 + aSeed * 0.5), 0.0, 1.0);
    vSeed = aSeed;
    gl_PointSize = uSize * (0.5 + aSeed) * vFade / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`

const SPARK_FRAG = /* glsl */ `
  varying float vFade;
  varying float vSeed;
  vec3 spectrum(float t) { return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    // four-point twinkle
    float core = max(0.0, 1.0 - length(d) * 2.4);
    float rays = max(0.0, 1.0 - abs(d.x) * 16.0 - abs(d.y) * 2.2) + max(0.0, 1.0 - abs(d.y) * 16.0 - abs(d.x) * 2.2);
    vec3 col = mix(vec3(1.0), spectrum(vSeed * 3.0), 0.55);
    gl_FragColor = vec4(col * (core * core + rays * 0.7) * vFade, 1.0);
    #include <colorspace_fragment>
  }
`

/** A burst of glints thrown off the card's rim when the face lands. */
class Sparks {
  readonly points: THREE.Points
  private mat: THREE.ShaderMaterial
  private age = 99

  constructor(count = 70) {
    const pos = new Float32Array(count * 3)
    const vel = new Float32Array(count * 3)
    const seed = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      // start on the card's outline, fly outwards
      const a = Math.random() * Math.PI * 2
      const x = Math.cos(a)
      const y = Math.sin(a)
      const k = 1 / Math.max(Math.abs(x) / (CARD_W / 2), Math.abs(y) / (CARD_H / 2))
      pos.set([x * k, y * k, 0.01], i * 3)
      const sp = 0.25 + Math.random() * 0.6
      vel.set([x * sp, y * sp + 0.15, 0.1 + Math.random() * 0.35], i * 3)
      seed[i] = Math.random()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aVel', new THREE.BufferAttribute(vel, 3))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      uniforms: { uAge: { value: 99 }, uSize: { value: 40 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.points = new THREE.Points(g, this.mat)
    this.points.renderOrder = 12
    this.points.frustumCulled = false
    this.points.visible = false
  }

  burst() {
    this.age = 0
  }

  update(dt: number) {
    this.age += dt
    this.mat.uniforms.uAge.value = this.age
    this.points.visible = this.age < 1.1
  }

  /** Base glint size in device px at 1 unit from the camera. */
  setSize(px: number) {
    this.mat.uniforms.uSize.value = px
  }
}

export interface StageOptions {
  /** called whenever a new card face is revealed */
  onReveal?: (item: CardItem) => void
  /** called when the face starts turning away */
  onHide?: () => void
  /** supplies the next card (image already decoded, or null for a placeholder) */
  nextCard: () => Promise<{ item: CardItem; img: HTMLImageElement | null }>
}

export class FrogStage {
  readonly canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private clock = new THREE.Clock()

  private rig = new THREE.Group()
  private follow = new THREE.Group() // carries the card along with the hand
  private followPivot = new THREE.Vector3()
  private hand = new HandRig()
  private warp: WarpUniforms
  private angle = new Spring(0, 700, 0.3) // card flip angle once caught
  private flipFrom = 0
  private gripPx = new THREE.Vector2()
  private flip = new THREE.Group()
  private tilt = new THREE.Group()
  private frontMat: THREE.ShaderMaterial
  private backMat: THREE.ShaderMaterial
  private edgeMat: THREE.ShaderMaterial
  private glowMat: THREE.MeshBasicMaterial

  private phase: Phase = 'front'
  private phaseT = 0
  private swapped = false
  private flash = 0
  private pointer = new THREE.Vector2()
  private pointerSmooth = new THREE.Vector2()
  private hovering = false
  private held = false
  private paused = false
  private skipRequested = false
  private frozenAngle: number | null = null
  private current: CardItem | null = null
  private pending: { item: CardItem; tex: CardTex } | null = null
  private queuedBack: FaceTex | null = null // goes on once the back is out of sight
  private prefetching = false
  private gen = 0 // bumps on every jump so stale prefetches are dropped
  private sparks: Sparks
  private raycaster = new THREE.Raycaster()
  private cardMeshes: THREE.Object3D[] = []
  private raf = 0
  private time = 0

  constructor(
    private container: HTMLElement,
    private opts: StageOptions,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.canvas = this.renderer.domElement
    container.appendChild(this.canvas)

    // camera whose principal point sits at the image centre, cropped to VIEW
    const halfW = Math.max(PX - VIEW.l, VIEW.r - PX)
    const halfH = Math.max(PY - VIEW.t, VIEW.b - PY)
    this.camera = new THREE.PerspectiveCamera(
      THREE.MathUtils.radToDeg(2 * Math.atan(halfH / FOCAL)),
      halfW / halfH,
      0.1,
      20,
    )
    this.camera.setViewOffset(
      halfW * 2,
      halfH * 2,
      VIEW.l - (PX - halfW),
      VIEW.t - (PY - halfH),
      VIEW.r - VIEW.l,
      VIEW.b - VIEW.t,
    )

    // the rig pivots around the frog's chest for breathing / parallax
    const pivot = new THREE.Vector3(0, -0.15, -2.6)
    this.rig.position.copy(pivot)
    const content = new THREE.Group()
    content.position.copy(pivot).negate()
    this.rig.add(content)
    this.scene.add(this.rig)

    const loader = new THREE.TextureLoader()
    const srgb = (t: THREE.Texture) => ((t.colorSpace = THREE.SRGBColorSpace), t)

    const weights = loader.load('/frog-weights.png')
    this.warp = createWarpUniforms(weights, IMG_W, IMG_H)

    // body layer (puppet-warped so the hand can move)
    {
      const { geo, pos, scale } = planeForRect(0, 0, IMG_W, IMG_H, BG_DEPTH)
      const rect = { x0: 0, y0: 0, x1: IMG_W, y1: IMG_H }
      const m = new THREE.Mesh(geo, warpMaterial(srgb(loader.load('/frog-bg.webp')), rect, scale, this.warp))
      m.position.copy(pos)
      m.renderOrder = 0
      m.frustumCulled = false
      content.add(m)
    }

    // card: base pose → follows the hand → flips → tilts about the gripped edge
    this.followPivot = unproject(CARD_GRIP, -CARD_POS.z)
    this.follow.position.copy(this.followPivot)
    const followInner = new THREE.Group()
    followInner.position.copy(this.followPivot).negate()
    this.follow.add(followInner)
    content.add(this.follow)
    const base = new THREE.Group()
    base.rotation.copy(CARD_ROT)
    // slide the card within its own plane so its top-left corner stays where the fitted one was
    const shift = new THREE.Vector3((CARD_W - FIT_W) / 2, (FIT_H - CARD_H) / 2, 0).applyEuler(CARD_ROT)
    base.position.copy(CARD_POS).add(shift)
    followInner.add(base)
    base.add(this.flip)
    this.flip.add(this.tilt)
    this.tilt.position.x = -CARD_W / 2
    const tiltInner = new THREE.Group()
    tiltInner.position.x = CARD_W / 2
    this.tilt.add(tiltInner)

    const blank = new THREE.Texture()
    const holoUniforms = () => ({
      map: { value: blank },
      foilMap: { value: blank },
      uTime: { value: 0 },
      uPointer: { value: this.pointerSmooth },
      uFlash: { value: 0 },
    })
    this.frontMat = new THREE.ShaderMaterial({ vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG, uniforms: holoUniforms() })
    this.backMat = new THREE.ShaderMaterial({ vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG, uniforms: holoUniforms() })
    this.edgeMat = new THREE.ShaderMaterial({
      vertexShader: HOLO_VERT,
      fragmentShader: EDGE_FRAG,
      uniforms: { uTime: { value: 0 } },
    })

    const front = new THREE.Mesh(faceGeometry(), this.frontMat)
    front.position.z = CARD_T / 2
    const backGeo = faceGeometry()
    backGeo.rotateX(Math.PI) // upright after a top-over-bottom flip
    const back = new THREE.Mesh(backGeo, this.backMat)
    back.position.z = -CARD_T / 2
    const edgeGeo = new THREE.ExtrudeGeometry(cardShape(), { depth: CARD_T, bevelEnabled: false, curveSegments: 8 })
    edgeGeo.translate(0, 0, -CARD_T / 2)
    const edge = new THREE.Mesh(edgeGeo, [new THREE.MeshBasicMaterial({ visible: false }), this.edgeMat])
    for (const m of [front, back, edge]) m.renderOrder = 5
    const glowPad = CARD_W * 0.11
    this.glowMat = new THREE.MeshBasicMaterial({
      map: glowTexture(glowPad),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: 1,
    })
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W + glowPad * 2, CARD_H + glowPad * 2), this.glowMat)
    glow.renderOrder = 6
    tiltInner.add(glow, front, back, edge)
    this.sparks = new Sparks()
    base.add(this.sparks.points)
    this.cardMeshes = [front, back]

    // thumb layer: a camera-facing plane just in front of the card's top edge,
    // so the depth test hides it whenever the swinging card comes closer.
    {
      this.scene.updateMatrixWorld(true)
      const grip = new THREE.Vector3(-CARD_W / 2 + 0.23, CARD_H / 2, 0).applyMatrix4(base.matrixWorld)
      const depth = -grip.z - 0.045
      const b = THUMB_BOX
      const { geo, pos, scale } = planeForRect(b.x0, b.y0, b.x1, b.y1, depth, 6)
      const m = new THREE.Mesh(geo, warpMaterial(srgb(loader.load('/frog-thumb.webp')), b, scale, this.warp))
      m.position.copy(pos)
      m.renderOrder = 10
      m.frustumCulled = false
      content.add(m)
    }

    this.bindEvents()
    this.resize()
    new ResizeObserver(() => this.resize()).observe(container)
  }

  /** Load the back design + first card, then start the loop. */
  async start() {
    const first = await this.opts.nextCard()
    const tex = await cardTextures(first.item, first.img)
    this.setFront(first.item, tex)
    this.applyBack()
    this.opts.onReveal?.(first.item)
    this.prefetch()
    this.clock.start()
    this.loop()
  }

  /** Flip to the next card right now. */
  next() {
    this.skipRequested = true
  }

  /** Flip straight to a particular card (history, gallery pick). */
  async jump(card: Promise<{ item: CardItem; img: HTMLImageElement | null }>) {
    const gen = ++this.gen
    const c = await card
    if (gen !== this.gen) return
    const tex = await cardTextures(c.item, c.img)
    if (gen !== this.gen) return this.dropTex(tex)
    this.upload(tex)
    this.dropPending()
    this.pending = { item: c.item, tex }
    // the face is hidden right now: swap at once, otherwise flip as soon as we can
    if (this.phase === 'back' || (this.phase === 'flipOut' && this.swapped)) this.swapNow()
    else if (this.phase !== 'flipOut') this.skipRequested = true
  }

  /** Keep the face showing (e.g. while the pointer is on the add-to-cart button). */
  hold(on: boolean) {
    this.held = on
  }

  /** Where the bottom edge of the card sits, in CSS px relative to the canvas. */
  anchor() {
    this.scene.updateMatrixWorld(true)
    const p = new THREE.Vector3(0, -CARD_H / 2, 0).applyMatrix4(this.sparks.points.parent!.matrixWorld)
    p.project(this.camera)
    return { x: ((p.x + 1) / 2) * this.canvas.clientWidth, y: ((1 - p.y) / 2) * this.canvas.clientHeight }
  }

  setPaused(p: boolean) {
    this.paused = p
  }

  get isPaused() {
    return this.paused
  }

  /** Debug: hold the card at a fixed flip angle (radians). */
  freeze(angle: number | null) {
    this.frozenAngle = angle
  }

  /** Debug: pin the thumb/wrist at fixed angles (radians). */
  poseHand(thumb: number, wrist: number) {
    this.hand.override = { thumb, wrist }
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.renderer.dispose()
  }

  private setFront(item: CardItem, tex: CardTex) {
    const u = this.frontMat.uniforms
    ;(u.map.value as THREE.Texture).dispose()
    ;(u.foilMap.value as THREE.Texture).dispose()
    u.map.value = tex.front.map
    u.foilMap.value = tex.front.foil
    disposeFace(this.queuedBack)
    this.queuedBack = tex.back
    this.current = item
  }

  /** Put the current card's back on; only while the back can't be seen. */
  private applyBack() {
    if (!this.queuedBack) return
    const u = this.backMat.uniforms
    ;(u.map.value as THREE.Texture).dispose()
    ;(u.foilMap.value as THREE.Texture).dispose()
    u.map.value = this.queuedBack.map
    u.foilMap.value = this.queuedBack.foil
    this.queuedBack = null
  }

  /** Upload now so the swap mid-flip never hitches. */
  private upload(tex: CardTex) {
    for (const t of [tex.front.map, tex.front.foil, tex.back.map, tex.back.foil]) this.renderer.initTexture(t)
  }

  private dropTex(tex: CardTex) {
    disposeFace(tex.front)
    disposeFace(tex.back)
  }

  private dropPending() {
    if (!this.pending) return
    this.dropTex(this.pending.tex)
    this.pending = null
  }

  private async prefetch() {
    if (this.pending || this.prefetching) return
    this.prefetching = true
    const gen = this.gen
    let stale = false
    try {
      const next = await this.opts.nextCard()
      stale = gen !== this.gen || !!this.pending
      if (stale) return
      const tex = await cardTextures(next.item, next.img)
      stale = gen !== this.gen || !!this.pending
      if (stale) return this.dropTex(tex)
      this.upload(tex)
      this.pending = { item: next.item, tex }
    } catch (e) {
      console.warn('[froge] could not load next card', e)
      setTimeout(() => this.prefetch(), 2000)
    } finally {
      this.prefetching = false
      if (stale) this.prefetch()
    }
  }

  private bindEvents() {
    const toPointer = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect()
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1))
    }
    window.addEventListener('pointermove', (e) => {
      toPointer(e)
      this.hovering = this.hitCard()
      this.canvas.style.cursor = this.hovering ? 'pointer' : ''
    })
    this.canvas.addEventListener('pointerleave', () => {
      this.hovering = false
    })
    this.canvas.addEventListener('click', (e) => {
      toPointer(e as PointerEvent)
      if (this.hitCard()) this.next()
    })
    // phones: tilt the card with the device
    window.addEventListener('deviceorientation', (e) => {
      if (e.gamma == null || e.beta == null) return
      this.pointer.set(THREE.MathUtils.clamp(e.gamma / 30, -1, 1), THREE.MathUtils.clamp((45 - e.beta) / 30, -1, 1))
    })
  }

  private hitCard() {
    this.raycaster.setFromCamera(this.pointer, this.camera)
    return this.raycaster.intersectObjects(this.cardMeshes, false).length > 0
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container
    if (!w || !h) return
    let cw = w
    let ch = w / VIEW_ASPECT
    if (ch > h) {
      ch = h
      cw = h * VIEW_ASPECT
    }
    this.renderer.setSize(Math.round(cw), Math.round(ch))
    this.sparks.setSize(ch * this.renderer.getPixelRatio() * 0.05)
  }

  private enterFlip(next: 'flipOut' | 'flipIn') {
    this.phase = next
    this.phaseT = 0
    this.flipFrom = next === 'flipOut' ? 0 : Math.PI
    if (next === 'flipOut') this.opts.onHide?.()
  }

  private advance(dt: number) {
    const holdFront = this.paused || this.hovering || this.held
    this.phaseT += dt
    switch (this.phase) {
      case 'front':
        if (this.skipRequested || (!holdFront && this.phaseT >= TIMING.frontHold)) {
          this.skipRequested = false
          this.swapped = false
          this.enterFlip('flipOut')
        }
        break
      case 'flipOut':
        // once the front has turned away, quietly swap in the next artwork
        if (!this.swapped && this.angle.x - this.flipFrom > Math.PI / 2 + 0.2 && this.pending) this.swapNow()
        if (this.phaseT >= TIMING.windup + FLIPS.flipOut.spin) this.land('back')
        break
      case 'back':
        if (!this.swapped && this.pending) this.swapNow()
        // wait on the back until the next card is ready (slow networks)
        if (this.phaseT >= TIMING.backHold && (this.swapped || this.phaseT > 6)) this.enterFlip('flipIn')
        break
      case 'flipIn':
        if (this.phaseT >= TIMING.windup + FLIPS.flipIn.spin) {
          this.land('front')
          this.flash = 1
          this.sparks.burst()
          if (this.current) this.opts.onReveal?.(this.current)
        }
        break
    }
  }

  private swapNow() {
    if (!this.pending) return
    this.setFront(this.pending.item, this.pending.tex)
    this.pending = null
    this.swapped = true
    this.prefetch()
  }

  /** The thumb pins the card: hand the angle over to a spring for the settle. */
  private land(next: Phase) {
    const f = FLIPS[this.phase as 'flipOut' | 'flipIn']
    this.phase = next
    this.phaseT = 0
    // keep the angle small: drop whole turns
    const target = this.flipFrom + f.turn
    const wrap = Math.floor((target + 1e-3) / (Math.PI * 2)) * Math.PI * 2
    this.angle.x -= wrap
    this.angle.target = target - wrap
    this.hand.catch(f.power)
    if (next === 'front') this.applyBack()
  }

  /** Card angle while it's in the air + the cue for the hand. */
  private flight(): HandCue | null {
    if (this.phase !== 'flipOut' && this.phase !== 'flipIn') return null
    const f = FLIPS[this.phase]
    const t = this.phaseT
    const back = 0.14 * f.power // anticipation: the card tips the other way first
    if (t < TIMING.windup) {
      const w = t / TIMING.windup
      this.angle.x = this.flipFrom - back * (1 - (1 - w) * (1 - w))
      return { mode: 'windup', u: w, power: f.power }
    }
    const u = Math.min((t - TIMING.windup) / f.spin, 1)
    // flicked: explodes off the thumb, bleeding speed into the catch
    const curve = 0.18 * u + 0.82 * (1 - Math.pow(1 - u, 3))
    const slope = 0.18 + 0.82 * 3 * Math.pow(1 - u, 2)
    const total = f.turn + back
    this.angle.x = this.flipFrom - back + total * curve
    this.angle.v = (total * slope) / f.spin
    return { mode: 'spin', u, power: f.power }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop)
    this.tick(Math.min(this.clock.getDelta(), 1 / 20))
  }

  /** Debug: stop the clock and advance by hand, e.g. to film a flick frame by frame. */
  step(frames: number, dt = 1 / 60) {
    cancelAnimationFrame(this.raf)
    for (let i = 0; i < frames; i++) this.tick(dt)
  }

  private tick(dt: number) {
    this.time += dt
    const t = this.time
    this.advance(dt)

    const cue = this.flight()
    if (!cue) this.angle.step(dt)
    this.hand.update(dt, cue ?? { mode: 'rest' })
    this.hand.apply(this.warp)

    let angle = this.angle.x
    let lift = cue?.mode === 'spin' ? Math.sin(Math.PI * cue.u) * (cue.power > 1 ? 1.4 : 1) : 0
    if (this.frozenAngle != null) {
      angle = this.frozenAngle
      lift = Math.abs(Math.sin(angle))
    }
    this.flip.rotation.x = -angle // top tips away, bottom swings toward you
    this.flip.position.set(0, lift * 0.02, lift * 0.03)

    // the card rides along with the hand
    const wristA = this.hand.gripTransform(this.gripPx)
    const s = -CARD_POS.z / FOCAL
    this.follow.position.set(
      this.followPivot.x + this.gripPx.x * s,
      this.followPivot.y - this.gripPx.y * s,
      this.followPivot.z,
    )
    this.follow.rotation.z = -wristA

    // pointer: shimmer + gentle tilt about the gripped edge, parallax on the body
    this.pointerSmooth.lerp(this.pointer, 1 - Math.exp(-dt * 6))
    const ps = this.pointerSmooth
    this.tilt.rotation.set(-ps.y * 0.025, ps.x * 0.05, 0)

    // breathing
    this.rig.rotation.set(ps.y * -0.02, ps.x * 0.035, Math.sin(t * 0.9) * 0.005)
    this.rig.position.y = -0.15 + Math.sin(t * 1.8) * 0.004
    this.rig.scale.setScalar(1 + Math.sin(t * 1.8) * 0.0025)

    this.flash *= Math.exp(-dt * 3.5)
    for (const m of [this.frontMat, this.backMat]) {
      m.uniforms.uTime.value = t
      m.uniforms.uFlash.value = this.flash
    }
    this.edgeMat.uniforms.uTime.value = t
    this.sparks.update(dt)
    this.glowMat.opacity = 0.9 + 0.1 * Math.sin(t * 2.4) + this.flash * 0.6

    this.renderer.render(this.scene, this.camera)
  }
}
