import './style.css'
import { CardFeed, FROG_CARTEL, ServerError, fillTraits, ordinalAt, ordinalsOwnedBy, parseOutpoint, type CardItem } from './feed'
import { cosignedAddresses, twetchAccounts, twetchLinked, twetchWallet, twetchIcon, type TwetchAccount, type TwetchWallet } from './links'
import { loadImage, RARITY_COLORS } from './cardArt'
import { layoutOf, pickLayout } from './fullArt'
import { Cart, money, PRICE_TIERS, priceAt } from './cart'
import { FrogStage } from './stage'
import { setImageSrc } from './bfile'
import { setThumbSrc } from './thumbs'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T

const params = new URLSearchParams(location.search)
const status = $('#status')
const title = $('#card-title')
const meta = $('#card-meta')
const layoutBox = $('#layout')
const pauseBtn = $<HTMLButtonElement>('#pause')
const addBtn = $<HTMLButtonElement>('#add')
const prevBtn = $<HTMLButtonElement>('#prev')
const fwdBtn = $<HTMLButtonElement>('#fwd')
const stageEl = $('#stage')

// shown if the indexer can't be reached at all
const OFFLINE_CARD: CardItem = {
  id: 'offline',
  title: 'Frog Cartel',
  collection: FROG_CARTEL.name,
  imageUrl: '/frog-face.webp',
  rarity: 'Offline',
  traits: [{ name: 'Status', value: 'Indexer unreachable' }],
}

let feed = new CardFeed()
let owned: CardItem[] = []
let mine = new Set<string>() // ids of the looked-up wallet's cards, including ones shown before the search finishes
const cart = new Cart()

// --- history ------------------------------------------------------------------
// Every card handed to the frog, in order, so the arrows can go back and forth.
const deck: CardItem[] = []
let cursor = -1 // last card handed to the stage
let shown = -1 // card whose face is showing
let aim = -1 // card we're flipping towards (lets quick taps on the arrows add up)
let showing: CardItem | null = null

const withImage = async (item: CardItem) => ({ item, img: await loadImage(item.imageUrl).catch(() => null) })

async function nextCard() {
  const i = ++cursor
  let item = deck[i]
  if (!item) {
    item = await feed.next().catch(() => OFFLINE_CARD)
    // a gallery pick may have taken this slot meanwhile; the stage drops this card then
    deck[i] ??= item
  }
  return withImage(item)
}

function goTo(i: number) {
  if (i < 0) return
  if (i >= deck.length) {
    stage.next() // fresh card, already being prefetched
    return
  }
  aim = cursor = i
  stage.jump(withImage(deck[i]))
}

/** Put a specific card in the frog's hand (gallery pick). */
function present(item: CardItem) {
  deck.push({ ...item }) // a new history entry, even if seen before
  goTo(deck.length - 1)
}

function setStatus(text: string) {
  status.textContent = text
}

function onReveal(item: CardItem) {
  showing = item
  aim = shown = deck.indexOf(item)
  title.textContent = item.title
  const bits = [item.rarity, item.rank ? `Rank ${item.rank}` : null].filter(Boolean)
  meta.textContent = bits.join(' · ')
  showLayout(item)
  prevBtn.disabled = shown <= 0
  markGallery()
  showAdd()
}

// --- Classic / Full art switch, for art close to the card's shape (fullArt.ts) ---
function showLayout(item: CardItem) {
  const { layout, choosable } = layoutOf(item, stage.currentArt)
  layoutBox.hidden = !choosable
  for (const b of layoutBox.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.layout === layout))
}

layoutBox.addEventListener('click', (e) => {
  const pick = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-layout]')?.dataset.layout
  if (!showing || (pick !== 'classic' && pick !== 'full') || pick === layoutOf(showing, stage.currentArt).layout) return
  pickLayout(showing, pick)
  stage.redrawFront()
  showLayout(showing)
})

// --- add to cart (only while a face is showing) --------------------------------
function placeAdd() {
  const a = stage.anchor()
  const c = stage.canvas.getBoundingClientRect()
  const s = stageEl.getBoundingClientRect()
  addBtn.style.left = `${c.left - s.left + a.x}px`
  // under the card, but never below the stage, where it would cover the card's name
  const h = addBtn.offsetHeight || 48
  addBtn.style.top = `${Math.min(c.top - s.top + a.y + 14, s.height - h - 8)}px`
}

function renderAdd() {
  if (!showing) return
  const inCart = cart.has(showing.id)
  addBtn.classList.toggle('in-cart', inCart)
  addBtn.querySelector('.add-label')!.textContent = inCart ? 'In your cart' : 'Add to cart'
  $('#add-price').textContent = inCart ? '✓' : money(cart.nextPrice)
  addBtn.setAttribute('aria-label', inCart ? `${showing.title} is in your cart, remove it` : `Add ${showing.title} to cart for ${money(cart.nextPrice)}`)
}

function showAdd() {
  // only for ordinals the visitor looked up: random cards can't be ordered
  if (!showing || showing.id === 'offline' || !mine.has(showing.id)) return
  renderAdd()
  addBtn.hidden = false
  placeAdd()
  addBtn.classList.remove('out')
}

function hideAdd() {
  addBtn.classList.add('out')
  stage.hold(false)
}

addBtn.addEventListener('transitionend', () => {
  if (addBtn.classList.contains('out')) addBtn.hidden = true
})
addBtn.addEventListener('pointerenter', () => stage.hold(true))
addBtn.addEventListener('pointerleave', () => stage.hold(false))
addBtn.addEventListener('click', () => toggleCart(showing, addBtn))

