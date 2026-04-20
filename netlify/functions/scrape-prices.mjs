import * as cheerio from 'cheerio';
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const VINTED_BRAND_IDS = {
  'Hermès': 4785, 'Hermes': 4785, 'Chanel': 481, 'Louis Vuitton': 417,
  'Gucci': 567, 'Dior': 671, 'Prada': 3573, 'Bottega Veneta': 86972,
  'Saint Laurent': 377, 'Celine': 1443, 'Balenciaga': 2369, 'Loewe': 24209,
  'Valentino': 15450529, 'Burberry': 364, 'Fendi': 1189, 'Givenchy': 2371,
  'Miu Miu': 1745, 'Versace': 2293, 'Dolce & Gabbana': 1043,
  'Alexander McQueen': 52193, 'Jacquemus': 168278,
};

const PAGES_PER_PLATFORM = 3;
const PAGE_TIMEOUT_MS = 8000;

function parsePrice(text) {
  if (!text) return 0;
  const m = text.replace(/\s/g, '').match(/([\d.,]+)/);
  if (!m) return 0;
  const raw = m[1];
  let normalized;
  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  if (hasComma && hasDot) {
    // Either "1.234,56" (DE) or "1,234.56" (EN) — whichever comes last is decimal
    normalized = raw.lastIndexOf(',') > raw.lastIndexOf('.')
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(/,/g, '');
  } else if (hasComma) {
    // "1234,56" DE decimal or "1,234" EN thousand
    const parts = raw.split(',');
    normalized = parts[parts.length - 1].length === 3 ? raw.replace(/,/g, '') : raw.replace(',', '.');
  } else if (hasDot) {
    // "1.234" DE thousand or "1.23" EN decimal
    const parts = raw.split('.');
    normalized = parts[parts.length - 1].length === 3 ? raw.replace(/\./g, '') : raw;
  } else {
    normalized = raw;
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

async function fetchWithTimeout(url, opts = {}, timeout = PAGE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

// ───────────────────────── VINTED ─────────────────────────
// Vinted API returns 401 without session cookies. We first hit the homepage
// to collect Set-Cookie (access_token_web), then reuse those for API calls.

async function bootstrapVintedCookies(diag) {
  try {
    const res = await fetchWithTimeout('https://www.vinted.de/', {
      headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' },
    }, 6000);
    diag.push(`vinted home: HTTP ${res.status}`);

    let raw = [];
    if (typeof res.headers.getSetCookie === 'function') raw = res.headers.getSetCookie();
    if (!raw.length) {
      const all = res.headers.get('set-cookie');
      if (all) raw = all.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
    }

    // Dedupe by cookie name, keep last value wins (that's browser behavior).
    const byName = new Map();
    for (const c of raw) {
      const first = c.split(';')[0].trim();
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      byName.set(first.slice(0, eq), first);
    }
    diag.push(`vinted home: ${byName.size} unique cookies (${raw.length} raw)`);
    if (byName.size) diag.push(`vinted cookies: ${[...byName.keys()].join(',')}`);
    return [...byName.values()].join('; ');
  } catch (e) {
    console.error('[vinted bootstrap]', e.message);
    diag.push(`vinted home: error ${e.message}`);
    return '';
  }
}

// Fallback: scrape Vinted's HTML search page (works without API auth)
async function scrapeVintedHtmlPage(brand, productName, page, cookieHeader, diag) {
  const brandId = VINTED_BRAND_IDS[brand];
  const q = `${brand} ${productName}`.trim();
  const brandParam = brandId ? `&brand_ids[]=${brandId}` : '';
  const url = `https://www.vinted.de/catalog?search_text=${encodeURIComponent(q)}${brandParam}&page=${page}&order=relevance`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-DE,de;q=0.9',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
      },
    }, 10000);
    diag.push(`vinted-html p${page}: HTTP ${res.status}`);
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const listings = [];
    $('div[data-testid^="product-item-id-"]').each((_, el) => {
      const $el = $(el);
      const testid = $el.attr('data-testid') || '';
      const idMatch = testid.match(/product-item-id-(\d+)/);
      const id = idMatch?.[1];
      const title = $el.find('[data-testid$="--description-title"]').first().text().trim()
                 || $el.find('.new-item-box__title').first().text().trim();
      const priceText = $el.find('[data-testid$="--price-text"]').first().text().trim()
                    || $el.find('.new-item-box__summary--compact').first().text().trim();
      const price = parsePrice(priceText);
      const href = $el.find('a').first().attr('href');
      if (!price) return;
      listings.push({
        platform: 'vinted',
        title: title || `Vinted ${id}`,
        price,
        currency: 'EUR',
        url: href?.startsWith('http') ? href : href ? `https://www.vinted.de${href}` : (id ? `https://www.vinted.de/items/${id}` : undefined),
        image: $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src'),
      });
    });
    diag.push(`vinted-html p${page}: ${listings.length} items`);
    return listings;
  } catch (e) {
    console.error(`[vinted-html p${page}]`, e.message);
    diag.push(`vinted-html p${page}: error ${e.message}`);
    return [];
  }
}

