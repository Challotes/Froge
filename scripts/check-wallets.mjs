// Reads real wallets with Froge's own code (src/feed.ts) and counts what an
// owner would see: how many ordinals show, which are skipped and why, and any
// data Froge fails to read (a rarity on chain but no rarity on the card, a
// missing name, an ordinal that broke the reader).
//
// Wallets are picked at random each run: recent market buyers and holders from
// across the history of 1Sat inscriptions (GorillaPool's public indexer). No
// addresses are stored. Run it after changing how ordinals are read:
//
//   node scripts/check-wallets.mjs          # 100 wallets
//   node scripts/check-wallets.mjs 300      # more wallets, slower
//
// Each wallet reads at most its first 300 ordinals (the site reads up to 6,000).

import { createServer } from 'vite'

const API = 'https://ordinals.gorillapool.io/api'
const WALLETS = Number(process.argv[2]) || 100
const FROGE_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'exotic', 'legendary', 'mythical', 'mythic', 'super rare', 'ultra rare']

async function get(path) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(API + path, { signal: AbortSignal.timeout(30_000) })
      if (r.ok) return await r.json()
      if (r.status < 500) return []
    } catch {
      /* try again */
    }
  }
  return []
}

const shuffle = (a) => a.sort(() => Math.random() - 0.5)

// --- pick wallets
const buyers = new Set()
const holders = new Set()
for (let i = 0; i < 6; i++) {
  for (const s of await get(`/market/sales?limit=300&offset=${Math.floor(Math.random() * 9000)}`)) if (s.owner) buyers.add(s.owner)
  for (const t of await get(`/inscriptions/search?limit=300&offset=${Math.floor(Math.random() * 6e6)}`)) if (t.owner && !t.spend) holders.add(t.owner)
}
const wallets = [...new Set([...shuffle([...buyers]).slice(0, WALLETS / 2), ...shuffle([...holders])])].slice(0, WALLETS)
console.log(`Reading ${wallets.length} wallets…`)

// --- Froge's reader, loaded through Vite so the TypeScript runs as-is
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
const { toCard } = await vite.ssrLoadModule('/src/feed.ts')
let unreadable = 0
console.warn = () => unreadable++ // toCard warns when it skips an ordinal it couldn't read

const counts = {}
const add = (k) => (counts[k] = (counts[k] ?? 0) + 1)
const oddWords = {}
const filters = [{ insc: {} }, { sigil: {} }].map((f) => Buffer.from(JSON.stringify(f)).toString('base64'))
let done = 0
const queue = [...wallets]
await Promise.all(
  Array.from({ length: 5 }, async () => {
    for (let a; (a = queue.shift()); ) {
      for (const q of filters) {
        for (const txo of await get(`/txos/address/${a}/unspent?q=${q}&limit=300&offset=0`)) {
          add('ordinals')
          const map = txo.origin?.data?.map
          const type = txo.origin?.data?.insc?.file?.type ?? (txo.data?.sigil ? 'Twetch-era' : 'unknown')
          const before = unreadable
          const item = toCard(txo)
          if (unreadable > before) add('unreadable: metadata Froge could not read')
          else if (!item) {
            const kind = type === 'text/html' ? 'web page (HTML)' : type.replace(/^(video|audio|model|text)\/.*/, '$1')
            add(type.startsWith('image/') ? `skipped: ${type}` : `not shown: ${kind}`)
          }
          else {
            add('shown')
            if (item.title === 'Untitled') add('shown as "Untitled"')
            const sd = map?.subTypeData ?? {}
            const word = [sd.rarityLabel, map?.rarity, sd.rank].find((v) => typeof v === 'string' && v.trim() && !(Number(v) > 0))
            if (word && !item.rarity) add('rarity on chain, not read')
            if (word && !FROGE_RARITIES.includes(word.trim().toLowerCase())) oddWords[word.trim()] = (oddWords[word.trim()] ?? 0) + 1
          }
        }
      }
      if (++done % 20 === 0) console.log(`  ${done} wallets`)
    }
  }),
)
await vite.close()

console.log()
for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(8)}  ${k}`)
const odd = Object.entries(oddWords)
if (odd.length) console.log(`\nRarity words with no card colour (add them to RARITY_ALIAS in src/cardArt.ts): ${odd.map(([w, n]) => `${w} (${n})`).join(', ')}`)
const problems = (counts['unreadable: metadata Froge could not read'] ?? 0) + (counts['rarity on chain, not read'] ?? 0) + odd.length
console.log(problems ? '\nSomething to look at above.' : '\nNo reading problems found.')
process.exit(problems ? 1 : 0)
