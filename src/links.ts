// Wallets like Twetch keep coins at one address and ordinals at another, so a
// pasted receive address can hold no ordinals at all. Two ways to find the rest
// of the wallet:
//  1. Twetch: the receive address's public key (visible in any tx it signed)
//     identifies the Twetch account, and Twetch reports that account's
//     ordinals address.
//  2. Any wallet: an address that signed a transaction alongside this one,
//     where this one paid with plain coins. Both signatures must be full
//     (SIGHASH ALL); pre-signed market listings use SINGLE|ANYONECANPAY, so a
//     buyer is never linked to the seller they bought from.

import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { scriptPushes, unwrapTx } from './bfile'

const API = 'https://ordinals.gorillapool.io/api'
const TWETCH = 'https://api.twetch.com/v1'
const SIGHASH_ALL_FORKID = 0x41
const MAX_TXS = 300 // most recent spends checked; plenty to catch a wallet's own pair
const PARALLEL = 8

export interface TwetchWallet {
  account: TwetchAccount | null
  /** ordinals addresses Twetch has on file, not including the looked-up address */
  linked: string[]
  /** Twetch's own list of the account's NFTs (it catches some the ordinals indexer missed) */
  tokens: TwetchToken[]
}

export interface TwetchToken {
  collection: string // Twetch's collection id
  collectionName?: string
  state: { currentOutpoint: string; ownerAddress?: string }
  token: { image?: string; name: string; number?: number; rank?: number; rarity?: string }
}

/**
 * Fast: the Twetch account behind `address` (found via the public key in a tx
 * it signed) and the ordinals addresses Twetch has on file for it. null if it
 * isn't a Twetch account.
 */
export async function twetchLinked(address: string): Promise<TwetchWallet | null> {
  const spends = await spendingTxs(address, 3)
  for (const txid of spends) {
    const key = (await signers(txid).catch(() => [])).find((s) => s.address === address)?.key
    if (!key) continue
    const res = await fetch(`${TWETCH}/auth/user-by-pubkey/${key}`)
    if (!res.ok) return null
    const { userId } = await res.json()
    if (typeof userId !== 'number') return null
    const [account, { addresses, tokens }] = await Promise.all([
      fetch(`${TWETCH}/users/${userId}`).then((r) => (r.ok ? r.json().then(toAccount) : null)).catch(() => null),
      twetchHoldings(userId),
    ])
    return { account, linked: addresses.filter((a) => a !== address), tokens }
  }
  return null
}

/**
 * Slow: addresses that signed a transaction alongside `address` while it paid
 * with plain coins. Reads each of its recent spending transactions.
 */
export async function cosignedAddresses(address: string, onProgress?: (done: number, total: number) => void) {
  const spends = await spendingTxs(address)
  const linked = new Set<string>()
  let done = 0
  const next = [...spends]
  const worker = async () => {
    for (let txid; (txid = next.shift()); ) {
      const s = await signers(txid).catch(() => [])
      // this address paid with plain coins (a P2PKH unlock is exactly <sig> <pubkey>)
      if (s.some((x) => x.address === address && x.plain)) for (const x of s) if (x.address !== address) linked.add(x.address)
      onProgress?.(++done, spends.length)
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))
  return [...linked]
}

