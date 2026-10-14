// The basket of printed cards. Printing in bulk is cheaper, so every card
// added costs less than the one before (down to a floor).

import type { CardItem } from './feed'

/** Price of the 1st, 2nd, 3rd… card in the basket; the last tier repeats. */
export const PRICE_TIERS = [20, 15, 10]
export const CURRENCY = 'USD'

const KEY = 'froge-cart'

export const priceAt = (i: number) => PRICE_TIERS[Math.min(i, PRICE_TIERS.length - 1)]

export const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: CURRENCY, maximumFractionDigits: 0 }).format(n)

export class Cart extends EventTarget {
  items: CardItem[] = []

  constructor() {
    super()
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]')
      if (Array.isArray(saved)) this.items = saved.filter((i) => i && typeof i.id === 'string')
    } catch {
      /* storage unavailable: start empty */
    }
  }

  get count() {
    return this.items.length
  }

  get total() {
    return this.items.reduce((sum, _, i) => sum + priceAt(i), 0)
  }

  /** What the next card added would cost. */
  get nextPrice() {
    return priceAt(this.items.length)
  }

  /** Saved compared with paying the first-card price for every card. */
  get savings() {
    return this.count * PRICE_TIERS[0] - this.total
  }

  has(id: string) {
    return this.items.some((i) => i.id === id)
  }

  add(item: CardItem) {
    if (this.has(item.id)) return
    this.items.push(item)
    this.changed()
  }

  remove(id: string) {
    this.items = this.items.filter((i) => i.id !== id)
    this.changed()
  }

  private changed() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.items))
    } catch {
      /* not persisted this time */
    }
    this.dispatchEvent(new Event('change'))
  }
}
