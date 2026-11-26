// Low-level BSC JSON-RPC helpers. Pure functions, no network hardcoding beyond
// injected fetcher — makes it testable and Deno-portable (fetch is global).
import { toFunctionSelector, decodeAbiParameters } from 'viem';

const HEX = /^0x[0-9a-fA-F]*$/;

/** Build eth_call data for a zero-arg view function. */
export function callData(fnName) {
  return toFunctionSelector(`${fnName}()`);
}

/** Decode a 32-byte word as uint256 BigInt, or null on failure. */
export function decodeUint(hex) {
  if (typeof hex !== 'string' || !HEX.test(hex) || hex.length < 4) return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

/** Decode ABI-encoded dynamic string result, or null on failure. */
export function decodeString(hex) {
  if (typeof hex !== 'string' || !HEX.test(hex) || hex.length <= 2 + 128) return null;
  try {
    const [s] = decodeAbiParameters([{ type: 'string' }], hex);
    return typeof s === 'string' ? s : null;
  } catch {
    return null;
  }
}

export function decodeAddress(hex) {
  if (typeof hex !== 'string' || !HEX.test(hex) || hex.length !== 66) return null;
  const addr = '0x' + hex.slice(26);
  return /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr : null;
}

/**
 * Create an RPC caller against a list of URLs with simple failover.
 * callFn(fetcherUrl, payload) is injectable for tests; defaults to global fetch.
 * @param {string[]} urls RPC endpoints in priority order
 * @param {{callFn?: Function}} [opts]
 * @returns {(method: string, params: any[]) => Promise<any>}
 */
export function createRpcCaller(urls, opts = {}) {
  const callFn = opts.callFn ?? ((url, payload) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json()));

  return async function rpcCall(method, params = []) {
    const payload = { jsonrpc: '2.0', id: 1, method, params };
    let lastErr = null;
    for (const url of urls) {
      try {
        const json = await callFn(url, payload);
        if (json && json.error) { lastErr = new Error(json.error.message || 'rpc error'); continue; }
        if (json && 'result' in json) return json.result;
        lastErr = new Error('malformed rpc response');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('no rpc urls configured');
  };
}
