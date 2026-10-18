// Paints the card faces onto canvases. Each face comes with a matching
// "foil" mask canvas: white = holographic foil, black = plain print.
//
// The layout copies the card Twetch shows for an ordinal (its 3D card model,
// /3d/sam-rectangle.glb): a rounded 63 × 88 card with a coloured border, the
// square artwork on top and a black info panel underneath. Every gap is the
// same margin. Text positions are Twetch's, given in "panel px" where the
// panel is 2048 px wide.

import type { CardItem } from './feed'
import qrcode from 'qrcode-generator'
import { bFileUrl, bTxid } from './bfile'

export const CARD_ASPECT = 2.006 / 2.8 // width / height (63 × 88 mm)
export const CORNER = 0.0534 // outer corner radius, as a fraction of card width
// card geometry, also used by the full-art layout (fullArt.ts)
export const CW = 1400
export const CH = Math.round(CW / CARD_ASPECT)
export const M = CW * 0.0363 // margin around and between the art and the panel
const ART = CW - M * 2 // square artwork
export const R = CW * 0.0499 // corner radius of the art, panel and back
const PANEL_Y = M + ART + M
const PANEL_H = CH - PANEL_Y - M
const P = ART / 2048 // panel px → canvas px
export const FONT = 'Helvetica, Arial, sans-serif'
export const MM = CW / 63 // canvas px per millimetre of the printed card

// The layout above is in "card px", 1400 across. On screen the card is painted
// smaller: four full-size canvases per card ran phones' in-app browsers out of
// memory, and the card is never shown that big. Phones get 700 px, larger screens 1024.
const PAINT_W = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700 ? 700 : 1024
const K = PAINT_W / CW

export interface Face {
  art: HTMLCanvasElement
  foil: HTMLCanvasElement
}

/** Rarity colours for the site's UI. */
export const RARITY_COLORS: Record<string, string> = {
  common: '#a9b4c6',
  uncommon: '#2ee6d6',
  rare: '#4da3ff',
  epic: '#b46bff',
  exotic: '#ff5ad1',
  legendary: '#ffc23d',
  mythic: '#ff4d6d',
  mythical: '#ff4d6d',
  'super rare': '#b46bff',
  'ultra rare': '#ffc23d',
}

/** Card border (top → bottom) and pill text colours per rarity, as on Twetch's cards. */
const CARD_RARITY: Record<string, { border: string[]; pill: string[] }> = {
  common: { border: ['#9aa1ad', '#939aa6', '#878e9a', '#7b828e', '#717884'], pill: ['#9ba5af'] },
  uncommon: { border: ['#76dfee', '#72d5f0', '#6cc5f4', '#66b5f7', '#62a9f9'], pill: ['#5fa5fa'] },
  rare: { border: ['#3fd798', '#51df95', '#6be992', '#84f38f', '#97fb8c'], pill: ['#34d399'] },
  epic: { border: ['#6133ff', '#784dff', '#926aff', '#a783ff', '#b491ff'], pill: ['#f587b4'] },
  exotic: { border: ['#9aa4ff', '#9bb9ff', '#a3eeff', '#bcc1ff', '#cf8cff'], pill: ['#8c8cf0', '#a3f0ff'] },
  legendary: { border: ['#ffd361', '#ffce4e', '#fac334', '#daa213', '#b78404'], pill: ['#fabe23'] },
}
/** Rarity words other apps use, as the nearest of the six card colours. */
const RARITY_ALIAS: Record<string, string> = {
  mythical: 'exotic',
  mythic: 'exotic',
  'super rare': 'epic',
  'ultra rare': 'legendary',
}
export const cardRarity = (rarity?: string) => {
  const k = (rarity ?? '').trim().toLowerCase()
  return CARD_RARITY[RARITY_ALIAS[k] ?? k] ?? CARD_RARITY.common
}

/** Load artwork; files ORDFS can't serve are read straight from the chain. */
export async function loadImage(url: string): Promise<HTMLImageElement> {
  try {
    return await loadUrl(url)
  } catch (e) {
    const txid = bTxid(url)
    const blob = txid && (await bFileUrl(txid, true).catch(() => null))
    if (!blob) throw e
    return loadUrl(blob)
  }
}

export function loadUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`image failed: ${url}`))
    img.src = url
  })
}

export function canvasPair() {
  const make = () => {
    const c = document.createElement('canvas')
    c.width = Math.round(CW * K)
    c.height = Math.round(CH * K)
    return c
  }
  const art = make()
  const foil = make()
  const a = art.getContext('2d')!
  const f = foil.getContext('2d')!
  a.scale(K, K) // draw in card px
  f.scale(K, K)
  f.fillStyle = '#000'
  f.fillRect(0, 0, CW, CH)
  return { art, foil, a, f }
}

