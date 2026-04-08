import fetch from 'node-fetch';

const VINTED_BRAND_IDS = {
  "HermÃ¨s": 6021,
  "Chanel": 1783,
  "Louis Vuitton": 2656,
  "Gucci": 53,
  "Dior": 100665,
  "Prada": 61,
  "Bottega Veneta": 45624,
  "Saint Laurent": 90703,
  "Celine": 42096,
  "Balenciaga": 556,
  "Loewe": 95498,
  "Valentino": 132,
  "Burberry": 547,
  "Fendi": 52,
  "Givenchy": 51,
  "Miu Miu": 58,
  "Versace": 133,
  "Dolce & Gabbana": 77,
  "Alexander McQueen": 35,
  "Jacquemus": 4160741,
  "The Row": 321689,
  "Jil Sander": 102,
  "Lanvin": 56,
  "Margiela": 55,
  "Undercover": 191755,
  "Yohji Yamamoto": 145,
  "Comme des GarÃ§ons": 47,
  "Issey Miyake": 54,
  "Rick Owens": 144841,
  "Ann Demeulemeester": 44,
  "Peter Halley": 188923,
  "Moschino": 59,
  "Missoni": 60,
  "Emilio Pucci": 62,
  "Vivienne Westwood": 130,
  "Paul Smith": 63,
  "Dunhill": 78,
  "Ferragamo": 79,
  "Armani": 34,
  "Cavalli": 80,
  "Max Mara": 81,
  "Raf Simons": 82,
  "Oswald Boateng": 83,
  "Hugo Boss": 84,
  "Tom Ford": 86,
  "Maison Martin Margiela": 87,
  "Viktor & Rolf": 88,
  "Hussein Chalayan": 89,
  "John Galliano": 91,
  "Elie Saab": 92,
  "Haider Ackermann": 93,
  "Peter Dundas": 94,
  "Ulyana Sergeenko": 96,
  "Iris van Herpen": 97,
  "Conner McKnight": 98,
  "Tory Burch": 131,
  "Carolina Herrera": 134,
  "Salvatore Ferragamo": 135,
  "Roberto Cavalli": 136,
  "Gianfranco FerrÃ©": 137,
  "Zac Posen": 138,
  "Oscar de la Renta": 139,
  "Badgley Mischka": 140,
  "Carolina Herrera": 141,
  "Jenny Packham": 142,
  "Marchesa": 143,
  "Monique Lhuillier": 146,
  "Vera Wang": 147,
  "Isabel Toledo": 148,
  "Giorgio Armani": 149,
  "Elie Saab Couture": 150
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const HEADERS_BASE = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

async function scrapeVinted(brand, productName, material, color) {
  try {
    const brandId = VINTED_BRAND_IDS[brand];
    if (!brandId) {
      return { listings: [], count: 0, error: 'Brand not found in Vinted' };
    }

    const searchText = [productName, material, color].filter(Boolean).join(' ');
    const url = `https://www.vinted.de/api/v2/catalog/items?search_text=${encodeURIComponent(searchText)}&brand_ids[]=${brandId}&per_page=20&order=relevance`;

    const response = await fetch(url, {
      headers: HEADERS_BASE,
      timeout: 5000
    });

    if (!response.ok) {
      return { listings: [], count: 0, error: `Vinted API error: ${response.status}` };
    }

    const data = await response.json();
    const items = data.items || [];

    const listings = items.map(item => ({
      title: item.title || 'Unknown',
      price: item.price_cents ? item.price_cents / 100 : 0,
      condition: mapVintedCondition(item.status),
      url: `https://www.vinted.de/items/${item.id}`,
      platform: 'Vinted',
      imageUrl: item.photo?.high_resolution?.url || item.photo?.url || '',
      currency: 'EUR'
    }));

    return { listings, count: listings.length };
  } catch (error) {
    return { listings: [], count: 0, error: `Vinted scrape failed: ${error.message}` };
  }
}

async function scrapeEbay(brand, productName, material, color) {
  try {
    const searchText = [brand, productName, material, color].filter(Boolean).join(' ');
    const url = `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(searchText)}&_sacat=0&_sop=12&rt=nc`;

    const response = await fetch(url, {
      headers: HEADERS_BASE,
      timeout: 5000
    });

    if (!response.ok) {
      return { listings: [], count: 0, error: `eBay fetch error: ${response.status}` };
    }

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
    const itemRegex = /<div[^>]*class="[^"]*s-item[^"]*"[^>]*>[\s\S]*?<\/div>/g;
    const items = html.match(itemRegex) || [];

    items.slice(0, 20).forEach(itemHtml => {
      const titleMatch = itemHtml.match(/<span[^>]*role="heading"[^>]*>([^<]+)<\/span>/);
      const priceMatch = itemHtml.match(/<span[^>]*class="[^"]*s-item__price[^"]*"[^>]*>([^<]+)<\/span>/);
      const linkMatch = itemHtml.match(/<a[^>]*href="([^"]*)"[^>]*class="[^"]*s-item__link[^"]*"/);

      if (titleMatch && priceMatch) {
        const title = titleMatch[1].trim();
        const priceText = priceMatch[1].trim();
        const price = parseFloat(priceText.replace(/[â¬$,]/g, '').trim());
        const url = linkMatch ? linkMatch[1] : '';

        if (!isNaN(price) && title) {
          listings.push({
            title,
            price,
            condition: extractConditionFromTitle(title),
            url,
            platform: 'eBay',
            imageUrl: '',
            currency: 'EUR'
          });
        }
      }
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
      const response = await fetch(apiUrl, {
        headers: HEADERS_BASE,
        timeout: 5000
      });

      if (response.ok) {
        const data = await response.json();
        const items = data.products || [];

        const listings = items.map(item => ({
          title: item.name || 'Unknown',
          price: item.price || 0,
          condition: item.condition || 'unknown',
          url: item.url || `https://de.vestiairecollective.com/search/?q=${encodeURIComponent(searchText)}`,
          platform: 'Vestiaire Collective',
          imageUrl: item.image_url || '',
          currency: 'EUR'
        }));

        return { listings, count: listings.length };
      }
    } catch (apiError) {
      console.log('Vestiaire API failed, attempting HTML scrape');
    }

    const url = `https://de.vestiairecollective.com/search/?q=${encodeURIComponent(searchText)}`;
    const response = await fetch(url, {
      headers: HEADERS_BASE,
      timeout: 5000
    });

    if (!response.ok) {
      return { listings: [], count: 0, error: `Vestiaire fetch error: ${response.status}` };
    }

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
    const itemRegex = /<article[^>]*data-testid="product-item"[^>]*>[\s\S]*?<\/article>/g;
    const items = html.match(itemRegex) || [];

    items.slice(0, 20).forEach(itemHtml => {
      const titleMatch = itemHtml.match(/<h2[^>]*>([^<]+)<\/h2>/);
      const priceMatch = itemHtml.match(/<span[^>]*class="[^"]*Price[^"]*"[^>]*>([^<]+)<\/span>/);
      const linkMatch = itemHtml.match(/<a[^>]*href="([^"]*)"[^>]*class="[^"]*ProductCard[^"]*"/);

      if (titleMatch && priceMatch) {
        const title = titleMatch[1].trim();
        const priceText = priceMatch[1].trim();
        const price = parseFloat(priceText.replace(/[â¬$,]/g, '').trim());
        const url = linkMatch ? `https://de.vestiairecollective.com${linkMatch[1]}` : '';

        if (!isNaN(price) && title) {
          listings.push({
            title,
            price,
            condition: extractConditionFromTitle(title),
            url,
            platform: 'Vestiaire Collective',
            imageUrl: '',
            currency: 'EUR'
          });
        }
      }
    });
  } catch (e) {
    console.error('Vestiaire parsing error:', e);
  }

  return listings;
}

