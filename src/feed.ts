// Where the cards come from. Everything here is plain data — the stage never
// needs to know about Bitcoin, it just receives CardItems with an image URL.

export const FROG_CARTEL = {
  name: 'Frog Cartel',
  // 1Sat collection outpoint (GorillaPool indexer)
  collectionId: '9e9268256e16840b19beb620f12f4abf65801ea5e96a0a31917418d713a486c8_0',
  twetchCollection: 'c8925e7b008668089d3ae1fc1cf450f7f45f0b4af43cd7d30b84446ecb374d6d',
  approxSupply: 3150,
}

// numbered 1–10,000; Twetch serves each one with its traits and rarity
export const NOOGIES = {
  name: 'NOOGIES',
  twetchCollection: 'df0c100a282e695a2b03ff4f484e266ba47691e1d753bf4cc8428b80a8af14f7',
  supply: 10000,
}

import { scriptPushes, unwrapTx } from './bfile'
import type { TwetchToken } from './links'

const API = 'https://ordinals.gorillapool.io/api'
const ORDFS = 'https://ordfs.network'

export interface Trait {
  name: string
  value: string
  rarity?: string
}

export interface CardItem {
  id: string // origin outpoint
  title: string
  number?: number
  collection: string
  collectionId?: string
  imageUrl: string
  rarity?: string
  rank?: number
  series?: number
  traits: Trait[]
  owner?: string
  /** every outpoint at the address holding this item (Twetch-era and 1Sat copies) */
  locations?: string[]
  /** where Twetch lists it, for reading its traits the way Twetch shows them */
  twetch?: { collection: string; number: number }
}

const collectionQuery = () =>
  btoa(JSON.stringify({ map: { subTypeData: { collectionId: FROG_CARTEL.collectionId } } }))