export function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

/** Coloured metal border shared by both faces; all of it is foil. */
export function paintBorder(a: CanvasRenderingContext2D, f: CanvasRenderingContext2D, stops: string[]) {
  const g = a.createLinearGradient(0, 0, CW * 0.25, CH)
  stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s))
  rounded(a, 0, 0, CW, CH, CW * CORNER)
  a.fillStyle = g
  a.fill()

  // bevelled rim catching the light
  const rim = CW * 0.0135
  rounded(a, rim / 2, rim / 2, CW - rim, CH - rim, CW * CORNER - rim / 2)
  a.strokeStyle = 'rgba(255,255,255,0.28)'
  a.lineWidth = rim
  a.stroke()
  rounded(a, rim, rim, CW - rim * 2, CH - rim * 2, CW * CORNER - rim)
  a.strokeStyle = 'rgba(255,255,255,0.55)'
  a.lineWidth = 3
  a.stroke()

  rounded(f, 0, 0, CW, CH, CW * CORNER)
  f.fillStyle = '#fff'
  f.fill()
}

function samplePixel(img: HTMLImageElement): string {
  const c = document.createElement('canvas')
  c.width = c.height = 1
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0, 2, 2, 0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `rgb(${r},${g},${b})`
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight: number | string) {
  let s = size
  do {
    ctx.font = `${weight} ${s}px ${FONT}`
    s -= 2
  } while (ctx.measureText(text).width > maxW && s > 12)
}

/** Rarity pill, right-aligned in the panel; returns its width. */
function paintPill(a: CanvasRenderingContext2D, rarity: string, right: number, top: number) {
  const colors = cardRarity(rarity).pill
  const h = 120 * P
  a.font = `500 ${72 * P}px ${FONT}`
  const w = a.measureText(rarity).width + 150 * P
  const x = right - w
  const tint = (c: string, alpha: number) => {
    const g = a.createLinearGradient(x, top, x + w, top + h)
    colors.forEach((s, i) => g.addColorStop(colors.length > 1 ? i / (colors.length - 1) : 0, s))
    a.globalAlpha = alpha
    a.fillStyle = colors.length > 1 ? g : c
  }
  rounded(a, x, top, w, h, h / 2)
  tint(colors[0], 0.2)
  a.fill()
  a.globalAlpha = 1
  tint(colors[0], 1)
  a.textBaseline = 'middle'
  a.fillText(rarity, x + 75 * P, top + h / 2 + 2)
  a.globalAlpha = 1
  a.textBaseline = 'alphabetic'
  return w
}

/** Froge's edition badge ("Nº 002"), tucked into the artwork's bottom-right corner. */
function paintEdition(a: CanvasRenderingContext2D, f: CanvasRenderingContext2D, rarity: string | undefined, edition: number) {
  const text = `Nº ${String(edition).padStart(3, '0')}`
  a.font = `bold ${2.9 * MM}px ${FONT}`
  const w = a.measureText(text).width + 3.6 * MM
  const h = 5 * MM
  const x = M + ART - 1.2 * MM - w
  const y = M + ART - 1.2 * MM - h
  const stops = cardRarity(rarity).border
  const g = a.createLinearGradient(x, y, x + w, y + h)
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c))
  a.save()
  a.shadowColor = 'rgba(0,0,0,0.4)'
  a.shadowBlur = 0.6 * MM
  rounded(a, x, y, w, h, h / 2)
  a.fillStyle = g
  a.fill()
  a.restore()
  a.fillStyle = '#16131f'
  a.textBaseline = 'middle'
  a.fillText(text, x + 1.8 * MM, y + h / 2 + 1)
  a.textBaseline = 'alphabetic'
  rounded(f, x, y, w, h, h / 2) // foil, like the border
  f.fillStyle = '#fff'
  f.fill()
}

/**
 * Paint the front. `edition` is this copy's number; until certificates exist
 * nothing has been steelminted, so every card's next edition is 001.
 */
