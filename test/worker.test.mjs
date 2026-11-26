// Worker tests — vitest (Node). Exercises the Hono app via app.request(),
// with an in-memory stub facilitator (no network) and mocked RPC/fetch.
import { describe, it, expect } from 'vitest';
import { createWorkerApp } from '../src/worker.mjs';
import { createRpcCaller } from '../src/rpc.mjs';

const SELLER = '0xAe9ad223a1D4e9ADecFd3BD8363f1b8Ea4e0d512';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ADDR = '0x1234567890abcdef1234567890abcdef12345678';

/** Stub facilitator: x402 v2 exact scheme on Base, verify/settle offline. */
function stubFacilitator() {
  return {
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
      extensions: [],
    }),
    verify: async () => ({ isValid: true, payer: ADDR }),
    settle: async () => ({ success: true, transaction: '0xdeadbeef', network: 'eip155:8453' }),
  };
}

/** Mocked RPC caller: one-word eth_call results, counts calls. */
function mockRpc(urlLog = null) {
  let n = 0;
  const callFn = async (url, payload) => {
    if (urlLog) urlLog.push(url);
    n += 1;
    return { jsonrpc: '2.0', id: 1, result: '0x00' }; // decodes to null everywhere
  };
  return { rpcCall: createRpcCaller(['https://rpc-a.invalid', 'https://rpc-b.invalid'], { callFn }), count: () => n };
}

/** fetchImpl stub: Sourcify always 404 → match 'none'. */
const sourcifyNoneFetch = async () => ({ ok: false, json: async () => ({}) });

function makeApp(extraDeps = {}) {
  const { rpcCall } = mockRpc();
  return createWorkerApp({}, {
    rpcCall,
    fetchImpl: sourcifyNoneFetch,
    facilitator: stubFacilitator(),
    bypassHeader: 'x-test-bypass',
    bypassValue: 'letmein',
    ...extraDeps,
  });
}

const bypass = { 'x-test-bypass': 'letmein' };

describe('worker: free routes', () => {
  it('GET /health → 200 with paid endpoints and price', async () => {
    const res = await makeApp().request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.paidEndpoints).toEqual(['/v1/inspect', '/v1/batch']);
    expect(body.price).toBe('$0.001');
    expect(body.chainId).toBe(56);
  });

  it('GET /openapi.json → valid doc with both paid paths and payment info', async () => {
    const res = await makeApp().request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toMatch(/^3\./);
    for (const p of ['/v1/inspect', '/v1/batch']) {
      expect(doc.paths[p]).toBeTruthy();
      expect(doc.paths[p].get['x-payment-info']).toMatchObject({
        protocol: 'x402', network: 'eip155:8453', payTo: SELLER, price: '$0.001',
      });
    }
  });
});

