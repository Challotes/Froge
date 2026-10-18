// The full-art card front: the artwork fills the whole card inside the rarity
// border, with the name on a dark fade along the bottom. The classic front
// (cardArt.ts: square art on top, info panel below) fits any artwork; full art
// only suits art that is close to the card's own shape, so it's chosen per card:
//
//  - art that needs at most DEFAULT_TRIM cut off to fill the card (5:7, A4,
//    2:3 portraits) gets full art by default;
//  - art that needs up to CHOOSE_TRIM cut off can be switched to full art by
//    the owner (the Classic / Full art switch under the card);
//  - everything else (square, landscape, tall) is always classic.
//
// Measured on 25 real ordinals and 1,500 market listings: about a fifth of
// ordinal art is portrait and close to card-shaped; most of the rest is square.
// The owner choosing keeps us from judging every collection: art with its own
// caption or title near the edge, which the trim or name fade would cover, is
// simply left on Classic.

import type { CardItem } from './feed'
import { canvasPair, cardRarity, CH, CW, FONT, M, MM, paintBorder, R, rounded, type Face } from './cardArt'

/** Off switch: false puts every card back on the classic layout. */
export const FULL_ART = true

const DEFAULT_TRIM = 0.05
const CHOOSE_TRIM = 0.13

export type Layout = 'classic' | 'full'

// the art window: the whole card inside the border
const IW = CW - M * 2
const IH = CH - M * 2

/** Share of the artwork cut off when it covers the art window (0 = exact fit). */
export function trimFor(img: HTMLImageElement) {
  const r = img.naturalWidth / img.naturalHeight
  const t = IW / IH
  return r > 0 ? 1 - Math.min(r / t, t / r) : 1
}

/** Owners' picks by ordinal, so a card keeps its layout when it comes round again. */
const picks = new Map<string, Layout>()

/** The owner switched this card's layout. */
export function pickLayout(item: CardItem, layout: Layout) {
  item.layout = layout
  picks.set(item.id, layout)
}

/** Which layouts this card can have, and the one it shows now (the owner's pick, else the default). */
export function layoutOf(item: CardItem, img: HTMLImageElement | null): { layout: Layout; choosable: boolean } {
  const trim = FULL_ART && img?.naturalWidth ? trimFor(img) : 1
  const choosable = trim <= CHOOSE_TRIM
  if (!choosable) return { layout: 'classic', choosable }
  return { layout: item.layout ?? picks.get(item.id) ?? (trim <= DEFAULT_TRIM ? 'full' : 'classic'), choosable }
}

/** Paint the full-art front. Same `edition` as paintFront. */
export function paintFullFront(item: CardItem, img: HTMLImageElement, edition = 1): Face {
  const { art, foil, a, f } = canvasPair()
  const stops = cardRarity(item.rarity).border
  paintBorder(a, f, stops)

  // --- artwork, covering the window (centred, so any trim is shared by both edges)
  a.save()
  rounded(a, M, M, IW, IH, R)
  a.clip()
  a.fillStyle = '#000'
  a.fillRect(M, M, IW, IH)
  const k = Math.max(IW / img.naturalWidth, IH / img.naturalHeight)
  const w = img.naturalWidth * k
  const h = img.naturalHeight * k
  a.imageSmoothingEnabled = k < 2 // keep small pixel art crisp
  a.drawImage(img, M + (IW - w) / 2, M + (IH - h) / 2, w, h)
  a.imageSmoothingEnabled = true

  // a fade to black along the bottom, so the name reads on any artwork
  const band = IH * 0.2
  const fadeTop = M + IH - band * 1.55
  const fade = a.createLinearGradient(0, fadeTop, 0, M + IH)
  fade.addColorStop(0, 'rgba(0,0,0,0)')
  fade.addColorStop(0.42, 'rgba(0,0,0,0.78)')
  fade.addColorStop(1, 'rgba(0,0,0,0.92)')
  a.fillStyle = fade
  a.fillRect(M, fadeTop, IW, band * 1.55)
  a.restore()
  rounded(a, M, M, IW, IH, R) // the art sits slightly recessed
  a.strokeStyle = 'rgba(0,0,0,0.35)'
  a.lineWidth = 3
  a.stroke()

  // --- name along the bottom: one line, or two for long names
  const pad = 4.2 * MM
  const baseY = M + IH - 4.6 * MM
  const { lines, size } = fitName(a, item.title, IW - pad * 2)
  a.font = `bold ${size}px ${FONT}`
  a.fillStyle = '#fff'
  lines.forEach((l, i) => a.fillText(l, M + pad, baseY - (lines.length - 1 - i) * size * 1.12))

  // --- rarity pill just above the name
  if (item.rarity) {
    const top = baseY - (lines.length - 1) * size * 1.12 - size * 0.95 - 5.4 * MM
    a.font = `600 ${2.5 * MM}px ${FONT}`
    const pw = a.measureText(item.rarity).width + 3.6 * MM
    const ph = 4.4 * MM
    const px = M + pad
    const g = a.createLinearGradient(px, top, px + pw, top)
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c))
    rounded(a, px, top, pw, ph, ph / 2)
    a.globalAlpha = 0.25
    a.fillStyle = g
    a.fill()
    a.globalAlpha = 1
    a.fillStyle = g
    a.textBaseline = 'middle'
    a.fillText(item.rarity, px + 1.8 * MM, top + ph / 2 + 1)
    a.textBaseline = 'alphabetic'
  }

  paintEditionTop(a, f, stops, edition)
  return { art, foil }
}

/** The name at the largest size that fits; long names wrap to two lines, at " - " if there is one. */
function fitName(a: CanvasRenderingContext2D, title: string, maxW: number) {
  const fits = (t: string, s: number) => {
    a.font = `bold ${s}px ${FONT}`
    return a.measureText(t).width <= maxW
  }
  for (let s = 5.4 * MM; s >= 3.9 * MM; s -= 2) if (fits(title, s)) return { lines: [title], size: s }
  // "Series - #003 Title" breaks at the dash; anything else at the best word
  const words = title.split(' ')
  const dash = title.indexOf(' - ')
  const splits: string[][] = dash > 0 ? [[title.slice(0, dash), title.slice(dash + 3)]] : []
  for (let i = 1; i < words.length; i++) splits.push([words.slice(0, i).join(' '), words.slice(i).join(' ')])
  for (let s = 4.6 * MM; s >= 3.2 * MM; s -= 2) {
    for (const l of splits) if (fits(l[0], s) && fits(l[1], s)) return { lines: l, size: s }
  }
  let s = 3.2 * MM
  while (!fits(title, s) && s > 20) s -= 2
  return { lines: [title], size: s }
}

/** Froge's edition badge ("Nº 001"), top right: the bottom of a full-art card holds the name. */
function paintEditionTop(a: CanvasRenderingContext2D, f: CanvasRenderingContext2D, stops: string[], edition: number) {
  const text = `Nº ${String(edition).padStart(3, '0')}`
  a.font = `bold ${2.9 * MM}px ${FONT}`
  const w = a.measureText(text).width + 3.6 * MM
  const h = 5 * MM
  const x = M + IW - 1.6 * MM - w
  const y = M + 1.6 * MM
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

