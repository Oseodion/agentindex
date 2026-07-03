// server/index.js - Phase 2 MCP server
// Exposes market intelligence tools about the OKX.AI agent marketplace.
require('dotenv').config();
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const db = require('../collector/db');

const KNOWN_CATEGORIES = [
  'Finance',
  'Software services',
  'World Cup',
  'Lifestyle',
  'Art creation',
  'Others',
];

db.initDb();

// --- helpers ---

function nowIso() {
  return new Date().toISOString();
}

function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function paidPrices(agents) {
  return agents
    .map((a) => a.price_usdt)
    .filter((p) => typeof p === 'number' && p > 0)
    .sort((a, b) => a - b);
}

function round(n, places = 4) {
  if (n === null || n === undefined) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// Fuzzy match an input string against a list of candidates.
// Scores: exact (case-insensitive) > substring > shared-word overlap.
function fuzzyMatch(input, candidates) {
  const needle = String(input).toLowerCase().trim();
  if (!needle) return null;

  let best = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const hay = candidate.toLowerCase();
    let score = 0;
    if (hay === needle) score = 1000;
    else if (hay.includes(needle) || needle.includes(hay)) {
      score = 500 + Math.min(needle.length, hay.length) / Math.max(needle.length, hay.length) * 100;
    } else {
      const needleWords = needle.split(/\s+/);
      const hayWords = hay.split(/\s+/);
      for (const w of needleWords) {
        if (w.length < 2) continue;
        for (const h of hayWords) {
          if (h.includes(w) || w.includes(h)) score += 50;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return bestScore > 0 ? best : null;
}

function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(err) {
  return jsonResult({ error: err.message, generated_at: nowIso() });
}

// --- report builders (exported for testing; each never throws) ---

function buildMarketOverview() {
  const agents = db.getAllAgents();
  const totalSales = agents.reduce((s, a) => s + (a.sales || 0), 0);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const prices = paidPrices(agents);

  return {
    total_agents: agents.length,
    total_sales: totalSales,
    sales_last_24h: db.getSalesLast24h(),
    new_agents_last_7_days: db.getNewAgentsCountSince(sevenDaysAgo),
    avg_price_usdt: round(prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : null),
    median_price_usdt: round(median(prices)),
    top_5_sellers: agents.slice(0, 5).map((a) => ({
      name: a.name,
      category: a.category,
      price_usdt: a.price_usdt,
      sales: a.sales,
    })),
    category_breakdown: db.getCategoryBreakdown().map((c) => ({
      category: c.category,
      agent_count: c.agent_count,
      total_sales: c.total_sales,
      avg_price: round(c.avg_price),
    })),
    generated_at: nowIso(),
    data_freshness: db.getDataFreshness(),
  };
}

function buildCategoryReport(categoryInput) {
  const matched = fuzzyMatch(categoryInput, KNOWN_CATEGORIES);
  if (!matched) {
    return {
      error: `No category matched "${categoryInput}". Known categories: ${KNOWN_CATEGORIES.join(', ')}`,
      generated_at: nowIso(),
    };
  }

  const agents = db.getAgentsByCategory(matched);
  const totalSales = agents.reduce((s, a) => s + (a.sales || 0), 0);
  const prices = paidPrices(agents);
  const avgPrice = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : null;
  const saturation = agents.length > 0 ? totalSales / agents.length : 0;

  const top5 = agents.slice(0, 5);
  const newest3 = [...agents]
    .sort((a, b) => String(b.first_seen_at).localeCompare(String(a.first_seen_at)))
    .slice(0, 3);

  const topSeller = top5[0];
  const summary =
    `The "${matched}" category on OKX.AI has ${agents.length} agents with ${totalSales} total sales ` +
    `(${round(saturation, 2)} sales per agent). ` +
    (topSeller
      ? `The top seller is "${topSeller.name}" at ${topSeller.price_usdt} USDT with ${topSeller.sales} sales. `
      : 'No agents found in this category. ') +
    `Average paid price is ${round(avgPrice, 4) ?? 'n/a'} USDT, median ${round(median(prices), 4) ?? 'n/a'} USDT. ` +
    (saturation >= 10
      ? 'Demand per agent is high relative to typical categories, suggesting room for well-differentiated new entrants.'
      : saturation >= 3
        ? 'Demand per agent is moderate; a new entrant should differentiate on capability or price to capture share.'
        : 'Demand per agent is low; entering this category carries higher risk unless the offering is clearly unique.');

  return {
    category: matched,
    agent_count: agents.length,
    total_sales: totalSales,
    avg_price: round(avgPrice),
    median_price: round(median(prices)),
    top_5_agents: top5.map((a) => ({
      name: a.name,
      price_usdt: a.price_usdt,
      sales: a.sales,
      rating: a.rating,
      positive_pct: a.positive_pct,
    })),
    newest_3_agents: newest3.map((a) => ({
      name: a.name,
      price_usdt: a.price_usdt,
      first_seen_at: a.first_seen_at,
    })),
    saturation_score: round(saturation, 2),
    summary,
    generated_at: nowIso(),
  };
}

function buildPricingBenchmark(categoryInput, keywords) {
  const matched = fuzzyMatch(categoryInput, KNOWN_CATEGORIES);
  if (!matched) {
    return {
      error: `No category matched "${categoryInput}". Known categories: ${KNOWN_CATEGORIES.join(', ')}`,
      generated_at: nowIso(),
    };
  }

  let agents = db.getAgentsByCategory(matched);
  if (keywords) {
    const kw = String(keywords).toLowerCase();
    const filtered = agents.filter(
      (a) =>
        a.name.toLowerCase().includes(kw) ||
        (a.description_summary || '').toLowerCase().includes(kw)
    );
    if (filtered.length > 0) agents = filtered;
  }

  const prices = paidPrices(agents);
  const med = median(prices);
  const top5 = agents.slice(0, 5);
  const top5Paid = top5.filter((a) => typeof a.price_usdt === 'number' && a.price_usdt > 0);
  const belowMedian = med !== null ? top5Paid.filter((a) => a.price_usdt <= med).length : 0;

  let insight;
  if (top5Paid.length === 0 || med === null) {
    insight = 'Not enough paid agents in this category to draw a price-vs-sales conclusion.';
  } else if (belowMedian > top5Paid.length / 2) {
    insight =
      `${belowMedian} of the top ${top5Paid.length} paid sellers are priced at or below the category median ` +
      `(${round(med)} USDT), suggesting lower prices correlate with higher sales in "${matched}".`;
  } else {
    insight =
      `${top5Paid.length - belowMedian} of the top ${top5Paid.length} paid sellers are priced above the category median ` +
      `(${round(med)} USDT), suggesting buyers in "${matched}" pay for perceived quality rather than the lowest price.`;
  }

  const p25 = percentile(prices, 0.25);
  const p75 = percentile(prices, 0.75);
  let suggested;
  if (prices.length === 0) {
    suggested = 'No paid pricing data in this category; consider launching at a low introductory price (e.g. 0.1-0.5 USDT) to gather sales signals.';
  } else if (belowMedian > top5Paid.length / 2) {
    suggested =
      `Enter between ${round(p25)} and ${round(med)} USDT. Top sellers here cluster at or below the median, ` +
      'so an at-or-below-median price maximizes early adoption.';
  } else {
    suggested =
      `Enter between ${round(med)} and ${round(p75)} USDT. Buyers in this category reward quality over cheapness, ` +
      'so pricing at or above the median is viable if positioning is strong.';
  }

  return {
    category: matched,
    price_distribution: {
      min: round(prices[0] ?? null),
      p25: round(p25),
      median: round(med),
      p75: round(p75),
      max: round(prices[prices.length - 1] ?? null),
    },
    top_3_sellers_prices: agents.slice(0, 3).map((a) => ({ name: a.name, price_usdt: a.price_usdt })),
    price_vs_sales_insight: insight,
    suggested_entry_price: suggested,
    generated_at: nowIso(),
  };
}

function buildGapFinder() {
  const breakdown = db.getCategoryBreakdown().filter((c) => c.category !== null);

  const ranking = breakdown
    .map((c) => ({
      category: c.category,
      agent_count: c.agent_count,
      total_sales: c.total_sales || 0,
      opportunity_score: round((c.total_sales || 0) / c.agent_count - c.agent_count * 2, 2),
    }))
    .sort((a, b) => b.opportunity_score - a.opportunity_score);

  const underserved = [];
  for (const c of breakdown) {
    if (c.agent_count < 5) {
      const top = db.getAgentsByCategory(c.category)[0];
      if (top && (top.sales || 0) > 20) {
        underserved.push({
          category: c.category,
          agent_count: c.agent_count,
          top_seller_name: top.name,
          top_seller_sales: top.sales,
        });
      }
    }
  }

  const buckets = [
    { label: '0-0.1', min: 0, max: 0.1 },
    { label: '0.1-0.5', min: 0.1, max: 0.5 },
    { label: '0.5-1', min: 0.5, max: 1 },
    { label: '1-2', min: 1, max: 2 },
    { label: '2+', min: 2, max: Infinity },
  ];
  const priceGaps = [];
  for (const c of breakdown) {
    const agents = db.getAgentsByCategory(c.category);
    for (const bucket of buckets) {
      const inBucket = agents.filter(
        (a) =>
          typeof a.price_usdt === 'number' &&
          a.price_usdt > bucket.min &&
          a.price_usdt <= bucket.max
      );
      const bucketSales = inBucket.reduce((s, a) => s + (a.sales || 0), 0);
      if (bucketSales > 0 && inBucket.length <= 2) {
        priceGaps.push({
          category: c.category,
          price_range_usdt: bucket.label,
          agent_count: inBucket.length,
          total_sales: bucketSales,
        });
      }
    }
  }
  priceGaps.sort((a, b) => b.total_sales - a.total_sales);

  const opportunities = [];
  for (const r of ranking.slice(0, 3)) {
    opportunities.push(
      `${r.category} has ${r.agent_count} agents but ${r.total_sales} total sales - ` +
      `${round(r.total_sales / r.agent_count, 1)} sales per agent, ` +
      (r.opportunity_score > 0
        ? 'high demand relative to supply, room for more agents.'
        : 'demand and supply are more balanced; differentiation matters more than being early.')
    );
  }
  while (opportunities.length < 3) {
    if (underserved[opportunities.length - ranking.slice(0, 3).length]) {
      const u = underserved[opportunities.length - ranking.slice(0, 3).length];
      opportunities.push(
        `${u.category} has only ${u.agent_count} agents yet its top seller "${u.top_seller_name}" has ${u.top_seller_sales} sales - proven demand with thin competition.`
      );
    } else {
      opportunities.push(
        'Across all categories, price points with sales but few agents (see price_gaps) represent quick-entry opportunities.'
      );
    }
  }

  return {
    opportunity_ranking: ranking,
    underserved_niches: underserved,
    price_gaps: priceGaps,
    opportunities: opportunities.slice(0, 3),
    generated_at: nowIso(),
  };
}

function buildAgentProfile(nameInput) {
  const agents = db.getAllAgents();
  const matched = fuzzyMatch(nameInput, agents.map((a) => a.name));
  if (!matched) {
    return {
      error: `No agent matched "${nameInput}".`,
      generated_at: nowIso(),
    };
  }

  const agent = agents.find((a) => a.name === matched);
  const history = db.getAgentHistory(matched).map((s) => ({
    captured_at: s.captured_at,
    sales: s.sales,
  }));

  let velocity = null;
  if (history.length > 1) {
    const first = history[0];
    const last = history[history.length - 1];
    const days =
      (new Date(last.captured_at) - new Date(first.captured_at)) / (24 * 60 * 60 * 1000);
    if (days > 0) {
      velocity = round(((last.sales || 0) - (first.sales || 0)) / days, 2);
    }
  }

  const inCategory = agent.category ? db.getAgentsByCategory(agent.category) : [];
  const rank = inCategory.findIndex((a) => a.name === matched) + 1;

  return {
    agent,
    sales_history: history,
    sales_velocity: velocity,
    category_rank: rank > 0 ? rank : null,
    total_agents_in_category: inCategory.length || null,
    generated_at: nowIso(),
  };
}

// --- MCP server wiring ---

function createServer() {
  const server = new McpServer({ name: 'agentindex', version: '0.1.0' });

  server.registerTool(
    'market_overview',
    {
      description:
        'Get a full snapshot of the OKX.AI agent marketplace: total agents listed, total and last-24h sales, ' +
        'new agents in the last 7 days, average and median prices in USDT (excluding free agents), the top 5 ' +
        'best-selling agents, and a per-category breakdown of agent count, sales, and average price. ' +
        'Call this first to understand overall market size, activity, and momentum before drilling into a category or agent.',
    },
    async () => {
      try {
        return jsonResult(buildMarketOverview());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'category_report',
    {
      description:
        'Get a detailed report on one marketplace category (Finance, Software services, World Cup, Lifestyle, ' +
        'Art creation, or Others - fuzzy matching is applied, so partial names like "art" or "software" work). ' +
        'Returns agent count, total sales, average/median price, the top 5 agents by sales, the 3 newest agents, ' +
        'a saturation score (sales per agent - higher means more demand per competitor), and a plain-English ' +
        'summary written to support a go/no-go decision on entering the category.',
      inputSchema: {
        category: z.string().describe('Category name to report on, e.g. "Finance" or "art"'),
      },
    },
    async ({ category }) => {
      try {
        return jsonResult(buildCategoryReport(category));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'pricing_benchmark',
    {
      description:
        'Get pricing intelligence for a category to decide what to charge for a new agent. Returns the price ' +
        'distribution (min/p25/median/p75/max in USDT, excluding free agents), the prices of the top 3 sellers, ' +
        'an observation on whether lower prices correlate with higher sales in this category, and a suggested ' +
        'entry price range with reasoning. Optionally pass keywords to narrow the benchmark to similar agents ' +
        '(matched against names and descriptions).',
      inputSchema: {
        category: z.string().describe('Category to benchmark, e.g. "Finance"'),
        keywords: z
          .string()
          .optional()
          .describe('Optional keywords to narrow the comparison, e.g. "trading signals"'),
      },
    },
    async ({ category, keywords }) => {
      try {
        return jsonResult(buildPricingBenchmark(category, keywords));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'gap_finder',
    {
      description:
        'Find underserved opportunities in the OKX.AI agent marketplace. Returns categories ranked by ' +
        'opportunity score (sales-per-agent minus 2x agent count - high demand relative to supply scores higher), ' +
        'underserved niches (categories with a proven top seller of over 20 sales but fewer than 5 total agents), ' +
        'price gaps (price ranges within categories where sales exist but few agents compete), and exactly 3 ' +
        'plain-English opportunity statements. Call this when deciding what kind of agent to build or where to launch it.',
    },
    async () => {
      try {
        return jsonResult(buildGapFinder());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'agent_profile',
    {
      description:
        'Get the full profile and sales time-series for one specific agent on the OKX.AI marketplace. ' +
        'The name is fuzzy-matched (case-insensitive, partial names work - "worldcup" matches "WorldCupCaller"). ' +
        'Returns the full agent record (price, rating, positive review %, category, description), the sales ' +
        'history from hourly snapshots, sales velocity (sales per day since tracking began), and the agent\'s ' +
        'sales rank within its category. Use this to research a competitor or track a specific agent over time.',
      inputSchema: {
        name: z.string().describe('Agent name or partial name, e.g. "AlphaCopy" or "world cup"'),
      },
    },
    async ({ name }) => {
      try {
        return jsonResult(buildAgentProfile(name));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr - stdout is reserved for the MCP protocol.
  console.error('AgentIndex MCP server running on stdio. 5 tools registered.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal server error:', err);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  buildMarketOverview,
  buildCategoryReport,
  buildPricingBenchmark,
  buildGapFinder,
  buildAgentProfile,
};
