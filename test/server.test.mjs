// BSC Mint Radar test suite — mock RPC via fixture JSON, real x402 gateway middleware.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, loadConfig } from '../src/server.mjs';
import { callData, decodeString, decodeUint, createRpcCaller } from '../src/rpc.mjs';
import { createInspectCache, normalizeSourcifyStatus, mapPool, isValidAddress } from '../src/inspect.mjs';
import { buildOpenApi } from '../src/openapi.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, 'fixtures/rpc-fixtures.json'), 'utf8'));

const APE = '0x1111111111111111111111111111111111111111';
const FOX = '0x2222222222222222222222222222222222222222';

/** Mock RPC: serve fixture data per contract per selector; count calls. */
function mockRpc({ counters } = {}) {
  return async function rpcCall(method, params) {
    if (method !== 'eth_call') return '0x0';
    const { to, data } = params[0];
    const key = to.toLowerCase();
    const contract = key === APE ? fx.contracts.demoApe : key === FOX ? fx.contracts.freeMint : null;
    for (const [name, sel] of Object.entries(fx.selectors)) {
      if (data === sel) {
        if (counters) counters[name] = (counters[name] ?? 0) + 1;
        if (contract && contract[name]) return contract[name];
        return null; // selector absent on contract → RPC error path
      }
    }
    return null;
  };
}

/** Mock Sourcify v2: demo contract verified exact + ABI, other → none. */
function mockFetch() {
  return async function fetchImpl(url) {
    if (url.includes('/v2/contract/')) {
      // .../v2/contract/{chainId}/{address}?fields=abi
      const m = url.match(/v2\/contract\/\d+\/(0x[0-9a-fA-F]{40})/);
      const addr = m?.[1]?.toLowerCase();
      if (addr === APE) {
        return {
          ok: true,
          json: async () => ({
            chainId: '56', address: APE, match: 'exact_match',
            abi: [
              { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }] },
              { type: 'function', name: 'pause', inputs: [], outputs: [] },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ chainId: '56', address: addr, match: null }) };
    }
    return { ok: false, json: async () => null };
  };
}

const baseConfig = {
  ...loadConfig(),
  port: 0,
};

const deps = { rpcCall: mockRpc(), fetchImpl: mockFetch(), bypassHeader: 'x-test-pay' };

