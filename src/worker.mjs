// Cloudflare Worker entry (branch `workers`).
// Same API surface as the Express version (src/server.mjs) but as a Hono
// fetch-handler so it runs on Workers' V8-isolate runtime (no Node APIs).
//
// Payment gate: @x402/hono (x402 v2, Circle-compatible facilitator client) +
// @x402/evm ExactEvmScheme. 402 responses carry the machine-readable
// PAYMENT-REQUIRED header (base64url JSON) per x402 v2.
//
// Business logic (RPC failover, inspection, Sourcify v2, TTL cache) is reused
// from src/rpc.mjs and src/inspect.mjs — they are pure fetch/JS and
// Workers-compatible, no fs, no Node-only APIs.
import { Hono } from 'hono';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { createRpcCaller } from './rpc.mjs';
import { inspectContract, createInspectCache, mapPool, isValidAddress } from './inspect.mjs';
import { buildOpenApi } from './openapi.mjs';

// Static config (Workers cannot readFileSync; values mirror src/config.json,
// overridden per-deploy via vars in wrangler.jsonc / environment).
export const workerConfig = {
  chainId: 56,
  network: 'eip155:8453',
  sellerAddress: '0xAe9ad223a1D4e9ADecFd3BD8363f1b8Ea4e0d512',
  price: '$0.001',
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  rpcUrls: [
    'https://bsc-dataseed.binance.org',
    'https://bsc-rpc.publicnode.com',
  ],
  sourcifyUrl: 'https://sourcify.dev/server/v2/contract',
  cacheTtlMs: 600000, // 10 minutes
  batchMax: 10,
  batchConcurrency: 5,
  facilitatorUrl: 'https://api.circle.com/v1/facilitator/x402',
};

/**
 * Build the Hono app. Mirrors createApp() from the Express version.
 * @param {object} [config] overrides merged over workerConfig
 * @param {object} [deps] injectable for tests: rpcCall, fetchImpl, facilitator,
 *   bypassHeader/bypassValue, syncFacilitatorOnStart
 */
