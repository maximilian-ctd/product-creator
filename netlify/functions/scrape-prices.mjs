import * as cheerio from 'cheerio';

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
  const normalized = raw.includes(',') && raw.lastIndexOf(',') > raw.lastIndexOf('.')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(/,/g, '');
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

async function scrapeVintedPage(brand, productName, page) {
  const brandId = VINTED_BRAND_IDS[brand];
  const q = `${brand} ${productName}`.trim();
  const brandParam = brandId ? `&brand_ids[]=${brandId}` : '';
  const url = `https://www.vinted.de/api/v2/catalog/items?search_text=${encodeURIComponent(q)}${brandParam}&per_page=40&page=${page}&order=relevance`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
        'Referer': 'https://www.vinted.de/',
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map(it => ({
      platform: 'vinted',
      title: it.title || '',
      price: parseFloat(it.price?.amount ?? it.total_item_price?.amount ?? 0),
      currency: it.price?.currency_code || 'EUR',
      url: it.url,
      image: it.photo?.url || it.photo?.full_size_url,
      brand: it.brand_title,
      size: it.size_title,
      condition: it.status,
      city: it.user?.city,
    })).filter(l => l.price > 0);
  } catch (e) {
    console.error(`[vinted p${page}]`, e.message);
    return [];
  }
}

async function scrapeEbayPage(brand, productName, category, page) {
  const q = [brand, productName, category].filter(Boolean).join(' ').trim();
  const url = `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(q)}&_ipg=60&_pgn=${page}&LH_PrefLoc=1`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const listings = [];
    $('.s-item, li.s-item').each((_, el) => {
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
        condition: $el.find('.SECONDARY_INFO').first().text().trim() || undefined,
        city: $el.find('.s-item__location').first().text().trim() || undefined,
      });
    });
    return listings;
  } catch (e) {
    console.error(`[ebay p${page}]`, e.message);
    return [];
  }
}

async function scrapeVestiairePage(brand, productName, page) {
  const q = `${brand} ${productName}`.trim();
  const url = `https://www.vestiairecollective.com/search/?q=${encodeURIComponent(q)}&page=${page}`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' },
    });
    if (!res.ok) return [];
    const html = await res.text();

    const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const products =
          data?.props?.pageProps?.initialState?.search?.products ||
          data?.props?.pageProps?.products ||
          data?.props?.pageProps?.initialProducts ||
          [];
        const list = Array.isArray(products) ? products : (products?.items || []);
        const mapped = list.map(p => ({
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
        if (mapped.length > 0) return mapped;
      } catch { /* fall through to DOM parsing */ }
    }

    const $ = cheerio.load(html);
    const listings = [];
    $('[data-testid="product-card"], article.product-card').each((_, el) => {
      const $el = $(el);
      const title = $el.find('[data-testid="product-title"], h2, h3, .product-title').first().text().trim();
      const price = parsePrice($el.find('[data-testid="product-price"], .product-price').first().text());
      if (!title || !price) return;
      const href = $el.find('a').first().attr('href');
      listings.push({
        platform: 'vestiaire',
        title,
        price,
        currency: 'EUR',
        url: href?.startsWith('http') ? href : href ? `https://www.vestiairecollective.com${href}` : undefined,
        image: $el.find('img').first().attr('src'),
      });
    });
    return listings;
  } catch (e) {
    console.error(`[vestiaire p${page}]`, e.message);
    return [];
  }
}

async function scrapePlatform(name, scraper) {
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

  const { brand = '', category = '', productName = '' } = body;
  if (!brand && !productName) {
    return new Response(JSON.stringify({ error: 'brand or productName required' }), { status: 400 });
  }

  const t0 = Date.now();
  const [vinted, ebay, vestiaire] = await Promise.all([
    scrapePlatform('vinted', p => scrapeVintedPage(brand, productName, p)),
    scrapePlatform('ebay', p => scrapeEbayPage(brand, productName, category, p)),
    scrapePlatform('vestiaire', p => scrapeVestiairePage(brand, productName, p)),
  ]);

  return new Response(JSON.stringify({
    vinted,
    ebay,
    vestiaire,
    meta: {
      query: { brand, category, productName },
      pagesPerPlatform: PAGES_PER_PLATFORM,
      durationMs: Date.now() - t0,
      counts: { vinted: vinted.listings.length, ebay: ebay.listings.length, vestiaire: vestiaire.listings.length },
    },
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    },
  });
};

export const config = { path: '/.netlify/functions/scrape-prices' };
