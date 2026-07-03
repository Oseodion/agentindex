# AgentIndex - Project Context

## What this is
Market intelligence MCP server for the OKX.AI agent economy.
Built for the OKX AI Genesis Hackathon (deadline July 17, 2026).

## What we're building
An ASP (Agent Service Provider) listed on OKX.AI that exposes 
market data about the OKX.AI marketplace via MCP tools.
Other AI agents pay per call in USDT via OnchainOS on X Layer.

## Stack
- Node.js (CommonJS, no TypeScript)
- better-sqlite3 for database
- cheerio + node-fetch for data collection
- MCP SDK for the server
- OnchainOS for payments (Phase 3)

## Critical rules for Claude Code
- NEVER run any git commands (no git add, commit, push, status)
- NEVER install global packages
- NEVER modify CLAUDE.md
- All git operations are done manually by the developer
- Use CommonJS (require/module.exports) not ES modules
- No TypeScript, no unnecessary complexity

## Project phases
- Phase 1: Collector (SQLite database + hourly data collection) ← CURRENT
- Phase 2: MCP server (query tools exposed to AI agents)
- Phase 3: OnchainOS payment integration + ASP listing

## Current status
Starting Phase 1.