/** Start app on an ephemeral port; returns { url, close } */
async function serve(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test('GET /health is free and returns status + version', async () => {
  const { url, close } = await serve(createApp(baseConfig, deps));
  try {
    const res = await fetch(`${url}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.version);
    assert.equal(body.chainId, 56);
  } finally { close(); }
});

test('GET /v1/inspect without payment returns 402 with x402 accepts', async () => {
  const { url, close } = await serve(createApp(baseConfig, deps));
  try {
    const res = await fetch(`${url}/v1/inspect?address=${APE}`);
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.ok(Array.isArray(body.accepts) && body.accepts.length > 0, 'machine-readable accepts[]');
    assert.ok(body.x402Version >= 1);
    const scheme = body.accepts[0];
    assert.equal(scheme.scheme, 'exact');
    assert.equal(scheme.network, 'eip155:8453');
    assert.equal(scheme.asset, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'); // USDC on Base
    assert.equal(scheme.payTo.toLowerCase(), '0xae9ad223a1d4e9adecfd3bd8363f1b8ea4e0d512');
    assert.equal(scheme.amount, '1000'); // $0.001 USDC (6 decimals)
  } finally { close(); }
});

test('GET /v1/inspect with payment bypass returns full report', async () => {
  const { url, close } = await serve(createApp(baseConfig, deps));
  try {
    const res = await fetch(`${url}/v1/inspect?address=${APE}`, { headers: { 'x-test-pay': '1' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.address, APE);
    assert.equal(body.name, 'Demo Ape Club');
    assert.equal(body.symbol, 'DAPE');
    assert.equal(body.chainId, 56);
    assert.equal(body.totalSupply, '1234');
    assert.equal(body.maxSupply, '5000');
    assert.equal(body.freeSlots, '3766');
    assert.equal(body.mintPriceWei, '5000000000000000');
    assert.equal(body.mintPriceBNB, 0.005);
    assert.equal(body.isFreeMint, false);
    assert.equal(body.sourcifyMatch, 'exact');
    assert.equal(body.safety.hasOwner, true);
    assert.equal(body.safety.ownerCanPause, true);
    assert.ok(typeof body.fetchedAt === 'string' && !isNaN(Date.parse(body.fetchedAt)));
  } finally { close(); }
});

test('GET /v1/inspect with invalid address returns 400', async () => {
  const { url, close } = await serve(createApp(baseConfig, deps));
  try {
    for (const bad of ['0x123', 'not-an-address', '']) {
      const res = await fetch(`${url}/v1/inspect?address=${encodeURIComponent(bad)}`, { headers: { 'x-test-pay': '1' } });
      assert.equal(res.status, 400, bad);
    }
    assert.equal(isValidAddress('0x123'), false);
    assert.equal(isValidAddress(APE), true);
  } finally { close(); }
});

test('GET /v1/batch with more than 10 addresses returns 400', async () => {
  const { url, close } = await serve(createApp(baseConfig, deps));
  try {
    const addresses = Array.from({ length: 11 }, () => APE).join(',');
    const res = await fetch(`${url}/v1/batch?addresses=${addresses}`, { headers: { 'x-test-pay': '1' } });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /Maximum 10/);
  } finally { close(); }
});

test('GET /v1/batch returns ordered array and handles free-mint + unknown contracts', async () => {
  const { url, close } = await serve(createApp(baseConfig, deps));
  try {
    const unknown = '0x3333333333333333333333333333333333333333';
    const res = await fetch(`${url}/v1/batch?addresses=${APE},${FOX},${unknown}`, { headers: { 'x-test-pay': '1' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 3);
    assert.equal(body[1].isFreeMint, true); // no paying price getter found
    assert.equal(body[1].freeSlots, '1');
    assert.equal(body[2].name, null);
    assert.equal(body[2].sourcifyMatch, 'none'); // sourcify none-handling
    assert.equal(body[2].safety.hasOwner, 'unknown');
  } finally { close(); }
});

test('inspect cache: second lookup hits cache (RPC not re-called)', async () => {
  const counters = {};
  const cache = createInspectCache({
    ttlMs: 600_000,
    inspect: (addr, d) => import('../src/inspect.mjs').then((m) => m.inspectContract(addr, d)),
  });
  const d = { rpcCall: mockRpc({ counters }), sourcifyBase: null, chainId: 56 };
  const first = await cache.get(APE, d);
  const second = await cache.get(APE, d);
  assert.equal(first._cache, 'miss');
  assert.equal(second._cache, 'hit');
  assert.equal(second.name, first.name);
  const rpcCalls = Object.values(counters).reduce((a, b) => a + b, 0);
  const afterSecond = Object.values(counters).reduce((a, b) => a + b, 0);
  await cache.get(APE, d); // third lookup also cached
  assert.equal(Object.values(counters).reduce((a, b) => a + b, 0), afterSecond, 'no new RPC calls after cache');
  assert.ok(rpcCalls > 0);
});

test('cache expiry: entry older than TTL is re-fetched', async () => {
  const counters = {};
  const cache = createInspectCache({
    ttlMs: 50, // 50 ms for test speed
    inspect: (addr, d) => import('../src/inspect.mjs').then((m) => m.inspectContract(addr, d)),
  });
  const d = { rpcCall: mockRpc({ counters }), sourcifyBase: null, chainId: 56 };
  await cache.get(APE, d);
  const calls1 = Object.values(counters).reduce((a, b) => a + b, 0);
  await cache.get(APE, d); // within TTL → cached
  assert.equal(Object.values(counters).reduce((a, b) => a + b, 0), calls1);
  await new Promise((r) => setTimeout(r, 60));
  const again = await cache.get(APE, d);
  assert.equal(again._cache, 'miss');
  assert.ok(Object.values(counters).reduce((a, b) => a + b, 0) > calls1);
});

test('sourcify none-handling: not_found maps to "none", unknown flags "unknown"', async () => {
  const result = await import('../src/inspect.mjs').then((m) =>
    m.inspectContract(FOX, { rpcCall: mockRpc(), sourcifyBase: 'https://sourcify.dev/server/check-all-by-addresses', chainId: 56, fetchImpl: mockFetch() }),
  );
  assert.equal(result.sourcifyMatch, 'none');
  assert.equal(result.safety.hasOwner, 'unknown');
  assert.equal(result.safety.ownerCanPause, 'unknown');
});

test('GET /openapi.json is valid JSON with 2 paid paths and x-payment-info', async () => {
  const { url, close } = await serve(createApp(baseConfig, deps));
  try {
    const res = await fetch(`${url}/openapi.json`);
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.openapi, '3.1.0');
    assert.ok(doc.paths['/v1/inspect']);
    assert.ok(doc.paths['/v1/batch']);
    for (const p of ['/v1/inspect', '/v1/batch']) {
      assert.equal(doc.paths[p].get.responses['402'].description.includes('x402'), true);
      assert.ok(doc.paths[p].get['x-payment-info'].payTo.startsWith('0x'));
    }
    assert.ok(doc.paths['/health'] === undefined, 'free routes not required in doc');
    // round-trip JSON validity
    JSON.parse(JSON.stringify(doc));
  } finally { close(); }
});

test('unit: rpc decoders and sourcify status normalization', async () => {
  assert.equal(decodeString(fx.contracts.demoApe.name), 'Demo Ape Club');
  assert.equal(decodeUint(fx.contracts.demoApe.totalSupply), 1234n);
  assert.equal(decodeUint('0xzz'), null);
  assert.equal(decodeString('0x'), null);
  assert.equal(normalizeSourcifyStatus('exact_match'), 'exact');
  assert.equal(normalizeSourcifyStatus('partial_match'), 'partial');
  assert.equal(normalizeSourcifyStatus('match'), 'match');
  assert.equal(normalizeSourcifyStatus('not_found'), 'none');
  assert.equal(typeof callData('name'), 'string');
});

test('rpc caller fails over between urls and throws when all fail', async () => {
  let which = 0;
  const rpcCall = createRpcCaller(['https://bad-a.invalid', 'https://bad-b.invalid'], {
    callFn: async (url) => {
      which++;
      if (url.includes('bad-a')) throw new Error('boom');
      if (url.includes('bad-b')) throw new Error('also boom');
      return { jsonrpc: '2.0', id: 1, result: '0x1' };
    },
  });
  await assert.rejects(() => rpcCall('eth_call', [{ to: APE, data: callData('name') }, 'latest']), /also boom/);
  assert.equal(which, 2, 'tried both urls');

  const okCall = createRpcCaller(['https://x'], { callFn: async () => ({ jsonrpc: '2.0', id: 1, result: '0x01' }) });
  assert.equal(await okCall('eth_blockNumber', []), '0x01');
});

test('mapPool preserves order with bounded concurrency', async () => {
  const seen = [];
  let active = 0, maxActive = 0;
  const out = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active--; seen.push(n);
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(maxActive <= 3, `concurrency bounded (max ${maxActive})`);
});
