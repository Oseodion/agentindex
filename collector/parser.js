// collector/parser.js
const cheerio = require('cheerio');

function toNumber(str) {
  if (str === null || str === undefined) return null;
  const cleaned = String(str).replace(/[^0-9.\-]/g, '');
  if (cleaned === '') return null;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

// Parses agent cards out of fully-rendered marketplace HTML.
// defaultCategory tags every agent found (used when the page was rendered
// with a specific category tab selected). Never throws - returns [] on failure.
function parseAgentsPage(html, defaultCategory) {
  const agents = [];
  try {
    const $ = cheerio.load(html || '');

    const cardSelectors = [
      '[class*="agent-card"]',
      '[class^="AgentCard_card__"]',
      '[class*=" AgentCard_card__"]',
      '[data-testid*="agent"]',
      '[class*="AgentCard"]',
      '[class*="card"]',
    ];

    let $cards = $();
    for (const sel of cardSelectors) {
      const found = $(sel);
      if (found.length > 0) {
        $cards = found;
        break;
      }
    }

    $cards.each((_, el) => {
      const $el = $(el);

      const name =
        $el.find('[class*="name__"], [class*="title__"], h3, h2').first().text().trim() ||
        $el.find('[class*="name"], [class*="title"]').first().text().trim() ||
        null;

      if (!name) return;

      const description =
        $el.find('[class*="description__"], [class*="desc__"], p').first().text().trim() ||
        null;

      const priceEl = $el.find('[class*="priceAmount"]').first();
      const priceMatch = priceEl.length ? priceEl.text().match(/([\d,]+\.?\d*)/) : null;
      const price_usdt = priceMatch ? toNumber(priceMatch[1]) : null;

      const ratingEl = $el.find('[class*="scoreText"]').first();
      const ratingMatch = ratingEl.length ? ratingEl.text().match(/(\d+\.?\d*)/) : null;
      const rating = ratingMatch ? toNumber(ratingMatch[1]) : null;

      let positive_pct = null;
      let sales = 0;
      $el.find('[class*="statText"]').each((_, statEl) => {
        const statText = $(statEl).text();
        if (statText.includes('%')) {
          const m = statText.match(/([\d.]+)\s*%/);
          if (m) positive_pct = toNumber(m[1]);
        } else if (/sold|sales/i.test(statText)) {
          const m = statText.match(/([\d,]+)/);
          if (m) sales = toNumber(m[1]) || 0;
        }
      });

      agents.push({
        name,
        category: defaultCategory || null,
        price_usdt,
        sales,
        rating,
        positive_pct,
        description_summary: description,
      });
    });
  } catch (err) {
    console.error('parseAgentsPage failed:', err.message);
    return [];
  }

  return agents;
}

// Normalizes agent objects out of a discovered JSON API response.
// Handles a few common response shapes; never throws.
function parseAgentsFromJson(json) {
  try {
    let list = [];
    if (Array.isArray(json)) list = json;
    else if (Array.isArray(json?.data)) list = json.data;
    else if (Array.isArray(json?.data?.list)) list = json.data.list;
    else if (Array.isArray(json?.list)) list = json.list;
    else if (Array.isArray(json?.result)) list = json.result;
    else if (Array.isArray(json?.items)) list = json.items;

    return list
      .map((item) => {
        const name = item.name || item.agentName || item.title;
        if (!name) return null;
        return {
          name: String(name).trim(),
          category: item.category || item.categoryName || null,
          price_usdt: toNumber(item.price ?? item.priceUsdt ?? item.price_usdt),
          sales: toNumber(item.sales ?? item.soldCount ?? item.sold) || 0,
          rating: toNumber(item.rating ?? item.score),
          positive_pct: toNumber(item.positivePct ?? item.positive_pct ?? item.positiveRate),
          description_summary: item.description || item.summary || null,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error('parseAgentsFromJson failed:', err.message);
    return [];
  }
}

module.exports = { parseAgentsPage, parseAgentsFromJson };