function toggleCart(item: CardItem | null, from: HTMLElement) {
  if (!item) return
  if (cart.has(item.id)) {
    cart.remove(item.id)
    toast(`Removed ${item.title}`)
    return
  }
  const price = cart.nextPrice
  cart.add(item)
  flyToCart(item, from)
  const next = cart.nextPrice
  toast(next < price ? `Added for ${money(price)} · your next card is only ${money(next)}` : `Added for ${money(price)}`)
}

/** A little copy of the art arcs into the basket. */
function flyToCart(item: CardItem, from: HTMLElement) {
  const a = from.getBoundingClientRect()
  const b = $('#cart-btn').getBoundingClientRect()
  const img = new Image()
  setImageSrc(img, item.imageUrl)
  img.className = 'flyer'
  document.body.append(img)
  const x0 = a.left + a.width / 2 - 28
  const y0 = a.top + a.height / 2 - 28
  const dx = b.left + b.width / 2 - 28 - x0
  const dy = b.top + b.height / 2 - 28 - y0
  img
    .animate(
      [
        { transform: `translate(${x0}px, ${y0}px) scale(0.6) rotate(0deg)`, opacity: 0 },
        { transform: `translate(${x0 + dx * 0.3}px, ${y0 + dy * 0.3 - 120}px) scale(1.25) rotate(-12deg)`, opacity: 1, offset: 0.35 },
        { transform: `translate(${x0 + dx}px, ${y0 + dy}px) scale(0.3) rotate(20deg)`, opacity: 0.4 },
      ],
      { duration: 750, easing: 'cubic-bezier(.3,.7,.4,1)' },
    )
    .finished.then(() => {
      img.remove()
      const btn = $('#cart-btn')
      btn.classList.remove('bump')
      void btn.offsetWidth
      btn.classList.add('bump')
    })
}

// --- cart sheet ----------------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function thumb(item: CardItem) {
  const img = el('img', 'thumb')
  img.alt = ''
  img.decoding = 'async'
  setThumbSrc(img, item.imageUrl)
  return img
}

function renderCart() {
  const n = cart.count
  const badge = $('#cart-count')
  badge.hidden = n === 0
  badge.textContent = String(n)
  $('#cart-total').textContent = n ? money(cart.total) : 'Cart'

  const ladder = $('#ladder')
  ladder.replaceChildren(
    ...PRICE_TIERS.map((p, i) => {
      const last = i === PRICE_TIERS.length - 1
      const li = el('li')
      li.append(el('span', 'tier-n', last ? `${i + 1}+ cards` : i === 0 ? '1st card' : `${i + 1}${i === 1 ? 'nd' : 'rd'} card`))
      li.append(el('b', '', last ? `${money(p)} each` : money(p)))
      const reached = n > i
      li.classList.toggle('reached', reached)
      li.classList.toggle('next', !reached && n === i)
      return li
    }),
  )

  $('#lines').replaceChildren(
    ...cart.items.map((item, i) => {
      const li = el('li', 'line')
      const info = el('div', 'line-info')
      info.append(el('span', 'line-title', item.title), el('span', 'line-meta', item.rarity ?? item.collection))
      const price = el('span', 'line-price', money(priceAt(i)))
      const rm = el('button', 'rm', '×')
      rm.setAttribute('aria-label', `Remove ${item.title}`)
      rm.addEventListener('click', () => cart.remove(item.id))
      const show = el('button', 'line-show')
      show.setAttribute('aria-label', `Show ${item.title} in Froge's hand`)
      show.append(thumb(item))
      show.addEventListener('click', () => {
        present(item)
        closeSheets()
      })
      li.append(show, info, price, rm)
      return li
    }),
  )
  $('#cart-empty').hidden = n > 0
  $('#subtotal').textContent = money(cart.total)
  $('#save-row').hidden = cart.savings <= 0
  $('#savings').textContent = `−${money(cart.savings)}`
  $<HTMLButtonElement>('#checkout').disabled = n === 0
  $('#checkout').textContent = n ? `Checkout · ${money(cart.total)}` : 'Checkout'
  renderAdd()
  markGallery()
}
cart.addEventListener('change', renderCart)

$('#checkout').addEventListener('click', () => toast('Checkout is the next thing we build. Your cart is saved on this device.'))

// --- ordinals sheet -----------------------------------------------------------
// Every ordinal at the address, filterable by collection chip and search box.
const grid = $('#grid')
const gridMsg = $('#grid-msg')
const chips = $('#chips')
const filterInput = $<HTMLInputElement>('#filter')
const tiles = new Map<string, HTMLElement>()
let activeCollection: string | null = null

// One-off items (a meme, a 1/1) would each get a chip of their own, so any
// collection with a single item at the address shares one "One of a kind" chip.
const ONE_OFFS = 'One of a kind'
let collectionCounts = new Map<string, number>()
const groupOf = (i: CardItem) => ((collectionCounts.get(i.collection) ?? 0) > 1 ? i.collection : ONE_OFFS)

function countCollections() {
  collectionCounts = new Map()
  for (const i of owned) collectionCounts.set(i.collection, (collectionCounts.get(i.collection) ?? 0) + 1)
}

/** Collections at the address, biggest first, Frog Cartel always leading, one-offs last. */
function collections() {
  const counts = new Map<string, number>()
  for (const i of owned) counts.set(groupOf(i), (counts.get(groupOf(i)) ?? 0) + 1)
  return [...counts].sort(
    (a, b) =>
      Number(b[0] === FROG_CARTEL.name) - Number(a[0] === FROG_CARTEL.name) ||
      Number(a[0] === ONE_OFFS) - Number(b[0] === ONE_OFFS) ||
      b[1] - a[1] ||
      a[0].localeCompare(b[0]),
  )
}

const searchText = (item: CardItem) => [item.title, item.rarity, ...item.traits.map((t) => t.value)].join(' ').toLowerCase()

let renderGen = 0
let rendering = false // tiles still being added

