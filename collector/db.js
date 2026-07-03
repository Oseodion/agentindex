// collector/db.js
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || './data/agentindex.db';

let db = null;

function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT,
      price_usdt REAL,
      sales INTEGER DEFAULT 0,
      rating REAL,
      positive_pct REAL,
      description_summary TEXT,
      first_seen_at TEXT,
      last_updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      sales INTEGER,
      rating REAL,
      positive_pct REAL,
      price_usdt REAL,
      captured_at TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE,
      total_agents INTEGER,
      total_sales INTEGER,
      new_agents_today INTEGER,
      avg_price REAL,
      top_seller_name TEXT,
      top_seller_sales INTEGER,
      category_breakdown TEXT,
      captured_at TEXT
    );
  `);

  return db;
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

function insertOrUpdateAgent(agent) {
  const now = new Date().toISOString();
  const existing = getDb()
    .prepare('SELECT * FROM agents WHERE name = ?')
    .get(agent.name);

  if (!existing) {
    getDb()
      .prepare(
        `INSERT INTO agents (name, category, price_usdt, sales, rating, positive_pct, description_summary, first_seen_at, last_updated_at)
         VALUES (@name, @category, @price_usdt, @sales, @rating, @positive_pct, @description_summary, @now, @now)`
      )
      .run({ ...agent, now });
    return { isNew: true };
  }

  const changed =
    existing.category !== agent.category ||
    existing.price_usdt !== agent.price_usdt ||
    existing.sales !== agent.sales ||
    existing.rating !== agent.rating ||
    existing.positive_pct !== agent.positive_pct ||
    existing.description_summary !== agent.description_summary;

  if (changed) {
    getDb()
      .prepare(
        `UPDATE agents SET category = @category, price_usdt = @price_usdt, sales = @sales,
         rating = @rating, positive_pct = @positive_pct, description_summary = @description_summary,
         last_updated_at = @now WHERE name = @name`
      )
      .run({ ...agent, now });
  }

  return { isNew: false };
}

function insertSnapshot(snapshot) {
  getDb()
    .prepare(
      `INSERT INTO snapshots (agent_name, sales, rating, positive_pct, price_usdt, captured_at)
       VALUES (@agent_name, @sales, @rating, @positive_pct, @price_usdt, @captured_at)`
    )
    .run(snapshot);
}

function upsertDailySummary(summary) {
  getDb()
    .prepare(
      `INSERT INTO daily_summary (date, total_agents, total_sales, new_agents_today, avg_price, top_seller_name, top_seller_sales, category_breakdown, captured_at)
       VALUES (@date, @total_agents, @total_sales, @new_agents_today, @avg_price, @top_seller_name, @top_seller_sales, @category_breakdown, @captured_at)
       ON CONFLICT(date) DO UPDATE SET
         total_agents = excluded.total_agents,
         total_sales = excluded.total_sales,
         new_agents_today = excluded.new_agents_today,
         avg_price = excluded.avg_price,
         top_seller_name = excluded.top_seller_name,
         top_seller_sales = excluded.top_seller_sales,
         category_breakdown = excluded.category_breakdown,
         captured_at = excluded.captured_at`
    )
    .run(summary);
}

function getAllAgents() {
  return getDb().prepare('SELECT * FROM agents ORDER BY sales DESC').all();
}

function getAgentHistory(name) {
  return getDb()
    .prepare('SELECT * FROM snapshots WHERE agent_name = ? ORDER BY captured_at ASC')
    .all(name);
}

function getDailySummaries() {
  return getDb().prepare('SELECT * FROM daily_summary ORDER BY date DESC').all();
}

function getCategoryBreakdown() {
  return getDb()
    .prepare(
      `SELECT category, COUNT(*) as agent_count, SUM(sales) as total_sales, AVG(price_usdt) as avg_price
       FROM agents GROUP BY category`
    )
    .all();
}

module.exports = {
  initDb,
  insertOrUpdateAgent,
  insertSnapshot,
  upsertDailySummary,
  getAllAgents,
  getAgentHistory,
  getDailySummaries,
  getCategoryBreakdown,
};