function mapVintedCondition(status) {
  const conditionMap = {
    'good': 'Good',
    'excellent': 'Excellent',
    'never_worn': 'Never Worn',
    'never_worn_with_tag': 'New with Tag',
    'like_new': 'Like New',
    'fair': 'Fair',
    'poor': 'Poor'
  };
  return conditionMap[status] || 'Unknown';
}

function extractConditionFromTitle(title) {
  const lowerTitle = title.toLowerCase();
  if (lowerTitle.includes('neu') || lowerTitle.includes('new') || lowerTitle.includes('tag')) return 'New with Tag';
  if (lowerTitle.includes('wie neu') || lowerTitle.includes('like new')) return 'Like New';
  if (lowerTitle.includes('excellent') || lowerTitle.includes('ausgezeichnet')) return 'Excellent';
  if (lowerTitle.includes('good') || lowerTitle.includes('gut')) return 'Good';
  if (lowerTitle.includes('fair') || lowerTitle.includes('befriedigend')) return 'Fair';
  return 'Unknown';
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

export async function handler(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const { brand, category, productName, material, color } = body;

    if (!brand || !productName) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Missing required fields: brand, productName' })
      };
    }

    const results = await scrapeAllPlatforms(brand, category, productName, material, color);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(results)
    };
  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message
      })
    };
  }
}