export interface TwetchAccount {
  id: number
  name: string
  icon?: string
  followers: number
  publicKey: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const toAccount = (u: any): TwetchAccount => ({
  id: u.id,
  name: u.name ?? `User ${u.id}`,
  icon: u.icon,
  followers: u.numFollowers ?? 0,
  publicKey: u.publicKey,
})
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Twetch accounts for a name or user number. Display names aren't unique, so
 * `exact` can hold several; `close` are near misses for when nothing matches.
 */
export async function twetchAccounts(query: string): Promise<{ exact: TwetchAccount[]; close: TwetchAccount[] }> {
  const q = query.trim().replace(/^@/, '')
  if (/^\d+$/.test(q)) {
    const res = await fetch(`${TWETCH}/users/${q}`)
    return { exact: res.ok ? [toAccount(await res.json())] : [], close: [] }
  }
  const res = await fetch(`${TWETCH}/search/users?q=${encodeURIComponent(q)}&limit=50`) // 8 by default; capped at 25
  if (!res.ok) throw new Error(`${res.status}`)
  const body = await res.json()
  const all: TwetchAccount[] = ((Array.isArray(body) ? body : body.data) ?? [])
    .filter((u: { publicKey?: string }) => u.publicKey)
    .map(toAccount)
  const exact = all.filter((a) => a.name.trim().toLowerCase() === q.toLowerCase())
  exact.sort((a, b) => b.followers - a.followers)
  return { exact, close: exact.length ? [] : all.slice(0, 8) }
}

/** A Twetch account's receive address, plus its ordinals addresses and NFT list. */
export async function twetchWallet(account: TwetchAccount): Promise<{ receive: string } & TwetchWallet> {
  const receive = toAddress(ripemd160(sha256(fromHex(account.publicKey))))
  const { addresses, tokens } = await twetchHoldings(account.id)
  return { receive, account, linked: addresses.filter((a) => a !== receive), tokens }
}

// Twetch's own site sends uploaded avatars ("<hash>.jpeg", "avatars/2021/…")
// and its old cimg.twetch.com links to this host.
const TWETCH_MEDIA = 'https://media.ordinalswallet.com'

/** Profile picture URL for a Twetch account, resolved the way twetch.com does it. */
export function twetchIcon(icon?: string) {
  const s = icon?.trim()
  if (!s || s === '?') return null
  const b = /^(?:b:\/\/)?([a-f0-9]{64})(?:@\d{1,3})?$/i.exec(s) // b://<txid>, or <txid>@<output>
  if (b) return `https://ordfs.network/${b[1].toLowerCase()}`
  const btc = /^ord:\/\/([a-f0-9]{64}i\d{1,10})$/i.exec(s) // a Bitcoin inscription
  if (btc) return `https://cdn.ordinalswallet.com/inscription/content/${btc[1].toLowerCase()}`
  if (s.startsWith('/')) return `https://twetch.com${s}`
  if (/^https?:\/\//i.test(s)) {
    return s.replace(/^http:/, 'https:').replace(/\/\/(cimg|media)\.twetch\.(com|app)\//, '//media.ordinalswallet.com/')
  }
  if (!s.includes('://')) return `${TWETCH_MEDIA}/${s}`
  return null
}

/**
 * Where a Twetch account keeps its ordinals: its NFT ("twonk") address, plus
 * every address its Twetch token list says holds one of its items.
 */
async function twetchHoldings(userId: number): Promise<{ addresses: string[]; tokens: TwetchToken[] }> {
  const found = new Set<string>()
  const [twonk, list] = await Promise.all([
    fetch(`${TWETCH}/users/${userId}/twonk-address`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`${TWETCH}/wallet/${userId}/tokens`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ])
  if (typeof twonk?.address === 'string') found.add(twonk.address)
  const tokens: TwetchToken[] = (list?.data ?? []).filter((t: TwetchToken) => t?.state?.currentOutpoint && t?.token?.name)
  for (const t of tokens) if (t.state.ownerAddress) found.add(t.state.ownerAddress)
  return { addresses: [...found], tokens }
}

/** Transactions that spent coins from `address`, newest first. */
async function spendingTxs(address: string, max = MAX_TXS) {
  const spent = new Map<string, number>()
  for (let offset = 0; offset < 10000; offset += 1000) {
    const res = await fetch(`${API}/txos/address/${encodeURIComponent(address)}/history?limit=1000&offset=${offset}`)
    if (!res.ok) throw new Error(`${res.status}`)
    const txos: { spend?: string; spend_height?: number | null }[] = await res.json()
    for (const t of txos) if (t.spend) spent.set(t.spend, t.spend_height ?? Infinity)
    if (txos.length < 1000) break
  }
  return [...spent].sort((a, b) => b[1] - a[1]).slice(0, max).map(([txid]) => txid)
}

interface Signer {
  address: string
  key: string
  /** a plain P2PKH unlock (coins), rather than one carrying extra data (e.g. a sigil NFT) */
  plain: boolean
}

/** Inputs of `txid` signed with a full (ALL|FORKID) signature. */
async function signers(txid: string): Promise<Signer[]> {
  const res = await fetch(`${API}/tx/${txid}`)
  if (!res.ok) throw new Error(`${res.status}`)
  const tx = unwrapTx(new Uint8Array(await res.arrayBuffer()))
  const out: Signer[] = []
  for (const script of unlockingScripts(tx)) {
    // P2PKH-style unlocks push <sig> <pubkey>, sometimes followed by more data
    const p = scriptPushes(script)
    for (let i = 0; i + 1 < p.length; i++) {
      const [sig, key] = [p[i], p[i + 1]]
      const isSig = sig.length >= 9 && sig.length <= 73 && sig[0] === 0x30
      const isKey = (key.length === 33 && (key[0] === 2 || key[0] === 3)) || (key.length === 65 && key[0] === 4)
      if (isSig && isKey && sig[sig.length - 1] === SIGHASH_ALL_FORKID) {
        out.push({ address: toAddress(ripemd160(sha256(key))), key: toHex(key), plain: p.length === 2 })
        break
      }
    }
  }
  return out
}

function varint(b: Uint8Array, o: number): [number, number] {
  const n = b[o]
  if (n < 0xfd) return [n, o + 1]
  const len = n === 0xfd ? 2 : n === 0xfe ? 4 : 8
  let v = 0
  for (let i = 0; i < len; i++) v += b[o + 1 + i] * 2 ** (8 * i)
  return [v, o + 1 + len]
}

function unlockingScripts(tx: Uint8Array) {
  let [count, o] = varint(tx, 4)
  const scripts: Uint8Array[] = []
  while (count--) {
    const [len, at] = varint(tx, o + 36) // skip previous txid + index
    scripts.push(tx.subarray(at, at + len))
    o = at + len + 4 // sequence
  }
  return scripts
}

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)))

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function toAddress(pkh: Uint8Array) {
  const body = new Uint8Array([0, ...pkh])
  const bytes = new Uint8Array([...body, ...sha256(sha256(body)).subarray(0, 4)])
  let n = bytes.reduce((v, x) => v * 256n + BigInt(x), 0n)
  let s = ''
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s
    n /= 58n
  }
  for (const x of bytes) {
    if (x) break
    s = '1' + s
  }
  return s
}