export function paintFront(item: CardItem, img: HTMLImageElement | null, edition = 1): Face {
  const { art, foil, a, f } = canvasPair()
  paintBorder(a, f, cardRarity(item.rarity).border)

  // --- artwork: square, top of the card
  a.save()
  rounded(a, M, M, ART, ART, R)
  a.clip()
  a.fillStyle = img ? samplePixel(img) : '#6a5cff'
  a.fillRect(M, M, ART, ART)
  if (img) {
    const k = Math.min(ART / img.naturalWidth, ART / img.naturalHeight)
    const w = img.naturalWidth * k
    const h = img.naturalHeight * k
    a.imageSmoothingEnabled = k < 2 // keep small pixel art crisp
    a.drawImage(img, M + (ART - w) / 2, M + (ART - h) / 2, w, h)
    a.imageSmoothingEnabled = true
  }
  a.restore()
  paintEdition(a, f, item.rarity, edition)
  rounded(a, M, M, ART, ART, R) // the art sits slightly recessed
  a.strokeStyle = 'rgba(0,0,0,0.35)'
  a.lineWidth = 3
  a.stroke()

  // --- info panel
  const x0 = M
  const y0 = PANEL_Y
  rounded(a, x0, y0, ART, PANEL_H, R)
  a.fillStyle = '#000'
  a.fill()
  rounded(f, x0, y0, ART, PANEL_H, R)
  f.fillStyle = '#000'
  f.fill()

  const pillW = item.rarity ? paintPill(a, item.rarity, x0 + ART - 100 * P, y0 + 100 * P) : 0

  a.fillStyle = '#ffffff'
  fitText(a, item.title, ART - 200 * P - pillW - 60 * P, 120 * P, 'bold')
  a.fillText(item.title, x0 + 100 * P, y0 + 203 * P)

  const traits = item.traits.slice(0, 12) // the panel has room for six rows
  if (traits.length) {
    a.font = `500 ${60 * P}px ${FONT}`
    a.fillText('Attributes', x0 + 100 * P, y0 + 320 * P)
  }
  // two columns, filled left, right, left, right…
  a.fillStyle = '#BABBC7'
  traits.forEach((t, i) => {
    const x = x0 + (i % 2 ? 900 : 100) * P
    const y = y0 + (392 + Math.floor(i / 2) * 72) * P
    const text = `${t.name}: ${t.value}`
    fitText(a, text, 760 * P, 52 * P, 'normal')
    a.fillText(text, x, y)
  })

  return { art, foil }
}

// Twetch's card back for each collection (its own mapping, quirks included:
// LizerVAXX shows the Frog Cartel back, Slurp Juice the Astro Apes one).
// Keyed by the collection name in item titles; other collections get Twetch's plain black back.
const TWETCH_BACKS: Record<string, string> = {
  'fox syndicate': 'fox-syndicate',
  'astro ape': 'astro-ape',
  'lab monkes': 'astro-ape',
  'special forces': 'astro-ape',
  'rare sirloins': 'rare-sirloin',
  'lizervaxx™': 'lizer-vaxx',
  'frog cartel': 'frog-cartel',
  'oni society': 'oni-society',
  noogies: 'hats',
  'planetary skies': 'hats',
  'slurp juice': 'slurp-juice',
  'planetary balls': 'planetary-balls',
  'bored waifu': 'bored-waifu',
}

const backs = new Map<string, Promise<HTMLImageElement | null>>()

/** The back artwork for a card, or null for the plain back. */
export function loadBack(item: CardItem): Promise<HTMLImageElement | null> {
  const name = TWETCH_BACKS[item.collection.toLowerCase()]
  if (!name) return Promise.resolve(null)
  let p = backs.get(name)
  if (!p) {
    p = loadUrl(`https://twetch.com/3d/card/backs/${name}.png`).catch(() => {
      backs.delete(name) // try again next time
      return null
    })
    backs.set(name, p)
  }
  return p
}

/**
 * QR code to the card's page as bare-metal dots, as if cut out of the back's
 * artwork: no tile, no border. Rounded dots and corner eyes; foil for the sheen.
 * Dots must touch (radius 0.5 cell) to scan, and silver has no contrast on a
 * pale back, so pale backs get dark gunmetal dots instead.
 */
function paintSteelQr(a: CanvasRenderingContext2D, f: CanvasRenderingContext2D, text: string, x: number, y: number, size: number) {
  const q = qrcode(0, 'M')
  q.addData(text)
  q.make()
  const n = q.getModuleCount()
  const cell = size / n
  const isEye = (r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7)
  const pale = isPale(a, x, y, size, size)
  const steel = a.createLinearGradient(x, y, x + size, y + size)
  const tones = pale ? ['#3a3f48', '#22262d', '#353a43', '#1c2026', '#30353e'] : ['#eef0f4', '#9ba1ad', '#d9dce3', '#8a909c', '#e4e6ec']
  tones.forEach((c, i) => steel.addColorStop(i / 4, c))
  for (const [ctx, fill] of [[a, steel], [f, '#9a9a9a']] as const) {
    ctx.fillStyle = fill
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!q.isDark(r, c) || isEye(r, c)) continue
        ctx.beginPath()
        ctx.arc(x + (c + 0.5) * cell, y + (r + 0.5) * cell, cell * 0.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      const ex = x + c * cell
      const ey = y + r * cell
      ctx.beginPath()
      ctx.roundRect(ex, ey, 7 * cell, 7 * cell, 2.2 * cell)
      ctx.roundRect(ex + cell, ey + cell, 5 * cell, 5 * cell, 1.6 * cell)
      ctx.fill('evenodd')
      ctx.beginPath()
      ctx.roundRect(ex + 2 * cell, ey + 2 * cell, 3 * cell, 3 * cell, 1.1 * cell)
      ctx.fill()
    }
  }
}