/* eslint-disable @typescript-eslint/no-explicit-any */
// Two record shapes come back from the indexer:
//  - 1Sat ordinals: metadata lives on the origin inscription (origin.data.map)
//  - Twetch-era ordinals: no origin, the metadata is on the output itself (data.sigil)
function toCard(txo: any): CardItem | null {
  const origin = txo?.origin
  const map = origin?.data?.map ?? {}
  let sigil: any = txo?.data?.sigil ?? {}
  if (origin?.data?.map?.sigil) {
    try {
      sigil = JSON.parse(map.sigil)
    } catch {
      /* sigil is optional */
    }
  }
  if (!origin?.data?.map && !txo?.data?.sigil?.title) return null // unnamed sigil outputs have no usable image
  // Frog Cartel inscriptions are tiny HTML wrappers around a B:// PNG;
  // pull the real image out so it can become a WebGL texture.
  const bTx =
    (typeof sigil.image === 'string' && sigil.image.replace('b://', '').replace(/@\d+$/, '')) ||
    origin?.data?.insc?.text?.match(/\/content\/([0-9a-f]{64})/)?.[1]
  const fileType: string | undefined = origin?.data?.insc?.file?.type
  const imageUrl = bTx
    ? `${ORDFS}/${bTx}`
    : fileType?.startsWith('image/')
      ? `${ORDFS}/content/${origin!.outpoint}`
      : null
  if (!imageUrl) return null

  const traits: Trait[] = Array.isArray(sigil.attributes)
    ? sigil.attributes.map((a: any) => ({ name: a.trait_type ?? a.trait ?? a.name, value: a.value, rarity: a.rarity }))
    : (map.subTypeData?.traits ?? []).map((t: any) => ({ name: t.name, value: t.value, rarity: t.rarityLabel }))

  const title: string = map.name ?? sigil.title ?? 'Untitled'
  const num = sigil.number ?? Number(title.match(/#(\d+)\s*$/)?.[1] ?? NaN)
  return {
    id: origin?.outpoint ?? txo.outpoint,
    title,
    number: Number.isFinite(num) ? num : undefined,
    // items are named "<Collection> #123"
    collection: title.replace(/\s*#\d+\s*$/, '') || 'Ordinals',
    collectionId: map.subTypeData?.collectionId,
    imageUrl,
    rarity: sigil.rarity,
    rank: sigil.rank ?? map.subTypeData?.rank,
    series: sigil.series,
    traits,
    owner: txo.owner,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The indexer sometimes leaves a request hanging for ~50 s and then drops it,
 * so give up after 20 s and try again (twice) before failing the lookup.
 * Client errors (4xx) aren't retried.
 */
async function getJson(url: string, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    } catch (e) {
      if (attempt >= tries) throw e
    }
    if (res?.ok) return res.json()
    if (res && (res.status < 500 || attempt >= tries)) throw new Error(`${res.status} ${url}`)
    await new Promise((r) => setTimeout(r, 800 * attempt))
  }
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** What strangers see: random Frog Cartel and NOOGIES, half each, shuffled together. */
export async function randomCards(count = 16): Promise<CardItem[]> {
  const half = Math.ceil(count / 2)
  const [cartel, noogies] = await Promise.allSettled([randomCartel(half), randomNoogies(count - half)])
  const cards = [cartel, noogies].flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  if (!cards.length) throw cartel.status === 'rejected' ? cartel.reason : new Error('No random cards')
  return shuffle(cards)
}

async function randomCartel(count: number): Promise<CardItem[]> {
  const offset = Math.floor(Math.random() * (FROG_CARTEL.approxSupply - count))
  const txos = await getJson(
    `${API}/txos/search/unspent?q=${collectionQuery()}&limit=${count}&offset=${offset}`,
  )
  const cards = txos.map(toCard).filter(Boolean) as CardItem[]
  // the same frog on Twetch carries its rarity and current traits
  for (const c of cards) {
    if (c.number != null) c.twetch = { collection: FROG_CARTEL.twetchCollection, number: c.number }
  }
  return cards
}

/** Random NOOGIES straight from Twetch, which already has their traits and rarity. */
async function randomNoogies(count: number): Promise<CardItem[]> {
  const numbers = new Set<number>()
  while (numbers.size < count) numbers.add(1 + Math.floor(Math.random() * NOOGIES.supply))
  const found = await Promise.all(
    [...numbers].map((n) =>
      fetch(`https://api.twetch.com/v1/tokens/${NOOGIES.twetchCollection}/${n}`, { signal: AbortSignal.timeout(15_000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ),
  )
  const cards: CardItem[] = []
  for (const r of found) {
    if (!r?.token || !r.state) continue
    const item = twetchCard({ collection: NOOGIES.twetchCollection, collectionName: NOOGIES.name, token: r.token, state: r.state })
    if (!item) continue
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    item.traits = (r.token.attributes ?? []).map((a: any) => ({ name: a.traitType, value: String(a.value) }))
    item.rarity = r.token.rarity || 'Common'
    twetchChecked.set(item, Promise.resolve()) // already Twetch's own data
    cards.push(item)
  }
  return cards
}

const PAGE = 300
const MAX_ORDINALS = 6000

/**
 * Every image ordinal held by a wallet's addresses, any collection — what owners see.
 * `twetch`: the account's own NFT list, which fills gaps the indexer left.
 * `onProgress` gets the cards found so far after each page, so they can be shown before the end.
 */
export async function ordinalsOwnedBy(
  addresses: string[],
  onProgress?: (found: number, stage?: 'sorting', sofar?: CardItem[]) => void,
  twetch: TwetchToken[] = [],
): Promise<CardItem[]> {
  // inscriptions (1Sat) and sigil outputs (Twetch era); plain coins are skipped
  const filters = [{ insc: {} }, { sigil: {} }].map((f) => btoa(JSON.stringify(f)))
  // The same item can sit at the address twice: its Twetch-era sigil output and
  // its later 1Sat inscription. Same numbered name + same art = one card with
  // both locations. Unnumbered editions ("Egg") are separate copies, one card each.
  const byKey = new Map<string, CardItem>()
  const keyOf = (item: CardItem, location: string) =>
    item.number != null ? `${item.title}|${item.imageUrl}` : `@${location}`
  for (const address of addresses) for (const q of filters) {
    for (let offset = 0; offset < MAX_ORDINALS; offset += PAGE) {
      const txos = await getJson(
        `${API}/txos/address/${encodeURIComponent(address)}/unspent?q=${q}&limit=${PAGE}&offset=${offset}`,
      )
      for (const txo of txos) {
        const item = toCard(txo)
        if (!item) continue
        const key = keyOf(item, txo.outpoint)
        const seen = byKey.get(key)
        if (seen) {
          if (!seen.locations!.includes(txo.outpoint)) seen.locations!.push(txo.outpoint)
        } else {
          byKey.set(key, { ...item, locations: [txo.outpoint] })
        }
      }
      onProgress?.(byKey.size, undefined, [...byKey.values()])
      if (txos.length < PAGE) break
    }
  }
  // the indexer skips some Twetch-era outputs entirely; Twetch's list has them
  const atLocation = new Map<string, CardItem>()
  for (const i of byKey.values()) for (const l of i.locations!) atLocation.set(l, i)
  for (const t of twetch) {
    const item = twetchCard(t)
    if (!item) continue
    const key = keyOf(item, item.id)
    // same name, or the very same output (editions are just "Egg" on chain but "Egg #426" on Twetch)
    const seen = byKey.get(key) ?? atLocation.get(item.id)
    if (!seen) {
      byKey.set(key, item)
      fromTwetchOnly.add(item)
      continue
    }
    if (seen.number == null && item.number != null) {
      seen.title = item.title
      seen.number = item.number
    }
    if (!/#\d+\s*$/.test(seen.title) && t.collectionName) seen.collection = item.collection
    seen.rarity ??= item.rarity
    seen.rank ??= item.rank
    seen.twetch ??= item.twetch
    if (!seen.locations!.includes(item.id)) seen.locations!.push(item.id)
  }
  const items = [...byKey.values()]
  onProgress?.(items.length, 'sorting')
  await fillRarity(items)
  return items
}

/** cards only Twetch's list knew about: they arrive without attributes */
const fromTwetchOnly = new WeakSet<CardItem>()

function twetchCard(t: TwetchToken): CardItem | null {
  const bTx = t.token.image?.replace('b://', '').replace(/@\d+$/, '')
  if (!bTx || !/^[0-9a-f]{64}$/.test(bTx)) return null
  const title = t.token.name
  const outpoint = t.state.currentOutpoint.replace(':', '_')
  return {
    id: outpoint,
    title,
    number: t.token.number ?? undefined,
    collection: (/#\d+\s*$/.test(title) ? title.replace(/\s*#\d+\s*$/, '') : t.collectionName) || title || 'Ordinals',
    imageUrl: `${ORDFS}/${bTx}`,
    rarity: t.token.rarity || undefined,
    rank: t.token.rank || undefined,
    traits: [], // not in Twetch's list; read from the chain by fillTraits
    twetch: t.token.number != null ? { collection: t.collection, number: t.token.number } : undefined,
    owner: t.state.ownerAddress,
    locations: [outpoint],
  }
}

/**
 * Attributes for cards that arrived without any, read from the sigil JSON in
 * the output itself. Runs a few at a time in the background.
 */
export async function fillTraits(items: CardItem[], onFilled?: (item: CardItem) => void, onStart?: () => void) {
  const next = items.filter((i) => fromTwetchOnly.has(i) && !i.traits.length)
  if (next.length) onStart?.()
  const worker = async () => {
    for (let item; (item = next.shift()); ) {
      const traits = await traitsAt(item.locations![0]).catch(() => [])
      if (traits.length) {
        item.traits = traits
        onFilled?.(item)
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
}

const twetchChecked = new WeakMap<CardItem, Promise<void>>()

/**
 * For a card Twetch lists, use Twetch's own traits and rarity: they can differ
 * from the mint data on chain (traits gained later, e.g. Astro Apes' "Slurps";
 * Eggs' "Color"; none at all for Frog Vision Goggles). Fetched once per card,
 * when it's about to be shown; on failure the card keeps the chain's traits.
 */
export function twetchTraits(item: CardItem): Promise<void> {
  if (!item.twetch) return Promise.resolve()
  let p = twetchChecked.get(item)
  if (!p) {
    const { collection, number } = item.twetch
    p = fetch(`https://api.twetch.com/v1/tokens/${collection}/${number}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => {
        const token = r?.token
        // only the very same item: "Dead Frog Cartel #1909" is a later inscription, not Twetch's "Frog Cartel #1909"
        if (!token || token.name !== item.title) return
        // Twetch's card shows exactly these: none if it has none, and "Common" when unrated
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        item.traits = (token.attributes ?? []).map((a: any) => ({ name: a.traitType, value: String(a.value) }))
        item.rarity = token.rarity || 'Common'
      })
      .catch(() => {
        twetchChecked.delete(item) // try again next time
      })
    twetchChecked.set(item, p)
  }
  return p
}

async function traitsAt(outpoint: string): Promise<Trait[]> {
  const [txid, vout] = outpoint.split('_')
  const res = await fetch(`${API}/tx/${txid}`)
  if (!res.ok) return []
  const tx = unwrapTx(new Uint8Array(await res.arrayBuffer()))
  const script = outputScript(tx, Number(vout))
  if (!script) return []
  const text = new TextDecoder()
  for (const p of scriptPushes(script).reverse()) {
    if (p[0] !== 0x7b) continue // '{'
    try {
      const json = JSON.parse(text.decode(p))
      if (Array.isArray(json.attributes)) {
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        return json.attributes.map((a: any) => ({ name: a.trait_type ?? a.trait ?? a.name, value: a.value, rarity: a.rarity }))
      }
    } catch {
      /* not the metadata push */
    }
  }
  return []
}

function outputScript(tx: Uint8Array, vout: number) {
  let o = 4
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
    o += 36
    const len = varint()
    o += len + 4
  }
  const outputs = varint()
  for (let i = 0; i < outputs; i++) {
    o += 8
    const len = varint()
    if (i === vout) return tx.subarray(o, o + len)
    o += len
  }
  return null
}

// Rarity tiers by rank as a share of the collection, matching how Frog Cartel
// and other 1Sat collections label their own items (fitted from Frog Cartel).
const TIERS: [number, string][] = [
  [0.01, 'Exotic'],
  [0.04, 'Legendary'],
  [0.1, 'Epic'],
  [0.25, 'Rare'],
  [0.5, 'Uncommon'],
  [Infinity, 'Common'],
]

const sizes = new Map<string, Promise<number | undefined>>()

/** Number of items in a 1Sat collection, from the collection's own record. */
function collectionSize(collectionId: string) {
  let p = sizes.get(collectionId)
  if (!p) {
    p = getJson(`${API}/txos/${collectionId}?script=false`)
      .then((t) => {
        const q = Number((t?.origin?.data?.map ?? t?.data?.map)?.subTypeData?.quantity)
        return q > 0 ? q : undefined
      })
      .catch(() => undefined)
    sizes.set(collectionId, p)
  }
  return p
}

/**
 * Fill in the collection size (shown as "rank / size") and, where a collection
 * only publishes ranks, the rarity tier that rank falls in.
 */
async function fillRarity(items: CardItem[]) {
  const ids = [...new Set(items.filter((i) => i.rank && i.collectionId && !i.series).map((i) => i.collectionId!))]
  const known = new Map(await Promise.all(ids.map(async (id) => [id, await collectionSize(id)] as const)))
  for (const i of items) {
    i.series ??= i.collectionId ? known.get(i.collectionId) : undefined
    if (!i.rarity && i.rank && i.series) i.rarity = TIERS.find(([share]) => i.rank! / i.series! <= share)![1]
  }
}

/** A pasted location like "<txid>:1" or "<txid>_1", as an outpoint. */
export function parseOutpoint(text: string) {
  const m = text.trim().match(/^([0-9a-f]{64})[:_.](\d+)$/i)
  return m ? `${m[1].toLowerCase()}_${m[2]}` : null
}

/** One ordinal by its location, with whoever holds it now. */
export async function ordinalAt(outpoint: string): Promise<{ item: CardItem | null; owner?: string; spent: boolean }> {
  const txo = await getJson(`${API}/txos/${outpoint}?script=false`)
  return { item: toCard(txo), owner: txo.owner || undefined, spent: !!txo.spend }
}

/**
 * Endless supply of cards. Owner mode cycles their collection forever;
 * random mode keeps pulling fresh random slices.
 */
export class CardFeed {
  private queue: CardItem[] = []
  private owned: CardItem[] | null = null
  private ownedIdx = 0
  private loading: Promise<void> | null = null

  constructor(owned?: CardItem[]) {
    if (owned?.length) this.owned = shuffle([...owned])
  }

  get isOwnerMode() {
    return !!this.owned
  }

  async next(): Promise<CardItem> {
    if (this.owned) {
      const item = this.owned[this.ownedIdx % this.owned.length]
      this.ownedIdx++
      return item
    }
    if (this.queue.length < 4) this.refill()
    if (!this.queue.length) await this.refill()
    const item = this.queue.shift()
    if (!item) throw new Error('No cards available')
    return item
  }

  private refill() {
    this.loading ??= randomCards()
      .then((items) => {
        this.queue.push(...items)
      })
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }
}
