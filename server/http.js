// server/http.js - Phase 3 HTTP entry point
// Wraps the same 5 MCP tools (from server/index.js) behind Express with
// x402 payment middleware. Paying agents POST /mcp and pay a flat 0.50
// USDT0 per tool call on X Layer (eip155:196). Unpaid requests get a 402
// challenge.
//
// Pricing design: flat `exact` (EIP-3009) at $0.50 for every tools/call,
// matching the fee registered on-chain for this ASP's service listing
// 1:1. `exact` signs a single fixed amount per request - no settlement
// overrides, no cap, no per-tool variance. (An earlier `upto`-based
// per-tool pricing design was reverted: the on-chain listing shows one
// flat fee, and a variable-cap challenge disagreeing with that fee is the
// most likely cause of an "x402 verification failed" listing rejection.)
require('dotenv').config();
const express = require('express');
const { OKXFacilitatorClient } = require('@okxweb3/x402-core');
const {
  x402ResourceServer,
  x402HTTPResourceServer,
  paymentMiddlewareFromHTTPServer,
} = require('@okxweb3/x402-express');
const { ExactEvmScheme } = require('@okxweb3/x402-evm/exact/server');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { createServer } = require('./index.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PAY_TO = process.env.PAYMENT_ADDRESS || '0xdf54982caada64c73f7f27afc11a9600a36625aa';
const NETWORK = 'eip155:196'; // X Layer mainnet
const PRICE_USD = 0.50; // flat fee per tool call, matches the on-chain listing

// JSON-RPC methods that are MCP protocol handshake/introspection, not billable
// tool invocations. These must reach the server for free — the x402 route
// table has no concept of "free within this route," so a request that only
// contains these methods is bypassed around the payment middleware entirely
// (see the bypass middleware below).
const PROTOCOL_METHODS = new Set([
  'initialize',
  'tools/list',
  'notifications/initialized',
  'ping',
]);

// True when every message in the body (single or batch) is a protocol-level
// method. A batch mixing a protocol method with a real tools/call is NOT
// exempt — any tools/call present routes the whole request through payment.
function isProtocolOnlyRequest(body) {
  if (!body) return false;
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return false;
  return messages.every((msg) => msg && PROTOCOL_METHODS.has(msg.method));
}

// --- payment layer (graceful: server still starts if this fails) ---

let resourceServer = null;
let paymentMiddleware = null;
let paymentSetupError = null;

try {
  const facilitatorClient = new OKXFacilitatorClient({
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    syncSettle: false, // async settlement - right tradeoff for cheap calls
  });

  resourceServer = new x402ResourceServer(facilitatorClient)
    .register(NETWORK, new ExactEvmScheme());

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    'POST /mcp': {
      accepts: {
        scheme: 'exact',
        network: NETWORK,
        payTo: PAY_TO,
        price: `$${PRICE_USD.toFixed(2)}`,
        maxTimeoutSeconds: 300,
      },
      description: 'AgentIndex - OKX.AI marketplace intelligence over MCP. Flat 0.50 USDT per tool call.',
      mimeType: 'application/json',
    },
  });

  paymentMiddleware = paymentMiddlewareFromHTTPServer(httpServer);
} catch (err) {
  paymentSetupError = err;
  console.error(`Payment layer setup failed: ${err.message}`);
}

// --- express app ---

const app = express();
// Render (and most PaaS) terminate TLS at a reverse proxy and forward plain
// HTTP internally, setting X-Forwarded-Proto: https. Without trust proxy,
// req.protocol reports "http" even for real HTTPS requests, which leaked
// into the x402 challenge's resource.url (built from req.protocol) as
// "http://...". A scheme mismatch against the https:// endpoint registered
// on-chain fails the marketplace's x402 verification during listing review.
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'AgentIndex',
    tools: [
      'market_overview',
      'category_report',
      'pricing_benchmark',
      'gap_finder',
      'agent_profile',
    ],
    network: 'X Layer (eip155:196)',
    version: '1.0.0',
  });
});

// Stateless MCP: one server + transport pair per request. Shared by both
// the free protocol-level path and the post-payment path below.
async function handleMcpRequest(req, res) {
  try {
    const mcpServer = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });
    res.on('close', () => {
      transport.close();
      mcpServer.close();
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

// Bypass: MCP protocol-level requests (initialize, tools/list, ping, ...)
// are not billable and must reach the server even with no payment. Checked
// before the payment middleware; anything else (tools/call) falls through
// to it via next().
app.post('/mcp', (req, res, next) => {
  if (isProtocolOnlyRequest(req.body)) {
    return handleMcpRequest(req, res);
  }
  next();
});

if (paymentMiddleware) {
  // Global mount (per SELLER.md): the middleware matches its own
  // "POST /mcp" route table against req.path. Mounting at a path prefix
  // (app.use('/mcp', ...)) would strip the prefix and the route table
  // would never match, silently serving tools unpaid.
  app.use(paymentMiddleware);
} else {
  // Never serve the tools for free: without a working payment layer,
  // /mcp is unavailable rather than unpaid.
  app.use('/mcp', (_req, res) => {
    res.status(503).json({
      error: 'Payment layer unavailable; /mcp is disabled.',
      detail: paymentSetupError ? paymentSetupError.message : 'unknown',
    });
  });
}

// Reached only after payment middleware has verified/settled a tools/call.
// `exact` signs and settles a fixed amount - no settlement override needed.
app.post('/mcp', handleMcpRequest);

// Stateless server: no SSE streams to resume, no sessions to delete.
app.get('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST.' },
    id: null,
  });
});
app.delete('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST.' },
    id: null,
  });
});

app.listen(PORT, async () => {
  if (resourceServer) {
    try {
      // Must complete before requests are served (SELLER.md requirement).
      await resourceServer.initialize();
      console.error('Payment layer initialized.');
    } catch (err) {
      // Keep the server up (health endpoint stays available); the payment
      // middleware will reject /mcp calls it cannot verify.
      console.error(`Payment layer initialization failed: ${err.message}`);
    }
  }
  console.error(`AgentIndex HTTP server running on port ${PORT}`);
  console.error(`Payment address: ${PAY_TO}`);
  console.error(`Network: X Layer (${NETWORK})`);
});
