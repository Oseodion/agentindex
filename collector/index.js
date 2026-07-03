// collector/index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const db = require('./db');
const { parseAgentsPage, parseAgentsFromJson } = require('./parser');

const TARGET_URL = 'https://www.okx.ai/agents';
const USER_AGENT = 'Mozilla/5.0 (compatible; AgentIndex/1.0; +https://github.com/Oseodion/agentindex)';
const SNAPSHOTS_DIR = process.env.SNAPSHOTS_DIR || './data/snapshots';
const INTERVAL_MINUTES = parseInt(process.env.COLLECTOR_INTERVAL_MINUTES || '60', 10);
const API_CONFIG_PATH = path.join(SNAPSHOTS_DIR, '..', 'api-config.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadApiConfig() {
  try {
    if (fs.existsSync(API_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(API_CONFIG_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to read api-config.json:', err.message);
  }
  return null;
}

function saveApiConfig(config) {
  ensureDir(path.dirname(API_CONFIG_PATH));
  fs.writeFileSync(API_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function looksLikeAgentList(json) {
  const candidates = [
    json,
    json?.data,
    json?.data?.list,
    json?.list,
    json?.result,
    json?.items,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      const sample = c[0];
      if (sample && typeof sample === 'object') {
        const keys = Object.keys(sample).map((k) => k.toLowerCase());
        if (keys.some((k) => k.includes('name') || k.includes('title'))) {
          return true;
        }
      }
    }
  }
  return false;
}

// APPROACH 1: try to discover a backend JSON API by watching network traffic.
async function discoverApi(browser) {
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  const candidates = [];

  page.on('response', async (response) => {
    try {
      const req = response.request();
      const resourceType = req.resourceType();
      if (resourceType !== 'xhr' && resourceType !== 'fetch') return;

      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) return;

      const json = await response.json().catch(() => null);
      if (!json) return;

      if (looksLikeAgentList(json)) {
        candidates.push({ url: response.url(), method: req.method(), json });
      }
    } catch (_err) {
      // ignore individual response failures during discovery
    }
  });

  console.log(`Discovery: opening ${TARGET_URL} to sniff network traffic...`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  await context.close();

  if (candidates.length === 0) {
    console.log('Discovery: no JSON API candidates found.');
    return null;
  }

  // Prefer the candidate with the most agent-like entries.
  let best = candidates[0];
  let bestCount = 0;
  for (const c of candidates) {
    const arr = c.json?.data?.list || c.json?.data || c.json?.list || c.json?.result || c.json?.items || c.json;
    const count = Array.isArray(arr) ? arr.length : 0;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }

  console.log(`Discovery: found candidate API endpoint: ${best.method} ${best.url}`);
  console.log(`Discovery: response structure keys: ${Object.keys(best.json).join(', ')}`);

  ensureDir(SNAPSHOTS_DIR);
  fs.writeFileSync(
    path.join(SNAPSHOTS_DIR, 'api-sample.json'),
    JSON.stringify(best.json, null, 2)
  );

  const config = { endpoint: best.url, method: best.method, discoveredAt: new Date().toISOString() };
  saveApiConfig(config);

  return config;
}

// Fetch all agents from a previously-discovered JSON API, following pagination if present.
async function collectViaApi(config) {
  const agents = [];
  const seenUrls = new Set();
  let url = config.endpoint;
  let page = 1;
  const maxPages = 100;

  while (url && !seenUrls.has(url) && page <= maxPages) {
    seenUrls.add(url);
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`API request failed: ${res.status} ${res.statusText}`);
    const json = await res.json();
    const batch = parseAgentsFromJson(json);
    if (batch.length === 0) break;
    agents.push(...batch);

    // Try common pagination param patterns.
    const u = new URL(url);
    if (u.searchParams.has('page')) {
      const nextPage = parseInt(u.searchParams.get('page'), 10) + 1;
      u.searchParams.set('page', String(nextPage));
      url = u.toString();
      page += 1;
    } else if (u.searchParams.has('offset') && u.searchParams.has('limit')) {
      const limit = parseInt(u.searchParams.get('limit'), 10) || batch.length;
      const nextOffset = parseInt(u.searchParams.get('offset'), 10) + limit;
      u.searchParams.set('offset', String(nextOffset));
      url = u.toString();
      page += 1;
      if (batch.length < limit) break;
    } else {
      break; // no pagination pattern detected, assume single page has everything
    }
  }

  return agents;
}

const CATEGORY_TABS = ['World Cup', 'Finance', 'Software services', 'Lifestyle', 'Art creation', 'Others'];

async function scrollToLoadAll(page) {
  let previousHeight = 0;
  for (let i = 0; i < 20; i++) {
    const height = await page.evaluate('document.body.scrollHeight');
    if (height === previousHeight) break;
    previousHeight = height;
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(1000);
}

// APPROACH 2 (fallback): fully render the page and parse the HTML with cheerio.
// Visits the "All" tab first to capture every agent, then revisits each category
// tab so agents can be tagged with their category (the card markup itself has no
// per-card category attribute).
async function collectViaRenderedHtml(browser) {
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  console.log(`Rendering: opening ${TARGET_URL}...`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[class^="AgentCard_card__"], [class*=" AgentCard_card__"], [class*="AgentCard"]', {
    timeout: 30000,
  }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await scrollToLoadAll(page);

  const allHtml = await page.content();
  ensureDir(SNAPSHOTS_DIR);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(SNAPSHOTS_DIR, `rendered-${timestamp}.html`), allHtml);

  const agentsByName = new Map();
  for (const agent of parseAgentsPage(allHtml)) {
    agentsByName.set(agent.name, agent);
  }

  for (const tabName of CATEGORY_TABS) {
    try {
      const tab = page.locator('[class*="FilterBar_categoryTab__"]', { hasText: tabName }).first();
      if ((await tab.count()) === 0) {
        console.log(`Category tab "${tabName}" not found, skipping.`);
        continue;
      }
      await tab.click();
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await scrollToLoadAll(page);

      const html = await page.content();
      const categoryAgents = parseAgentsPage(html, tabName);
      for (const agent of categoryAgents) {
        const existing = agentsByName.get(agent.name);
        if (existing) existing.category = tabName;
        else agentsByName.set(agent.name, agent);
      }
    } catch (err) {
      console.error(`Failed to collect category "${tabName}": ${err.message}`);
    }
  }

  await context.close();

  return Array.from(agentsByName.values());
}

async function collectAgents() {
  let config = loadApiConfig();
  const browser = await chromium.launch();

  try {
    if (!config) {
      config = await discoverApi(browser);
    }

    if (config) {
      console.log('Using discovered API endpoint for collection.');
      try {
        const agents = await collectViaApi(config);
        if (agents.length > 0) return agents;
        console.log('API returned no agents, falling back to rendered HTML parsing.');
      } catch (err) {
        console.error(`API collection failed: ${err.message}. Falling back to rendered HTML parsing.`);
      }
    }

    console.log('Using rendered HTML parsing for collection.');
    return await collectViaRenderedHtml(browser);
  } finally {
    await browser.close();
  }
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function buildDailySummary(allAgents, newAgentsToday, snapshotCount) {
  const totalAgents = allAgents.length;
  const totalSales = allAgents.reduce((sum, a) => sum + (a.sales || 0), 0);
  const prices = allAgents.map((a) => a.price_usdt).filter((p) => typeof p === 'number');
  const avgPrice = prices.length > 0 ? prices.reduce((s, p) => s + p, 0) / prices.length : null;

  let topSeller = null;
  for (const a of allAgents) {
    if (!topSeller || (a.sales || 0) > (topSeller.sales || 0)) topSeller = a;
  }

  const categoryBreakdown = db.getCategoryBreakdown();

  return {
    date: todayDateString(),
    total_agents: totalAgents,
    total_sales: totalSales,
    new_agents_today: newAgentsToday,
    avg_price: avgPrice,
    top_seller_name: topSeller ? topSeller.name : null,
    top_seller_sales: topSeller ? topSeller.sales || 0 : null,
    category_breakdown: JSON.stringify(categoryBreakdown),
    captured_at: new Date().toISOString(),
  };
}

async function runCollection() {
  console.log(`\n[${new Date().toISOString()}] Starting collection run...`);

  try {
    const agents = await collectAgents();

    if (!agents || agents.length === 0) {
      throw new Error('No agents found on the page');
    }

    const capturedAt = new Date().toISOString();
    let newCount = 0;

    for (const agent of agents) {
      const { isNew } = db.insertOrUpdateAgent(agent);
      if (isNew) newCount += 1;

      db.insertSnapshot({
        agent_name: agent.name,
        sales: agent.sales || 0,
        rating: agent.rating,
        positive_pct: agent.positive_pct,
        price_usdt: agent.price_usdt,
        captured_at: capturedAt,
      });
    }

    const allAgents = db.getAllAgents();
    const summary = buildDailySummary(allAgents, newCount, agents.length);
    db.upsertDailySummary(summary);

    console.log(
      `Collection complete. ${allAgents.length} agents in database. ${newCount} new today. ${agents.length} snapshots recorded.`
    );
  } catch (err) {
    console.error(`Collection failed: ${err.message}. Existing data preserved.`);
  }
}

function main() {
  ensureDir(SNAPSHOTS_DIR);
  db.initDb();
  console.log('AgentIndex collector starting.');
  console.log(`Collection interval: ${INTERVAL_MINUTES} minutes.`);

  runCollection();
  setInterval(runCollection, INTERVAL_MINUTES * 60 * 1000);
}

if (require.main === module) {
  main();
}

module.exports = { runCollection, collectAgents };