/**
 * Build the gallery. Big wallets have thousands of tiles, so they're added a
 * batch per frame (first screenful at once) to keep the page responsive.
 * Resolves once every tile is in.
 */
function renderGallery(): Promise<void> {
  const gen = ++renderGen
  rendering = true
  tiles.clear()
  countCollections()
  const cols = collections()
  // a re-render (more ordinals found) can regroup collections; never filter to one that's gone
  if (activeCollection && !cols.some(([c]) => c === activeCollection)) activeCollection = null
  const rank = new Map(cols.map(([c], i) => [c, i]))
  const sorted = [...owned].sort(
    (a, b) => rank.get(groupOf(a))! - rank.get(groupOf(b))! || (a.number ?? 1e9) - (b.number ?? 1e9) || a.title.localeCompare(b.title),
  )
  grid.replaceChildren()
  const done = new Promise<void>((resolve) => {
    let i = 0
    const batch = () => {
      if (gen !== renderGen) return resolve()
      const frag = document.createDocumentFragment()
      for (const end = Math.min(i + (i ? 300 : 150), sorted.length); i < end; i++) {
        const tile = makeTile(sorted[i])
        tile.hidden = !tileShown(tile)
        markTile(tile)
        frag.append(tile)
      }
      grid.append(frag)
      if (i < sorted.length) return requestAnimationFrame(batch)
      rendering = false
      applyFilter() // final count for the "nothing matches" message
      resolve()
    }
    batch()
  })

  const chip = (label: string, count: number, col: string | null) => {
    const b = el('button', 'chip')
    b.setAttribute('role', 'tab')
    b.dataset.col = col ?? ''
    b.append(label, el('span', 'chip-n', count.toLocaleString()))
    b.addEventListener('click', () => pickCollection(col))
    return b
  }
  chips.replaceChildren(chip('All', owned.length, null), ...cols.map(([c, n]) => chip(c, n, c)))
  chips.hidden = cols.length < 2
  chipsExpanded = false
  const across = wallet.length > 1 ? ` across ${wallet.length} linked addresses` : ''
  $('#collection-sub').textContent = `${owned.length.toLocaleString()} ordinal${owned.length === 1 ? "" : "s"}${across} · tap one to put it in his hand`
  $('#collection-sub').title = wallet.join('\n')
  applyFilter()
  return done
}

function makeTile(item: CardItem) {
  const tile = el('div', 'tile')
  tile.dataset.col = groupOf(item)
  tile.dataset.search = searchText(item)
  const pick = el('button', 'tile-pick')
  pick.setAttribute('aria-label', `Show ${item.title} in Froge's hand`)
  pick.append(thumb(item))
  const label = el('span', 'tile-label')
  const dot = el('i', 'dot')
  dot.style.background = RARITY_COLORS[(item.rarity ?? '').toLowerCase()] ?? 'var(--muted)'
  if (item.number != null) label.append(dot, el('b', '', `#${item.number}`), el('span', 'tile-name', item.collection))
  else label.append(dot, el('span', 'tile-name', item.title))
  pick.title = item.title
  pick.append(label)
  pick.addEventListener('click', () => {
    present(item)
    if (matchMedia('(max-width: 760px)').matches) closeSheets()
  })
  const quick = el('button', 'tile-add')
  quick.addEventListener('click', () => toggleCart(item, quick))
  tile.append(pick, quick)
  tile.dataset.id = item.id
  tiles.set(item.id, tile)
  return tile
}

/** Filter the panel to one collection and have the frog flick through it. */
function pickCollection(col: string | null, start?: CardItem) {
  activeCollection = col
  const pool = col ? owned.filter((i) => groupOf(i) === col) : owned
  feed = new CardFeed(pool)
  setStatus(col ? `Flicking through ${col} · ${pool.length.toLocaleString()}` : `Your ordinals · ${owned.length.toLocaleString()}`)
  applyFilter()
  present(start ?? pool[Math.floor(Math.random() * pool.length)])
}

function tileShown(tile: HTMLElement) {
  const q = filterInput.value.trim().toLowerCase()
  return (!activeCollection || tile.dataset.col === activeCollection) && (!q || tile.dataset.search!.includes(q))
}

function applyFilter() {
  let visible = 0
  for (const tile of tiles.values()) {
    const show = tileShown(tile)
    tile.hidden = !show
    if (show) visible++
  }
  for (const b of chips.children) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.col === (activeCollection ?? '')))
  // while tiles are still being added the matches may just not be in yet
  if (owned.length) showGridMessage(visible || rendering ? '' : 'Nothing matches that search.')
  layoutChips()
}

// Collection chips wrap to two rows; the rest fold behind a "+N more" chip.
let chipsExpanded = false
const moreChip = el('button', 'chip chip-more')
moreChip.addEventListener('click', () => {
  chipsExpanded = !chipsExpanded
  layoutChips()
})

// Chip widths are measured once per set of chips and the wrapping is worked out
// here, because measuring the page repeatedly (with thousands of tiles in it)
// froze big wallets for seconds.
const CHIP_GAP = 6
const chipWidths = new WeakMap<HTMLElement, number>()
let moreWidth = 0
let chipsWidth = 0 // kept up to date by the ResizeObserver below, so reading it never forces layout

