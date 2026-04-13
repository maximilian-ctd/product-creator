import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const VINTED_BRAND_IDS = {
  "Hermès": 4785, "Chanel": 481, "Louis Vuitton": 417, "Gucci": 567,
  "Dior": 671, "Prada": 3573, "Bottega Veneta": 86972, "Saint Laurent": 377,
  "Celine": 1443, "Balenciaga": 2369, "Loewe": 24209, "Valentino": 15450529,
  "Burberry": 364, "Fendi": 1189, "Givenchy": 2371, "Miu Miu": 1745,
  "Versace": 2293, "Dolce & Gabbana": 1043, "Alexander McQueen": 52193,
  "Jacquemus": 168278, "The Row": 547584, "Brunello Cucinelli": 103740,
  "Jil Sander": 17991, "Acne Studios": 180798, "Maison Margiela": 639289,
  "Isabel Marant": 121, "Stella McCartney": 60498, "Ami Paris": 7228770,
  "Totême": 546105, "Max Mara": 465
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const HEADERS_BASE = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RETRIES = 1;

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (response.ok || response.status === 404) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
    if (attempt < retries) {
      const backoff = 300 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastError;
}

async function scrapeVinted(brand, productName, material, color) {
  try {
    const brandId = VINTED_BRAND_IDS[brand];
    if (!brandId) {
      return { listings: [], count: 0, error: 'Brand not found in Vinted' };
    }
    const searchText = [productName, material, color].filter(Boolean).join(' ');
    const url = `https://www.vinted.de/api/v2/catalog/items?search_text=${encodeURIComponent(searchText)}&brand_ids[]=${brandId}&per_page=20&order=relevance`;

    const response = await fetchWithRetry(url, { headers: HEADERS_BASE });
    if (!response.ok) return { listings: [], count: 0, error: `Vinted API error: ${response.status}` };

    const data = await response.json();
    const items = data.items || [];

    const listings = items
      .map(item => ({
        title: item.title || 'Unknown',
        price: item.price_cents ? item.price_cents / 100 : (typeof item.price === 'object' ? parseFloat(item.price?.amount) : parseFloat(item.price)) || 0,
        condition: mapVintedCondition(item.status || item.status_id),
        conditionRaw: item.status,
        url: `https://www.vinted.de/items/${item.id}`,
        platform: 'Vinted',
        imageUrl: item.photo?.high_resolution?.url || item.photo?.url || '',
        currency: 'EUR',
        createdAt: item.photo?.high_resolution?.timestamp || null
      }))
      .filter(l => l.price > 0);

    return { listings, count: listings.length };
  } catch (error) {
    return { listings: [], count: 0, error: `Vinted scrape failed: ${error.message}` };
  }
}

async function scrapeEbay(brand, productName, material, color) {
  try {
    const searchText = [brand, productName, material, color].filter(Boolean).join(' ');
    const url = `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(searchText)}&_sacat=0&_sop=12&LH_PrefLoc=1&rt=nc`;

    const response = await fetchWithRetry(url, { headers: HEADERS_BASE });
    if (!response.ok) return { listings: [], count: 0, error: `eBay fetch error: ${response.status}` };

    const html = await response.text();
    const listings = parseEbayListings(html);
    return { listings, count: listings.length };
  } catch (error) {
    return { listings: [], count: 0, error: `eBay scrape failed: ${error.message}` };
  }
}

function parseEbayListings(html) {
  const listings = [];
  try {
    const $ = cheerio.load(html);
    $('li.s-item, div.s-item').each((_, el) => {
      if (listings.length >= 20) return false;
      const $el = $(el);
      const title = $el.find('.s-item__title [role="heading"], .s-item__title span[role="heading"], .s-item__title').first().text().trim();
      const priceText = $el.find('.s-item__price').first().text().trim();
      const href = $el.find('a.s-item__link').attr('href') || '';
      const imageUrl = $el.find('.s-item__image-img, img.s-item__image-img').attr('src') || $el.find('img').attr('src') || '';
      const subtitle = $el.find('.s-item__subtitle, .SECONDARY_INFO').first().text().trim();

      if (!title || !priceText) return;
      if (/shop on ebay/i.test(title)) return;

      const price = parseEuroPrice(priceText);
      if (!Number.isFinite(price) || price <= 0) return;

      listings.push({
        title,
        price,
        condition: subtitle ? mapEbayCondition(subtitle) : extractConditionFromTitle(title),
        conditionRaw: subtitle,
        url: href,
        platform: 'eBay',
        imageUrl,
        currency: 'EUR'
      });
    });
  } catch (e) {
    console.error('eBay parsing error:', e);
  }
  return listings;
}

async function scrapeVestiaire(brand, productName, material, color) {
  try {
    const searchText = [brand, productName, material, color].filter(Boolean).join(' ');

    try {
      const apiUrl = `https://search.vestiairecollective.com/v1/products/search?q=${encodeURIComponent(searchText)}&country=DE&limit=20`;
      const response = await fetchWithRetry(apiUrl, { headers: HEADERS_BASE }, 0);
      if (response.ok) {
        const data = await response.json();
        const items = data.products || data.items || [];
        if (Array.isArray(items) && items.length > 0) {
          const listings = items
            .map(item => ({
              title: item.name || item.title || 'Unknown',
              price: typeof item.price === 'object' ? parseFloat(item.price.amount) : parseFloat(item.price) || 0,
              condition: normalizeVestiaireCondition(item.condition),
              conditionRaw: item.condition,
              url: item.url || `https://de.vestiairecollective.com/search/?q=${encodeURIComponent(searchText)}`,
              platform: 'Vestiaire Collective',
              imageUrl: item.image_url || item.imageUrl || '',
              currency: 'EUR'
            }))
            .filter(l => l.price > 0);
          return { listings, count: listings.length };
        }
      }
    } catch (apiError) {
      // fall through to HTML scrape
    }

    const url = `https://de.vestiairecollective.com/search/?q=${encodeURIComponent(searchText)}`;
    const response = await fetchWithRetry(url, { headers: HEADERS_BASE });
    if (!response.ok) return { listings: [], count: 0, error: `Vestiaire fetch error: ${response.status}` };

    const html = await response.text();
    const listings = parseVestiareListings(html);
    return { listings, count: listings.length };
  } catch (error) {
    return { listings: [], count: 0, error: `Vestiaire scrape failed: ${error.message}` };
  }
}

function parseVestiareListings(html) {
  const listings = [];
  try {
    const $ = cheerio.load(html);

    $('[data-testid="product-card"], [data-testid="product-item"], article.product-card, a.product-search-card').each((_, el) => {
      if (listings.length >= 20) return false;
      const $el = $(el);
      const title = $el.find('h2, [data-testid="product-card-title"], .product-card__title, .product-search-card__product-title').first().text().trim();
      const priceText = $el.find('[data-testid*="price"], [class*="Price"], [class*="price"], .product-card__price, .product-search-card__price').first().text().trim();
      let href = $el.is('a') ? $el.attr('href') : $el.find('a').first().attr('href');
      const imageUrl = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
      const conditionText = $el.find('[class*="condition" i], [data-testid*="condition"]').first().text().trim();

      if (!title || !priceText) return;
      const price = parseEuroPrice(priceText);
      if (!Number.isFinite(price) || price <= 0) return;

      if (href && !href.startsWith('http')) href = `https://de.vestiairecollective.com${href}`;

      listings.push({
        title,
        price,
        condition: conditionText ? normalizeVestiaireCondition(conditionText) : extractConditionFromTitle(title),
        conditionRaw: conditionText,
        url: href || '',
        platform: 'Vestiaire Collective',
        imageUrl,
        currency: 'EUR'
      });
    });

    if (listings.length === 0) {
      const jsonMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          const items = findItemsInObject(data);
          items.slice(0, 20).forEach(item => {
            const price = typeof item.price === 'object' ? parseFloat(item.price.amount) : parseFloat(item.price);
            if (Number.isFinite(price) && price > 0 && item.name) {
              listings.push({
                title: item.name,
                price,
                condition: normalizeVestiaireCondition(item.condition),
                conditionRaw: item.condition,
                url: item.link || item.url || '',
                platform: 'Vestiaire Collective',
                imageUrl: item.imageUrl || item.image_url || '',
                currency: 'EUR'
              });
            }
          });
        } catch {}
      }
    }
  } catch (e) {
    console.error('Vestiaire parsing error:', e);
  }
  return listings;
}

