// server/http.js - Phase 3 HTTP entry point
// Wraps the same 5 MCP tools (from server/index.js) behind Express with
// x402 payment middleware. Paying agents POST /mcp and pay per tool call
// in USDT0 on X Layer (eip155:196). Unpaid requests get a 402 challenge.
//
// Pricing design: setSettlementOverrides requires the `upto` scheme -
// the buyer signs a spending cap (the price of the most expensive tool)
// and the server settles the actual per-tool amount, which must be <= cap.
// `exact` (EIP-3009) signs a fixed amount that cannot vary at settlement,
// so it cannot express per-tool pricing on a single /mcp route. The
// ExactEvmScheme is still registered on the resource server (capability),
// but the offered payment option is `upto` with a $1.00 cap.
require('dotenv').config();
const express = require('express');
const { OKXFacilitatorClient } = require('@okxweb3/x402-core');
const {
  x402ResourceServer,
  x402HTTPResourceServer,
  paymentMiddlewareFromHTTPServer,
  setSettlementOverrides,
} = require('@okxweb3/x402-express');
const { ExactEvmScheme } = require('@okxweb3/x402-evm/exact/server');
const { UptoEvmScheme } = require('@okxweb3/x402-evm/upto/server');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { createServer } = require('./index.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PAY_TO = process.env.PAYMENT_ADDRESS || '0xdf54982caada64c73f7f27afc11a9600a36625aa';
const NETWORK = 'eip155:196'; // X Layer mainnet

// Per-tool prices in USD. The `upto` cap must be >= the max price here.
const TOOL_PRICES_USD = {
  market_overview: 0.10,
  category_report: 0.50,
  pricing_benchmark: 0.50,
  gap_finder: 1.00,
  agent_profile: 0.25,
};
const PRICE_CAP_USD = Math.max(...Object.values(TOOL_PRICES_USD)); // 1.00

// Compute the settlement amount for one JSON-RPC body (single message or
// batch). Only tools/call messages with a known tool name are billed;
// protocol traffic (initialize, tools/list, notifications, ping) settles
// "0" which short-circuits with no on-chain transaction. Batches sum the
// per-tool prices, clamped to the signed cap.
function settlementAmountFor(body) {
  const messages = Array.isArray(body) ? body : [body];
  let totalUsd = 0;
  for (const msg of messages) {
    if (msg && msg.method === 'tools/call') {
      const toolName = msg.params && msg.params.name;
      const price = TOOL_PRICES_USD[toolName];
      if (typeof price === 'number') totalUsd += price;
    }
  }
  if (totalUsd <= 0) return '0';
  return `$${Math.min(totalUsd, PRICE_CAP_USD).toFixed(2)}`;
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
    .register(NETWORK, new ExactEvmScheme())
    .register(NETWORK, new UptoEvmScheme());

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    'POST /mcp': {
      accepts: {
        scheme: 'upto',
        network: NETWORK,
        payTo: PAY_TO,
        price: `$${PRICE_CAP_USD.toFixed(2)}`, // cap; actual amount set per call
        maxTimeoutSeconds: 300,
      },
      description:
        'AgentIndex - OKX.AI marketplace intelligence over MCP. ' +
        'Per-tool pricing (settled from your signed cap): market_overview $0.10, ' +
        'category_report $0.50, pricing_benchmark $0.50, gap_finder $1.00, agent_profile $0.25.',
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

// Stateless MCP: one server + transport pair per request.
app.post('/mcp', async (req, res) => {
  try {
    setSettlementOverrides(res, { amount: settlementAmountFor(req.body) });

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
});

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
