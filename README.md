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
- **Full-art cards.** Portrait art close to the card's shape can fill the whole
  card instead of sitting in the square window. The owner switches between
  Classic and Full art under the card's name.
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

## Decisions

Why things are the way they are, so changes don't undo them by accident.

- **Only the current owner can order a steelmint** of an ordinal: a steel copy
  is a claim about that ordinal, so it comes from whoever holds it.
- **Classic is the default layout** because it fits any artwork: square,
  landscape or portrait, nothing is cut off.
- **Full art is offered only where it fits** (`src/fullArt.ts`). Art that loses
  5% or less to fill the card gets full art by default; up to 13%, it starts on
  Classic and the owner can switch; anything further off is Classic only. In a
  sample of 1,500 market listings about a fifth of ordinal art was close to
  card-shaped and most of the rest was square. The owner choosing (rather than
  a rule per collection) keeps captions and titles near the edge of the art
  from being cut off without anyone having to judge each collection.
  `FULL_ART = false` turns it off.
- **One unreadable ordinal never hides a wallet.** Minting apps store names,
  traits and rarity in different places and shapes, so `toCard` in
  `src/feed.ts` reads each known variant and skips (with a console warning)
  anything it can't read.
- **Rarity words become one of six card colours.** Common, Uncommon, Rare, Epic,
  Exotic and Legendary follow Twetch; other apps' words map to the nearest
  (`RARITY_ALIAS` in `src/cardArt.ts`), and the card shows the word as minted.

## Checking ordinal reading

`node scripts/check-wallets.mjs` reads about 100 random real wallets with
Froge's own code and lists what shows, what's skipped and why, and anything
Froge failed to read. Run it after changing how ordinals are read. It exits
with an error if it finds a reading problem.

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
| `src/fullArt.ts` | The full-art front, and which cards get it |
| `src/feed.ts` | Finds ordinals for a wallet; random Frog Cartel and NOOGIES cards |
| `src/links.ts` | Twetch accounts and linked addresses |
| `src/bfile.ts` | Fallback that reads B:// artwork straight from the transaction |
| `src/cart.ts` | Cart and price ladder |
| `src/thumbs.ts` | Gallery and cart thumbnails, shrunk to the size they are shown at |
| `scripts/check-wallets.mjs` | Reads random real wallets and reports anything Froge can't read |