function layoutChips() {
  chips.classList.toggle('expanded', chipsExpanded)
  const all = [...chips.querySelectorAll<HTMLElement>('.chip:not(.chip-more)')]
  if (chips.hidden || !chipsWidth || !all.length) {
    moreChip.remove()
    for (const c of all) c.hidden = false
    return // laid out once the panel is showing
  }
  if (all.some((c) => !chipWidths.has(c)) || !moreWidth) {
    // one measuring pass, with every chip showing
    for (const c of all) c.hidden = false
    moreChip.textContent = '+88 more'
    chips.append(moreChip)
    for (const c of all) chipWidths.set(c, c.offsetWidth)
    moreWidth = moreChip.offsetWidth
  }
  const rowsFor = (widths: number[]) => {
    let rows = 1
    let x = 0
    for (const w of widths) {
      if (x > 0 && x + w > chipsWidth) {
        rows++
        x = 0
      }
      x += w + CHIP_GAP
    }
    return rows
  }
  const widths = all.map((c) => chipWidths.get(c)!)
  if (rowsFor(widths) <= 2) {
    moreChip.remove()
    for (const c of all) c.hidden = false
    return
  }
  chips.append(moreChip)
  if (chipsExpanded) {
    for (const c of all) c.hidden = false
    moreChip.textContent = 'Show less'
    return
  }
  // keep chips in order while they (and "+N more") fit on two rows; the selected one always stays
  const keep = new Set<number>()
  for (let i = 0; i < all.length; i++) {
    const trial = [...keep, i].sort((a, b) => a - b)
    if (rowsFor([...trial.map((j) => widths[j]), moreWidth]) <= 2) keep.add(i)
    else break
  }
  const selected = all.findIndex((c) => c.getAttribute('aria-selected') === 'true')
  if (selected >= 0 && !keep.has(selected)) {
    keep.add(selected)
    for (const j of [...keep].sort((a, b) => b - a)) {
      const order = [...keep].sort((a, b) => a - b)
      if (rowsFor([...order.map((k) => widths[k]), moreWidth]) <= 2) break
      if (j !== selected) keep.delete(j)
    }
  }
  all.forEach((c, i) => (c.hidden = !keep.has(i)))
  moreChip.textContent = `+${all.length - keep.size} more`
}

new ResizeObserver(([entry]) => {
  const width = entry.contentRect.width
  if (width === chipsWidth) return // only re-fold when the width changes
  chipsWidth = width
  layoutChips()
}).observe(chips)

function showGridMessage(text: string) {
  setBusy(false)
  gridMsg.classList.remove('loading')
  grid.querySelectorAll('.skeleton').forEach((s) => s.remove())
  gridMsg.textContent = text
  gridMsg.hidden = !text
}

// --- searching indicators ---------------------------------------------------------
// A lookup can take several seconds, so every stage of it shows that work is happening:
// "Your ordinals" counts up as they're found, the status line pulses and the panel
// shimmers with placeholder tiles.
const browseBtn = $<HTMLButtonElement>('#browse')
const sheetGo = $<HTMLButtonElement>('#sheet-lookup button[type="submit"]')

/** `progress`: the short version for the "Your ordinals" button. */
function setBusy(on: boolean, progress = 'Searching…') {
  document.body.classList.toggle('searching', on)
  sheetGo.classList.toggle('busy', on)
  sheetGo.textContent = on ? 'Searching…' : 'Show ordinals'
  browseBtn.classList.toggle('busy', on)
  $('#browse .browse-label').textContent = on ? progress : 'Your ordinals'
  $('#browse-count').hidden = on || !owned.length
  if (on) startTicker()
  else stopTicker()
}

/** Loading state in the panel: a spinner line plus placeholder tiles. */
function showLoading(text: string, progress?: string) {
  setBusy(true, progress)
  setStatus(text)
  gridMsg.classList.add('loading')
  gridMsg.textContent = text
  gridMsg.hidden = false
  if (!grid.querySelector('.tile, .skeleton')) {
    grid.replaceChildren(...Array.from({ length: 12 }, (_, i) => {
      const s = el('div', 'skeleton')
      s.style.animationDelay = `${(i % 3) * 0.12 + Math.floor(i / 3) * 0.08}s`
      return s
    }))
  }
}

/** Reset the ordinals panel for a new search, in a loading state. It stays closed so Froge can be watched. */
function openSearch(text: string, sub = '') {
  owned = []
  mine = new Set()
  tiles.clear()
  grid.replaceChildren()
  people.hidden = true
  chips.hidden = true
  filterInput.hidden = true
  $('#sheet-lookup').hidden = true
  $('#collection-title').textContent = 'Your ordinals'
  $('#collection-sub').textContent = sub
  showLoading(text)
}

/** A search failed: say so in the panel, opened, and offer the search box again. */
function searchFailed(status: string, message: string) {
  setStatus(status)
  showGridMessage(message)
  $('#sheet-lookup').hidden = false
  if (!$('#collection').classList.contains('open')) openSheet('#collection')
}

// background work after the gallery is showing ("still checking…" under the subtitle)
const bgTasks = new Map<string, string>()
function background(key: string, text: string | null) {
  if (text) bgTasks.set(key, text)
  else bgTasks.delete(key)
  const note = $('#bg-note')
  note.hidden = !bgTasks.size
  note.textContent = [...bgTasks.values()].at(-1) ?? ''
}

function markGallery() {
  for (const tile of tiles.values()) markTile(tile)
}

function markTile(tile: HTMLElement) {
  const id = tile.dataset.id!
  const inCart = cart.has(id)
  tile.classList.toggle('in-cart', inCart)
  tile.classList.toggle('current', showing?.id === id)
  const quick = tile.querySelector<HTMLButtonElement>('.tile-add')!
  quick.textContent = inCart ? '✓' : '+'
  quick.setAttribute('aria-label', inCart ? 'In cart, remove' : `Add to cart for ${money(cart.nextPrice)}`)
}

filterInput.addEventListener('input', applyFilter)

// --- sheets -----------------------------------------------------------------------
const scrim = $('#scrim')
let lastFocus: HTMLElement | null = null

// the "Got an idea?" box in Your ordinals can be made smaller; it's full size again next time
const cookStrip = $('#cook-strip')
cookStrip.querySelector('.cook-strip-x')!.addEventListener('click', () => cookStrip.classList.add('min'))

