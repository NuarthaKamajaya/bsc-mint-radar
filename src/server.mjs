// BSC Mint Radar server. Free: /health, /openapi.json. Paid (x402 USDC on Base):
// /v1/inspect, /v1/batch — via @circle-fin/x402-batching Gateway middleware.
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { createRpcCaller } from './rpc.mjs';
import { inspectContract, createInspectCache, mapPool, isValidAddress } from './inspect.mjs';
import { buildOpenApi } from './openapi.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadConfig(overrides = {}) {
  const file = readFileSync(overrides.configPath ?? join(__dirname, 'config.json'), 'utf8');
  const config = { ...JSON.parse(file), ...overrides };
  // PORT/Seller address can be overridden via env, never secrets.
  if (process.env.PORT) config.port = Number(process.env.PORT);
  if (process.env.SELLER_ADDRESS) config.sellerAddress = process.env.SELLER_ADDRESS;
  return config;
}

export function createApp(config, deps = {}) {
  const rpcCall = deps.rpcCall ?? createRpcCaller(config.rpcUrls);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cache = createInspectCache({
    ttlMs: config.cacheTtlMs,
    inspect: (address, d) => inspectContract(address, d),
  });

  const app = express();

  const gateway = createGatewayMiddleware({
    sellerAddress: config.sellerAddress,
    networks: config.network,
    facilitatorUrl: config.facilitatorUrl,
    description: 'BSC Mint Radar — live BSC NFT contract inspection',
  });
  // Optional key-based access bypass (uses the SDK's official hook). Enabled
  // only when deps.bypassHeader is provided — e.g. tests; off in production.
  if (deps.bypassHeader) {
    gateway.onProtectedRequest(async (ctx) => {
      const v = ctx.getHeader(deps.bypassHeader);
      if (v && (!deps.bypassValue || v === deps.bypassValue)) return { grantAccess: true };
      return undefined;
    });
  }

  // ---- Free routes ----
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.0', chainId: config.chainId, paidEndpoints: ['/v1/inspect', '/v1/batch'], price: config.price });
  });

  app.get('/openapi.json', (req, res) => {
    res.json(buildOpenApi(config));
  });

  // ---- Paid routes ----
  // Pre-validation runs BEFORE the payment gate: an unpaid request with bad
  // input gets an honest 400, not a paid-wall 402. Paid requests are
  // re-validated inside the handler (defense in depth).
  const validateInspect = (req, res, next) => {
    if (!isValidAddress(req.query.address)) {
      return res.status(400).json({ error: 'invalid_address', message: 'Provide ?address=0x… (40-hex EVM address)' });
    }
    next();
  };
  const validateBatch = (req, res, next) => {
    const raw = req.query.addresses;
    if (typeof raw !== 'string' || raw.trim() === '') {
      return res.status(400).json({ error: 'missing_addresses', message: 'Provide ?addresses=0x…,0x… (max 10)' });
    }
    const addresses = raw.split(',').map((s) => s.trim());
    if (addresses.length > config.batchMax) {
      return res.status(400).json({ error: 'too_many_addresses', message: `Maximum ${config.batchMax} addresses per batch` });
    }
    for (const a of addresses) {
      if (!isValidAddress(a)) {
        return res.status(400).json({ error: 'invalid_address', message: `Not a valid EVM address: ${a}` });
      }
    }
    next();
  };
  const requirePayment = (req, res, next) => {
    // The SDK answers unpaid requests with HTTP 402, payload in the base64url
    // `PAYMENT-REQUIRED` header, and writes the body via raw res.end('{}').
    // Intercept res.end so the payload is mirrored into a machine-readable body.
    const origEnd = res.end.bind(res);
    res.end = function (chunk, ...rest) {
      if (res.statusCode === 402 && (chunk === undefined || typeof chunk === 'string')) {
        const hdr = res.getHeader('PAYMENT-REQUIRED') ?? res.getHeader('payment-required');
        if (typeof hdr === 'string' && hdr) {
          try {
            const b64 = hdr.replace(/-/g, '+').replace(/_/g, '/');
            chunk = JSON.stringify(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')));
          } catch { /* keep original body */ }
        }
      }
      return origEnd(chunk, ...rest);
    };
    gateway.require(config.price ?? '$0.001')(req, res, next);
  };

  app.get('/v1/inspect', validateInspect, requirePayment, async (req, res) => {
    const address = req.query.address;
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'invalid_address', message: 'Provide ?address=0x… (40-hex EVM address)' });
    }
    try {
      const { _cache, ...result } = await cache.get(address, {
        rpcCall,
        fetchImpl,
        sourcifyBase: config.sourcifyUrl,
        chainId: config.chainId,
      });
      res.set('X-Cache', _cache);
      res.json(result);
    } catch (e) {
      res.status(502).json({ error: 'rpc_unavailable', message: e.message });
    }
  });

  app.get('/v1/batch', validateBatch, requirePayment, async (req, res) => {
    const raw = req.query.addresses;
    if (typeof raw !== 'string' || raw.trim() === '') {
      return res.status(400).json({ error: 'missing_addresses', message: 'Provide ?addresses=0x…,0x… (max 10)' });
    }
    const addresses = raw.split(',').map((s) => s.trim());
    if (addresses.length > config.batchMax) {
      return res.status(400).json({ error: 'too_many_addresses', message: `Maximum ${config.batchMax} addresses per batch` });
    }
    for (const a of addresses) {
      if (!isValidAddress(a)) {
        return res.status(400).json({ error: 'invalid_address', message: `Not a valid EVM address: ${a}` });
      }
    }
    try {
      const results = await mapPool(addresses, config.batchConcurrency, async (address) => {
        try {
          const { _cache, ...result } = await cache.get(address, {
            rpcCall,
            fetchImpl,
            sourcifyBase: config.sourcifyUrl,
            chainId: config.chainId,
          });
          return result;
        } catch (e) {
          return { address, error: 'rpc_unavailable', message: e.message };
        }
      });
      res.json(results);
    } catch (e) {
      res.status(502).json({ error: 'batch_failed', message: e.message });
    }
  });

  return app;
}

export function start(config, deps = {}) {
  const app = createApp(config, deps);
  const server = app.listen(config.port, () => {
    console.log(`BSC Mint Radar listening on :${config.port} — paid routes ${config.price} USDC (x402, Base) → ${config.sellerAddress}`);
  });
  return { app, server };
}

// Run only when executed directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start(loadConfig());
}