async function scrapeVintedPage(brand, productName, page, cookieHeader, diag) {
  const brandId = VINTED_BRAND_IDS[brand];
  const q = `${brand} ${productName}`.trim();
  const brandParam = brandId ? `&brand_ids[]=${brandId}` : '';
  const url = `https://www.vinted.de/api/v2/catalog/items?search_text=${encodeURIComponent(q)}${brandParam}&per_page=40&page=${page}&order=relevance`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'de-DE,de;q=0.9',
        'Referer': 'https://www.vinted.de/',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
      },
    });
    diag.push(`vinted p${page}: HTTP ${res.status}`);
    if (!res.ok) return [];
    const data = await res.json();
    const items = data.items || [];
    diag.push(`vinted p${page}: ${items.length} items`);
    return items.map(it => ({
      platform: 'vinted',
      title: it.title || '',
      price: parseFloat(it.price?.amount ?? it.total_item_price?.amount ?? 0),
      currency: it.price?.currency_code || 'EUR',
      url: it.url || (it.path ? `https://www.vinted.de${it.path}` : undefined),
      image: it.photo?.url || it.photo?.full_size_url,
      brand: it.brand_title,
      size: it.size_title,
      condition: it.status,
      city: it.user?.city,
    })).filter(l => l.price > 0);
  } catch (e) {
    console.error(`[vinted p${page}]`, e.message);
    diag.push(`vinted p${page}: error ${e.message}`);
    return [];
  }
}

// ───────────────────────── EBAY ─────────────────────────
// eBay migrated from .s-item to .s-card in 2024. New selectors below.

async function scrapeEbayPage(brand, productName, category, page, diag) {
  const q = [brand, productName, category].filter(Boolean).join(' ').trim();
  const url = `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(q)}&_ipg=60&_pgn=${page}`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' },
    });
    diag.push(`ebay p${page}: HTTP ${res.status}`);
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const listings = [];

    // New layout (2024+): .s-card with .s-card__price, .s-card__title, .s-card__link
    $('.s-card').each((_, el) => {
      const $el = $(el);
      const title = $el.find('.s-card__title, .su-styled-text.primary.bold, [role="heading"]').first().text().trim();
      const price = parsePrice($el.find('.s-card__price').first().text());
      const href = $el.find('a.s-card__link, a').first().attr('href');
      if (!title || !price || !href) return;
      if (/^shop on ebay$/i.test(title)) return;
      listings.push({
        platform: 'ebay',
        title,
        price,
        currency: 'EUR',
        url: href,
        image: $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src'),
        condition: $el.find('.s-card__subtitle, .SECONDARY_INFO').first().text().trim() || undefined,
      });
    });

    // Fallback: legacy .s-item (still used occasionally)
    if (listings.length === 0) {
      $('li.s-item, .s-item').each((_, el) => {
        const $el = $(el);
        const title = $el.find('.s-item__title, [role="heading"]').first().text().trim();
        if (!title || /^shop on ebay$/i.test(title)) return;
        const price = parsePrice($el.find('.s-item__price').first().text());
        if (!price) return;
        listings.push({
          platform: 'ebay',
          title,
          price,
          currency: 'EUR',
          url: $el.find('a.s-item__link').first().attr('href'),
          image: $el.find('.s-item__image-img, img').first().attr('src'),
        });
      });
    }

    diag.push(`ebay p${page}: ${listings.length} items`);
    return listings;
  } catch (e) {
    console.error(`[ebay p${page}]`, e.message);
    diag.push(`ebay p${page}: error ${e.message}`);
    return [];
  }
}