function openSheet(id: string) {
  if (id === '#collection') cookStrip.classList.remove('min')
  closeSheets(false)
  lastFocus = document.activeElement as HTMLElement
  const sheet = $(id)
  sheet.hidden = false
  scrim.hidden = false
  requestAnimationFrame(() => {
    sheet.classList.add('open')
    scrim.classList.add('open')
    document.body.classList.add('sheet-open')
  })
  sheet.querySelector<HTMLElement>('[data-close]')?.focus()
}

function closeSheets(restore = true) {
  for (const sheet of document.querySelectorAll<HTMLElement>('.sheet.open')) {
    sheet.classList.remove('open')
    setTimeout(() => (sheet.hidden = !sheet.classList.contains('open')), 300)
  }
  scrim.classList.remove('open')
  document.body.classList.remove('sheet-open')
  setTimeout(() => (scrim.hidden = !scrim.classList.contains('open')), 300)
  if (restore) lastFocus?.focus()
}

// Market and Mint aren't built: each opens a card inviting people to cook it on OpenCook
const cooking = $<HTMLDialogElement>('#cooking')
for (const tab of document.querySelectorAll<HTMLElement>('[data-cook]')) {
  tab.addEventListener('click', () => {
    const what = tab.dataset.cook!
    $('#cooking-what').textContent = what
    $('#cooking-name').textContent = what
    $('#cooking-go').firstChild!.textContent = what === 'Market' ? 'Cook the Market ' : `Cook ${what} `
    cooking.showModal()
  })
}
cooking.querySelector('.cooking-x')!.addEventListener('click', () => cooking.close())
// a tap on the dimmed page around the card closes it
cooking.addEventListener('click', (e) => {
  if (e.target === cooking) {
    const r = cooking.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) cooking.close()
  }
})

scrim.addEventListener('click', () => closeSheets())
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => closeSheets())
$('#cart-btn').addEventListener('click', () => openSheet('#cart'))
$('#browse').addEventListener('click', () => {
  const fresh = !owned.length && !lookup
  if (fresh) {
    filterInput.hidden = true
    chips.hidden = true
    showGridMessage('Paste a BSV address to see every ordinal it holds, then tap one to put it in Froge’s hand.')
  }
  openSheet('#collection')
  if (fresh) $('#sheet-address').focus()
})

let toastTimer = 0
function toast(text: string) {
  const t = $('#toast')
  t.textContent = text
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600)
}

// --- address lookup -----------------------------------------------------------------

const people = $('#people')
let lookup = 0 // bumps per lookup so a slow old one can't overwrite a newer one
/** The looked-up address plus addresses proven to share its wallet (checkout will accept payment from any). */
let wallet: string[] = []

/** `known`: linked addresses already found (e.g. from a Twetch username), skipping the search. */
async function useAddress(address: string, focus?: string, known?: TwetchWallet) {
  const id = ++lookup
  background('cosign', null)
  background('traits', null)
  for (const i of ['#address', '#sheet-address']) $<HTMLInputElement>(i).value = address
  openSearch(known ? 'Finding your ordinals…' : 'Looking for the rest of your wallet…', address)
  showProfile(known?.account ?? null)
  try {
    // a receive address often holds no ordinals itself; Twetch knows its wallet's ordinals address
    const twetch = known ?? (await twetchLinked(address).catch(() => null))
    if (id !== lookup) return
    showProfile(twetch?.account ?? null)
    const linked = twetch?.linked ?? []
    wallet = [address, ...linked]
    if (linked.length) $('#collection-sub').textContent = `${address} + ${linked.length} linked`
    showLoading(twetch?.account ? `Finding ${twetch.account.name}’s ordinals…` : 'Finding your ordinals…')
    let early = false // their cards are already flipping
    const found = await ordinalsOwnedBy(
      wallet,
      (n, stage, sofar) => {
        if (id !== lookup) return
        if (stage === 'sorting') {
          tickFound = `Sorting your ${n.toLocaleString()}…`
          return showLoading(`Sorting your ${n.toLocaleString()} ordinals…`, `Sorting ${n.toLocaleString()}…`)
        }
        if (!n) return
        tickFound = `Found ${n.toLocaleString()} so far. Ribbit.`
        showLoading(`Finding your ordinals… ${n.toLocaleString()} so far`, `Found ${n.toLocaleString()}…`)
        // flip through what's here already rather than wait for the whole wallet (unless one card was asked for)
        if (!sofar || focus) return
        for (const i of sofar) mine.add(i.id)
        feed = new CardFeed(sofar)
        if (!early) present(sofar[Math.floor(Math.random() * sofar.length)])
        early = true
      },
      twetch?.tokens,
    )
    if (id !== lookup) return
    // not a Twetch wallet: look for co-signing addresses in the background, and add what they hold
    if (!twetch) addCosigned(id, address)
    // cards from Twetch's list come without attributes; read them from chain
    const traits = fillTraits(
      found,
      (item) => {
        if (id !== lookup) return
        const tile = tiles.get(item.id)
        if (tile) tile.dataset.search = searchText(item)
      },
      () => id === lookup && background('traits', 'Reading attributes from the chain…'),
    )
    traits.finally(() => id === lookup && background('traits', null))
    if (!found.length) {
      if (twetch) return searchFailed('No ordinals found · showing random cards', 'No ordinals found in this wallet.')
      // the co-sign search is still going and may yet find some
      return showLoading('Nothing here yet · checking linked addresses…')
    }
    owned = found
    mine = new Set(found.map((i) => i.id))
    activeCollection = null
    filterInput.value = ''
    filterInput.hidden = false
    $('#browse-count').hidden = false
    $('#browse-count').textContent = found.length.toLocaleString()
    const rendered = renderGallery()
    const wanted = focus && found.find((i) => i.id === focus || i.locations?.includes(focus))
    if (wanted) {
      pickCollection(groupOf(wanted), wanted)
      rendered.then(() => tiles.get(wanted.id)?.scrollIntoView({ block: 'center' }))
    } else if (early) {
      // already flipping their cards: carry on with all of them, without a jump
      activeCollection = null
      feed = new CardFeed(found)
      setStatus(`Your ordinals · ${found.length.toLocaleString()}`)
      applyFilter()
    } else {
      pickCollection(null) // everything, until they pick a collection
    }
  } catch (e) {
    console.warn('[froge] address lookup failed', e)
    if (id !== lookup) return
    if (e instanceof ServerError)
      searchFailed(
        'The ordinals server didn’t answer · showing random cards',
        'The ordinals server didn’t answer. If that’s the right address, press Show ordinals to try again.',
      )
    else
      searchFailed(
        'Froge couldn’t read this wallet · showing random cards',
        'Froge tripped over something in this wallet. Press Show ordinals to try again, and if it keeps happening, tell us on OpenCook.',
      )
  }
}

