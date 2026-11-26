// Contract inspection + 10-minute in-memory cache + optional Sourcify enrichment.
import {
  callData,
  decodeUint,
  decodeString,
  decodeAddress,
} from './rpc.mjs';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidAddress(a) {
  return typeof a === 'string' && ADDRESS_RE.test(a);
}

export const MAX_SUPPLY_SIGS = ['maxSupply', 'MAX_SUPPLY', 'hardCap', 'maximum'];
export const PRICE_SIGS = ['cost', 'price', 'mintPrice', 'MINT_PRICE', 'publicPrice', 'salePrice'];

/** Convert Sourcify match value to our vocabulary. */
export function normalizeSourcifyStatus(status) {
  switch (status) {
    case 'exact_match':
      return 'exact';
    case 'match':
    case 'match_runtime':
      return 'match';
    case 'partial_match':
      return 'partial';
    default:
      return 'none';
  }
}

/**
 * Fetch Sourcify verification status + ABI via the v2 API (v1 check-all-by-addresses
 * was retired). Shape: GET {base}/{chainId}/{address}?fields=abi →
 * { abi, match: 'exact_match'|'match'|null, ... }.
 * @returns {Promise<{match: string, abi: object[]|null}>}
 */
export async function fetchSourcify(address, chainId, sourcifyBase, fetchImpl = fetch) {
  const url = `${String(sourcifyBase).replace(/\/$/, '')}/${chainId}/${address}?fields=abi`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return { match: 'none', abi: null };
    const body = await res.json();
    const abi = Array.isArray(body?.abi) ? body.abi : null;
    const status = body?.match ?? body?.runtimeMatch ?? null;
    if (!status) return { match: 'none', abi: null };
    return { match: normalizeSourcifyStatus(status), abi };
  } catch {
    return { match: 'none', abi: null };
  }
}

function abiHasFn(abi, name) {
  return Array.isArray(abi) && abi.some((e) => e?.type === 'function' && e?.name === name && (e.inputs?.length ?? 0) === 0);
}

/** Try each candidate zero-arg uint256 view; return first non-null. */
async function tryUint(rpcCall, address, sigs) {
  for (const sig of sigs) {
    try {
      const res = await rpcCall('eth_call', [{ to: address, data: callData(sig) }, 'latest']);
      const v = decodeUint(res);
      if (v !== null) return { value: v, sig };
    } catch { /* function absent — try next */ }
  }
  return null;
}

/**
 * Inspect one contract.
 * @param {string} address
 * @param {object} deps { rpcCall, fetchImpl?, sourcifyBase?, chainId? }
 */
export async function inspectContract(address, deps) {
  const { rpcCall, fetchImpl = fetch, sourcifyBase, chainId = 56 } = deps;
  const addr = address;

  const [nameRaw, symbolRaw, supplyRaw, maxRes, priceRes, sourcify] = await Promise.all([
    rpcCall('eth_call', [{ to: addr, data: callData('name') }, 'latest']).catch(() => null),
    rpcCall('eth_call', [{ to: addr, data: callData('symbol') }, 'latest']).catch(() => null),
    rpcCall('eth_call', [{ to: addr, data: callData('totalSupply') }, 'latest']).catch(() => null),
    tryUint(rpcCall, addr, MAX_SUPPLY_SIGS),
    tryUint(rpcCall, addr, PRICE_SIGS),
    sourcifyBase ? fetchSourcify(addr, chainId, sourcifyBase, fetchImpl) : Promise.resolve({ match: 'none', abi: null }),
  ]);

  const name = decodeString(nameRaw);
  const symbol = decodeString(symbolRaw);
  const totalSupply = decodeUint(supplyRaw);
  const maxSupply = maxRes ? maxRes.value : null;
  const freeSlots = totalSupply !== null && maxSupply !== null && maxSupply >= totalSupply
    ? maxSupply - totalSupply
    : null;

  const mintPriceWei = priceRes ? priceRes.value : null;
  const bnb = mintPriceWei === null ? null : Number(mintPriceWei) / 1e18;
  // Per spec: free when price is 0, or when no paying price function exists.
  const isFreeMint = mintPriceWei === null || mintPriceWei === 0n;

  const abi = sourcify.abi;
  const hasOwner = abi ? abiHasFn(abi, 'owner') : 'unknown';
  const ownerCanPause = abi ? abiHasFn(abi, 'pause') : 'unknown';

  return {
    address: addr,
    name,
    symbol,
    chainId,
    totalSupply: totalSupply === null ? null : totalSupply.toString(),
    maxSupply: maxSupply === null ? null : maxSupply.toString(),
    freeSlots: freeSlots === null ? null : freeSlots.toString(),
    mintPriceWei: mintPriceWei === null ? null : mintPriceWei.toString(),
    mintPriceBNB: bnb,
    priceFunction: priceRes ? priceRes.sig : null,
    isFreeMint,
    sourcifyMatch: sourcify.match,
    safety: { hasOwner, ownerCanPause },
    fetchedAt: new Date().toISOString(),
  };
}

/** Simple TTL cache with single-flight de-duplication. */
export function createInspectCache({ ttlMs = 600_000, inspect }) {
  const store = new Map(); // key -> { at, value }
  const inflight = new Map();

  async function get(address, deps) {
    const key = address.toLowerCase();
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return { ...hit.value, _cache: 'hit' };
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const value = await inspect(address, deps);
      store.set(key, { at: Date.now(), value });
      return { ...value, _cache: 'miss' };
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return { get, _store: store };
}

/** Run tasks with bounded concurrency, preserving input order. */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
