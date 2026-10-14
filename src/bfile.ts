// Fallback for artwork ORDFS can't serve: read the B:// file straight out of
// the raw transaction (GorillaPool allows browser requests) and hand back a
// blob: URL. B:// outputs look like OP_RETURN <B prefix> <data> <mime type> …

const RAW_TX = 'https://ordinals.gorillapool.io/api/tx'
const B_PREFIX = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'

const cache = new Map<string, Promise<string | null>>()
let queue: Promise<unknown> = Promise.resolve() // spaced out so a big gallery doesn't flood the indexer

/** The ORDFS file URL's txid, if it's one we know how to recover. */
export function bTxid(url: string) {
  return url.match(/^https:\/\/ordfs\.network\/([0-9a-f]{64})$/)?.[1] ?? null
}

/** Point an <img> at `url`, recovering from the chain if ORDFS can't serve it. */
export function setImageSrc(img: HTMLImageElement, url: string) {
  const txid = bTxid(url)
  if (txid) {
    img.addEventListener(
      'error',
      () => {
        img.classList.add('recovering') // hide the broken-image icon meanwhile
        img.addEventListener('load', () => img.classList.remove('recovering'), { once: true })
        bFileUrl(txid).then((u) => u && (img.src = u), () => {})
      },
      { once: true },
    )
  }
  img.src = url
}

/**
 * blob: URL for the B:// file in `txid`, or null if there isn't one.
 * `urgent` (the card in the frog's hand) skips the queue the thumbnails wait in.
 */
export function bFileUrl(txid: string, urgent = false) {
  let p = cache.get(txid)
  if (!p) {
    const turn = urgent ? Promise.resolve() : (queue = queue.then(() => new Promise((r) => setTimeout(r, 120))))
    p = turn.then(async () => {
      const res = await fetch(`${RAW_TX}/${txid}`)
      if (!res.ok) throw new Error(`${res.status}`)
      const file = extractB(unwrapTx(new Uint8Array(await res.arrayBuffer())))
      return file ? URL.createObjectURL(new Blob([file.data as BlobPart], { type: file.type })) : null
    })
    p.catch(() => cache.delete(txid)) // let a later attempt retry
    cache.set(txid, p)
  }
  return p
}

/** GorillaPool serves <varint length><raw tx><merkle proof>; return just the tx. */
export function unwrapTx(b: Uint8Array) {
  const n = b[0]
  const head = n < 0xfd ? 1 : n === 0xfd ? 3 : n === 0xfe ? 5 : 9
  let len = n < 0xfd ? n : 0
  for (let i = 1; i < head; i++) len += b[i] * 2 ** (8 * (i - 1))
  return b.subarray(head, head + len)
}

function extractB(tx: Uint8Array): { data: Uint8Array; type: string } | null {
  let o = 4 // version
  const varint = () => {
    const n = tx[o++]
    if (n < 0xfd) return n
    const len = n === 0xfd ? 2 : n === 0xfe ? 4 : 8
    let v = 0
    for (let i = 0; i < len; i++) v += tx[o + i] * 2 ** (8 * i)
    o += len
    return v
  }
  const inputs = varint()
  for (let i = 0; i < inputs; i++) {
    o += 36 // previous txid + index
    const scriptLen = varint() // (read before adding: `o += varint()` would use the old o)
    o += scriptLen + 4 // unlocking script + sequence
  }
  const outputs = varint()
  const prefix = new TextEncoder().encode(B_PREFIX)
  for (let i = 0; i < outputs; i++) {
    o += 8 // satoshis
    const len = varint()
    const pushes = scriptPushes(tx.subarray(o, o + len))
    o += len
    const at = pushes.findIndex((p) => p.length === prefix.length && p.every((b, j) => b === prefix[j]))
    if (at >= 0 && pushes[at + 1]) {
      const type = pushes[at + 2] ? new TextDecoder().decode(pushes[at + 2]) : ''
      return { data: pushes[at + 1], type: type.startsWith('image/') ? type : 'image/png' }
    }
  }
  return null
}

/** Every data push in a script, in order (opcodes are skipped). */
export function scriptPushes(s: Uint8Array) {
  const out: Uint8Array[] = []
  let o = 0
  while (o < s.length) {
    const op = s[o++]
    let n = -1
    if (op >= 0x01 && op <= 0x4b) n = op
    else if (op === 0x4c) n = s[o++]
    else if (op === 0x4d) (n = s[o] | (s[o + 1] << 8)), (o += 2)
    else if (op === 0x4e) (n = (s[o] | (s[o + 1] << 8) | (s[o + 2] << 16)) + s[o + 3] * 2 ** 24), (o += 4)
    if (n >= 0) {
      out.push(s.subarray(o, o + n))
      o += n
    }
  }
  return out
}