export function createWorkerApp(config = {}, deps = {}) {
  const cfg = { ...workerConfig, ...config };
  const rpcCall = deps.rpcCall ?? createRpcCaller(cfg.rpcUrls);
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Module-level TTL Map cache (10 min). Isolate restarts lose it — acceptable
  // warm cache, same semantics as the in-process cache on Express.
  const cache = createInspectCache({
    ttlMs: cfg.cacheTtlMs,
    inspect: (address, d) => inspectContract(address, d),
  });

  const facilitator = deps.facilitator ?? new HTTPFacilitatorClient({
    url: cfg.facilitatorUrl,
    ...(deps.facilitatorAuth ? { createAuthHeaders: deps.facilitatorAuth } : {}),
  });
  const resourceServer = new x402ResourceServer(facilitator)
    .register(cfg.network, new ExactEvmScheme());
  // Facilitator /supported sync runs lazily on first paid request (Workers has
  // no startup phase; single-flight so concurrent cold requests share it).
  let initPromise = null;
  const ensureInit = () => {
    if (!initPromise) {
      initPromise = resourceServer.initialize();
      initPromise.catch(() => { initPromise = null; }); // allow retry on next request
    }
    return initPromise;
  };

  // Machine-readable 402 body mirroring the PAYMENT-REQUIRED header payload
  // (the header is authoritative per x402 v2; the body mirrors it so plain
  // HTTP clients don't need base64url decoding — same behavior as Express).
  const acceptsWire = {
    scheme: 'exact',
    network: cfg.network,
    amount: '1000', // $0.001 in USDC (6 decimals)
    asset: cfg.usdcAddress,
    payTo: cfg.sellerAddress,
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  };
  const unpaidBody = () => ({
    contentType: 'application/json',
    body: { x402Version: 2, error: 'Payment required', accepts: [acceptsWire] },
  });
  const routeCfg = {
    accepts: {
      scheme: 'exact',
      price: cfg.price,
      network: cfg.network,
      payTo: cfg.sellerAddress,
    },
    description: 'BSC Mint Radar — live BSC NFT contract inspection',
    mimeType: 'application/json',
    unpaidResponseBody: unpaidBody,
  };
  const paymentMw = paymentMiddleware(
    {
      'GET /v1/inspect': routeCfg,
      'GET /v1/batch': { ...routeCfg, description: 'BSC Mint Radar — batch inspection (max 10)' },
    },
    resourceServer,
    undefined, // paywallConfig (default HTML paywall)
    undefined, // paywall provider
    deps.syncFacilitatorOnStart ?? false,
  );

  const app = new Hono();

  // ---- Free routes ----
  app.get('/health', (c) => c.json({
    status: 'ok',
    version: '1.0.0',
    runtime: 'cloudflare-workers',
    chainId: cfg.chainId,
    paidEndpoints: ['/v1/inspect', '/v1/batch'],
    price: cfg.price,
  }));

  app.get('/openapi.json', (c) => c.json(buildOpenApi(cfg)));

  // x402 discovery manifest (agent402 / directories crawler)
  app.get('/.well-known/x402', (c) => c.json({
    x402Version: 2,
    resources: [
      {
        resource: `${c.env?.PUBLIC_ORIGIN ?? 'https://bsc-mint-radar.kamajaya-agents.workers.dev'}/v1/inspect`,
        method: 'GET',
        description: 'BSC Mint Radar — live BSC NFT contract inspection: name/symbol, supply, mint price, free mint slots, Sourcify match, safety flags',
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '1000',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          payTo: cfg.sellerAddress,
          maxTimeoutSeconds: 300,
          extra: { name: 'USD Coin', version: '2' },
        }],
      },
      {
        resource: `${c.env?.PUBLIC_ORIGIN ?? 'https://bsc-mint-radar.kamajaya-agents.workers.dev'}/v1/batch`,
        method: 'GET',
        description: 'BSC Mint Radar — batch NFT contract inspection (up to 10 addresses in one call)',
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '1000',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          payTo: cfg.sellerAddress,
          maxTimeoutSeconds: 300,
          extra: { name: 'USD Coin', version: '2' },
        }],
      },
    ],
  }));

  // ---- Paid routes ----
  // Validation runs BEFORE the payment gate: unpaid bad input gets an honest
  // 400, not a 402 paywall (same behavior as the Express version).
  app.use('/v1/*', async (c, next) => {
    const { path } = c.req;
    if (path === '/v1/inspect') {
      const address = c.req.query('address');
      // Bare unpaid probe (no param) must still return 402 so directory
      // crawlers can read our price/chain (agent402/PayAPI/minia2a rule).
      // Only a present-but-invalid address gets an honest 400.
      if (address === undefined || address.trim() === '') {
        // fall through to the payment gate
      } else if (!isValidAddress(address)) {
        return c.json({ error: 'invalid_address', message: 'Provide ?address=0x… (40-hex EVM address)' }, 400);
      }
    } else if (path === '/v1/batch') {
      const raw = c.req.query('addresses');
      if (typeof raw !== 'string' || raw.trim() === '') {
        // bare unpaid probe → let the payment gate answer 402
      } else {
      const addresses = raw.split(',').map((s) => s.trim());
      if (addresses.length > cfg.batchMax) {
        return c.json({ error: 'too_many_addresses', message: `Maximum ${cfg.batchMax} addresses per batch` }, 400);
      }
      for (const a of addresses) {
        if (!isValidAddress(a)) {
          return c.json({ error: 'invalid_address', message: `Not a valid EVM address: ${a}` }, 400);
        }
      }
      }
    } else {
      return c.json({ error: 'not_found' }, 404);
    }
    // Optional key-based access bypass (tests / ops only; off unless enabled).
    if (deps.bypassHeader) {
      const v = c.req.header(deps.bypassHeader);
      if (v && (!deps.bypassValue || v === deps.bypassValue)) return next();
    }
    await ensureInit();
    const resp = await paymentMw(c, next);
    // Directory crawlers (PayAPI/agent402/minia2a) read payTo from the JSON
    // body, but the SDK's 402 payload omits it — inject it into the body copy.
    if (resp && resp.status === 402) {
      try {
        const clone = new Response(await resp.clone().text(), resp);
        const payload = await clone.json();
        for (const a of payload?.accepts ?? []) {
          if (!a.payTo) a.payTo = cfg.sellerAddress;
        }
        return c.json(payload, 402, Object.fromEntries(resp.headers));
      } catch {
        return resp;
      }
    }
    return resp;
  });

  const inspectOne = async (address) => {
    const { _cache, ...result } = await cache.get(address, {
      rpcCall,
      fetchImpl,
      sourcifyBase: cfg.sourcifyUrl,
      chainId: cfg.chainId,
    });
    return { result, cacheState: _cache };
  };

  app.get('/v1/inspect', async (c) => {
    try {
      const { result, cacheState } = await inspectOne(c.req.query('address'));
      c.header('X-Cache', cacheState);
      return c.json(result);
    } catch (e) {
      return c.json({ error: 'rpc_unavailable', message: e.message }, 502);
    }
  });

  app.get('/v1/batch', async (c) => {
    const addresses = c.req.query('addresses').split(',').map((s) => s.trim());
    try {
      const results = await mapPool(addresses, cfg.batchConcurrency, async (address) => {
        try {
          const { result } = await inspectOne(address);
          return result;
        } catch (e) {
          return { address, error: 'rpc_unavailable', message: e.message };
        }
      });
      return c.json(results);
    } catch (e) {
      return c.json({ error: 'batch_failed', message: e.message }, 502);
    }
  });

  return app;
}

// Default fetch handler for Cloudflare Workers.
// CIRCLE_API_KEY is a Worker secret (wrangler secret put CIRCLE_API_KEY) —
// never stored in the repo.
const authFor = (apiKey) => () => ({
  verify: { Authorization: `Bearer ${apiKey}` },
  settle: { Authorization: `Bearer ${apiKey}` },
});

export default {
  fetch(request, env, ctx) {
    const app = createWorkerApp({
      sellerAddress: env.SELLER_ADDRESS || undefined,
      facilitatorUrl: env.FACILITATOR_URL || undefined,
      publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
    }, {
      facilitatorAuth: env.CIRCLE_API_KEY ? authFor(env.CIRCLE_API_KEY) : undefined,
    });
    return app.fetch(request, env, ctx);
  },
};