/** Is the print under this area light? (Average luminance.) */
function isPale(a: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const k = a.getTransform().a // card px → canvas px
  const px = a.getImageData(x * k, y * k, Math.max(1, w * k), Math.max(1, h * k)).data
  let light = 0
  for (let i = 0; i < px.length; i += 4) light += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
  return light / (px.length / 4) > 140
}

const QR_MM = 11 // one step above the smallest size that scanned on every back in testing (10 mm)

/** Froge's mark at the bottom centre of the back: the site's wordmark, with the QR above it. */
function paintFrogeMark(a: CanvasRenderingContext2D, f: CanvasRenderingContext2D, url: string) {
  const cx = CW / 2
  const baseline = CH - M - 3.2 * MM
  const fontPx = 4.6 * MM
  a.font = `900 ${fontPx}px Outfit, ${FONT}`
  a.letterSpacing = `${0.08 * fontPx}px`
  const w = a.measureText('FROGE').width
  const top = baseline - fontPx * 0.72
  const pale = isPale(a, cx - w / 2, top, w, baseline - top)

  // wordmark: same gradient and glow as the site's header logo
  const g = a.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0)
  g.addColorStop(0, '#ff6be6')
  g.addColorStop(0.5, '#ffffff')
  g.addColorStop(1, '#5ef0ff')
  a.save()
  a.textAlign = 'center'
  a.shadowColor = pale ? 'rgba(20,10,40,0.55)' : 'rgba(255,60,220,0.45)'
  a.shadowBlur = 1.2 * MM
  // letter-spacing adds a trailing gap; shift by half of it to stay centred
  const x = cx + 0.04 * fontPx
  if (pale) {
    // the white middle of the gradient vanishes on a light back: outline it
    a.strokeStyle = 'rgba(30,20,50,0.75)'
    a.lineWidth = 0.35 * MM
    a.lineJoin = 'round'
    a.strokeText('FROGE', x, baseline)
  }
  a.fillStyle = g
  a.fillText('FROGE', x, baseline)
  a.restore()
  f.save()
  f.font = a.font
  f.letterSpacing = a.letterSpacing
  f.textAlign = 'center'
  f.fillStyle = '#fff'
  f.fillText('FROGE', cx + 0.04 * fontPx, baseline)
  f.restore()
  a.letterSpacing = '0px'

  const size = QR_MM * MM
  const qrTop = top - 2 * MM - size
  paintSteelQr(a, f, url, cx - size / 2, qrTop, size)

  // "STEELMINT" stamped above the QR, in spaced capitals
  const word = 'STEELMINT'
  a.font = `600 ${2.1 * MM}px Outfit, ${FONT}`
  a.letterSpacing = `${0.55 * MM}px`
  a.textAlign = 'center'
  a.fillStyle = isPale(a, cx - 12 * MM, qrTop - 4 * MM, 24 * MM, 3 * MM) ? 'rgba(30,32,40,0.85)' : 'rgba(225,228,238,0.85)'
  a.fillText(word, cx + 0.275 * MM, qrTop - 1.6 * MM) // half the trailing letter-space, to stay centred
  a.letterSpacing = '0px'
  a.textAlign = 'left'
}

/** Where the back's QR points: the card's verify page once certificates exist; this ordinal on Froge for now. */
const cardUrl = (item: CardItem) =>
  item.owner ? `${location.origin}/?address=${item.owner}&ordinal=${item.id}` : location.origin

export function paintBack(item: CardItem, img: HTMLImageElement | null): Face {
  const { art, foil, a, f } = canvasPair()
  paintBorder(a, f, cardRarity(item.rarity).border)

  a.save()
  rounded(a, M, M, ART, CH - M * 2, R)
  a.clip()
  a.fillStyle = '#000'
  a.fillRect(M, M, ART, CH - M * 2)
  // the back fills this part of Twetch's texture (its card model's UVs)
  if (img) {
    const w = img.naturalWidth
    const h = img.naturalHeight
    a.drawImage(img, w * 0.012, h * 0.0135, w * 0.677, h * 0.9745, M, M, ART, CH - M * 2)
  }
  a.restore()
  rounded(f, M, M, ART, CH - M * 2, R)
  f.fillStyle = '#000'
  f.fill()
  paintFrogeMark(a, f, cardUrl(item))
  return { art, foil }
}
