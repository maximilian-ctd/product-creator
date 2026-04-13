# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MAISON Ô — "Pricing Intelligence & Produkttext v4.0". A luxury fashion resale pricing tool (German market) that combines a client-side React app with a Netlify Function that scrapes live listings from Vinted, eBay (DE), and Vestiaire Collective.

## Commands

- `npm run dev` / `npm run serve` — start `netlify dev` (serves `index.html` and the `/.netlify/functions/*` endpoints locally).
- `npm run build` — no-op; this is a static site + functions, no bundler step. `netlify.toml` points `functions = "netlify/functions"` with `node_bundler = "esbuild"`.
- There are no tests, lints, or type checks configured.

## Architecture

Two halves that must stay in sync through the HTTP contract below:

1. **Frontend — `index.html` (single file, ~1800 lines).** React 18 + D3 + Babel Standalone are loaded from CDNs; JSX is transpiled in-browser via `<script type="text/babel">`. There is no build pipeline, no bundler, no module system — everything (components, `BRAND_DATABASE`, pricing math, scraping client) lives in the one inline script tag. React hooks are pulled off the global (`const { useState, ... } = React;`). Edits to app logic happen directly in this file.

2. **Backend — `netlify/functions/scrape-prices.mjs`.** Single serverless function exporting `handler(event, context)`. Accepts `POST` with `{ brand, category, productName, material, color }`, fans out in parallel (`Promise.all`) to three scrapers, and returns `{ vinted, ebay, vestiaire, timestamp, searchParams }` where each platform block is `{ listings: [...], count, error? }`. Listing shape is normalized across platforms: `{ title, price, condition, url, platform, imageUrl, currency }`.

**Scraper specifics worth knowing before editing:**
- Vinted uses their JSON catalog API (`vinted.de/api/v2/catalog/items`) keyed by `VINTED_BRAND_IDS` — a hand-maintained brand→ID map at the top of the file. Adding a brand to the frontend's `BRAND_DATABASE` without a matching entry here causes Vinted to silently return empty. Note the file has mojibake in some brand keys (e.g. `"HermÃ¨s"`, `"Comme des GarÃ§ons"`) — the keys must match whatever the caller sends.
- eBay and Vestiaire fall back to HTML regex parsing (no cheerio despite being a dependency). Vestiaire first tries an undocumented search API, then scrapes HTML.
- All scrapers swallow errors into `{ listings: [], count: 0, error }` so one platform failing doesn't break the response. Preserve that contract.

**Frontend↔backend contract.** `fetchRealListings` in `index.html` (line ~38) POSTs to `/.netlify/functions/scrape-prices`; `convertRealListingsToPricing` flattens the three platform arrays and derives p25/median/p75/avg. Any change to the function's response shape must land in both files in the same commit.

**CORS / headers.** `netlify.toml` sets wildcard CORS for `/*`, and the function also emits its own CORS headers and handles `OPTIONS`. Keep both — the static headers don't apply to function responses.