function findItemsInObject(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj[0] && typeof obj[0] === 'object' && (obj[0].name || obj[0].title) && (obj[0].price !== undefined)) {
      return obj;
    }
    for (const v of obj) {
      const r = findItemsInObject(v, depth + 1);
      if (r.length) return r;
    }
    return [];
  }
  for (const k of Object.keys(obj)) {
    const r = findItemsInObject(obj[k], depth + 1);
    if (r.length) return r;
  }
  return [];
}

function parseEuroPrice(text) {
  if (!text) return NaN;
  const cleaned = text.replace(/[^\d.,-]/g, '');
  if (!cleaned) return NaN;
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');
  let normalized;
  if (hasComma && hasDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    const parts = cleaned.split(',');
    normalized = parts.length === 2 && parts[1].length <= 2 ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  } else {
    const parts = cleaned.split('.');
    normalized = parts.length > 2 ? cleaned.replace(/\./g, '') : cleaned;
  }
  return parseFloat(normalized);
}

// ── Condition normalization to 5 internal states ──
// Internal: pristine | exzellent | charmant | authentisch | charakter
function mapVintedCondition(status) {
  const s = String(status || '').toLowerCase();
  const map = {
    'new_with_tags': 'pristine',
    'never_worn_with_tag': 'pristine',
    'new_without_tags': 'pristine',
    'never_worn': 'pristine',
    'like_new': 'exzellent',
    'very_good': 'exzellent',
    'excellent': 'exzellent',
    'good': 'charmant',
    'satisfactory': 'authentisch',
    'fair': 'authentisch',
    'poor': 'charakter',
    '1': 'pristine', '2': 'exzellent', '3': 'charmant', '4': 'authentisch', '5': 'charakter'
  };
  return map[s] || 'unknown';
}