/** Second pass for non-Twetch wallets: add ordinals held at addresses that co-signed with this one. */
async function addCosigned(id: number, address: string) {
  background('cosign', 'Checking for linked addresses…')
  try {
    await addCosignedOrdinals(id, address)
  } finally {
    if (id === lookup) {
      background('cosign', null)
      // still nothing after the slow search too
      if (!owned.length && gridMsg.classList.contains('loading'))
        searchFailed('No ordinals at that address · showing random cards', 'No ordinals found at that address or any linked to it.')
    }
  }
}

async function addCosignedOrdinals(id: number, address: string) {
  const more = await cosignedAddresses(address, (done, total) => {
    if (id === lookup) background('cosign', `Checking for linked addresses… ${done} of ${total}`)
  }).catch(() => [] as string[])
  if (id !== lookup || !more.length) return
  const extra = await ordinalsOwnedBy(more).catch(() => [] as CardItem[])
  if (id !== lookup) return
  wallet = [...wallet, ...more]
  const have = new Set(owned.map((i) => `${i.title}|${i.imageUrl}`))
  const fresh = extra.filter((i) => !have.has(`${i.title}|${i.imageUrl}`))
  if (!fresh.length) return
  const first = !owned.length
  owned = [...owned, ...fresh]
  for (const i of fresh) mine.add(i.id)
  filterInput.hidden = false
  $('#sheet-lookup').hidden = true
  $('#browse-count').hidden = false
  $('#browse-count').textContent = owned.length.toLocaleString()
  renderGallery()
  if (first) {
    showGridMessage('')
    pickCollection(null)
  }
  else applyFilter()
  toast(`Found ${fresh.length.toLocaleString()} more at ${more.length === 1 ? 'a linked address' : `${more.length} linked addresses`}`)
}

/** A pasted ordinal location: find who holds it, then show their whole wallet. */
async function useOutpoint(outpoint: string) {
  const id = ++lookup
  showProfile(null)
  openSearch('Finding that ordinal…', outpoint.replace('_', ':'))
  try {
    const { item, owner, spent } = await ordinalAt(outpoint)
    if (id !== lookup) return
    if (!item || !owner || spent) {
      return spent
        ? searchFailed('That ordinal has moved on', 'That location has been spent, so the ordinal has moved. Paste its new location or an address.')
        : searchFailed('No ordinal found at that location', 'Couldn’t find an ordinal at that location.')
    }
    history.replaceState(null, '', `?address=${encodeURIComponent(owner)}&ordinal=${outpoint}`)
    useAddress(owner, outpoint)
  } catch {
    if (id === lookup) searchFailed('Couldn’t look up that location', 'Couldn’t look up that location. Try again in a moment.')
  }
}

/** A Twetch name or user number. Names aren't unique, so several matches get a picker. */
async function useTwetchName(name: string) {
  const id = ++lookup
  showProfile(null)
  openSearch(`Finding “${name}” on Twetch…`)
  try {
    const { exact, close } = await twetchAccounts(name)
    if (id !== lookup) return
    if (exact.length === 1) return useTwetchAccount(exact[0])
    if (!exact.length && !close.length)
      return searchFailed('No Twetch user by that name', 'Couldn’t find that Twetch user. Paste an address or ordinal location instead.')
    const accounts = exact.length ? exact : close
    // searched from the panel: pick there; otherwise in a list under the search box
    if ($('#collection').classList.contains('open')) return showPeople(name, accounts, !exact.length)
    showGridMessage('')
    setStatus('Pick your Twetch account')
    showSuggest(accounts, exact.length ? `${exact.length} Twetch users are called “${name}”` : `No Twetch user is called “${name}” exactly. Did you mean…`)
  } catch {
    if (id === lookup) searchFailed('Couldn’t reach Twetch', 'Couldn’t reach Twetch. Try again, or paste an address instead.')
  }
}

async function useTwetchAccount(account: TwetchAccount) {
  const id = ++lookup
  openSearch(`Finding ${account.name}’s wallet on Twetch…`)
  showProfile(account)
  try {
    const { receive, ...known } = await twetchWallet(account)
    if (id !== lookup) return
    history.replaceState(null, '', `?twetch=${account.id}`) // the user number is unique; names aren't
    useAddress(receive, undefined, known)
  } catch {
    if (id === lookup) searchFailed('Couldn’t reach Twetch', 'Couldn’t reach Twetch. Try again, or paste an address instead.')
  }
}

