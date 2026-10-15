// Thumbnails, shrunk to the size they're shown at. Ordinal art is often
// 1024 px or more; a wallet's worth of it at full size ran phones out of
// memory. Each image is loaded when its tile comes near the screen, drawn
// down to THUMB_PX, and only the small copy is kept.

import { loadUrl } from './cardArt'
import { bFileUrl, bTxid, setImageSrc } from './bfile'

const THUMB_PX = 256 // tiles are ~110 css px; enough for 2× screens
const PARALLEL = 4

const small = new Map<string, Promise<string>>()
let running = 0
const waiting: (() => void)[] = []

function turn() {
  if (running < PARALLEL) {
    running++
    return Promise.resolve()
  }
  return new Promise<void>((r) => waiting.push(r)).then(() => void running++)
}

function done() {
  running--
  waiting.shift()?.()
}

/** A blob: URL of the image drawn down to THUMB_PX, or the original URL when it's already small. */
function shrink(url: string) {
  let p = small.get(url)
  if (!p) {
    p = turn().then(async () => {
      try {
        let src = url
        let img: HTMLImageElement
        try {
          img = await loadUrl(src)
        } catch (e) {
          const txid = bTxid(url)
          const blob = txid && (await bFileUrl(txid))
          if (!blob) throw e
          img = await loadUrl((src = blob))
        }
        const k = THUMB_PX / Math.max(img.naturalWidth, img.naturalHeight)
        if (k >= 1) return src // small pixel art: keep it, it's crisper
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(img.naturalWidth * k))
        c.height = Math.max(1, Math.round(img.naturalHeight * k))
        // decode and scale off the main thread where the browser can, so scrolling stays smooth
        await img.decode().catch(() => {})
        const bmp = await createImageBitmap(img, { resizeWidth: c.width, resizeHeight: c.height, resizeQuality: 'high' }).catch(() => null)
        const ctx = c.getContext('2d')!
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(bmp ?? img, 0, 0, c.width, c.height)
        bmp?.close()
        const out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.9))
        c.width = c.height = 1
        return out ? URL.createObjectURL(out) : src
      } finally {
        done()
      }
    })
    p.catch(() => small.delete(url))
    small.set(url, p)
  }
  return p
}

const seen = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      const img = e.target as HTMLImageElement
      seen.unobserve(img)
      const url = img.dataset.src!
      img.classList.add('recovering') // hidden and pulsing until it arrives
      img.addEventListener('load', () => img.classList.remove('recovering'), { once: true })
      shrink(url).then(
        (src) => (img.src = src),
        () => setImageSrc(img, url), // couldn't read the pixels: show it as it is
      )
    }
  },
  { rootMargin: '300px' },
)

/** Point a thumbnail <img> at `url`; it loads, shrunk, once it's near the screen. */
export function setThumbSrc(img: HTMLImageElement, url: string) {
  img.dataset.src = url
  seen.observe(img)
}