// ───────────────────────── VESTIAIRE ─────────────────────────
// Vestiaire is behind CloudFlare. Direct requests get 403 "Just a moment...".
// Without a proxy service (ScraperAPI, Bright Data, etc.) this will fail reliably.
// Kept in place so we log it clearly and the frontend knows to degrade.

async function scrapeVestiairePage(brand, productName, page, diag) {
  const q = `${brand} ${productName}`.trim();
  const target = `https://www.vestiairecollective.com/search/?q=${encodeURIComponent(q)}&page=${page}`;

  // Vestiaire is behind CloudFlare. Use ScraperAPI proxy if configured.
  const scraperKey = process.env.SCRAPER_API_KEY;
  if (page === 1) diag.push(`vestiaire: scraperapi ${scraperKey ? 'enabled' : 'DISABLED'}`);
  // render=true triggers a headless browser (10 credits/req). Slower (15-30s) but
  // ultra_premium isn't available on the free plan. Timeout sized to Netlify function limit.
  const url = scraperKey
    ? `https://api.scraperapi.com/?api_key=${scraperKey}&url=${encodeURIComponent(target)}&render=true`
    : target;

  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' },
    }, scraperKey ? 24000 : PAGE_TIMEOUT_MS);
    diag.push(`vestiaire p${page}: HTTP ${res.status}`);
    if (!res.ok) return [];
    const html = await res.text();
    if (/Just a moment|cf-chl|cloudflare/i.test(html.slice(0, 2000))) {
      diag.push(`vestiaire p${page}: blocked by CloudFlare`);
      return [];
    }

    const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const search = data?.props?.pageProps?.initialState?.search
                   || data?.props?.pageProps?.searchInitialState
                   || {};
        const list = search.products || search.items
                 || data?.props?.pageProps?.products
                 || data?.props?.pageProps?.initialProducts
                 || [];
        const arr = Array.isArray(list) ? list : (list?.items || []);
        const mapped = arr.map(p => ({
          platform: 'vestiaire',
          title: p.name || p.title || p.model?.name || '',
          price: parseFloat(p.price?.cents ? p.price.cents / 100 : (p.price?.amount ?? p.price ?? 0)),
          currency: p.price?.currency || 'EUR',
          url: p.link || p.url || (p.id ? `https://www.vestiairecollective.com/p-${p.id}.shtml` : undefined),
          image: p.pictures?.[0]?.url || p.image?.url || p.pictureUrl,
          brand: p.brand?.name,
          condition: p.condition?.name || p.condition,
          size: p.size?.label,
        })).filter(l => l.price > 0 && l.title);
        diag.push(`vestiaire p${page}: ${mapped.length} items (NEXT_DATA)`);
        if (mapped.length > 0) return mapped;
      } catch (err) {
        diag.push(`vestiaire p${page}: NEXT_DATA parse failed`);
      }
    }

    const $ = cheerio.load(html);
    const listings = [];
    // Vestiaire uses CSS-modules: class names contain 'product-card' and '__<hash>'.
    $('[class*="product-card_productCard__"]').each((_, el) => {
      const $el = $(el);
      // Skip if this is an inner element (only match card root)
      if ($el.parents('[class*="product-card_productCard__"]').length > 0) return;
      const linkLabel = $el.find('a[class*="productLink"], a').first().attr('aria-label')?.trim();
      const imgAlt = $el.find('img').first().attr('alt')?.trim();
      const title = linkLabel
                 || imgAlt
                 || $el.find('[class*="productCard__text__top"], [class*="productCard__title"], [class*="brand"], [class*="description"]').first().text().trim()
                 || '';
      const price = parsePrice(
        $el.find('[class*="productCard__text--price"]:not([class*="regularPrice"])').first().text()
        || $el.find('[class*="productCard__text--price"]').first().text()
      );
      if (!price) return;
      const href = $el.find('a[class*="productLink"], a').first().attr('href');
      listings.push({
        platform: 'vestiaire',
        title: title || 'Vestiaire product',
        price,
        currency: 'EUR',
        url: href?.startsWith('http') ? href : href ? `https://www.vestiairecollective.com${href}` : undefined,
        image: $el.find('img').first().attr('src'),
      });
    });
    diag.push(`vestiaire p${page}: ${listings.length} items (DOM)`);
    return listings;
  } catch (e) {
    console.error(`[vestiaire p${page}]`, e.message);
    diag.push(`vestiaire p${page}: error ${e.message}`);
    return [];
  }
}