/** "Which one are you?" list for a name several Twetch accounts share. */
function showPeople(name: string, accounts: TwetchAccount[], near: boolean) {
  owned = []
  mine = new Set()
  tiles.clear()
  grid.replaceChildren()
  chips.hidden = true
  filterInput.hidden = true
  $('#sheet-lookup').hidden = false
  $('#collection-title').textContent = near ? 'Did you mean…' : 'Which one are you?'
  $('#collection-sub').textContent = near
    ? `No Twetch user is called “${name}” exactly`
    : `${accounts.length} Twetch users are called “${name}”`
  showGridMessage('')
  people.replaceChildren(...accounts.map((a) => personRow(a)))
  people.hidden = false
  setStatus('Pick your Twetch account')
  openSheet('#collection')
}

function personRow(a: TwetchAccount, pick: (a: TwetchAccount) => unknown = useTwetchAccount) {
  const row = document.createElement('button')
  row.className = 'person'
  const text = document.createElement('span')
  text.className = 'person-text'
  const strong = document.createElement('strong')
  strong.textContent = a.name
  const meta = document.createElement('span')
  meta.textContent = `@${a.id} · ${a.followers.toLocaleString()} follower${a.followers === 1 ? '' : 's'}`
  text.append(strong, meta)
  row.append(avatar(a), text)
  row.addEventListener('click', () => pick(a))
  return row
}

// --- Twetch accounts suggested as a name is typed --------------------------------------
const addressInput = $<HTMLInputElement>('#address')
const suggest = $('#suggest')
let suggestGen = 0 // bumps per keystroke so a slow old answer can't replace a newer one
let suggestTimer = 0

const looksLikeName = (v: string) => v.length >= 2 && !isAddress(v) && !parseOutpoint(v) && !/^[0-9a-f]{16,}/i.test(v)

function closeSuggest() {
  suggestGen++
  clearTimeout(suggestTimer)
  suggest.hidden = true
  suggest.replaceChildren()
  addressInput.setAttribute('aria-expanded', 'false')
  addressInput.removeAttribute('aria-activedescendant')
}

function showSuggest(accounts: TwetchAccount[], note?: string) {
  const rows = accounts.slice(0, 8).map((a, i) => {
    const row = personRow(a, (a) => {
      closeSuggest()
      addressInput.value = a.name
      addressInput.blur()
      useTwetchAccount(a)
    })
    row.id = `suggest-${i}`
    row.type = 'button'
    row.tabIndex = -1
    row.setAttribute('role', 'option')
    row.addEventListener('pointerdown', (e) => e.preventDefault()) // keep the box focused so the list stays until the tap lands
    return row
  })
  suggest.replaceChildren(...(note ? [el('p', 'suggest-note', note)] : []), ...rows)
  suggest.hidden = false
  addressInput.setAttribute('aria-expanded', 'true')
}

/** Move the highlighted suggestion with the arrow keys. */
function stepSuggest(by: number) {
  const rows = [...suggest.querySelectorAll<HTMLElement>('.person')]
  if (suggest.hidden || !rows.length) return false
  const at = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true')
  const next = at < 0 ? (by > 0 ? 0 : rows.length - 1) : (at + by + rows.length) % rows.length
  rows.forEach((r, i) => r.setAttribute('aria-selected', String(i === next)))
  rows[next].scrollIntoView({ block: 'nearest' })
  addressInput.setAttribute('aria-activedescendant', rows[next].id)
  return true
}

addressInput.addEventListener('input', () => {
  const v = addressInput.value.trim()
  if (!looksLikeName(v)) return closeSuggest()
  const gen = ++suggestGen
  clearTimeout(suggestTimer)
  suggestTimer = window.setTimeout(async () => {
    const found = await twetchAccounts(v).catch(() => null)
    if (gen !== suggestGen || !found) return
    const list = [...found.exact, ...found.close]
    if (list.length) showSuggest(list)
    else showSuggest([], `No Twetch user called “${v}”`)
  }, 300)
})

addressInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && stepSuggest(1)) e.preventDefault()
  else if (e.key === 'ArrowUp' && stepSuggest(-1)) e.preventDefault()
  else if (e.key === 'Escape' && !suggest.hidden) {
    e.stopPropagation()
    closeSuggest()
  } else if (e.key === 'Enter') {
    const picked = suggest.querySelector<HTMLElement>('.person[aria-selected="true"]')
    if (picked) {
      e.preventDefault()
      picked.click()
    }
  }
})
addressInput.addEventListener('blur', closeSuggest)
// --- while searching, the search box keeps them company -----------------------------------
// Froge at work alternates with what's worth knowing about steelmints. Once ordinals
// are arriving, the real count replaces the jokes.
const TICK_PROGRESS = [
  'Searching the chain…',
  'Froge is hopping through blocks…',
  'Sniffing out your ordinals…',
  'Rummaging through your wallet…',
  'Tongue out, catching ordinals…',
  'Big wallet! Still hopping…',
]
const TICK_FACTS = [
  'Owners only. No lily-pad lurkers.',
  'You can only cart what you own',
  'Pay from the wallet that owns it',
  'Every steelmint is verifiable',
  'Scan the back: proof it’s real',
  'Comes with a Froge certificate',
  'First steelmint of a card: Nº 001',
  'Get in first, claim Nº 001',
]
const searchBox = $('#address-form .search-box')
const ticker = $('#ticker')
let tickTimer = 0
let tickN = 0
let tickFound = '' // e.g. "Found 300 so far. Ribbit."

function nextTick() {
  const i = tickN++
  const fact = i % 2 === 1
  ticker.textContent = fact ? TICK_FACTS[(i >> 1) % TICK_FACTS.length] : tickFound || TICK_PROGRESS[(i >> 1) % TICK_PROGRESS.length]
  ticker.classList.toggle('fact', fact)
  ticker.classList.remove('in')
  void ticker.offsetWidth // restart the slide-in
  ticker.classList.add('in')
}

function startTicker() {
  // already running, or they're typing in the box
  if (tickTimer || document.activeElement === addressInput) return
  tickN = 0
  tickFound = ''
  searchBox.classList.add('ticking')
  ticker.hidden = false
  nextTick()
  tickTimer = window.setInterval(nextTick, 3000)
}