describe('worker: validation before payment gate', () => {
  it('unpaid /v1/inspect with invalid address → 400 (not 402)', async () => {
    const res = await makeApp().request('/v1/inspect?address=0xbad');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_address');
    expect(res.headers.get('payment-required')).toBeNull();
  });

  it('unpaid /v1/batch with >10 addresses → 400', async () => {
    const addresses = Array.from({ length: 11 }, (_, i) =>
      `0x${String(i).padStart(2, '0').repeat(0) || ''}${(i + 1).toString(16).padStart(40, '1')}`).join(',');
    const res = await makeApp().request(`/v1/batch?addresses=${addresses}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('too_many_addresses');
  });

  it('unpaid /v1/batch missing addresses → 402 (bare probe must expose price)', async () => {
    const res = await makeApp().request('/v1/batch');
    expect(res.status).toBe(402);
  });

  it('unpaid /v1/inspect missing address → 402 (bare probe must expose price)', async () => {
    const res = await makeApp().request('/v1/inspect');
    expect(res.status).toBe(402);
  });
});

describe('worker: x402 payment gate (unpaid → 402)', () => {
  it('unpaid /v1/inspect → 402 with base64url PAYMENT-REQUIRED header + machine-readable body', async () => {
    const res = await makeApp().request(`/v1/inspect?address=${ADDR}`);
    expect(res.status).toBe(402);
    const hdr = res.headers.get('payment-required');
    expect(hdr).toBeTruthy();
    // base64url decode (v2 spec: payload lives in the header)
    const b64 = hdr.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    const accept = decoded.accepts[0];
    expect(accept.scheme).toBe('exact');
    expect(accept.network).toBe('eip155:8453');
    expect(accept.payTo).toBe(SELLER);
    if (accept.asset) expect(accept.asset.toLowerCase()).toBe(USDC_BASE.toLowerCase());
    // body mirrors the header payload (machine-readable for API clients)
    const body = await res.json();
    expect(body.accepts?.[0]?.payTo).toBe(SELLER);
    expect(body.accepts?.[0]?.asset?.toLowerCase()).toBe(USDC_BASE.toLowerCase());
    expect(body.x402Version).toBe(2);
  });
});

describe('worker: business logic through paid route (bypass header)', () => {
  it('paid /v1/inspect → 200, Sourcify none, then cache hit on second call', async () => {
    const urlLog = [];
    const { rpcCall } = mockRpc(urlLog);
    const app = createWorkerApp({}, {
      rpcCall,
      fetchImpl: sourcifyNoneFetch,
      facilitator: stubFacilitator(),
      bypassHeader: 'x-test-bypass',
      bypassValue: 'letmein',
    });
    const res1 = await app.request(`/v1/inspect?address=${ADDR}`, { headers: bypass });
    expect(res1.status).toBe(200);
    expect(res1.headers.get('X-Cache')).toBe('miss');
    const body1 = await res1.json();
    expect(body1.address).toBe(ADDR);
    expect(body1.sourcifyMatch).toBe('none'); // Sourcify v2 → 404 → none
    expect(body1.chainId).toBe(56);

    const res2 = await app.request(`/v1/inspect?address=${ADDR}`, { headers: bypass });
    expect(res2.status).toBe(200);
    expect(res2.headers.get('X-Cache')).toBe('hit'); // 10-minute TTL cache
    expect(urlLog.filter((u) => u.includes('rpc-b.invalid')).length).toBe(0);
  });

  it('paid /v1/batch → 200 array of results for ≤10 addresses', async () => {
    const a2 = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const res = await makeApp().request(`/v1/batch?addresses=${ADDR},${a2}`, { headers: bypass });
    expect(res.status).toBe(200);
    const results = await res.json();
    expect(results).toHaveLength(2);
    expect(results[0].address).toBe(ADDR);
    expect(results[1].sourcifyMatch).toBe('none');
  });

  it('paid /v1/inspect with dead RPC degrades to 200 with null fields (inspect never throws)', async () => {
    const rpcCall = createRpcCaller(['https://rpc-a.invalid'], {
      callFn: async () => { throw new Error('connection refused'); },
    });
    const app = createWorkerApp({}, {
      rpcCall,
      fetchImpl: sourcifyNoneFetch,
      facilitator: stubFacilitator(),
      bypassHeader: 'x-test-bypass',
      bypassValue: 'letmein',
    });
    const res = await app.request(`/v1/inspect?address=${ADDR}`, { headers: bypass });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalSupply).toBeNull();
    expect(body.mintPriceWei).toBeNull();
    expect(body.isFreeMint).toBe(true); // no paying price getter found → free
    expect(body.sourcifyMatch).toBe('none');
  });
});

describe('rpc failover (reused src/rpc.mjs)', () => {
  it('fails over to the second URL when the first errors', async () => {
    const urlLog = [];
    const rpcCall = createRpcCaller(['https://rpc-a.invalid', 'https://rpc-b.invalid'], {
      callFn: async (url) => {
        urlLog.push(url);
        if (url.includes('rpc-a')) throw new Error('boom');
        return { jsonrpc: '2.0', id: 1, result: '0x01' };
      },
    });
    const result = await rpcCall('eth_call', [{ to: ADDR, data: '0x00' }, 'latest']);
    expect(result).toBe('0x01');
    expect(urlLog).toEqual(['https://rpc-a.invalid', 'https://rpc-b.invalid']);
  });

  it('tries next URL on rpc-level error object too', async () => {
    const rpcCall = createRpcCaller(['https://rpc-a.invalid', 'https://rpc-b.invalid'], {
      callFn: async (url) => url.includes('rpc-a')
        ? { jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } }
        : { jsonrpc: '2.0', id: 1, result: '0x02' },
    });
    expect(await rpcCall('eth_blockNumber', [])).toBe('0x02');
  });
});
