# FROGE Proof.fun

**Steelmint your ordinals.** Froge turns BSV ordinals into stainless-steel cards.
Look up a wallet, watch the frog flip through its ordinals, and add the ones you
own to your cart.

Live at [frogeproof.fun](https://www.frogeproof.fun).

## What it does

- **Look up any wallet** by BSV address, Twetch name (or user number) or ordinal
  location (`<txid>_<vout>`). Twetch accounts also pull in their linked ordinals
  addresses, so the whole collection shows up in one place.
- **The frog flips your cards.** A 3D frog (three.js) holds each ordinal as a
  card, front and back. With no wallet entered it shows random Frog Cartel and NOOGIES cards.
- **Cards in Twetch's design.** The 63 × 88 mm layout, rarity colours, traits
  and collection backs follow Twetch's own cards. Each steelmint adds a foil
  edition badge on the front and a STEELMINT QR + FROGE mark on the back.
- **Cart** with a bulk price ladder: $20 for the first card, $15 for the
  second, $10 for each card after that.

Only the current owner of an ordinal can order a steelmint of it.

## Status

The gallery, cards and cart work today. Checkout, payments and the Steelmint
certificate (an ordinal that proves each physical card is genuine) are being
designed and are **not built yet**; the checkout button is a placeholder.

## Run it

Needs Node 20.19 or newer.

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check and build into dist/
npm start        # serve dist/ (uses $PORT, default 4173)
```

The site runs entirely in the browser. There is no server, no account and no
API key: everything is read from public endpoints.

## Data sources

- [GorillaPool](https://ordinals.gorillapool.io) ordinals indexer: who owns what
- [ORDFS](https://ordfs.network): inscription images
- Twetch's public API (`api.twetch.com`): Twetch names, linked addresses,
  token traits and rarity, profile pictures
- Twetch card backs from `twetch.com`, Ordinals Wallet's media CDN for older
  Twetch profile pictures

Twetch's endpoints are undocumented and may change.

## Deploying

Hosted on Railway: it runs `npm run build`, then `npm start`. Allowed host
names (the domain, Railway and Cloudflare quick tunnels) are listed in
`vite.config.ts`.

## Credits

Card layout and collection backs follow [Twetch](https://twetch.com)'s card
design. Collection artwork belongs to its creators. Froge is not affiliated with
Twetch.

## Code

| File | What it does |
|---|---|
| `src/main.ts` | Page wiring: search, gallery, cart drawer |
| `src/stage.ts` | The three.js scene: frog, card and flip animation |
| `src/hand.ts` | Puppet-warp of the frog's hands around the card |
| `src/cardArt.ts` | Paints card fronts and backs (badge, QR, wordmark) |
| `src/feed.ts` | Finds ordinals for a wallet; random Frog Cartel and NOOGIES cards |
| `src/links.ts` | Twetch accounts and linked addresses |
| `src/bfile.ts` | Fallback that reads B:// artwork straight from the transaction |
| `src/cart.ts` | Cart and price ladder |
| `src/thumbs.ts` | Gallery and cart thumbnails, shrunk to the size they are shown at |