// ───────────────────────── ORCHESTRATION ─────────────────────────

async function scrapePlatform(scraper) {
  const pages = await Promise.all(
    Array.from({ length: PAGES_PER_PLATFORM }, (_, i) => scraper(i + 1))
  );
  const listings = pages.flat();
  const seen = new Set();
  const unique = listings.filter(l => {
    const key = l.url || `${l.title}|${l.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { listings: unique, pagesScraped: PAGES_PER_PLATFORM };
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { brand = '', category = '', productName = '', bypassCache = false } = body;
  if (!brand && !productName) {
    return new Response(JSON.stringify({ error: 'brand or productName required' }), { status: 400 });
  }

  const t0 = Date.now();
  const diag = [];

  // ── Cache lookup ──
  const cacheKey = createHash('sha256')
    .update(`${brand}|${category}|${productName}`.toLowerCase().trim())
    .digest('hex')
    .slice(0, 16);
  let cacheStore = null;
  try {
    cacheStore = getStore('scrape-cache');
    if (!bypassCache) {
      const cached = await cacheStore.get(cacheKey, { type: 'json' });
      if (cached && cached.timestamp && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        const ageMin = Math.round((Date.now() - cached.timestamp) / 60000);
        cached.body.meta = {
          ...cached.body.meta,
          cached: true,
          cacheAgeMinutes: ageMin,
          responseDurationMs: Date.now() - t0,
        };
        return new Response(JSON.stringify(cached.body), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'X-Cache': 'HIT',
          },
        });
      }
    }
  } catch (e) {
    diag.push(`cache: unavailable (${e.message})`);
  }

  const cookieHeader = await bootstrapVintedCookies(diag);
  diag.push(`vinted cookieHeader length: ${cookieHeader.length}`);

  // Try Vinted API first (cleaner JSON); fall back to HTML scraping if 401.
  const vintedPage1Api = await scrapeVintedPage(brand, productName, 1, cookieHeader, diag);
  const vintedScraper = vintedPage1Api.length > 0
    ? (p) => p === 1 ? Promise.resolve(vintedPage1Api) : scrapeVintedPage(brand, productName, p, cookieHeader, diag)
    : (p) => scrapeVintedHtmlPage(brand, productName, p, cookieHeader, diag);
  if (vintedPage1Api.length === 0) diag.push('vinted: falling back to HTML scraping');

  // Vestiaire via ScraperAPI is slow (JS render + CloudFlare bypass); 1 page only.
  const [vinted, ebay, vestiaire] = await Promise.all([
    scrapePlatform(vintedScraper),
    scrapePlatform(p => scrapeEbayPage(brand, productName, category, p, diag)),
    scrapeVestiairePage(brand, productName, 1, diag).then(listings => ({ listings, pagesScraped: 1 })),
  ]);

  const responseBody = {
    vinted,
    ebay,
    vestiaire,
    meta: {
      query: { brand, category, productName },
      pagesPerPlatform: PAGES_PER_PLATFORM,
      durationMs: Date.now() - t0,
      counts: { vinted: vinted.listings.length, ebay: ebay.listings.length, vestiaire: vestiaire.listings.length },
      diagnostics: diag,
      cached: false,
    },
  };

  // ── Cache write (only if we got meaningful results) ──
  const totalListings = vinted.listings.length + ebay.listings.length + vestiaire.listings.length;
  if (cacheStore && totalListings >= 5) {
    try {
      await cacheStore.setJSON(cacheKey, { timestamp: Date.now(), body: responseBody });
    } catch (e) {
      diag.push(`cache write failed: ${e.message}`);
    }
  }

  return new Response(JSON.stringify(responseBody), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Cache': 'MISS',
    },
  });
};

export const config = { path: '/.netlify/functions/scrape-prices' };
