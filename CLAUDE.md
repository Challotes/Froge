# Notes for AI assistants (and anyone new)

Start with README.md: what Froge does, the Decisions section (why things are
the way they are) and the table of files.

## How it fits together

- Everything runs in the browser. There is no backend, account or API key;
  all data comes from public endpoints (README, Data sources).
- `src/feed.ts` turns indexer records into `CardItem`s. It knows nothing about
  drawing. `toCard` is the one place that reads ordinal metadata; minting apps
  disagree on where names, traits and rarity live, and each known variant is
  commented where it's handled.
- `src/cardArt.ts` paints the classic front and the back onto canvases;
  `src/fullArt.ts` paints the full-art front and decides which layout a card
  gets. Each face is a pair: the art, and a foil mask (white = shiny metal).
- `src/stage.ts` is the three.js scene: it takes painted faces as textures and
  never needs to know about Bitcoin.
- `src/main.ts` wires the page: search, gallery, cart, the HUD under the card.

## Working on it

- `npm run dev` serves http://localhost:5173. `npm run build` type-checks and builds.
- After changing how ordinals are read, run `node scripts/check-wallets.mjs`.
- Match the surrounding style: short plain-English comments that say why, no
  semicolons, single quotes, two-space indent.
- `src/feed.ts` has Windows (CRLF) line endings; keep them when editing it.
- Cards are drawn in "card px" (1400 wide) and scaled down when painted; sizes
  on the printed card are written in millimetres (`MM`).

## Rules

- The repository is public. Commit only the site's own files. Nothing
  personal (names, emails, wallet addresses of real people) goes in code,
  comments or commit messages.
- Pushing to `main` deploys to the live site (Railway). Commit and push only
  when the owner asks.
- Checkout, payments and certificates are being designed, not built. Don't
  build them until the owner says so.