function mapEbayCondition(subtitle) {
  const s = subtitle.toLowerCase();
  if (/neu mit etikett|brand new|new with tag/.test(s)) return 'pristine';
  if (/neu$|neu\b|new$|\bnew\b/.test(s)) return 'pristine';
  if (/neuwertig|like new|wie neu/.test(s)) return 'exzellent';
  if (/sehr gut|very good|excellent/.test(s)) return 'exzellent';
  if (/gut\b|good/.test(s)) return 'charmant';
  if (/akzeptabel|acceptable|befriedigend/.test(s)) return 'authentisch';
  if (/ersatzteile|defekt|for parts/.test(s)) return 'charakter';
  return extractConditionFromTitle(subtitle);
}

function normalizeVestiaireCondition(cond) {
  if (!cond) return 'unknown';
  const s = String(cond).toLowerCase();
  if (/ungetragen.*etikett|never worn.*tag|brand new/.test(s)) return 'pristine';
  if (/ungetragen|never worn/.test(s)) return 'pristine';
  if (/sehr gut|very good|excellent/.test(s)) return 'exzellent';
  if (/gut\b|good/.test(s)) return 'charmant';
  if (/akzeptabel|fair|acceptable/.test(s)) return 'authentisch';
  return 'unknown';
}

function extractConditionFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/neu mit etikett|new with tag|\bnwt\b/.test(t)) return 'pristine';
  if (/wie neu|like new|neuwertig/.test(t)) return 'exzellent';
  if (/sehr gut|excellent|ausgezeichnet/.test(t)) return 'exzellent';
  if (/\bgut\b|\bgood\b/.test(t)) return 'charmant';
  if (/akzeptabel|fair|befriedigend/.test(t)) return 'authentisch';
  return 'unknown';
}

async function scrapeAllPlatforms(brand, category, productName, material, color) {
  const [vinted, ebay, vestiaire] = await Promise.all([
    scrapeVinted(brand, productName, material, color),
    scrapeEbay(brand, productName, material, color),
    scrapeVestiaire(brand, productName, material, color)
  ]);

  return {
    vinted,
    ebay,
    vestiaire,
    timestamp: new Date().toISOString(),
    searchParams: { brand, category, productName, material, color }
  };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
    const { brand, category, productName, material, color } = body;

    if (!brand || !productName) {
      return {
        statusCode: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing required fields: brand, productName' })
      };
    }

    const results = await scrapeAllPlatforms(brand, category, productName, material, color);

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
        'Netlify-CDN-Cache-Control': 'public, max-age=300, s-maxage=300'
      },
      body: JSON.stringify(results)
    };
  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', message: error.message })
    };
  }
}