function stopTicker() {
  clearInterval(tickTimer)
  tickTimer = 0
  searchBox.classList.remove('ticking')
  ticker.hidden = true
}

addressInput.addEventListener('focus', stopTicker) // tapping the box brings their text back to edit

// a list shown after pressing search isn't tied to the box being focused: any tap elsewhere closes it
document.addEventListener('pointerdown', (e) => {
  if (!suggest.hidden && !(e.target as HTMLElement).closest('.search-box')) closeSuggest()
})

/** Round profile picture, with the name's initial underneath until (or unless) it loads. */
function avatar(a: TwetchAccount) {
  const pic = document.createElement('span')
  pic.className = 'person-pic ring'
  pic.textContent = a.name.trim().charAt(0).toUpperCase()
  const url = twetchIcon(a.icon)
  if (url) {
    const img = Object.assign(document.createElement('img'), { alt: '', hidden: true })
    img.addEventListener('load', () => (img.hidden = false))
    setImageSrc(img, url) // NFT profile pictures are B:// files, recovered from chain if ORDFS can't serve them
    pic.append(img)
  }
  return pic
}

/** "Name @1234" above the gallery when the wallet is a Twetch account. */
function showProfile(a: TwetchAccount | null) {
  const el = $('#profile')
  el.hidden = !a
  if (!a) return
  const text = document.createElement('span')
  text.className = 'person-text'
  const strong = document.createElement('strong')
  strong.textContent = a.name
  const handle = document.createElement('span')
  handle.textContent = `@${a.id}`
  text.append(strong, handle)
  el.replaceChildren(avatar(a), text)
  el.title = `Twetch user ${a.id}`
}

const isAddress = (v: string) => /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(v)

function submitAddress(input: string) {
  const field = $<HTMLInputElement>(input)
  const v = field.value.trim()
  if (!v) return field.focus()
  const outpoint = parseOutpoint(v)
  if (outpoint) return useOutpoint(outpoint)
  if (!isAddress(v)) return useTwetchName(v)
  history.replaceState(null, '', `?address=${encodeURIComponent(v)}`)
  useAddress(v)
}

const stage = new FrogStage(stageEl, { nextCard, onReveal, onHide: hideAdd })
new ResizeObserver(() => !addBtn.hidden && placeAdd()).observe(stageEl)

const freeze = params.get('freeze')
if (freeze != null) stage.freeze(Number(freeze))
const pose = params.get('hand') // debug: ?hand=thumb,wrist (radians)
if (pose) {
  const [th, wr] = pose.split(',').map(Number)
  stage.poseHand(th || 0, wr || 0)
}

renderCart()

// --- first visit: draw the eye to the search box --------------------------------
// A soft pulsing glow, and the hint types itself out with a blinking caret,
// until the visitor clicks into the box or a search starts.
function beckon() {
  const form = $('#address-form')
  const input = $<HTMLInputElement>('#address')
  const hint = input.placeholder
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  let timer = 0
  const stop = () => {
    clearTimeout(timer)
    form.classList.remove('beckon')
    input.placeholder = hint
  }
  form.classList.add('beckon')
  if (!still) {
    let shown = 0
    let caret = true
    const tick = () => {
      if (shown < hint.length) {
        shown++
        input.placeholder = hint.slice(0, shown) + '|'
        timer = window.setTimeout(tick, shown === 1 ? 500 : 45)
      } else {
        caret = !caret
        input.placeholder = hint + (caret ? '|' : '')
        timer = window.setTimeout(tick, 530)
      }
    }
    input.placeholder = ''
    timer = window.setTimeout(tick, 900)
  }
  input.addEventListener('focus', stop, { once: true })
  form.addEventListener('submit', stop, { once: true })
  return stop
}

// card faces are painted on canvas, so the font must be ready first
await Promise.all(['500', '600', '700', '800', '900'].map((w) => document.fonts.load(`${w} 40px Outfit`))).catch(() => {})
setStatus('Random Frog Cartel & NOOGIES')
await stage.start()
if (import.meta.env.DEV) Object.assign(window, { froge: stage })
document.body.classList.add('ready')

const addr = params.get('address')
const quiet = addr || params.get('twetch') || params.get('ordinal')
if (!quiet) beckon()
if (addr) useAddress(addr, params.get('ordinal') ?? undefined)
else if (params.get('twetch')) useTwetchName(params.get('twetch')!)

// --- controls -------------------------------------------------------------------------
prevBtn.addEventListener('click', () => goTo(aim - 1))
fwdBtn.addEventListener('click', () => goTo(aim + 1))
pauseBtn.addEventListener('click', () => {
  stage.setPaused(!stage.isPaused)
  pauseBtn.setAttribute('aria-pressed', String(stage.isPaused))
  pauseBtn.textContent = stage.isPaused ? 'Play' : 'Pause'
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheets()
  if ((e.target as HTMLElement).tagName === 'INPUT' || document.querySelector('.sheet.open') || cooking.open) return
  if (e.key === 'ArrowRight' || e.key === ' ') {
    e.preventDefault()
    fwdBtn.click()
  }
  if (e.key === 'ArrowLeft') prevBtn.click()
  if (e.key === 'a' && !addBtn.hidden) addBtn.click()
  if (e.key === 'p') pauseBtn.click()
})
$<HTMLFormElement>('#address-form').addEventListener('submit', (e) => {
  e.preventDefault()
  closeSuggest()
  addressInput.blur() // puts the phone keyboard away so Froge can be seen, and lets the search box talk
  submitAddress('#address')
})
$<HTMLFormElement>('#sheet-lookup').addEventListener('submit', (e) => {
  e.preventDefault()
  submitAddress('#sheet-address')
})
